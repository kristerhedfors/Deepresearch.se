// Chat turn rendering: user bubbles and assistant turns (activity wrapper +
// streamed content + Raw/Copy/PDF tools + stats footer). Initialize once
// with the chat container and a scroll callback.

import { renderMarkdownInto } from "./markdown.js";
import { downloadReport } from "./report.js";
import { renderMapEmbed, renderStreetViewEmbed, renderStreetViewFrames } from "./activity.js";
import { renderQuiz } from "./quiz.js";
import { mountBalloonSpinner } from "./balloon-spinner.js";

export const EMPTY_TEXT =
  "Ask a research question to get started. I may ask a follow-up to narrow the scope, then search the web and report back with sources.";

let chat;
let scrollDown;
let isBusy = () => false;

/**
 * One-time wiring from app.js.
 * @param {HTMLElement} chatEl  the scrolling chat container
 * @param {(force?: boolean) => void} scrollFn  auto-follow scroll callback
 * @param {{isBusy?: () => boolean}} [opts]  gates the PDF download while streaming
 */
export function initTurns(chatEl, scrollFn, opts = {}) {
  chat = chatEl;
  scrollDown = scrollFn;
  isBusy = opts.isBusy || isBusy;
}

export function clearChatDom() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = EMPTY_TEXT;
  chat.replaceChildren(empty);
}

const clearEmpty = () => { chat.querySelector(".empty")?.remove(); };

// Splits a stored {role:"user", content} entry back into bubble parts.
// Document attachments aren't reconstructed as chips here — their text was
// already embedded inline in the message when it was sent (see stream.js's
// sendMessage), so it simply shows as part of the message text on reload.
// (message-content.js exports a hardened twin used on the send path; this
// local copy only ever sees records this app itself wrote.)
function splitUserContent(content) {
  if (typeof content === "string") return { text: content, imageUrls: [] };
  const text = content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const imageUrls = content.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  return { text, imageUrls };
}

// Loads a previously saved conversation (public/js/history-ui.js) into the
// chat DOM: user bubbles and assistant turns with their final text set
// directly, no typing animation or activity steps (those were live-session
// UI, never persisted — only the message content itself is saved). Street
// View elements ARE persisted (stream.js's `embeds` registry, keyed by
// assistant-message index) and re-rendered: the frame strip from its stored
// data URLs, and the interactive panorama rebuilt from its coordinates via
// the Maps JS SDK — a reopened conversation used to lose all imagery
// (reported bug). Frames whose URLs were size-capped away degrade to text.
// Quizzes re-render from their embed record too — resuming an unfinished one
// or showing the finished recap; `opts.quizHooks(embed)` (stream.js) wires
// their answers/completion back into the registry and history.
/**
 * @param {Array<{role: string, content: string|object[]}>} messages  the stored conversation
 * @param {object[]} [embeds]  the record's embeds registry (stream.js EmbedEntry[])
 * @param {{quizHooks?: (embed: object) => object}} [opts]
 */
export function renderStoredConversation(messages, embeds = [], opts = {}) {
  clearChatDom();
  let lastUser = { text: "", imageUrls: [] };
  messages.forEach((m, i) => {
    if (m.role === "user") {
      lastUser = splitUserContent(m.content);
      addUserBubble(lastUser.text, lastUser.imageUrls);
    } else if (m.role === "assistant" && typeof m.content === "string") {
      // question/images are threaded through so the PDF report button
      // works the same as it does on a live turn.
      const turn = addAssistantTurn(lastUser.text, lastUser.imageUrls);
      setText(turn, m.content);
      for (const e of embeds) {
        if (e?.msgIndex !== i) continue;
        if (e.kind === "streetview_embed") {
          renderStreetViewEmbed(turn, { lat: e.lat, lng: e.lng, heading: e.heading, pitch: e.pitch });
        } else if (e.kind === "map_embed") {
          renderMapEmbed(turn, { lat: e.lat, lng: e.lng, zoom: e.zoom, q: e.q || "" });
        } else if (e.kind === "streetview_frames" && e.frames?.some((f) => f?.url)) {
          renderStreetViewFrames(turn, { query: e.query || "", frames: e.frames.filter((f) => f?.url) });
        } else if (e.kind === "quiz" && e.quiz) {
          renderQuiz(turn, e.quiz, opts.quizHooks ? opts.quizHooks(e) : { answers: e.answers || [] });
        }
      }
    }
  });
}

/**
 * Appends a user bubble: message text, image thumbnails, document chips.
 * @param {string} text
 * @param {string[]} [imageUrls]  data URLs of attached images
 * @param {string[]} [docNames]   attached document names (chips)
 */
export function addUserBubble(text, imageUrls = [], docNames = []) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  if (imageUrls.length) {
    const imgs = document.createElement("div");
    imgs.className = "imgs";
    for (const url of imageUrls) {
      const img = document.createElement("img");
      img.src = url;
      imgs.appendChild(img);
    }
    el.appendChild(imgs);
  }
  if (docNames.length) {
    const docs = document.createElement("div");
    docs.className = "docs";
    for (const name of docNames) {
      const chip = document.createElement("span");
      chip.className = "doc-chip";
      chip.textContent = "📄 " + name;
      docs.appendChild(chip);
    }
    el.appendChild(docs);
  }
  chat.appendChild(el);
  scrollDown(true); // sending re-attaches auto-follow
}

/**
 * The per-reply handle every renderer works on — created here, mutated by
 * activity.js (steps/stats/embeds), stream.js (text, research log), and
 * report.js (PDF export).
 * @typedef {object} Turn
 * @property {HTMLElement} el            the .msg.assistant container
 * @property {HTMLElement} activityWrap  the <details class="activity"> wrapper
 * @property {HTMLElement} activity      the step-bar container
 * @property {HTMLElement} activityLabel the collapsed-summary label
 * @property {HTMLElement} content       the streamed-answer body
 * @property {HTMLElement} stats         the stats footer
 * @property {string} question           the user prompt (PDF report title)
 * @property {string[]} images           data URLs sent with it (embedded in the PDF)
 * @property {string} model              set from the `done` event
 * @property {Object<string, object>} steps  live generic steps by id
 * @property {string} text               the full answer text so far
 * @property {boolean} rawMode           Raw-button toggle state
 * @property {boolean} errored           setError was called
 * @property {boolean} finaleActive      typing umbrella is mid finish-finale
 * @property {number} searchCount        from the `done` event (collapse label)
 * @property {number} startedAt          anchors researchLog's relative timestamps
 * @property {object[]} researchLog      ordered research events (activity.js ResearchLogEntry)
 * @property {?object} doneStats         the final `done` event payload
 */

/**
 * An assistant turn = collapsible activity panel + streamed content (typing
 * icon until the first token) + Raw/Copy/PDF tools + stats footer.
 * @param {string} [question]  the user's prompt — becomes the PDF report's title
 * @param {string[]} [images]  the data URLs sent with it — embedded in the PDF report
 * @returns {Turn}
 */
export function addAssistantTurn(question = "", images = []) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = "msg assistant";

  // Activity: a <details open> wrapper whose steps show live during
  // research, then collapse to the single summary bar on completion.
  const activityWrap = document.createElement("details");
  activityWrap.className = "activity";
  activityWrap.open = true;
  const activitySummary = document.createElement("summary");
  activitySummary.className = "activity-summary";
  const activityLabel = document.createElement("span");
  activitySummary.appendChild(activityLabel);
  const activity = document.createElement("div");
  activity.className = "activity-steps";
  activityWrap.append(activitySummary, activity);

  const tools = document.createElement("div");
  tools.className = "msg-tools";
  const content = document.createElement("div");
  showTyping(content);
  const stats = document.createElement("div");
  stats.className = "stats";
  el.append(activityWrap, tools, content, stats);
  chat.appendChild(el);
  scrollDown();

  const turn = {
    el, activityWrap, activity, activityLabel, content, stats,
    question, images, model: "",
    steps: {}, text: "", rawMode: false, errored: false, searchCount: 0,
    finaleActive: false, // true while the typing umbrella plays its finish finale
    // Structured, ordered log of every research event this turn saw (steps,
    // searches, service lookups, the final stats) — the source for the
    // "Copy research JSON" debug button (activity.js). startedAt anchors the
    // per-event relative timestamps.
    startedAt: Date.now(),
    researchLog: [],
    doneStats: null,
  };
  tools.append(makeRawButton(turn), makeCopyButton(turn), makePdfButton(turn), makeFeedbackButton(turn));
  return turn;
}

// Feedback mode (the account panel's knob): while the body carries the
// `feedback-mode` class, every assistant turn's tools row shows a Feedback
// button — the button is ALWAYS in the DOM (live turns and reloaded ones
// alike), CSS shows/hides it, so flipping the knob applies to existing
// replies instantly with no re-render.
export function applyFeedbackMode(on) {
  document.body.classList.toggle("feedback-mode", on);
}

// The Feedback button opens a MODAL dialog (same overlay pattern as the
// account panel) — deliberately NOT an inline form: an inline textarea in
// the chat column competes with the ever-present composer, and on a phone
// the typing predictably lands in the composer and goes to the LLM instead
// of the feedback pipeline (observed live 2026-07-09: two feedback attempts
// arrived as chat questions #170/#171 while the feedback table stayed
// empty). A dimmed full-screen dialog is the unambiguous answer: while it's
// open, the composer isn't reachable at all.
function makeFeedbackButton(turn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-btn feedback-btn";
  btn.textContent = "Feedback";
  btn.title = "Tell the developers about this reply";
  btn.addEventListener("click", () => openFeedbackDialog(turn));
  return btn;
}

function openFeedbackDialog(turn) {
  document.querySelector(".fb-overlay")?.remove(); // one dialog at a time
  const overlay = document.createElement("div");
  overlay.className = "fb-overlay";
  const card = document.createElement("div");
  card.className = "fb-card";

  const head = document.createElement("div");
  head.className = "fb-card-head";
  const title = document.createElement("strong");
  title.textContent = "Feedback to the developers";
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "✕";
  close.addEventListener("click", () => overlay.remove());
  head.append(title, close);

  const about = document.createElement("p");
  about.className = "muted fb-about";
  const q = (turn.question || "").trim();
  about.textContent = q
    ? `About the reply to: “${q.length > 110 ? q.slice(0, 110) + "…" : q}”`
    : "About this reply";

  const ta = document.createElement("textarea");
  ta.rows = 4;
  ta.placeholder = "What was good or bad about this reply? What should change?";

  const note = document.createElement("p");
  note.className = "muted fb-note";
  note.textContent =
    "This goes to the site's developers — not to the AI. It's sent together with the question and reply above; answers show up under Feedback in your account panel.";

  const actions = document.createElement("div");
  actions.className = "fb-actions";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "fb-send";
  send.textContent = "Send feedback";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => overlay.remove());
  const status = document.createElement("span");
  status.className = "muted fb-note";
  actions.append(send, cancel, status);

  send.addEventListener("click", async () => {
    const comment = ta.value.trim();
    if (!comment) {
      ta.focus();
      return;
    }
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          comment,
          question: turn.question || undefined,
          answer_excerpt: turn.text ? turn.text.slice(0, 8000) : undefined,
          model: turn.model || undefined,
          page: location.pathname,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "HTTP " + res.status);
      }
      card.replaceChildren();
      const done = document.createElement("p");
      done.className = "fb-done";
      done.textContent = "Feedback sent ✓";
      const hint = document.createElement("p");
      hint.className = "muted";
      hint.textContent =
        "The developers read every submission — replies show up under Feedback in your account panel.";
      card.append(done, hint);
      setTimeout(() => overlay.remove(), 2500);
    } catch (err) {
      send.disabled = false;
      send.textContent = "Send feedback";
      status.textContent = (err?.message || "Could not send feedback.") + " Try again.";
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.remove();
  });

  card.append(head, about, ta, note, actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  ta.focus();
}

function makeRawButton(turn) {
  const rawBtn = document.createElement("button");
  rawBtn.type = "button";
  rawBtn.className = "tool-btn";
  rawBtn.textContent = "Raw";
  rawBtn.title = "Toggle raw text view";
  rawBtn.addEventListener("click", () => {
    turn.rawMode = !turn.rawMode;
    rawBtn.classList.toggle("active", turn.rawMode);
    renderContent(turn);
  });
  return rawBtn;
}

function makePdfButton(turn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-btn";
  btn.textContent = "PDF";
  btn.title = "Download as a PDF report";
  btn.addEventListener("click", async () => {
    // Downloads wait while an answer is streaming: on iOS a download can
    // navigate the page, which aborts the in-flight fetch mid-answer.
    if (isBusy()) {
      btn.textContent = "when done";
      btn.title = "The report downloads after the current research finishes";
      setTimeout(() => { btn.textContent = "PDF"; }, 1500);
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await downloadReport(turn, { model: turn.model });
      btn.textContent = "PDF ✓";
    } catch {
      btn.textContent = "PDF failed";
    }
    setTimeout(() => { btn.textContent = "PDF"; btn.disabled = false; }, 1500);
  });
  return btn;
}

function makeCopyButton(turn) {
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "tool-btn";
  copyBtn.textContent = "Copy";
  copyBtn.title = "Copy raw response to clipboard";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(turn.text);
      copyBtn.textContent = "Copied ✓";
    } catch {
      copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
  return copyBtn;
}

// Default view is rendered markdown (sanitized); Raw toggles plain text.
function renderContent(turn) {
  const c = turn.content;
  if (turn.errored) {
    c.className = "content error-text";
    c.textContent = turn.text;
    return;
  }
  if (turn.rawMode) {
    c.className = "content";
    c.textContent = turn.text;
  } else {
    c.className = "content md";
    renderMarkdownInto(c, turn.text);
  }
}

// Below this wait, dismissing the typing indicator is instant (no finale) —
// a quick direct reply shouldn't be held back by a celebratory flourish. Above
// it (a research-length wait), the big balloon plays the same completion finale
// the small step spinners do before the answer is revealed.
const TYPING_FINALE_MIN_MS = 1500;

function showTyping(content) {
  content.className = "content typing";
  content.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "typing-icon";
  content.appendChild(icon);
  // The single waiting spinner: play the intro in miniature, fixed in place.
  // Best-effort — falls back to the CSS twirly logo on reduced-motion/no-canvas.
  // The animation stops itself when setText/resetForRevision clears the icon.
  // The handle + wait-start are stashed on the content element so setText can
  // play the colored-balloon→blue-✓ FINISH FINALE (the same one the step spinners
  // got) when a research-length wait resolves into an answer.
  content.__typingSpinner = mountBalloonSpinner(icon, { style: 0, size: 72 });
  content.__typingStart = Date.now();
}

// Reveal the streamed answer where the typing indicator was: drop the typing
// state and expose the Raw/Copy tools. (Split out of setText so both the
// finale's completion callback and the no-finale path share one implementation.)
function revealTyping(turn) {
  turn.content.__typingSpinner = null;
  turn.content.classList.remove("typing");
  turn.content.replaceChildren();
  turn.el.classList.add("has-text");
}

/**
 * True while the turn still shows the typing indicator (no text yet).
 * @param {Turn} turn
 * @returns {boolean}
 */
export function isTyping(turn) {
  return turn.content.classList.contains("typing");
}

/**
 * Replaces the turn's full text (the stream re-sets the whole accumulator
 * on every delta) and re-renders it in the current Raw/markdown mode.
 * @param {Turn} turn
 * @param {string} text
 */
export function setText(turn, text) {
  if (isTyping(turn)) {
    // Already mid-finale: keep the latest text and stay under the balloon; the
    // finale's completion callback renders whatever accumulated by then.
    if (turn.finaleActive) {
      turn.text = text;
      return;
    }
    const content = turn.content;
    const handle = content.__typingSpinner;
    const waited = Date.now() - (content.__typingStart || Date.now());
    // A research-length wait resolving into a real (non-error) answer earns the
    // big balloon's COMPLETION FINALE: it speed-runs from wherever its boomerang
    // is into the fully-colored BLUE-AND-GOLD balloon and folds into the blue ✓ — exactly
    // like the small step spinners — and only THEN is the answer revealed. A
    // quick reply, an error, or a reduced-motion/no-canvas mount skips straight
    // to the reveal so nothing is needlessly held back.
    if (handle?.finish && !turn.errored && waited >= TYPING_FINALE_MIN_MS) {
      turn.finaleActive = true;
      turn.text = text; // keep accumulating deltas while the finale plays
      handle.finish(() => {
        turn.finaleActive = false;
        revealTyping(turn);
        renderContent(turn);
        scrollDown();
      });
      return;
    }
    revealTyping(turn); // reveal the Raw/Copy tools
  }
  turn.text = text;
  renderContent(turn);
  scrollDown();
}

/**
 * Appends an error message to the turn (kept beneath any partial answer)
 * and switches it to the error style.
 * @param {Turn} turn
 * @param {string} message
 */
export function setError(turn, message) {
  // setError is the single sink for EVERY error a turn can hit — server
  // errors (via stream.js's handleEvent), and the client-only ones that
  // never touch handleEvent (non-OK response, empty stream, network drop,
  // stop-before-any-output). Record each here so the "Copy research JSON"
  // debug export captures them all, with the same relative timestamp
  // convention as the rest of the research log.
  if (Array.isArray(turn.researchLog)) {
    turn.researchLog.push({ t: Date.now() - (turn.startedAt || Date.now()), event: "error", error: String(message) });
  }
  const text = turn.text ? turn.text + "\n\n[" + message + "]" : message;
  turn.errored = true;
  setText(turn, text);
}

// Post-validation replaced the draft: clear the bubble back to the typing
// indicator and wait for the corrected answer to stream.
export function resetForRevision(turn) {
  turn.text = "";
  turn.errored = false;
  turn.finaleActive = false;
  turn.el.classList.remove("has-text");
  showTyping(turn.content);
}

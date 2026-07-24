// Chat turn rendering: user bubbles and assistant turns (activity wrapper +
// streamed content + Raw/Copy/PDF tools + stats footer). Initialize once
// with the chat container and a scroll callback.

import { renderMarkdownInto } from "./markdown.js";
import { wireSourcePeek } from "./source-peek.js";
import { downloadReport } from "./report.js";
import { renderMapEmbed, renderStreetViewEmbed, renderStreetViewFrames } from "./activity.js";
import { renderQuiz } from "./quiz.js";
import { spaceIntentMatch } from "./space-core.js";
import { mountModeSpinner } from "./mode-spinner.js";
import { formatByteSize, mimeForName } from "./bash-core.js";
import { addFilesToProject, listProjects } from "./projects.js";

export const EMPTY_TEXT =
  "Ask a research question to get started. I may ask a follow-up to narrow the scope, then search the web and report back with sources. To send the developers feedback, just start your message with the word “feedback” — for example: “feedback: the map view was cut off on my phone”.";

// The how-to-give-feedback cue for a REOPENED chat. EMPTY_TEXT above only ever
// shows on the empty state of a fresh chat; a user who opens an old session
// from history to comment on it had no on-screen reminder that starting a
// message with "feedback" reaches the developers (the feedback fix loop —
// src/feedback.js). This subtle line, appended below a reopened conversation,
// is that reminder. It is never persisted to history and is removed the moment
// a new turn is added (clearEmpty).
export const FEEDBACK_HINT_TEXT =
  "Reopened from history. Spotted something off in this chat? Start a message with the word “feedback” to send it to the developers — they read every one.";

// Whether to show FEEDBACK_HINT_TEXT under a reopened conversation: only when
// the restored record actually has an answered turn to comment on (an empty or
// user-only record gets nothing). Pure — unit-tested in turns.test.js.
/**
 * @param {Array<{role?: string}>} messages  the stored conversation
 * @returns {boolean}
 */
export function shouldShowFeedbackHint(messages) {
  return Array.isArray(messages) && messages.some((m) => m?.role === "assistant");
}

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

const clearEmpty = () => {
  chat.querySelector(".empty")?.remove();
  // The reopened-chat feedback cue is transient too — it goes as soon as the
  // conversation gains a new turn (a send, or a re-render adding turns).
  chat.querySelector(".feedback-hint")?.remove();
};

// Appends the transient reopened-chat feedback cue below the current turns.
function addFeedbackHint() {
  const hint = document.createElement("div");
  hint.className = "feedback-hint";
  hint.textContent = FEEDBACK_HINT_TEXT;
  chat.appendChild(hint);
}

// A question with a tailored space animation (the /space/ archive's scenes —
// space-core.js spaceIntentMatch, EN+SV) mounts the playable wireframe canvas
// across the response area, above the streamed answer text, with the scene's
// curated factual reply as its caption (feedback #18: "show a moonshot from
// space between earth and moon" should animate, not just cite photos). Purely
// decorative-additive: the research answer still streams below, and the mount
// is DERIVED from the question — deterministic re-detection, so reloaded (and
// pre-feature) conversations get it too without an embeds-registry entry.
// The renderer is dynamic-imported: most conversations never ask about space,
// and the module graph stays lean. Fail-soft — never breaks a turn.
/**
 * @param {Turn} turn
 * @param {string} questionText the user message the turn answers
 */
export function mountSpaceEmbed(turn, questionText) {
  try {
    const m = spaceIntentMatch(questionText);
    if (!m || !turn?.el || turn._spaceEmbed) return;
    const host = document.createElement("div");
    host.className = "space-embed-host";
    turn.el.insertBefore(host, turn.content);
    turn._spaceEmbed = host;
    import("./space-embed.js")
      .then(({ mountSpaceScene }) => {
        if (!mountSpaceScene(host, m.id, { lang: m.lang, caption: true, moreLink: true })) host.remove();
      })
      .catch(() => host.remove());
  } catch { /* decorative — never break the turn */ }
}

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
      mountSpaceEmbed(turn, lastUser.text);
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
  // Reopening a past session is the one place a returning user might want to
  // give feedback on an old answer but has no empty-state hint to tell them how
  // — so show the cue here (removed on the next send via clearEmpty).
  if (shouldShowFeedbackHint(messages)) addFeedbackHint();
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
  tools.append(makeRawButton(turn), makeCopyButton(turn), makePdfButton(turn));
  return turn;
}

// ---- sandbox deliverables (the download flow) -------------------------------

// Files the bash-lite agent placed in /workspace/outbox, exported out of the
// VM (sandbox.js collectDeliverables) and attached to the reply: one chip per
// file — tapping it downloads; the ▾ caret opens a small menu with Download
// plus one "Add to project" entry per existing project (projects.js
// addFilesToProject, the same ingest the project dropzone uses, so a doc gets
// indexed and an image gets its EXIF pass). Live-session only, like the image
// deck: the blobs exist in this tab's memory and are not persisted to history —
// "Add to project" IS the durable path.
/**
 * @param {Turn} turn
 * @param {Array<{ name: string, size: number, blob: Blob }>} files
 */
export function renderDeliverables(turn, files) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.name && f.blob) : [];
  if (!list.length) return;
  const wrap = document.createElement("div");
  wrap.className = "deliverables";
  for (const f of list) wrap.appendChild(makeDeliverableChip(f));
  turn.el.insertBefore(wrap, turn.stats);
  scrollDown();
}

function makeDeliverableChip(f) {
  const chip = document.createElement("div");
  chip.className = "dl-chip";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "dl-main";
  main.title = "Download " + f.name;
  const name = document.createElement("span");
  name.className = "dl-name";
  name.textContent = "📄 " + f.name;
  const size = document.createElement("span");
  size.className = "dl-size";
  size.textContent = formatByteSize(f.size);
  main.append(name, size);
  main.addEventListener("click", () => downloadDeliverable(f, main));

  const caret = document.createElement("button");
  caret.type = "button";
  caret.className = "dl-caret";
  caret.title = "File options";
  caret.setAttribute("aria-label", "Options for " + f.name);
  caret.textContent = "▾";
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDeliverableMenu(chip, f, main);
  });

  chip.append(main, caret);
  return chip;
}

// Downloads wait while an answer is streaming, same as the PDF button: on iOS
// a download can navigate the page, which aborts the in-flight fetch.
function downloadDeliverable(f, btn) {
  if (isBusy()) {
    const prev = btn.querySelector(".dl-size")?.textContent;
    const sizeEl = btn.querySelector(".dl-size");
    if (sizeEl) {
      sizeEl.textContent = "when done";
      setTimeout(() => { sizeEl.textContent = prev || ""; }, 1500);
    }
    return;
  }
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// The chip's dropdown. One menu at a time; dismisses on any outside
// interaction (UX-1 — the shared popover-dismissal convention) while items
// inside stay clickable.
let openDlMenu = null;
function closeDeliverableMenu() {
  if (openDlMenu) {
    openDlMenu.el.remove();
    document.removeEventListener("pointerdown", openDlMenu.onOutside, true);
    openDlMenu = null;
  }
}

async function toggleDeliverableMenu(chip, f, mainBtn) {
  if (openDlMenu?.chip === chip) {
    closeDeliverableMenu();
    return;
  }
  closeDeliverableMenu();
  const menu = document.createElement("div");
  menu.className = "dl-menu";

  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "dl-item";
  dl.textContent = "⬇ Download";
  dl.addEventListener("click", () => {
    closeDeliverableMenu();
    downloadDeliverable(f, mainBtn);
  });
  menu.appendChild(dl);

  const onOutside = (e) => {
    if (!menu.contains(e.target)) closeDeliverableMenu();
  };
  chip.appendChild(menu);
  document.addEventListener("pointerdown", onOutside, true);
  openDlMenu = { chip, el: menu, onOutside };

  // Project entries load async (listProjects hits IndexedDB) after the menu
  // is already on screen with Download usable.
  let projects = [];
  try { projects = await listProjects(); } catch { /* fail-soft: download-only menu */ }
  if (openDlMenu?.el !== menu) return; // closed (or reopened) while loading
  if (!projects.length) {
    const none = document.createElement("div");
    none.className = "dl-item dl-none";
    none.textContent = "No projects yet — create one in the sidebar to save files into it";
    menu.appendChild(none);
    return;
  }
  for (const p of projects) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dl-item";
    item.textContent = `＋ Add to “${p.name}”`;
    item.addEventListener("click", async (e) => {
      e.stopPropagation();
      item.disabled = true;
      item.textContent = "Adding…";
      try {
        const file = new File([f.blob], f.name, { type: mimeForName(f.name) });
        const { errors } = await addFilesToProject(p.id, [file]);
        if (errors?.length) throw new Error(errors[0]);
        item.textContent = `Added to “${p.name}” ✓`;
        setTimeout(closeDeliverableMenu, 1200);
      } catch (err) {
        item.disabled = false;
        item.textContent = "Failed: " + (err?.message || "could not add");
      }
    });
    menu.appendChild(item);
  }
}

// Feedback is given straight from the chat now (a message that opens with the
// word "feedback" is routed to the feedback pipeline server-side — src/
// feedback.js feedbackIntent, src/pipeline.js runFeedbackCapture), so there is
// no per-reply Feedback button or modal here any more. The developers' replies
// still surface as threads under Feedback in the account panel
// (account-feedback.js).

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
    // Introspection answers cite repo files; in developer mode each becomes
    // a tap target opening the file from the source snapshot (source-peek.js;
    // gated inside — a no-op unless app.js wired the developer-mode gate).
    wireSourcePeek(c);
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
  // The single waiting spinner: play the current chat mode's symbol in
  // miniature, fixed in place (mode-spinner.js — balloon in Normal/
  // Introspection, the plant in SDK mode).
  // Best-effort — falls back to the CSS twirly logo on reduced-motion/no-canvas.
  // The animation stops itself when setText/resetForRevision clears the icon.
  // The handle + wait-start are stashed on the content element so setText can
  // play the colored-symbol→✓ FINISH FINALE (the same one the step spinners
  // got) when a research-length wait resolves into an answer.
  content.__typingSpinner = mountModeSpinner(icon, { style: 0, size: 72 });
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

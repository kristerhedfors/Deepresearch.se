// Chat turn rendering: user bubbles and assistant turns (activity wrapper +
// streamed content + Raw/Copy/PDF tools + stats footer). Initialize once
// with the chat container and a scroll callback.

import { renderMarkdownInto } from "./markdown.js";
import { downloadReport } from "./report.js";
import { renderMapEmbed, renderStreetViewEmbed, renderStreetViewFrames } from "./activity.js";
import { renderQuiz } from "./quiz.js";

export const EMPTY_TEXT =
  "Ask a research question to get started. I may ask a follow-up to narrow the scope, then search the web and report back with sources.";

let chat;
let scrollDown;
let isBusy = () => false;

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

// An assistant turn = collapsible activity panel + streamed content (typing
// icon until the first token) + Raw/Copy/PDF tools + stats footer.
// `question` (the user's prompt) becomes the PDF report's title; `images`
// (the data URLs sent with it) are embedded in the PDF report.
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

// The Feedback button + its inline form: a textarea under the reply, sent to
// POST /api/feedback together with the reply it's about (question, answer
// excerpt, model), where it becomes a dialogue thread with the development
// agent (account panel → Feedback).
function makeFeedbackButton(turn) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-btn feedback-btn";
  btn.textContent = "Feedback";
  btn.title = "Tell the developers about this reply";
  btn.addEventListener("click", () => {
    const existing = turn.el.querySelector(".fb-form");
    if (existing) {
      existing.remove();
      return;
    }
    const form = document.createElement("div");
    form.className = "fb-form";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.placeholder = "What was good or bad about this reply? What should change?";
    const actions = document.createElement("div");
    actions.className = "fb-actions";
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send feedback";
    const note = document.createElement("span");
    note.className = "muted fb-note";
    note.textContent = "Sent with this question & reply. Answers arrive under Feedback in your account panel.";
    send.addEventListener("click", async () => {
      const comment = ta.value.trim();
      if (!comment) return;
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
        form.replaceChildren();
        const done = document.createElement("p");
        done.className = "muted";
        done.textContent = "Feedback sent ✓ — replies show up under Feedback in your account panel.";
        form.appendChild(done);
        setTimeout(() => form.remove(), 6000);
      } catch (err) {
        send.disabled = false;
        send.textContent = "Send feedback";
        note.textContent = (err?.message || "Could not send feedback.") + " Try again.";
      }
    });
    actions.append(send, note);
    form.append(ta, actions);
    turn.el.insertBefore(form, turn.stats);
    ta.focus();
    scrollDown();
  });
  return btn;
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

function showTyping(content) {
  content.className = "content typing";
  content.replaceChildren();
  const icon = document.createElement("span");
  icon.className = "typing-icon";
  content.appendChild(icon);
}

export function isTyping(turn) {
  return turn.content.classList.contains("typing");
}

export function setText(turn, text) {
  if (isTyping(turn)) {
    turn.content.classList.remove("typing");
    turn.content.replaceChildren();
    turn.el.classList.add("has-text"); // reveal the Raw/Copy tools
  }
  turn.text = text;
  renderContent(turn);
  scrollDown();
}

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
  turn.el.classList.remove("has-text");
  showTyping(turn.content);
}

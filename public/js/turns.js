// Chat turn rendering: user bubbles and assistant turns (activity wrapper +
// streamed content + Raw/Copy/PDF tools + stats footer). Initialize once
// with the chat container and a scroll callback.

import { renderMarkdownInto } from "./markdown.js";
import { downloadReport } from "./report.js";

const EMPTY_TEXT =
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
// UI, never persisted — only the message content itself is saved).
export function renderStoredConversation(messages) {
  clearChatDom();
  let lastUser = { text: "", imageUrls: [] };
  for (const m of messages) {
    if (m.role === "user") {
      lastUser = splitUserContent(m.content);
      addUserBubble(lastUser.text, lastUser.imageUrls);
    } else if (m.role === "assistant" && typeof m.content === "string") {
      // question/images are threaded through so the PDF report button
      // works the same as it does on a live turn.
      const turn = addAssistantTurn(lastUser.text, lastUser.imageUrls);
      setText(turn, m.content);
    }
  }
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
  };
  tools.append(makeRawButton(turn), makeCopyButton(turn), makePdfButton(turn));
  return turn;
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

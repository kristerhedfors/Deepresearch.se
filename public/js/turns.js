// Chat turn rendering: user bubbles and assistant turns (activity wrapper +
// streamed content + Raw/Copy tools + stats footer). Initialize once with
// the chat container and a scroll callback.

import { renderMarkdownInto } from "./markdown.js";

const EMPTY_TEXT =
  "Ask a research question to get started. I may ask a follow-up to narrow the scope, then search the web and report back with sources.";

let chat;
let scrollDown;

export function initTurns(chatEl, scrollFn) {
  chat = chatEl;
  scrollDown = scrollFn;
}

export function clearChatDom() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = EMPTY_TEXT;
  chat.replaceChildren(empty);
}

const clearEmpty = () => { chat.querySelector(".empty")?.remove(); };

export function addUserBubble(text, imageUrls = []) {
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
  chat.appendChild(el);
  scrollDown(true); // sending re-attaches auto-follow
}

// An assistant turn = collapsible activity panel + streamed content (typing
// icon until the first token) + Raw/Copy tools + stats footer.
export function addAssistantTurn() {
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
    lastStep: null, steps: {}, text: "", rawMode: false, errored: false, searchCount: 0,
  };
  tools.append(makeRawButton(turn), makeCopyButton(turn));
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

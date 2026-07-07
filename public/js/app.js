// Deepresearch.se chat client — bootstrap and wiring.
//
// Module map:
//   timescale.js   — slider position <-> seconds mapping (pure)
//   markdown.js    — sanitized markdown rendering (vendored marked+DOMPurify)
//   turns.js       — user bubbles + assistant turns (content, tools, typing)
//   activity.js    — live research step bars, stats footer, collapse
//   models.js      — model dropdown (catalog, persistence, vision lookup)
//   attachments.js — pending images/documents, downscaling, card row
//   account.js     — account & usage panel (/api/me)
//   stream.js      — conversation history + /api/chat SSE send loop
//
// This file wires the page: scrolling, composer controls (slider, search
// knob, autogrow, submit), and the module initializers.

import { initAccountPanel } from "./account.js";
import { hasPending, indexingBusy, initAttachments, syncAttachState, takeAttachments } from "./attachments.js";
import { refreshProjects, setActiveProject } from "./projects.js";
import { initProjectsUi } from "./projects-ui.js";
import { loadSettings } from "./settings.js";
import { pullNewer, syncToServer } from "./sync.js";
import { initHistorySidebar } from "./history-ui.js";
import { initModels, selectedModelId, selectModel } from "./models.js";
import { clearHistory, initStream, isStreaming, sendMessage, stopGeneration } from "./stream.js";
import { BUDGET_MAX_S, BUDGET_MIN_S, fmtBudget, posToSeconds, secondsToPos } from "./timescale.js";
import { clearChatDom, initTurns } from "./turns.js";

// ---- Elements -------------------------------------------------------------

const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");

// ---- Auto-follow scrolling ---------------------------------------------
// Streaming pins the view to the bottom ONLY while the user is already
// there. Scrolling up detaches (no yank-back on the next token) and shows
// the jump-down button; pressing it — or scrolling back down yourself —
// re-attaches.

// The chrome (header items, composer) floats as fixed glass panes over
// the content — nothing hides or slides; the chat scrolls beneath and
// shows through the translucency and the gaps between items.
const jumpBtn = document.getElementById("jumpdown");
let autoFollow = true;

chat.addEventListener("scroll", () => {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  autoFollow = nearBottom;
  jumpBtn.hidden = nearBottom;
});
jumpBtn.addEventListener("click", () => {
  // Instant, not smooth: a smooth animation fires intermediate scroll
  // events that read as "user scrolled away" and re-detach — and the
  // bottom keeps moving while content streams.
  autoFollow = true;
  chat.scrollTop = chat.scrollHeight;
  jumpBtn.hidden = true;
});
const scrollDown = (force = false) => {
  if (force) autoFollow = true;
  if (autoFollow) chat.scrollTop = chat.scrollHeight;
};

// ---- Module wiring ---------------------------------------------------------

initTurns(chat, scrollDown, { isBusy: isStreaming });
initModels(document.getElementById("model"), { onChange: syncAttachState });
initAttachments(
  document.getElementById("attach"),
  document.getElementById("file"),
  document.getElementById("pending"),
);
initAccountPanel();
// Account settings (the cloud-storage knob): fetched once at boot so the
// storage modules' synchronous serverHistoryOn() checks have an answer.
// Cloud storage is ON by default — most accounts never touch the knob —
// so boot also runs a quiet background reconcile: push anything local the
// cloud doesn't have yet (diff-only; skips up-to-date items) and pull
// conversations written from other devices. Entirely fail-soft and
// deliberately not awaited — the app is fully usable while it runs.
loadSettings()
  .then((s) => {
    if (!s?.server_history) return;
    syncToServer().catch(() => {});
    pullNewer().catch(() => {});
  })
  .catch(() => {});

// ---- Research time-target slider ----------------------------------------
// Persisted as seconds; sent as time_budget_s with each request (the server
// plans the spend — src/budget.js). Position mapping in timescale.js.

const budgetSlider = document.getElementById("budget");
const budgetVal = document.getElementById("budgetval");
let budgetS = 60;
const savedBudget = parseInt(localStorage.getItem("budget_s"), 10);
if (savedBudget >= BUDGET_MIN_S && savedBudget <= BUDGET_MAX_S) budgetS = savedBudget;
budgetSlider.value = secondsToPos(budgetS);
const updateBudgetVal = () => { budgetVal.textContent = fmtBudget(budgetS); };
budgetSlider.addEventListener("input", () => {
  budgetS = posToSeconds(Number(budgetSlider.value));
  updateBudgetVal();
  localStorage.setItem("budget_s", String(budgetS));
});
updateBudgetVal();

// ---- Web-search knob ------------------------------------------------------
// Default on. Off = the answer comes from the model only; the time slider
// is moot then, so it dims.

const webSearchBox = document.getElementById("websearch");
webSearchBox.checked = localStorage.getItem("web_search") !== "off";
const syncSearchToggle = () => {
  budgetSlider.disabled = !webSearchBox.checked;
  document.getElementById("composer").classList.toggle("nosearch", !webSearchBox.checked);
};
webSearchBox.addEventListener("change", () => {
  localStorage.setItem("web_search", webSearchBox.checked ? "on" : "off");
  syncSearchToggle();
});
syncSearchToggle();

// The web-search popover opens on a press-and-hold of the spiderweb knob
// itself (the separate 🔍 button was dropped to give the slider its space).
// A held press must NOT also flip the toggle, so the label's click is
// swallowed when the hold timer fired.
const searchPop = document.getElementById("searchpop");
const searchToggle = document.getElementById("searchtoggle");
let holdTimer = 0;
let holdFired = false;
searchToggle.addEventListener("pointerdown", () => {
  holdFired = false;
  holdTimer = setTimeout(() => {
    holdFired = true;
    searchPop.hidden = false;
  }, 500);
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
  searchToggle.addEventListener(ev, () => clearTimeout(holdTimer));
}
searchToggle.addEventListener("click", (e) => {
  if (holdFired) {
    e.preventDefault();
    e.stopPropagation();
    holdFired = false;
  }
});
searchToggle.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("click", (e) => {
  if (!searchPop.hidden && !searchPop.contains(e.target)) searchPop.hidden = true;
});

// ---- Header: clear chat / chat history / projects ---------------------------

// The header's "New chat" leaves any project context (a plain chat);
// "New chat in project" (projects-ui.js) passes keepProject so the fresh
// conversation adopts the project it was started from.
function newChat(keepProject = false) {
  if (keepProject !== true) setActiveProject(null);
  clearHistory();
  clearChatDom();
  input.focus();
}
document.getElementById("clearbtn").addEventListener("click", () => newChat());

// Loading a saved conversation restores the model/time-target/web-search
// settings it was sent with, same as re-opening a real chat-app
// conversation. Shared by the history sidebar and the project panel.
function applyRecordSettings(record) {
  if (record.model) selectModel(record.model);
  if (Number.isFinite(record.budgetS) && record.budgetS >= BUDGET_MIN_S && record.budgetS <= BUDGET_MAX_S) {
    budgetS = record.budgetS;
    budgetSlider.value = secondsToPos(budgetS);
    updateBudgetVal();
    localStorage.setItem("budget_s", String(budgetS));
  }
  webSearchBox.checked = record.webSearch !== false;
  localStorage.setItem("web_search", webSearchBox.checked ? "on" : "off");
  syncSearchToggle();
}

// Encrypted local history sidebar (public/js/history-ui.js + history-store.js).
const historySidebar = initHistorySidebar({
  onNew: newChat,
  onLoad: applyRecordSettings,
});
// Projects (public/js/projects.js + projects-ui.js): collections of chats
// and files with their own cloud knob and retrieval scope.
initProjectsUi({ onNew: newChat, onLoad: applyRecordSettings });
refreshProjects().catch(() => {});
initStream(scrollDown, { onHistoryChange: () => historySidebar.onSaved() });

// ---- First-visit privacy notice (acknowledgement kept in a cookie) --------

const privacy = document.getElementById("privacy");
if (!/(?:^|;\s*)dr_privacy_ack=1/.test(document.cookie)) privacy.hidden = false;
document.getElementById("privacyok").addEventListener("click", () => {
  document.cookie = "dr_privacy_ack=1; max-age=31536000; path=/; SameSite=Lax; Secure";
  privacy.hidden = true;
});

// ---- Composer ---------------------------------------------------------------

// Single-line composer that grows with content up to the CSS max-height,
// then scrolls internally.
const autogrow = () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
};
input.addEventListener("input", autogrow);

// While a response is streaming, the same button switches from send
// (arrow) to stop (square) — never disabled, so it stays clickable to
// interrupt generation. stream.js keeps whatever streamed so far as
// normal context, so the composer is immediately ready for a follow-up.
const SEND_ICON = send.innerHTML;
const STOP_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
function setSendMode(streaming) {
  send.innerHTML = streaming ? STOP_ICON : SEND_ICON;
  send.classList.toggle("stop", streaming);
  send.setAttribute("aria-label", streaming ? "Stop generating" : "Send");
  send.title = streaming ? "Stop generating" : "Send";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isStreaming()) {
    stopGeneration();
    return;
  }
  const text = input.value.trim();
  if (!text && !hasPending()) return;
  if (indexingBusy()) {
    alert("Still indexing an attached document — try again in a moment (the card shows progress).");
    return;
  }
  input.value = "";
  autogrow();
  setSendMode(true);
  const { images, docs } = takeAttachments();
  await sendMessage(text, {
    images,
    docs,
    model: selectedModelId(),
    budgetS,
    webSearch: webSearchBox.checked,
  });
  setSendMode(false);
  input.focus();
});

// Enter inserts a line break — nothing is sent until the arrow is tapped
// (form submit). The input just grows via the autogrow handler above.

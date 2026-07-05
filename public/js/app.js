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
import { hasPending, initAttachments, syncAttachState, takeAttachments } from "./attachments.js";
import { initModels, selectedModelId } from "./models.js";
import { clearHistory, initStream, sendMessage } from "./stream.js";
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

initTurns(chat, scrollDown);
initStream(scrollDown);
initModels(document.getElementById("model"), { onChange: syncAttachState });
initAttachments(
  document.getElementById("attach"),
  document.getElementById("file"),
  document.getElementById("pending"),
);
initAccountPanel();

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

// 🔍 symbol: tap/click for a popover explaining the web-search knob
// (title tooltips don't exist on touch devices).
const searchPop = document.getElementById("searchpop");
document.getElementById("searchinfo").addEventListener("click", (e) => {
  e.stopPropagation();
  searchPop.hidden = !searchPop.hidden;
});
document.addEventListener("click", (e) => {
  if (!searchPop.hidden && !searchPop.contains(e.target)) searchPop.hidden = true;
});

// ---- Header: clear chat ----------------------------------------------------

document.getElementById("clearbtn").addEventListener("click", () => {
  clearHistory();
  clearChatDom();
  input.focus();
});

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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !hasPending()) return;
  input.value = "";
  autogrow();
  send.disabled = true;
  const { images, docs } = takeAttachments();
  await sendMessage(text, {
    images,
    docs,
    model: selectedModelId(),
    budgetS,
    webSearch: webSearchBox.checked,
  });
  send.disabled = false;
  input.focus();
});

// Enter inserts a line break — nothing is sent until the arrow is tapped
// (form submit). The input just grows via the autogrow handler above.

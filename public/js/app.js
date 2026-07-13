// Deepresearch.se chat client — bootstrap and wiring.
//
// Module map (what this file wires):
//   timescale.js      — slider position <-> seconds mapping (pure)
//   turns.js          — user bubbles + assistant turns (content, tools, typing)
//   activity.js       — live research step bars, stats footer, embeds, collapse
//   models.js         — model dropdown (catalog, persistence, vision lookup)
//   attachments.js    — pending images/documents, downscaling, card row
//   account.js        — account & usage panel (/api/me)
//   stream.js         — conversation history + /api/chat SSE send loop
//   history-ui.js     — the encrypted local-history drawer
//   projects.js/-ui   — project records, panel, header chip
//   settings.js       — cached /api/settings (cloud/feedback knob state)
//   sync.js           — boot-time cloud reconcile (push diff + pullNewer)
//   imagedeck.js      — the conversation-wide image deck (onDeckAsk hook)
//   pending-answer.js — the resume-across-relaunch pointer
//
// This file wires the page: scrolling, composer controls (slider, search
// knob, autogrow, submit), and the module initializers.

import { initAccountPanel } from "./account.js";
import { hasPending, indexingBusy, initAttachments, syncAttachState, takeAttachments } from "./attachments.js";
import { refreshProjects, setActiveProject } from "./projects.js";
import { initProjectsUi } from "./projects-ui.js";
import { bashLiteOn, developerModeOn, loadSettings } from "./settings.js";
import { applyDeveloperTheme, cachedDeveloperMode } from "./dev-mode.js";
import { initIntrospectUi, noteIntrospectionText } from "./introspect-ui.js";
import { setMapViewAnchor, setPovAnchor } from "./activity.js";
import { onDeckAsk } from "./imagedeck.js";
import { pullNewer, syncToServer } from "./sync.js";
import { initHistorySidebar } from "./history-ui.js";
import { initModels, selectedModelId, selectModel } from "./models.js";
import { readPending } from "./pending-answer.js";
import {
  clearHistory,
  conversationAsText,
  conversationStarted,
  initStream,
  isStreaming,
  prewarmSandbox,
  resumePendingAnswer,
  sendMessage,
  stopGeneration,
} from "./stream.js";
import { BUDGET_MAX_S, BUDGET_MIN_S, fmtBudget, posToSeconds, secondsToPos } from "./timescale.js";
import { applyFeedbackMode, clearChatDom, EMPTY_TEXT, initTurns } from "./turns.js";

// ---- Elements -------------------------------------------------------------

const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");

// Developer-mode titanium theme — applied FIRST, synchronously, from the local
// cache (dev-mode.js) so a returning developer-mode user (a PWA relaunch reads
// the device-cached shell before /api/settings answers) paints the titanium
// palette with no blue flash. The server's authoritative developer_mode
// reconciles this below once loadSettings() resolves. { persist: false }: this
// is reading the cache, not making a new decision.
applyDeveloperTheme(cachedDeveloperMode(), { persist: false });

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
  document.getElementById("camera"),
  document.getElementById("camerafile"),
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
    // Feedback mode (account panel knob): reveal the per-reply Feedback
    // buttons — turns.js keeps them in the DOM, the body class shows them.
    applyFeedbackMode(s?.feedback_mode === true);
    // Reconcile the titanium theme with the server's authoritative
    // developer_mode: repaints (and re-caches) if this device flipped the knob
    // elsewhere, or if the account had developer mode on but no local cache
    // yet (first load on a new device). A no-op when the cache already agreed.
    applyDeveloperTheme(s?.developer_mode === true);
    // Experimental execution sandbox self-heal: the sandbox needs the page to
    // be cross-origin isolated (COEP), which the server only sends when the
    // bash_lite knob is on. If the knob is on but THIS page loaded without
    // isolation (a tab open from before the knob was flipped, or a stale
    // cache), the sandbox silently can't boot. Reload ONCE to fetch the
    // now-isolated shell — guarded by sessionStorage so a server that never
    // sends COEP can't cause a reload loop.
    if (s?.bash_lite_mcp === true && !window.crossOriginIsolated && !sessionStorage.getItem("dr_coep_reload")) {
      sessionStorage.setItem("dr_coep_reload", "1");
      // NOT location.reload(): an installed iOS PWA relaunches from a shell
      // cached ON THE DEVICE that predates the COEP header, and reload() keeps
      // returning that same non-isolated copy (observed live: fresh JS but
      // client_diag.coi=false). Navigate to a FRESH URL instead — a distinct
      // path forces a real network fetch of /rver (which the server sends with
      // COEP), which no on-device or bfcache copy can satisfy.
      location.replace(location.pathname + "?_coep=" + Date.now());
      return;
    }
    if (window.crossOriginIsolated) sessionStorage.removeItem("dr_coep_reload");
    if (!s?.server_history) return;
    syncToServer().catch(() => {});
    pullNewer().catch(() => {});
  })
  .catch(() => {});

// bfcache / PWA-resume self-heal: a page restored from the back-forward cache
// (Safari especially, and any tab navigated away-and-back) keeps its ORIGINAL
// isolation state and does NOT re-run the module-top self-heal above — so a
// tab that was ever shown non-isolated stays non-isolated (and the sandbox
// silently refuses) across every resume. On a bfcache restore, re-check and
// reload to fetch the now-isolated shell. `persisted` is true only for an
// actual bfcache restore, so a normal navigation never triggers this.
window.addEventListener("pageshow", (e) => {
  if (e.persisted && bashLiteOn() && !window.crossOriginIsolated) {
    sessionStorage.removeItem("dr_coep_reload");
    location.replace(location.pathname + "?_coep=" + Date.now());
  }
});

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

// ---- The ghost: the door to DRC (2026-07-10 directive) ----------------------
// Upper right, directly left of the account button. The ghost symbol's NEW
// MEANING: it TAKES YOU to ghost territory — DRC, "deep research secure",
// the khaki client-side twin at /cure where this server is not in any data
// path at all (your own API keys, browser-local storage, model calls
// straight from the browser). That is a structurally stronger anonymity
// than the old per-conversation incognito toggle ever was: there is
// nothing for the server to log in DRC, ever. The server keeps honoring
// `incognito: true` on /api/chat (the anonymous-chat API promise stands —
// src/chatlog.js), but the ghost UI now points at the real thing. Always
// visible, never locked.

const ghostBtn = document.getElementById("ghostbtn");

function syncGhostState() {
  ghostBtn.hidden = false;
  ghostBtn.disabled = false;
  ghostBtn.title =
    "Ghost mode — DeepResearch.Se/cure: the khaki client-side twin where this server never sees your chats (your own API keys, browser-local storage)";
}

ghostBtn.addEventListener("click", () => {
  // In the installed PWA the webview's status-bar tint is pinned at
  // launch — iOS ignores the destination page's theme-color on in-app
  // navigation (on-device-trace skill, 2026-07-10: the khaki /cure under
  // a still-blue bar). Ghost mode therefore opens in its OWN browsing
  // context from a standalone app; plain navigation everywhere else.
  const standalone =
    /** @type {any} */ (navigator).standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
  if (standalone) window.open("/cure", "_blank");
  else location.assign("/cure");
});
syncGhostState();

// ---- Copy conversation ------------------------------------------------------
// Directly below the account button: copies the whole on-screen conversation
// as plain text — "User: …" / "Assistant: …" turns, with images and appended
// context blocks (documents, project materials) reduced to one-line
// references (stream.js's conversationAsText). Visible only once there is a
// conversation to copy; the icon flips to a checkmark briefly as the
// confirmation (a title attribute alone is invisible on touch devices).

const copyBtn = document.getElementById("copybtn");
const COPY_ICON = copyBtn.innerHTML;
const COPIED_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
let copiedTimer = 0;

function syncCopyState() {
  copyBtn.hidden = !conversationStarted();
}

copyBtn.addEventListener("click", async () => {
  const text = conversationAsText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The async clipboard API can be missing or denied (older webviews) —
    // fall back to the legacy selection path so the button still works.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* nothing left to try */ }
    ta.remove();
  }
  copyBtn.innerHTML = COPIED_ICON;
  copyBtn.classList.add("copied");
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.classList.remove("copied");
  }, 1500);
});
syncCopyState();

// ---- Header: clear chat / chat history / projects ---------------------------

// The header's "New chat" leaves any project context (a plain chat);
// "New chat in project" (projects-ui.js) passes keepProject so the fresh
// conversation adopts the project it was started from.
function newChat(keepProject = false) {
  if (keepProject !== true) setActiveProject(null);
  clearHistory(); // also resets the (API-level) incognito flag
  clearChatDom();
  syncCopyState();
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
  syncCopyState(); // …and the loaded conversation is copyable
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

// The composer's send/stop button toggle. Defined HERE — before the
// pending-answer resume below can call it — because setSendMode reads the
// icon consts; a `const` used before its initializer is a temporal-dead-zone
// crash, and readPending() being true at load would otherwise throw
// "Cannot access 'STOP_ICON' before initialization" and abort the whole
// bootstrap (no handlers attach, the page is dead). While a response streams,
// the same button switches from send (arrow) to stop (square) — never
// disabled, so it stays clickable to interrupt generation. stream.js keeps
// whatever streamed so far as normal context, so the composer is immediately
// ready for a follow-up.
const SEND_ICON = send.innerHTML;
const STOP_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
function setSendMode(streaming) {
  send.innerHTML = streaming ? STOP_ICON : SEND_ICON;
  send.classList.toggle("stop", streaming);
  send.setAttribute("aria-label", streaming ? "Stop generating" : "Send");
  send.title = streaming ? "Stop generating" : "Send";
}

// Resume-across-relaunch: if a previous session kicked off research and was
// discarded (a backgrounded PWA iOS reclaimed) before the answer arrived,
// reopen that conversation and poll the server-parked answer back. The
// research finished on the server regardless (src/chat.js's ctx.waitUntil);
// this collects it. Fire-and-forget and fail-soft — never blocks boot. The
// button reflects the streaming state so a tap Stops rather than sends,
// resetting whatever the outcome.
if (readPending()) setSendMode(true);
resumePendingAnswer({ onLoad: applyRecordSettings })
  .catch(() => {})
  .finally(() => setSendMode(false));

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

// Pre-warm the execution sandbox the moment the composer is focused (knob on +
// isolated + no attachments/project/dev-mode → a bare boot). The ~25s CheerpX
// cold start then elapses while the user types, so a shell ask answers without
// the wait. Strictly best-effort and idempotent (see prewarmSandbox).
input.addEventListener("focus", prewarmSandbox);

// Introspection mode's mascot (developer mode): as soon as what the user is
// TYPING reads as an ask about this site's own implementation, TIN — the
// titanium robot — slides in with the answer-route picker, so the private
// (own-key, browser-direct) choice can be made BEFORE the question is sent.
// Debounced; a no-op with the knob off. See public/js/introspect-ui.js.
initIntrospectUi({ tier: "drs" });
let introspectTypeTimer = 0;
input.addEventListener("input", () => {
  clearTimeout(introspectTypeTimer);
  introspectTypeTimer = setTimeout(() => {
    if (developerModeOn()) noteIntrospectionText(input.value);
  }, 350);
});

// The image deck's per-image chat panel (imagedeck.js): asking there
// anchors the next message at that image's position (the map_view anchor —
// activity.js setMapViewAnchor) and then goes through the ordinary composer
// path, so quotas, attachments state, streaming controls and history all
// behave exactly like a typed message. (The deck's mini-map needs no key —
// it uses the keyless maps embed; see imagedeck.js keylessMapEmbedUrl.)
onDeckAsk((text, point) => {
  // A PHOTO image anchors as a POV (position + heading — the server's POV
  // path reproduces exactly that frame and renders a fresh Street View
  // there as the new current location); a MAP image anchors as a map view.
  if (point) (point.kind === "map" ? setMapViewAnchor : setPovAnchor)(point);
  input.value = text;
  form.requestSubmit();
});

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
  syncCopyState();
  input.focus();
});

// Enter inserts a line break — nothing is sent until the arrow is tapped
// (form submit). The input just grows via the autogrow handler above.

// CSS<->JS freshness handshake (the counterpart of app.css's
// --css-version): the boot guard walks and repairs the JS MODULE graph,
// but a device that heuristically cached the STYLESHEET before the
// no-cache asset policy keeps rendering with stale rules forever — on
// 2026-07-08 that made history rows invisible on a real iPhone while
// every module was current. If the marker doesn't match, fetch the
// stylesheet with cache:"reload" (bypasses AND overwrites the cached
// entry) and swap the link so the fresh rules apply without a reload.
const CSS_VERSION = "h32";
try {
  const seen = getComputedStyle(document.documentElement).getPropertyValue("--css-version").trim();
  if (seen !== CSS_VERSION) {
    fetch("/css/app.css", { cache: "reload" })
      .then(() => {
        const link = document.querySelector('link[rel="stylesheet"][href*="app.css"]');
        if (link) link.href = "/css/app.css?v=" + CSS_VERSION;
      })
      .catch(() => {});
  }
} catch {
  // never let the freshness probe break boot
}

// Boot completed: every module linked and every handler above is attached.
// index.html's inline boot guard blocks native form submits until this flag
// exists (see the guard's comment for the stale-module incident it covers).
window.__appReady = true;

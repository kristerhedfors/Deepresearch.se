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
import { balloonReset, initBalloonGuide } from "./balloon.js";
import { refreshProjects, setActiveProject } from "./projects.js";
import { initProjectsUi } from "./projects-ui.js";
import { bashLiteOn, developerModeOn, loadSettings } from "./settings.js";
import { applyDeveloperTheme, cachedDeveloperMode } from "./dev-mode.js";
import { cachedSandboxMode, clearIsolationGuard, isolateForSandbox, storeSandboxMode } from "./sandbox-mode.js";
import { setSandboxImage } from "./sandbox.js";
import { hideTerminalIcon, showTerminalIcon } from "./agent-backdrop.js";
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
import { BUDGET_MAX_S, BUDGET_MIN_S, budgetTier, fmtBudget, posToSeconds, secondsToPos } from "./timescale.js";
import { applyFeedbackMode, clearChatDom, EMPTY_TEXT, initTurns } from "./turns.js";
import { initTestpoints } from "./testpoints.js";

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

// Execution-sandbox isolation self-heal — fired SYNCHRONOUSLY at first paint
// from the cached knob (sandbox-mode.js), BEFORE loadSettings() resolves. The
// sandbox needs the page cross-origin isolated (COEP), which the server only
// sends when the bash_lite knob is on; if a returning sandbox user's page
// loaded non-isolated (a bfcache/device-cached shell, or a tab opened before
// the knob was flipped), waiting for /api/settings to fire the reload left a
// window where a send silently fell back to a plain web answer with NO sandbox
// activity (observed live: chat_logs #306 — coi/sab/bl all false on the same
// build that worked once isolated). Firing from the local cache closes that
// window; if it navigates, the rest of boot is abandoned for the fresh load.
// A no-op for everyone who never enabled the sandbox (no cache → want=false).
// If it navigates, the current boot is abandoned for the fresh isolated load;
// otherwise clear the guard so a later loss of isolation can self-heal again.
if (!isolateForSandbox(cachedSandboxMode())) clearIsolationGuard();

// Reveal the header terminal icon at first paint from the cached knob, so a
// returning sandbox user sees the "Linux is starting" icon the instant they
// land — before /api/settings resolves (which then reconciles it below). The
// VM itself pre-warms from loadSettings once isolation is confirmed.
if (cachedSandboxMode()) showTerminalIcon();

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
// The Se/rver balloon guide (F-16): the blue tier's symbol character —
// the ghost's counterpart — hovering among clouds above the composer. Pure
// decoration (fail-soft, pointer-events:none); it flares + climbs on every
// completed task (stream.js's done event) and swishes through clouds on all
// its transitions.
initBalloonGuide();
initModels(document.getElementById("model"), { onChange: syncAttachState });
initAttachments(
  document.getElementById("attach"),
  document.getElementById("file"),
  document.getElementById("pending"),
  document.getElementById("camera"),
  document.getElementById("camerafile"),
);
const account = initAccountPanel();
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
    // Reconcile the local sandbox-knob cache with the server's authoritative
    // value (sandbox-mode.js), so the NEXT load's synchronous boot self-heal
    // above reflects a flip made on another device — and so a first-ever enable
    // on this device seeds the cache.
    const sandboxOn = s?.bash_lite_mcp === true;
    storeSandboxMode(sandboxOn);
    // The self-heal for the FIRST-EVER enable (no cache existed at boot, so the
    // synchronous pass above ran with want=false): now that the server confirms
    // the knob is on, navigate to the isolated shell. Same guarded, fresh-URL
    // navigation as the boot pass — deduped in isolateForSandbox.
    if (isolateForSandbox(sandboxOn)) return;
    clearIsolationGuard();
    // The knob is on and the page is isolated — boot the VM straight away so
    // "enabled" means the Linux system is already running (its terminal drifting
    // faintly behind the chat) the moment the app opens, not only once the user
    // focuses the composer. Same bare, best-effort, idempotent boot as the
    // composer-focus pre-warm (a later attachment/project is handled by
    // resetSandboxIfBare at send time).
    // Reconcile the header terminal icon with the authoritative knob: show it
    // (a cross-device enable that had no local cache at first paint) or hide a
    // stale-cache icon when the server says the sandbox is off.
    if (sandboxOn) { showTerminalIcon(); applySandboxImage().finally(prewarmSandbox); } else hideTerminalIcon();
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
  // A bfcache restore is a fresh chance to isolate, so reset the one-shot guard
  // first (resetGuard). Use the cache too, not just the live setting: a cold
  // restore may reach here before /api/settings has repopulated bashLiteOn().
  if (e.persisted) isolateForSandbox(cachedSandboxMode() || bashLiteOn(), { resetGuard: true });
});

// ---- Research time-target slider ----------------------------------------
// Persisted as seconds; sent as time_budget_s with each request (the server
// plans the spend — src/budget.js). Position mapping in timescale.js. The
// readout stacks the time over the report tier it buys (budgetTier — the
// slider also scales the answer's comprehensiveness, brief → full report).

const budgetSlider = document.getElementById("budget");
const budgetVal = document.getElementById("budgetval");
const budgetTime = document.getElementById("budgettime");
const budgetTierEl = document.getElementById("budgettier");
let budgetS = 60;
const savedBudget = parseInt(localStorage.getItem("budget_s"), 10);
if (savedBudget >= BUDGET_MIN_S && savedBudget <= BUDGET_MAX_S) budgetS = savedBudget;
budgetSlider.value = secondsToPos(budgetS);
const updateBudgetVal = () => {
  const tier = budgetTier(budgetS);
  budgetTime.textContent = fmtBudget(budgetS);
  budgetTierEl.textContent = tier.label;
  budgetVal.title = "Research time target · " + tier.desc;
};
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

// Open /cure, in a fresh browsing context for the installed PWA (iOS pins the
// launch status-bar tint on in-app navigation — the khaki /cure under a still-
// blue bar; on-device-trace skill 2026-07-10), plain navigation elsewhere.
function goToCure(path) {
  const standalone =
    /** @type {any} */ (navigator).standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
  if (standalone) window.open(path, "_blank");
  else location.assign(path);
}

ghostBtn.addEventListener("click", async () => {
  // Crossing to Se/cure signed-in now hands over a whole SECURE RESEARCH SPACE:
  // a bundle of temporary, account-connected proxy grants (web search + LLM API)
  // minted for this signed-in account (src/proxy.js). We mint it here so the
  // encrypted bundle can ride the navigation URL — ciphertext in the query
  // (?rp=), decryption key in the ANCHOR (#rk=, never sent to the server). The
  // /cure page opens it, exchanges the grant tokens, and connects the APIs.
  ghostBtn.disabled = true;
  try {
    const res = await fetch("/api/proxy/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (res.ok) {
      const b = await res.json(); // { blob, key, connected }
      if (b && b.blob && b.key) {
        goToCure("/cure?rp=" + encodeURIComponent(b.blob) + "#rk=" + encodeURIComponent(b.key));
        return;
      }
    }
  } catch {
    // offline / grants unavailable — fall through to a plain crossover
  } finally {
    ghostBtn.disabled = false;
  }
  // Fallback: no bundle (feature off, no D1, or a network error). Preserve the
  // legacy web-search intent marker so the old grant path still fires, and
  // cross over plain. A plain visitor who never crossed never sets it.
  try {
    localStorage.setItem("dr_ws_grant_intent", "1");
  } catch {
    // storage blocked → /cure simply won't offer server web search; harmless
  }
  goToCure("/cure");
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
  balloonReset(); // the guide's pennant tail belongs to the conversation
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
  syncChatInset(); // the taller composer must not bury the reply's tail
};
input.addEventListener("input", autogrow);

// Keep the chat's bottom inset matched to the FIXED footer glass so the last
// lines of a reply always clear the composer pane. The footer's real footprint
// (composer height — which GROWS as the textarea autosizes — plus margins and
// the iPhone safe-area inset) exceeds the old fixed 8rem, which left the tail
// of a slightly-over-one-page reply buried behind the glass, reachable only by
// an iOS rubber-band drag that snapped back on release. Measuring from the
// composer's top edge to the viewport bottom captures that footprint exactly,
// regardless of safe-area or margin collapsing; +14px is a small breathing
// gap. Fail-soft; the CSS 8rem (var --chat-pad-bottom fallback) still applies.
function syncChatInset() {
  try {
    const composer = document.getElementById("composer");
    if (!composer || !chat) return;
    const overlap = window.innerHeight - composer.getBoundingClientRect().top;
    if (overlap > 0) chat.style.setProperty("--chat-pad-bottom", Math.round(overlap + 14) + "px");
  } catch {
    /* best-effort — the CSS fallback still applies */
  }
}
if (window.ResizeObserver) {
  try {
    new ResizeObserver(syncChatInset).observe(document.getElementById("composer"));
  } catch {
    /* no ResizeObserver — the resize/orientation listeners still fire */
  }
}
window.addEventListener("resize", syncChatInset);
window.addEventListener("orientationchange", syncChatInset);
syncChatInset();

// The self-hosted Linux sandbox image (docs/SANDBOX-LOCAL-IMAGE.md): fetch the
// admin's selection once and point sandbox.js at it BEFORE any boot. Empty ⇒ the
// built-in streamed default (current behavior), so this is inert until an image
// is uploaded and selected. Fully fail-soft — any error leaves the default.
let _sandboxImageApplied = null;
function applySandboxImage() {
  if (_sandboxImageApplied) return _sandboxImageApplied;
  _sandboxImageApplied = fetch("/api/sandbox-image")
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg && typeof cfg.url === "string") setSandboxImage(cfg.url, !!cfg.prefetch); })
    .catch(() => {});
  return _sandboxImageApplied;
}
// Kick it at module init too so the composer-focus pre-warm (below) can pick it
// up even before settings resolve.
applySandboxImage();

// Pre-warm the execution sandbox the moment the composer is focused (knob on +
// isolated + no attachments/project/dev-mode → a bare boot). The ~25s CheerpX
// cold start then elapses while the user types, so a shell ask answers without
// the wait. Strictly best-effort and idempotent (see prewarmSandbox).
input.addEventListener("focus", () => applySandboxImage().finally(prewarmSandbox));

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
const CSS_VERSION = "h38";
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

// The Se/rver first-visit LANDING intro (F-16, owner directive 2026-07-15):
// the blue tier's counterpart of /cure's umbrella intro — the logo vortex
// untwists into WIRE BALLOONS, the camera drops a full 180° (rolling
// sideways, clouds swishing past) and ends looking up from underneath at the
// five-balloon fleet as color floods back (public/js/balloon-intro.js).
// Gated exactly like /cure's: plays ONCE per browser (marked seen only after
// it actually ran), never under prefers-reduced-motion, never over a /try
// deep link — and `?anim=1` (or `?anim=rev` for the reverse play) forces it
// through every gate as the explicit replay/verification path. The admin
// /api/anim speed multiplier is fetched time-boxed (~900 ms) so a slow server
// only ever costs the default speed. Entirely fail-soft: any import, fetch,
// or play failure leaves the app exactly as it was (dynamic import so boot
// pays nothing for it on every later visit).
(() => {
  try {
    const rev = /[?&]anim=rev\b/.test(location.search);
    const force = rev || /[?&]anim=1\b/.test(location.search);
    const SEEN_KEY = "dr_rver_intro_seen";
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // storage blocked — treat as unseen; the flag below just won't stick
    }
    let reduced = false;
    try {
      reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      // no matchMedia — animate
    }
    const deepLinked = /[?&]try=/.test(location.search);
    if (!force && (reduced || seen || deepLinked)) return;
    const speedFetch = Promise.race([
      fetch("/api/anim")
        .then((r) => r.json())
        .then((j) => Number(j?.speed) || 1),
      new Promise((res) => setTimeout(() => res(1), 900)),
    ]).catch(() => 1);
    Promise.all([import("./balloon-intro.js"), speedFetch])
      .then(([m, speed]) =>
        m.playBalloonIntro({
          speed,
          reverse: rev ? true : undefined,
          onDone: () => {
            // Seen only once it actually RAN (the /cure discipline): a failed
            // module load keeps the flag unset so the one first-visit play
            // isn't burned on a broken attempt.
            try {
              localStorage.setItem(SEEN_KEY, "1");
            } catch {}
          },
        })
      )
      .catch(() => {});
  } catch {
    // decoration — never let it near the boot path
  }
})();

// Testable interaction points (public/js/testpoints.js): the try-it queue.
// On landing with ?try=<id> (a shared /try link) this opens the banner and
// runs the point's declared ACTIONS to set the scene; the header launcher
// opens the queue. Admin-only end to end — the fetches 403 for everyone
// else, so nothing renders. The hooks are the app-specific side effects an
// action triggers, so testpoints.js never reaches into this file's internals.
initTestpoints({
  hooks: {
    openAccountView: (view) => account.open(view),
    // The left drawer holds both chat history and the projects list.
    openHistory: () => document.getElementById("historybtn")?.click(),
    openProjects: () => document.getElementById("historybtn")?.click(),
    newChat: () => newChat(),
    compose: (text, sendNow) => {
      input.value = text;
      autogrow();
      if (sendNow) form.requestSubmit();
      else input.focus();
    },
    setSearch: (on) => {
      webSearchBox.checked = !!on;
      localStorage.setItem("web_search", on ? "on" : "off");
      syncSearchToggle();
    },
    setBudget: (sec) => {
      if (!Number.isFinite(sec)) return;
      budgetS = Math.min(Math.max(sec, BUDGET_MIN_S), BUDGET_MAX_S);
      budgetSlider.value = secondsToPos(budgetS);
      updateBudgetVal();
      localStorage.setItem("budget_s", String(budgetS));
    },
    selectModel: (m) => selectModel(m),
  },
});

// Boot completed: every module linked and every handler above is attached.
// index.html's inline boot guard blocks native form submits until this flag
// exists (see the guard's comment for the stale-module incident it covers).
window.__appReady = true;

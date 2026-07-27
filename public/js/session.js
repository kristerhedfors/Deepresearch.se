// @ts-check
// The SESSION the current tab is attached to — browser glue over the pure
// registry in session-core.js (which carries the full design note: a session is
// an agent, a workspace and a history; a tab merely attaches to one).
//
// This module owns three things the core deliberately cannot:
//   1. the two stores — localStorage `dr_sessions` (durable, shared) and
//      sessionStorage `dr_session_tab` (this tab's attachment),
//   2. the heartbeat that keeps this tab's lease alive,
//   3. the module-level "which session am I" that every other client module
//      reads instead of reaching for a browser-global key.
//
// CONCURRENT WRITES. Several tabs share one localStorage registry and there is
// no lock, so every mutator here is READ-MODIFY-WRITE over the live stored
// value and only ever patches THIS tab's own record. Two tabs writing at the
// same instant can still lose one patch (whole-value last-writer-wins), which is
// acceptable precisely because no tab ever writes another's record: the worst
// case is one missed heartbeat, and the next beat 5s later repairs it. Do NOT
// "optimize" this by caching the parsed registry across calls — that is how a
// tab would start clobbering its siblings.
//
// Everything is fail-soft. Storage can be unavailable (private mode, blocked
// cookies, quota) and a session must still work for the life of the page, so a
// failed read yields an empty registry and a failed write is dropped: the tab
// keeps its in-memory session id, which is enough for isolation — only the
// durability (surviving a reload, or a cold relaunch collecting an answer) is
// lost. Import-safe in Node: every browser global is guarded.

import {
  HEARTBEAT_MS,
  SESSION_ATTACH_KEY,
  SESSION_REGISTRY_KEY,
  attachDecision,
  blankSession,
  claimSession,
  dropSession,
  emptyRegistry,
  getSession,
  heartbeat as beat,
  listSessions,
  newSessionId,
  newTabId,
  normalizeConfig,
  normalizePending,
  parseAttachment,
  parseRegistry,
  pruneRegistry,
  putSession,
  releaseSession,
  resumeTarget,
  serializeAttachment,
  serializeRegistry,
  touchSession,
} from "./session-core.js";

export { HEARTBEAT_MS };

/** This tab's id — minted on first use, then stable for the life of the tab. */
let tabId = "";
/** The session this tab is attached to. */
let sid = "";
/** @type {number | null} */
let beatTimer = null;

// ---- the two stores ----------------------------------------------------------

/** @returns {Storage | null} */
function ls() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // storage blocked
  }
}

/** @returns {Storage | null} */
function ss() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function now() {
  return Date.now();
}

/**
 * The live registry, re-read every time (see the concurrency note above).
 * @returns {import('./session-core.js').SessionRegistry}
 */
export function readRegistry() {
  try {
    return parseRegistry(ls()?.getItem(SESSION_REGISTRY_KEY));
  } catch {
    return emptyRegistry();
  }
}

/** @param {import('./session-core.js').SessionRegistry} reg */
function writeRegistry(reg) {
  try {
    ls()?.setItem(SESSION_REGISTRY_KEY, serializeRegistry(reg));
  } catch {
    /* quota or blocked storage — this tab keeps working from memory */
  }
}

/**
 * Read-modify-write the registry through a patch function.
 * @param {(reg: import('./session-core.js').SessionRegistry) => import('./session-core.js').SessionRegistry} fn
 */
function updateRegistry(fn) {
  try {
    writeRegistry(fn(readRegistry()));
  } catch {
    /* never let registry bookkeeping break a send or a boot */
  }
}

function persistAttachment() {
  try {
    ss()?.setItem(SESSION_ATTACH_KEY, serializeAttachment({ tabId, sid }));
  } catch {
    /* the in-memory ids still isolate this tab for the life of the page */
  }
}

// ---- identity ----------------------------------------------------------------

/** This tab's id (stable for the tab's life). @returns {string} */
export function currentTabId() {
  if (!tabId) tabId = newTabId(now());
  return tabId;
}

/**
 * The session this tab is attached to. Non-empty after initSession; before that
 * it mints one on demand so a module that asks early (or a unit test) still gets
 * a stable id rather than "".
 * @returns {string}
 */
export function currentSessionId() {
  if (!sid) sid = newSessionId(now());
  return sid;
}

/** This tab's session record, or null if storage lost it. */
export function currentSession() {
  return getSession(readRegistry(), currentSessionId());
}

// ---- boot --------------------------------------------------------------------

/**
 * Resolve which session this tab owns, and start its lease.
 *
 * Returns the boot decision so app.js can act on it:
 *   `fresh`    — a brand-new session (a new tab, per the owner's rule that a new
 *                tab is always a new session; also a first-ever visit).
 *   `resumed`  — this tab reattached to the session it had before a reload.
 *   `held`     — the session this tab was on is open in ANOTHER live tab. A
 *                fresh session is created and attached so the tab is usable
 *                immediately, and `heldSid` names the other one so the UI can
 *                offer "take over there" (the owner's choice-not-silent-share
 *                rule). This is the duplicate-tab case.
 *
 * @param {{agent: string, config?: unknown}} opts the seed for a new session —
 *   the account's stored chat mode and last-used send settings.
 * @returns {{sid: string, status: "fresh" | "resumed" | "held", heldSid: string | null, record: import('./session-core.js').SessionRecord | null}}
 */
export function initSession({ agent, config }) {
  const att = parseAttachment(ss()?.getItem(SESSION_ATTACH_KEY));
  tabId = att.tabId || newTabId(now());
  const t = now();
  const decision = attachDecision({ reg: readRegistry(), sid: att.sid, tabId, now: t });

  /** @type {"fresh" | "resumed" | "held"} */
  let status;
  /** @type {string | null} */
  let heldSid = null;

  if (decision.action === "attach" && att.sid) {
    sid = att.sid;
    status = "resumed";
  } else {
    if (decision.action === "held") heldSid = att.sid || null;
    sid = newSessionId(t);
    status = decision.action === "held" ? "held" : "fresh";
    updateRegistry((reg) =>
      pruneRegistry(
        claimSession(putSession(reg, blankSession({ sid, agent, config, now: t })), sid, tabId, t),
        t,
      ),
    );
  }
  persistAttachment();
  if (status === "resumed") updateRegistry((reg) => claimSession(reg, sid, tabId, t));
  startHeartbeat();
  return { sid, status, heldSid, record: currentSession() };
}

/**
 * Start a brand-new session in this tab, abandoning (but not deleting) whatever
 * it was attached to. This is "open as a new session" on the duplicate-tab
 * prompt, and the natural home for a future "new session" control.
 * @param {{agent: string, config?: unknown}} opts
 * @returns {string} the new session id
 */
export function startNewSession({ agent, config }) {
  const t = now();
  const previous = sid;
  sid = newSessionId(t);
  updateRegistry((reg) => {
    // Release the old lease so the session we walked away from is reusable
    // straight away rather than waiting out its stale window.
    const freed = previous ? releaseSession(reg, previous, tabId, t) : reg;
    return pruneRegistry(
      claimSession(putSession(freed, blankSession({ sid, agent, config, now: t })), sid, tabId, t),
      t,
    );
  });
  persistAttachment();
  startHeartbeat();
  return sid;
}

/**
 * Take a session over from a tab that is (or was) holding it — the other half of
 * the duplicate-tab prompt. The previous holder's next heartbeat refuses to
 * steal it back (session-core `heartbeat`), so the lease stays single-writer.
 * @param {string} target
 * @returns {boolean} false if the session no longer exists
 */
export function takeOverSession(target) {
  const t = now();
  if (!getSession(readRegistry(), target)) return false;
  const previous = sid;
  sid = target;
  updateRegistry((reg) => {
    const freed = previous && previous !== target ? releaseSession(reg, previous, tabId, t) : reg;
    return claimSession(freed, target, tabId, t);
  });
  persistAttachment();
  startHeartbeat();
  return true;
}

/**
 * Give up this tab's lease — called on pagehide so a closed tab's session is
 * immediately reusable instead of waiting out LEASE_STALE_MS. Best-effort: the
 * stale window is the real guarantee (a crashed tab releases nothing).
 *
 * EXCEPT WHILE RESEARCH IS IN FLIGHT. pagehide fires when a tab is merely
 * backgrounded, not only when it closes, so releasing unconditionally would hand
 * a RUNNING session to the next tab that opens — which is precisely the bug this
 * whole change removes, arriving through a side door. A busy session keeps its
 * claim and lets the stale window decide, so an answer is adopted only once the
 * holder has really stopped beating.
 *
 * The honest limit: if the OS freezes a live backgrounded tab's timers for longer
 * than LEASE_STALE_MS, its session looks orphaned and a sibling may adopt the
 * answer. That is inherent to a heartbeat, and it is the safe direction — on iOS
 * a tab held frozen that long with an in-flight request is usually being
 * discarded, which is exactly the case the adoption exists for. A resumed tab
 * beats immediately on visibilitychange (app.js) to keep the window short.
 */
export function detachSession() {
  stopHeartbeat();
  if (!sid) return;
  const t = now();
  if (normalizePending(currentSession()?.pending, t)) return; // research in flight — stay claimed
  updateRegistry((reg) => releaseSession(reg, sid, tabId, t));
}

/**
 * Forget a session outright (its workspace and lease). Used when a session's
 * conversation is deleted, or to clean up after "take over" left an empty one.
 * @param {string} target
 */
export function forgetSession(target) {
  if (!target || target === sid) return; // never delete the one we're using
  updateRegistry((reg) => dropSession(reg, target));
}

// ---- the lease ---------------------------------------------------------------

function startHeartbeat() {
  stopHeartbeat();
  try {
    // Beat once immediately so a session is held from the moment it exists,
    // then on the interval. An unref'd timer would be wrong here (the page owns
    // it); it is cleared by detachSession on pagehide.
    beatTimer = /** @type {any} */ (setInterval(() => heartbeatNow(), HEARTBEAT_MS));
  } catch {
    /* no timers (tests) — the lease simply never refreshes */
  }
  heartbeatNow();
}

function stopHeartbeat() {
  try {
    if (beatTimer !== null) clearInterval(beatTimer);
  } catch {
    /* nothing to do */
  }
  beatTimer = null;
}

/** Refresh this tab's lease now (also useful on visibilitychange/pageshow). */
export function heartbeatNow() {
  if (!sid) return;
  const t = now();
  updateRegistry((reg) => beat(reg, sid, tabId, t));
}

/**
 * Whether this tab still holds its session, i.e. nobody took it over. The send
 * path can use this to avoid two tabs driving one workspace.
 * @returns {boolean}
 */
export function holdsSession() {
  const rec = currentSession();
  return !!rec && rec.heldBy === tabId;
}

// ---- the session's own state -------------------------------------------------
// Each of these replaces a browser-global localStorage key that every tab used
// to share. `agent` was `dr_chat_mode`; the config fields were `model`,
// `budget_s` and `web_search`; `pending` was the single `dr_pending_answer` slot.

/** The agent (chat mode) answering in this session. @returns {string} */
export function sessionAgent() {
  return currentSession()?.agent || "";
}

/** @param {string} agent */
export function setSessionAgent(agent) {
  const t = now();
  updateRegistry((reg) => touchSession(reg, currentSessionId(), { agent }, t));
}

/** This session's send settings. @returns {import('./session-core.js').SessionConfig} */
export function sessionConfig() {
  return normalizeConfig(currentSession()?.config);
}

/** @param {Partial<import('./session-core.js').SessionConfig>} patch */
export function setSessionConfig(patch) {
  const t = now();
  updateRegistry((reg) => {
    const rec = getSession(reg, currentSessionId());
    if (!rec) return reg;
    return touchSession(reg, rec.sid, { config: normalizeConfig({ ...rec.config, ...patch }) }, t);
  });
}

/** The conversation this session is on. @returns {string | null} */
export function sessionConvId() {
  return currentSession()?.convId || null;
}

/** @param {string | null} convId */
export function setSessionConvId(convId) {
  const t = now();
  updateRegistry((reg) => touchSession(reg, currentSessionId(), { convId: convId || null }, t));
}

/** @param {import('./session-core.js').PendingPointer | null} pending */
export function setSessionPending(pending) {
  const t = now();
  updateRegistry((reg) => touchSession(reg, currentSessionId(), { pending }, t));
}

/**
 * The in-flight answer THIS boot may collect — session-core's resumeTarget,
 * which is what stops a new tab adopting another tab's research while still
 * letting a cold relaunch collect an answer that finished while the app was
 * gone. Attaches to the returned session so the resume runs in the right place.
 * @returns {{sid: string, pending: import('./session-core.js').PendingPointer} | null}
 */
export function claimResumeTarget() {
  const t = now();
  const target = resumeTarget({ reg: readRegistry(), sid, tabId, now: t });
  if (!target) return null;
  if (target.sid !== sid) {
    // A cold relaunch adopting an orphan: move this tab onto that session so its
    // agent, workspace and history all follow the answer we're collecting.
    sid = target.sid;
    persistAttachment();
    updateRegistry((reg) => claimSession(reg, sid, tabId, t));
  }
  return target;
}

/**
 * Every session in this browser, newest first, for the sidebar's live-session
 * list. Metadata only (see session-core listSessions).
 * @returns {ReturnType<typeof listSessions>}
 */
export function liveSessions() {
  return listSessions(readRegistry(), now());
}

/**
 * Test seam: reset the module's in-memory identity so a unit test can simulate a
 * fresh tab. Never called by the app.
 */
export function __resetSessionState() {
  stopHeartbeat();
  tabId = "";
  sid = "";
}

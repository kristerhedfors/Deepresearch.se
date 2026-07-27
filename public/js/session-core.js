// @ts-check
// The SESSION registry — the pure core behind multi-tab isolation.
//
// A SESSION is the unit this app actually works in (owner directive,
// 2026-07-27): **an agent, a workspace and a history**, bound together and
// addressed by one id.
//
//   agent      — the chat mode that answers (chat-mode-core.js)
//   workspace  — the execution environment: the browser VM's overlay, or the
//                container `session` in src/exec-container.js (already
//                one-container-per-session, disk thrown away with it)
//   history    — the conversation record this session is on (history-store.js)
//
// A TAB is not a session. A tab ATTACHES to one, and an arbitrary number of
// sessions may exist at once — which is the point: several agents working in
// parallel, and eventually background agents with no tab attached at all.
//
// WHAT THIS FIXES. Before this module every one of those three things was
// browser-global, so a second tab silently joined the first tab's work:
// `dr_pending_answer` was a SINGLE slot, so a new tab booted straight into
// another tab's in-flight research (app.js read it, showed Stop, and polled
// somebody else's answer back); the chat mode was one per account, so opening a
// tab could land you in a different agent than the one you left; and both tabs
// then persisted the same conversation id, last writer winning in IndexedDB and
// in the R2 mirror. Reported by the owner, 2026-07-27.
//
// WHERE THE STATE LIVES — the split is the whole design:
//
//   localStorage `dr_sessions`     the REGISTRY. Durable, shared by every tab.
//                                  One record per session. Survives a cold
//                                  relaunch, which is what makes the iOS
//                                  resume below still work.
//   sessionStorage `dr_session_tab` the ATTACHMENT: {tabId, sid} — which
//                                  session THIS tab is looking at. Per-tab by
//                                  construction, so two tabs cannot read each
//                                  other's. Same precedent as exec-env.js's
//                                  execSessionId (and the COEP one-shot guard).
//
// THE LEASE. An attached tab heartbeats `heldAt` into its record. A session is
// "held" while that beat is fresh (LEASE_STALE_MS); once it goes quiet the
// session is ORPHANED — its tab was closed, or the PWA was discarded. Liveness
// is a timestamp comparison, never a promise, so a tab that dies without
// releasing anything still frees its session.
//
// THE iOS RECLAIM RULE (the subtle part — see resumeTarget). pending-answer.js
// was deliberately localStorage because sessionStorage does NOT survive an iOS
// PWA discard + cold relaunch, and collecting a finished answer after exactly
// that is the feature's whole reason to exist. Moving the pointer per-tab would
// have fixed multi-tab by breaking it. So the pointer stays DURABLE (in the
// session record) and the *adoption* is what gets a rule: a boot with no tab
// attachment may adopt an orphaned session's pending answer ONLY when no
// session is currently held — i.e. this tab is the only one alive, so the app
// is coming back, not being opened a second time. A second tab always finds a
// live lease and always gets a fresh session instead.
//
// PRIVACY (invariant 4). A record is METADATA ONLY, exactly like the pointer it
// absorbed: ids, the agent name, the send settings, timestamps. NEVER message
// text, never a title, never a filename — those stay in the encrypted history
// record. So nothing readable at rest is added by making sessions first-class.
//
// Pure core (the chat-mode-core.js / bash-core.js pattern): no DOM, no storage,
// no clock, no imports. Every function takes the registry and `now` and returns
// a new value, so all of it is unit-tested in Node and the browser glue
// (session.js) stays a thin wrapper.

/** Registry schema version — bumped only for a shape change that can't be read. */
export const SESSION_SCHEMA_V = 1;

/** localStorage key holding the durable registry (shared by every tab). */
export const SESSION_REGISTRY_KEY = "dr_sessions";

/** sessionStorage key holding THIS tab's {tabId, sid} attachment. */
export const SESSION_ATTACH_KEY = "dr_session_tab";

/**
 * How long a session stays "held" after its holder's last heartbeat. 20s = 4
 * missed beats at HEARTBEAT_MS, the same shape of reasoning as
 * src/answers.js RUNNING_STALE_MS: long enough that a busy main thread (a VM
 * boot, a big render) is never mistaken for a dead tab, short enough that a
 * closed tab's session is reusable before the user notices.
 */
export const LEASE_STALE_MS = 20 * 1000;

/** How often an attached tab refreshes its lease. */
export const HEARTBEAT_MS = 5 * 1000;

/** Matches src/answers.js ANSWER_TTL_MS — past it the parked answer is purged. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * Registry cap. "An arbitrary number of sessions" is the product goal, but
 * localStorage is ~5MB shared with everything else, so the STORE is bounded
 * while the live set is not: pruneRegistry evicts the least recently used
 * sessions that nothing is holding and nothing is waiting on. A user with 24
 * live sessions has other problems.
 */
export const MAX_SESSIONS = 24;

/** An unheld session with no pending answer is forgotten after this long. */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * A session's send settings — the knobs that used to be browser-global
 * localStorage (`model`, `budget_s`, `web_search`) and so were retuned in every
 * tab whenever one tab loaded a conversation (app.js applyRecordSettings).
 * @typedef {{model: string, budgetS: number | null, webSearch: boolean}} SessionConfig
 */

/**
 * The resume pointer for an in-flight answer. Metadata only (see the privacy
 * note above); absorbed from pending-answer.js, which now reads it from here.
 * @typedef {{convId: string, requestId: string, startedAt: number, model?: string, budgetS?: number | null, webSearch?: boolean}} PendingPointer
 */

/**
 * One session: an agent, a workspace and a history.
 * @typedef {object} SessionRecord
 * @property {string} sid          the session id (also the workspace id)
 * @property {string} agent        the chat mode answering in this session
 * @property {string | null} convId the conversation this session is on
 * @property {SessionConfig} config the send settings
 * @property {PendingPointer | null} pending an in-flight answer to collect
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string | null} heldBy the tab id currently attached
 * @property {number} heldAt        that tab's last heartbeat
 */

/**
 * @typedef {{v: number, sessions: Record<string, SessionRecord>}} SessionRegistry
 */

/**
 * Mint a session id. Deliberately inside `[A-Za-z0-9._-]{1,64}` so it can be
 * handed to the server VERBATIM as the exec-container session
 * (src/exec-container.js sanitizeSession) — one id names the agent, the
 * workspace and the history, which is the whole point of the model. Same shape
 * as exec-backends-core.js newExecSession.
 * @param {number} now epoch ms
 * @param {() => number} [rand] injected for tests
 * @returns {string}
 */
export function newSessionId(now, rand = Math.random) {
  return "s-" + Math.floor(now).toString(36) + "-" + rand().toString(36).slice(2, 8);
}

/**
 * Mint a tab id. Only ever compared for equality, never sent anywhere.
 * @param {number} now epoch ms
 * @param {() => number} [rand]
 * @returns {string}
 */
export function newTabId(now, rand = Math.random) {
  return "t-" + Math.floor(now).toString(36) + "-" + rand().toString(36).slice(2, 8);
}

/** @param {unknown} v @returns {boolean} */
function isStr(v) {
  return typeof v === "string" && v !== "";
}

/**
 * Clamp any value to a session config. Unknown/missing fields take the app's
 * own defaults rather than throwing — a malformed record must degrade, never
 * break a boot (invariant 2's spirit, applied to storage).
 * @param {unknown} raw
 * @returns {SessionConfig}
 */
export function normalizeConfig(raw) {
  const o = raw && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  const budget = typeof o.budgetS === "number" && Number.isFinite(o.budgetS) ? o.budgetS : null;
  return {
    model: typeof o.model === "string" ? o.model : "",
    budgetS: budget,
    webSearch: o.webSearch !== false,
  };
}

/**
 * Validate a raw pending pointer and check it against the recovery window.
 * Returns null when absent, malformed, or older than the TTL — past which
 * src/answers.js has already purged the parked answer, so resuming could only
 * 404. This is pending-answer.js's original parsePending, moved here so the
 * registry and the pointer cannot disagree about freshness.
 * @param {unknown} raw
 * @param {number} now epoch ms
 * @param {number} [ttlMs]
 * @returns {PendingPointer | null}
 */
export function normalizePending(raw, now, ttlMs = PENDING_TTL_MS) {
  if (!raw || typeof raw !== "object") return null;
  const p = /** @type {any} */ (raw);
  if (!isStr(p.convId) || !isStr(p.requestId)) return null;
  if (typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt)) return null;
  if (now - p.startedAt >= ttlMs) return null; // past the recovery window
  return /** @type {PendingPointer} */ ({
    convId: p.convId,
    requestId: p.requestId,
    startedAt: p.startedAt,
    model: typeof p.model === "string" ? p.model : "",
    budgetS: typeof p.budgetS === "number" && Number.isFinite(p.budgetS) ? p.budgetS : null,
    webSearch: p.webSearch !== false,
  });
}

/**
 * A fresh session record. `agent` is the caller's business (a new tab seeds it
 * from the account default — chat-mode.js), not this module's.
 * @param {{sid: string, agent: string, config?: unknown, now: number}} opts
 * @returns {SessionRecord}
 */
export function blankSession({ sid, agent, config, now }) {
  return {
    sid,
    agent,
    convId: null,
    config: normalizeConfig(config),
    pending: null,
    createdAt: now,
    updatedAt: now,
    heldBy: null,
    heldAt: 0,
  };
}

/**
 * Clamp a stored record. Returns null when it has no usable id — a record
 * without one can never be addressed, so keeping it would only waste quota.
 * Note `pending` is NOT freshness-checked here: parsing must not depend on the
 * clock, so an expired pointer survives the read and is filtered at USE time
 * (freshPending / resumeTarget). That keeps parseRegistry a pure function of
 * its input, which is what makes it testable.
 * @param {unknown} raw
 * @returns {SessionRecord | null}
 */
export function normalizeSession(raw) {
  const o = raw && typeof raw === "object" ? /** @type {any} */ (raw) : null;
  if (!o || !isStr(o.sid)) return null;
  const created = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;
  const updated = typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : created;
  return {
    sid: o.sid,
    agent: typeof o.agent === "string" ? o.agent : "",
    convId: isStr(o.convId) ? o.convId : null,
    config: normalizeConfig(o.config),
    // Shape-check only (no TTL): normalizePending needs a clock, so pass a time
    // that cannot expire anything and let the use sites apply the window.
    pending: normalizePending(o.pending, typeof o.pending?.startedAt === "number" ? o.pending.startedAt : 0),
    createdAt: created,
    updatedAt: updated,
    heldBy: isStr(o.heldBy) ? o.heldBy : null,
    heldAt: typeof o.heldAt === "number" && Number.isFinite(o.heldAt) ? o.heldAt : 0,
  };
}

/** An empty registry. @returns {SessionRegistry} */
export function emptyRegistry() {
  return { v: SESSION_SCHEMA_V, sessions: {} };
}

/**
 * Parse the stored registry. Any problem — absent, non-JSON, wrong shape, a
 * future schema version — yields an EMPTY registry rather than an error: the
 * worst case is that the user's tabs each start a fresh session, which is
 * exactly the safe direction. Individual unreadable records are dropped and
 * the rest kept.
 * @param {string | null | undefined} raw
 * @returns {SessionRegistry}
 */
export function parseRegistry(raw) {
  if (!raw) return emptyRegistry();
  let o;
  try {
    o = JSON.parse(raw);
  } catch {
    return emptyRegistry();
  }
  if (!o || typeof o !== "object") return emptyRegistry();
  // A registry written by a NEWER build may hold fields this one would silently
  // drop on the next write, so don't adopt it — start clean instead of
  // corrupting the other build's state.
  if (o.v !== SESSION_SCHEMA_V) return emptyRegistry();
  const src = o.sessions && typeof o.sessions === "object" ? o.sessions : {};
  /** @type {Record<string, SessionRecord>} */
  const sessions = {};
  for (const key of Object.keys(src)) {
    const rec = normalizeSession(src[key]);
    // The map key and the record's own id must agree, or lookups would lie.
    if (rec && rec.sid === key) sessions[key] = rec;
  }
  return { v: SESSION_SCHEMA_V, sessions };
}

/** @param {SessionRegistry} reg @returns {string} */
export function serializeRegistry(reg) {
  return JSON.stringify({ v: SESSION_SCHEMA_V, sessions: reg.sessions });
}

/**
 * @param {SessionRegistry} reg
 * @param {string | null | undefined} sid
 * @returns {SessionRecord | null}
 */
export function getSession(reg, sid) {
  if (!isStr(sid)) return null;
  return reg.sessions[/** @type {string} */ (sid)] || null;
}

/**
 * Insert or replace a record. Returns a NEW registry — every mutator here is
 * immutable so a caller can compute the next state, decide not to write it, and
 * never have corrupted what it read.
 * @param {SessionRegistry} reg
 * @param {SessionRecord} rec
 * @returns {SessionRegistry}
 */
export function putSession(reg, rec) {
  return { v: SESSION_SCHEMA_V, sessions: { ...reg.sessions, [rec.sid]: rec } };
}

/**
 * @param {SessionRegistry} reg
 * @param {string} sid
 * @returns {SessionRegistry}
 */
export function dropSession(reg, sid) {
  if (!reg.sessions[sid]) return reg;
  const sessions = { ...reg.sessions };
  delete sessions[sid];
  return { v: SESSION_SCHEMA_V, sessions };
}

/**
 * Patch a session's fields and stamp `updatedAt`. A missing session is a no-op
 * (the caller's session may have been pruned by another tab) rather than an
 * error — the boot path must never throw over registry bookkeeping.
 * @param {SessionRegistry} reg
 * @param {string} sid
 * @param {Partial<SessionRecord>} patch
 * @param {number} now
 * @returns {SessionRegistry}
 */
export function touchSession(reg, sid, patch, now) {
  const rec = getSession(reg, sid);
  if (!rec) return reg;
  return putSession(reg, { ...rec, ...patch, sid: rec.sid, updatedAt: now });
}

/**
 * Whether a session's holder is still alive — a fresh heartbeat, nothing more.
 * @param {SessionRecord | null | undefined} rec
 * @param {number} now
 * @param {number} [staleMs]
 * @returns {boolean}
 */
export function sessionHeld(rec, now, staleMs = LEASE_STALE_MS) {
  if (!rec || !rec.heldBy) return false;
  return now - rec.heldAt < staleMs;
}

/**
 * Whether ANY session is currently held — i.e. whether another tab of this app
 * is alive. The discriminator behind the iOS reclaim rule: on a cold relaunch
 * nothing is held (every tab died with the app), while a genuine second tab
 * always finds the first tab's live lease.
 * @param {SessionRegistry} reg
 * @param {number} now
 * @param {string | null} [exceptTabId] ignore this tab's own leases
 * @param {number} [staleMs]
 * @returns {boolean}
 */
export function anySessionHeld(reg, now, exceptTabId = null, staleMs = LEASE_STALE_MS) {
  for (const sid of Object.keys(reg.sessions)) {
    const rec = reg.sessions[sid];
    if (exceptTabId && rec.heldBy === exceptTabId) continue;
    if (sessionHeld(rec, now, staleMs)) return true;
  }
  return false;
}

/**
 * Take (or refresh) the lease on a session. Callers decide WHETHER to claim —
 * attachDecision answers that; this only records it.
 * @param {SessionRegistry} reg
 * @param {string} sid
 * @param {string} tabId
 * @param {number} now
 * @returns {SessionRegistry}
 */
export function claimSession(reg, sid, tabId, now) {
  return touchSession(reg, sid, { heldBy: tabId, heldAt: now }, now);
}

/**
 * Refresh this tab's lease. Refuses to beat for a session another live tab has
 * taken over (a "take over here" elsewhere must not be undone by the loser's
 * next heartbeat), which is what keeps the lease single-writer.
 * @param {SessionRegistry} reg
 * @param {string} sid
 * @param {string} tabId
 * @param {number} now
 * @returns {SessionRegistry}
 */
export function heartbeat(reg, sid, tabId, now) {
  const rec = getSession(reg, sid);
  if (!rec) return reg;
  if (rec.heldBy && rec.heldBy !== tabId && sessionHeld(rec, now)) return reg;
  return claimSession(reg, sid, tabId, now);
}

/**
 * Give up the lease (a deliberate close/detach). Only the holder may release,
 * so a stale tab cannot unlock a session someone else took over.
 * @param {SessionRegistry} reg
 * @param {string} sid
 * @param {string} tabId
 * @param {number} now
 * @returns {SessionRegistry}
 */
export function releaseSession(reg, sid, tabId, now) {
  const rec = getSession(reg, sid);
  if (!rec || rec.heldBy !== tabId) return reg;
  return touchSession(reg, sid, { heldBy: null, heldAt: 0 }, now);
}

/**
 * What a tab should do about the session it wants to attach to. The UX rule
 * behind `held` is the owner's decision (2026-07-27): a second tab on the SAME
 * session is offered a choice — open a new session, or take over here — rather
 * than silently co-editing one workspace. An ephemeral VM has one writer.
 * @param {{reg: SessionRegistry, sid: string | null | undefined, tabId: string, now: number, staleMs?: number}} opts
 * @returns {{action: "attach" | "missing" | "held", holder: string | null}}
 */
export function attachDecision({ reg, sid, tabId, now, staleMs = LEASE_STALE_MS }) {
  const rec = getSession(reg, sid);
  if (!rec) return { action: "missing", holder: null };
  // Our own lease (this tab reloading) is always ours to retake.
  if (rec.heldBy === tabId) return { action: "attach", holder: tabId };
  if (sessionHeld(rec, now, staleMs)) return { action: "held", holder: rec.heldBy };
  return { action: "attach", holder: null };
}

/**
 * A session's pending pointer, if it is still inside the recovery window.
 * @param {SessionRecord | null | undefined} rec
 * @param {number} now
 * @param {number} [ttlMs]
 * @returns {PendingPointer | null}
 */
export function freshPending(rec, now, ttlMs = PENDING_TTL_MS) {
  if (!rec || !rec.pending) return null;
  return normalizePending(rec.pending, now, ttlMs);
}

/**
 * WHICH in-flight answer this boot may collect — the function that fixes the
 * reported bug, so its rules are spelled out:
 *
 *  1. **A tab attached to a session gets THAT session's pending answer, and
 *     never another's.** This is the whole fix: a second tab can no longer
 *     resume the research a first tab is running, cannot clear its pointer, and
 *     cannot ack away the server's parked copy.
 *  2. **A tab with no attachment adopts an orphaned pending answer only when
 *     nothing else is held.** No live lease anywhere means every tab died —
 *     the iOS PWA discard + cold relaunch this feature exists for — so the app
 *     is coming back and should collect what finished while it was gone. If any
 *     session IS held, another tab is alive, so this is a second tab and gets a
 *     fresh session instead (the owner's "a new tab is always a new session").
 *  3. **Most recently started wins** among orphans, and an expired pointer is
 *     never returned (src/answers.js has already purged that answer).
 *
 * @param {{reg: SessionRegistry, sid: string | null | undefined, tabId: string, now: number, ttlMs?: number, staleMs?: number}} opts
 * @returns {{sid: string, pending: PendingPointer} | null}
 */
export function resumeTarget({ reg, sid, tabId, now, ttlMs = PENDING_TTL_MS, staleMs = LEASE_STALE_MS }) {
  if (isStr(sid)) {
    const own = getSession(reg, sid);
    // Rule 1. A session another live tab has taken over is not ours to resume
    // even though we still think we are attached to it.
    if (own && (!own.heldBy || own.heldBy === tabId || !sessionHeld(own, now, staleMs))) {
      const pending = freshPending(own, now, ttlMs);
      if (pending) return { sid: own.sid, pending };
    }
    return null;
  }
  // Rule 2. Another tab alive → this is a second tab, not a relaunch.
  if (anySessionHeld(reg, now, tabId, staleMs)) return null;
  /** @type {{sid: string, pending: PendingPointer} | null} */
  let best = null;
  for (const key of Object.keys(reg.sessions)) {
    const rec = reg.sessions[key];
    if (sessionHeld(rec, now, staleMs)) continue;
    const pending = freshPending(rec, now, ttlMs);
    if (!pending) continue;
    // Rule 3.
    if (!best || pending.startedAt > best.pending.startedAt) best = { sid: rec.sid, pending };
  }
  return best;
}

/**
 * Bound the store. Evicts the least recently updated sessions once over `max`,
 * and forgets unheld idle ones outright. NEVER evicts a session that is held or
 * that still has a collectable answer — losing either would lose real work, so
 * an over-quota registry full of live sessions simply stays over.
 * @param {SessionRegistry} reg
 * @param {number} now
 * @param {{max?: number, idleMs?: number, ttlMs?: number, staleMs?: number}} [opts]
 * @returns {SessionRegistry}
 */
export function pruneRegistry(reg, now, opts = {}) {
  const max = opts.max ?? MAX_SESSIONS;
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
  const staleMs = opts.staleMs ?? LEASE_STALE_MS;
  /** @param {SessionRecord} rec */
  const protectedRec = (rec) => sessionHeld(rec, now, staleMs) || !!freshPending(rec, now, ttlMs);

  /** @type {Record<string, SessionRecord>} */
  const sessions = {};
  for (const key of Object.keys(reg.sessions)) {
    const rec = reg.sessions[key];
    if (!protectedRec(rec) && now - rec.updatedAt >= idleMs) continue; // idle → forgotten
    sessions[key] = rec;
  }
  const keys = Object.keys(sessions);
  if (keys.length <= max) return { v: SESSION_SCHEMA_V, sessions };
  // Over cap: drop the oldest unprotected sessions until we fit.
  const droppable = keys
    .filter((k) => !protectedRec(sessions[k]))
    .sort((a, b) => sessions[a].updatedAt - sessions[b].updatedAt);
  let over = keys.length - max;
  for (const k of droppable) {
    if (over <= 0) break;
    delete sessions[k];
    over--;
  }
  return { v: SESSION_SCHEMA_V, sessions };
}

/**
 * The registry as a list for the sessions UI (the history sidebar's live-session
 * group). Newest activity first, each annotated with what the user needs to
 * choose between them. Metadata only — a title would mean message-derived text
 * in localStorage, which the privacy note above rules out; the sidebar joins
 * `convId` against the encrypted history record for a label.
 * @param {SessionRegistry} reg
 * @param {number} now
 * @param {{staleMs?: number, ttlMs?: number}} [opts]
 * @returns {Array<{sid: string, agent: string, convId: string | null, held: boolean, busy: boolean, updatedAt: number}>}
 */
export function listSessions(reg, now, opts = {}) {
  const staleMs = opts.staleMs ?? LEASE_STALE_MS;
  const ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
  return Object.keys(reg.sessions)
    .map((k) => reg.sessions[k])
    .map((rec) => ({
      sid: rec.sid,
      agent: rec.agent,
      convId: rec.convId,
      held: sessionHeld(rec, now, staleMs),
      busy: !!freshPending(rec, now, ttlMs),
      updatedAt: rec.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Parse the per-tab attachment blob. Returns nulls rather than throwing so a
 * boot with unusable sessionStorage simply mints a new tab id + session.
 * @param {string | null | undefined} raw
 * @returns {{tabId: string | null, sid: string | null}}
 */
export function parseAttachment(raw) {
  if (!raw) return { tabId: null, sid: null };
  try {
    const o = JSON.parse(raw);
    return {
      tabId: isStr(o?.tabId) ? o.tabId : null,
      sid: isStr(o?.sid) ? o.sid : null,
    };
  } catch {
    return { tabId: null, sid: null };
  }
}

/**
 * @param {{tabId: string, sid: string}} att
 * @returns {string}
 */
export function serializeAttachment(att) {
  return JSON.stringify({ tabId: att.tabId, sid: att.sid });
}

// NB the per-session VM overlay ids are NOT here: `sandboxOverlayIds` lives in
// sandbox-files.js, the sandbox's own device-planning core. sandbox.js is inside
// the /cure public module graph and session-core.js is not, so importing this
// module there would 401 the whole Se/cure tier (the recurring public-graph
// failure class — see the execution-sandbox skill). The session id reaches the
// VM as a plain string through `setSandboxSession`, the same seam
// `setSandboxImage` already uses.

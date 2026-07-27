// @ts-check
// Resume-across-relaunch pointer for an in-flight research answer.
//
// The server finishes every research run even after the client vanishes
// (src/chat.js's ctx.waitUntil) and parks the answer for 15 min
// (src/answers.js). stream.js's in-session recovery picks that up when the
// tab survives. But iOS can DISCARD a backgrounded PWA entirely — a cold
// relaunch loses all in-memory state (the request id, the on-screen turn),
// so before this there was nothing left to poll with and the finished
// answer expired unclaimed. This pointer closes that last gap: the research
// still completed on the server, and the next launch collects it.
//
// PER SESSION SINCE 2026-07-27 (the multi-tab fix). This used to be a SINGLE
// browser-global localStorage slot, `dr_pending_answer`, which made every new
// tab boot straight into whatever research another tab was running: app.js read
// the slot, showed Stop, polled somebody else's answer back, cleared the other
// tab's marker and acked the server's parked copy out from under it. The pointer
// now lives on the SESSION record (session-core.js) — one per session, so a
// session's in-flight answer belongs to that session and nothing else can reach
// it.
//
// WHY IT IS STILL DURABLE (localStorage, not sessionStorage). Moving the pointer
// to per-tab storage would have "fixed" multi-tab by breaking the only case this
// feature exists for: sessionStorage does not survive an iOS PWA discard + cold
// relaunch. So the pointer stays durable in the shared registry and the
// ADOPTION is what carries the rule instead — session-core's resumeTarget lets a
// boot collect an orphaned answer only when no other tab is alive. See its
// comment for the full rule; the reason it lives there is that it is pure logic
// and unit-tested, which this file's storage glue cannot be.
//
// PRIVACY: the marker is METADATA ONLY — conversation id, request id, the
// settings, a timestamp. NEVER any message text. The question itself lives
// only in the encrypted IndexedDB record (history-store.js); this pointer
// just says "that conversation is awaiting request R". So nothing readable
// at rest is added by this feature — the same posture as the rest of the
// app. Incognito chats persist nothing, so stream.js writes no marker for
// them (there's no encrypted record to reopen either).

import { PENDING_TTL_MS, normalizePending } from "./session-core.js";
import { currentSession, setSessionPending } from "./session.js";

export { PENDING_TTL_MS };

/**
 * The stored pointer: conversation id, the answer-recovery request id, the
 * send-time settings a resumed turn needs, and when the send started.
 * Metadata only — never message text (see the privacy note above).
 * @typedef {import('./session-core.js').PendingPointer} PendingPointer
 */

/**
 * Pure: validate + freshness-check a raw stored string. Returns the pointer
 * object, or null if it's absent, malformed, the wrong shape, or older than
 * the TTL — past which src/answers.js has already purged the parked answer,
 * so resuming it could only 404.
 *
 * The shape/TTL rules themselves live in session-core.js `normalizePending`
 * (one definition, so the registry and this pointer can never disagree about
 * whether an answer is still collectable); this wrapper only adds the JSON
 * decode, which is what the stored-string form needs.
 * @param {string | null | undefined} raw
 * @param {number} now epoch ms
 * @param {number} [ttlMs]
 * @returns {PendingPointer | null}
 */
export function parsePending(raw, now, ttlMs = PENDING_TTL_MS) {
  if (!raw) return null;
  try {
    return normalizePending(JSON.parse(raw), now, ttlMs);
  } catch {
    return null;
  }
}

// Session-registry wrappers. All fail-soft (session.js swallows storage
// failures): a blocked store costs the durability of resume-across-relaunch,
// never a send or a boot.

/**
 * Arm this SESSION's resume pointer.
 * @param {PendingPointer} p
 */
export function writePending(p) {
  setSessionPending(p);
}

/**
 * THIS session's pending pointer, if it is still inside the recovery window.
 *
 * Deliberately narrow: it answers only "is my own session awaiting an answer",
 * which is what the composer's Stop-button state needs. Deciding WHICH session a
 * boot may collect from — including a cold relaunch adopting an orphan — is
 * session.js `claimResumeTarget`, because that decision is exactly where the
 * multi-tab bug lived and it must be made once, in one place.
 * @param {number} [now] epoch ms
 * @returns {PendingPointer | null}
 */
export function readPending(now = Date.now()) {
  return normalizePending(currentSession()?.pending, now);
}

/** Disarm this session's resume pointer. */
export function clearPending() {
  setSessionPending(null);
}

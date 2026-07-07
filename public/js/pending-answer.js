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
// PRIVACY: the marker is METADATA ONLY — conversation id, request id, the
// settings, a timestamp. NEVER any message text. The question itself lives
// only in the encrypted IndexedDB record (history-store.js); this pointer
// just says "that conversation is awaiting request R". So nothing readable
// at rest is added by this feature — the same posture as the rest of the
// app. Incognito chats persist nothing, so stream.js writes no marker for
// them (there's no encrypted record to reopen either).
//
// It is deliberately localStorage: it must survive a full PWA discard and
// cold relaunch, which in-memory state and (on iOS) sessionStorage do not.
// Single-slot — one in-flight answer at a time; a new send overwrites it.

const KEY = "dr_pending_answer";
export const PENDING_TTL_MS = 15 * 60 * 1000; // matches src/answers.js ANSWER_TTL_MS

// Pure: validate + freshness-check a raw stored string. Returns the pointer
// object, or null if it's absent, malformed, the wrong shape, or older than
// the TTL — past which src/answers.js has already purged the parked answer,
// so resuming it could only 404. Kept pure (storage/clock injected by the
// wrappers below) so it's unit-tested in Node.
export function parsePending(raw, now, ttlMs = PENDING_TTL_MS) {
  if (!raw) return null;
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  if (typeof p.convId !== "string" || !p.convId) return null;
  if (typeof p.requestId !== "string" || !p.requestId) return null;
  if (typeof p.startedAt !== "number" || !Number.isFinite(p.startedAt)) return null;
  if (now - p.startedAt >= ttlMs) return null; // past the recovery window
  return p;
}

// Browser wrappers (not unit-tested — localStorage/Date). All fail-soft:
// storage access can throw (private mode, disabled storage, quota) and must
// never break a send or a boot.
export function writePending(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — resume-across-relaunch just won't be available */
  }
}

export function readPending(now = Date.now()) {
  try {
    return parsePending(localStorage.getItem(KEY), now);
  } catch {
    return null;
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

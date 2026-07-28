// @ts-check
// What happens to a question that never got an answer.
//
// A send can end with no answer text at all: an empty completion, a route that
// failed, a dropped connection we could not recover from, or Stop pressed
// before the first token. The client used to REVERT such a question — pop it
// off the conversation "so a retry starts clean".
//
// That quietly desynced the two conversations. The question bubble stays on
// screen (the user can still read it, right above the error), while the
// model-facing history no longer held it. Feedback #45 is what that cost: a
// question died on a phone before it ever reached the server, the user typed
// "Try again", and the model answered — truthfully — that "the original
// question never reached this conversation" while it sat there on screen. The
// user's report was one line: "you should have that info available."
//
// So the question STAYS, and an assistant marker records that it went
// unanswered. The marker is an ASSISTANT turn for two reasons: roles stay
// strictly alternating (no consecutive user messages for a provider to merge —
// src/anthropic.js does that defensively), and the model is TOLD in words that
// the turn produced nothing rather than having to infer it from a gap. That
// mirrors the convention the partial-answer path already uses, where a stream
// that died mid-answer is kept with "[This answer was cut off by a connection
// error.]" appended.
//
// The markers state only what happened. They carry no instruction to the model
// about what to do next: resolving a bare "try again" back to the question it
// retries is the deterministic machinery's job (conversation.js
// previousUserText for triage, introspect-core.js retrievalQuery for the source
// RAG), not something to prompt-stuff into the transcript.

/** @typedef {"empty" | "failed" | "dropped" | "stopped"} UnansweredReason */

// Why the turn produced nothing, in the words the transcript will carry.
/** @type {Record<UnansweredReason, string>} */
const REASON_CAUSES = {
  // The request completed but the model returned no text.
  empty: "no answer was produced",
  // The route itself failed (non-OK response, a private/on-device run that threw).
  failed: "the request failed before any answer arrived",
  // The connection died and the server's parked copy could not be recovered.
  dropped: "the connection dropped before any answer arrived",
  // The user pressed Stop before the first token.
  stopped: "it was stopped before any answer arrived",
};

/**
 * The transcript marker for a question that went unanswered. Bracketed like
 * the cut-off-answer marker, so a reader (and the model) can tell it apart
 * from generated text.
 * @param {UnansweredReason | string} [reason]
 * @returns {string}
 */
export function unansweredMarker(reason) {
  const cause = REASON_CAUSES[/** @type {UnansweredReason} */ (reason)] || REASON_CAUSES.failed;
  return `[The question above went unanswered — ${cause}.]`;
}

/**
 * Settle an unanswered send in the conversation: keep the question and append
 * the marker. A no-op unless the conversation actually ends on a user turn —
 * an answer that landed (or a marker already appended) must never be followed
 * by one, which also makes a double call harmless.
 * @param {{role?: string, content?: any}[]} history the model-facing conversation, mutated in place
 * @param {UnansweredReason | string} [reason]
 * @returns {boolean} whether a marker was appended
 */
export function markUnanswered(history, reason) {
  if (!Array.isArray(history) || !history.length) return false;
  if (history[history.length - 1]?.role !== "user") return false;
  history.push({ role: "assistant", content: unansweredMarker(reason) });
  return true;
}

/**
 * Whether a message is one of our markers rather than model output. The
 * conversation renderer uses this to style a restored marker as the error it
 * represents instead of as an answer.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isUnansweredMarker(text) {
  return /^\[The question above went unanswered — .+\.\]$/.test(String(text || "").trim());
}

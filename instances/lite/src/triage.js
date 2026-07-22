// @ts-check
// The triage phase's schema + its model-free last-ditch normalizer
// (research-pipeline step 1). triage decides, per message, one of:
//   - "direct"   answer straight away, no web search
//   - "research" run 1-N web searches, then synthesize
// plus the search queries. When the model's JSON is junk (or the model call
// failed entirely), normalizeTriage produces a usable plan model-free, so the
// pipeline is deterministic even with an unreliable model (PA-1 / PA-2).

import { S } from "./schema.js";

export const triageSchema = S.object({
  mode: S.stringEnum(["direct", "research"]),
  queries: S.arrayOf(S.string()),
});

/**
 * Model-free fallback. Mirrors the parent's discipline: a short follow-up in an
 * ongoing conversation seeds the search from the PRIOR question; a substantial
 * standalone message becomes a one-query research; a trivial one answers direct.
 * @param {any} triage the (possibly junk) parsed model output
 * @param {string} lastUser the current user message
 * @param {string} [priorUser] the previous user message, if any
 * @returns {{ mode: "direct"|"research", queries: string[] }}
 */
export function normalizeTriage(triage, lastUser, priorUser = "") {
  // A usable model answer passes straight through.
  if (
    triage &&
    (triage.mode === "direct" || triage.mode === "research") &&
    Array.isArray(triage.queries)
  ) {
    const queries = triage.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
    if (triage.mode === "research" && queries.length === 0) {
      return { mode: "research", queries: [seedQuery(lastUser, priorUser)] };
    }
    return { mode: triage.mode, queries: triage.mode === "research" ? queries : [] };
  }

  // Junk / missing — decide model-free.
  const msg = String(lastUser || "").trim();
  if (isSmalltalk(msg)) return { mode: "direct", queries: [] };
  const words = msg.split(/\s+/).filter(Boolean).length;
  // A short message in an ongoing conversation is a FOLLOW-UP, not trivia —
  // seed the search from the prior question so the query stands alone.
  if (words <= 4 && priorUser) return { mode: "research", queries: [seedQuery(msg, priorUser)] };
  // A very short STANDALONE message with no context to expand is trivial.
  if (words <= 2) return { mode: "direct", queries: [] };
  return { mode: "research", queries: [seedQuery(msg, priorUser)] };
}

// A deterministic greeting/smalltalk gate — routes such messages to "direct"
// with no web search, no model round-trip. English AND Swedish with equal
// breadth (PA-6): every form on one side has its counterpart on the other, and
// the parity is pinned in triage.test.js. Extend BOTH sides in the same change.
const SMALLTALK = new RegExp(
  "^(?:" +
    [
      // greetings — EN
      "hi", "hey", "hello", "yo", "good\\s+(?:morning|evening|afternoon)",
      // greetings — SV
      "hej", "hejsan", "tjena", "tja", "god\\s+(?:morgon|kväll|eftermiddag)",
      // thanks — EN / SV
      "thanks?(?:\\s+you)?", "thank\\s+you", "cheers",
      "tack(?:\\s+så\\s+mycket)?", "tackar",
      // farewells — EN / SV
      "bye", "goodbye", "see\\s+you",
      "hej\\s*då", "vi\\s+ses", "ha\\s+det\\s+bra",
    ].join("|") +
    ")[\\s!.,]*$",
  "i",
);

/** @param {string} msg @returns {boolean} */
export function isSmalltalk(msg) {
  return SMALLTALK.test(String(msg || "").trim());
}

/**
 * A short follow-up ("and in 2024?") is meaningless as a standalone query, so
 * seed it from the prior question. Language-neutral by construction.
 * @param {string} lastUser @param {string} priorUser @returns {string}
 */
function seedQuery(lastUser, priorUser) {
  const msg = String(lastUser || "").trim();
  const words = msg.split(/\s+/).filter(Boolean).length;
  if (words <= 4 && priorUser) return `${String(priorUser).trim()} ${msg}`.trim().slice(0, 300);
  return msg.slice(0, 300);
}

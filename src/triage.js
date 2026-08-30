// @ts-check
// The pipeline's JSON-hardening layer: the declared schema for the validation
// phase, the hardenJson runner that applies it, and seedFromConversation — the
// MODEL-FREE fallback that turns a conversation into one search query when a
// planning phase's JSON comes back unusable.
//
// The filename is historical. The triage phase this module was written for is
// gone: the deterministic five-phase cascade it classified for was replaced by
// the standard four-node graph (src/pipeline-standard.js) and the model-driven
// loop (src/agentic.js), and neither has a triage node. What survived is the
// part that was never about triage — a schema applied behind a fail-soft
// fallback, and a seeder that must not be written twice.
//
// Seam with the phases: they own the FLOW and run each phase's parsed model
// JSON through hardenJson(SCHEMA, …) before their own fail-soft handling; this
// module is pure — no I/O, no SSE events, no model calls — so the shapes and
// the fallback logic are testable on their own.

import { arrayOf, object, string, validate } from "./schema.js";

/**
 * seedFromConversation's verdict: search these queries, or answer directly.
 * @typedef {{ action: "research", queries: string[] } | { action: "direct" }} SeedDecision
 */

// ---- JSON-phase schemas --------------------------------------------------

// A hardening layer over the raw model JSON (src/schema.js), applied BEHIND
// the existing fail-soft fallbacks. On a clean match hardenJson() returns the
// normalized object; on ANY miss it returns the raw value untouched, so a
// malformed shape degrades exactly as it did before the schema existed
// (accept the draft) and never throws.
export const VALIDATE_SCHEMA = object(
  {
    verdict: string(),
    // Display-only list; coerce leniently to match the pipeline's historical
    // `.map(String)` treatment of a stray non-string issue.
    issues: arrayOf(string({ coerce: true })),
    revised_answer: string(),
  },
  /** @type {any} */ ({ optional: ["issues", "revised_answer"] }),
);

// Runs a JSON-phase value through its declared schema. ok → the normalized
// object; miss → the raw value, so the caller's existing fallback path runs
// unchanged. validate() never throws, so this is always safe.
/**
 * @param {object} schema One of the schema declarations above.
 * @param {any} value Raw parsed model JSON (may be anything).
 * @returns {any}
 */
export function hardenJson(schema, value) {
  const r = validate(schema, value);
  return r.ok ? r.value : value;
}

/**
 * The model-free planning fallback: seed a search from the conversation
 * without asking anything.
 *
 * The standard pipeline's query-plan node (src/pipeline-standard.js
 * normalizeQueryPlan) is its one caller today, and the reason it is a shared
 * function rather than a branch there is the rule it holds: a bare
 * back-reference ("undersök saken", "det då?") must never reach a search
 * engine verbatim, in either language. A second hand-written seeder would
 * drift from this one.
 * @param {string} lastUser
 * @param {string} priorUser
 * @param {{ forceResearch?: boolean }} [opts]
 * @returns {SeedDecision}
 */
export function seedFromConversation(lastUser, priorUser, { forceResearch = false } = {}) {
  // A SHORT latest message in an ongoing conversation is almost always a
  // pure back-reference ("undersök saken", "det då?") with no searchable
  // content of its own, so seed the search from the prior question (the
  // established, self-contained topic) rather than the referential phrase.
  // A LONGER follow-up is deliberately left as-is: it carries its own
  // content words (e.g. "…hur det ser ut för sd" — the entity "sd" is right
  // there), which a fuzzy search can use, so replacing it with the prior
  // topic would only DROP that focus.
  const cur = lastUser.trim();
  const prior = (priorUser || "").trim();
  const looksLikeFollowup = cur.length < 40 && cur.split(/\s+/).filter(Boolean).length <= 6;
  if (prior && looksLikeFollowup) {
    return { action: "research", queries: [prior.slice(0, 300)] };
  }
  if (cur.length >= 12) return { action: "research", queries: [cur.slice(0, 300)] };
  // Too short to search and nothing to resolve against. Normally that means
  // answer directly; with forceResearch there is no direct answer to give, so
  // search what there is.
  if (!forceResearch) return { action: "direct" };
  const query = cur || prior;
  return query ? { action: "research", queries: [query.slice(0, 300)] } : { action: "direct" };
}

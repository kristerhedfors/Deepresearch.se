// @ts-check
// The MODEL-FREE query seeder — the one function that turns a conversation
// into a search decision when a planning phase's JSON comes back unusable.
//
// SERVED AND PURE so both tiers can import the SAME seeder: the server's
// standard graph (src/pipeline-standard.js normalizeQueryPlan, via the
// src/triage.js façade) and Se/cure's client graph (public/js/drc-research.js
// normalizeDrcQueryPlan). It holds the bilingual back-reference rule — a bare
// "undersök saken" / "det då?" must never reach a search engine verbatim, in
// either language — and that rule guards the one string that leaves through
// the query-only search grant, so a second hand-written seeder drifting from
// this one would be a privacy-adjacent bug, not a cosmetic one
// (research-brief-core.js's header names exactly this drift as the failure
// class shared cores exist to prevent).

/**
 * seedFromConversation's verdict: search these queries, or answer directly.
 * @typedef {{ action: "research", queries: string[] } | { action: "direct" }} SeedDecision
 */

/**
 * The model-free planning fallback: seed a search from the conversation
 * without asking anything.
 *
 * The reason it is a shared function rather than a branch in each caller is
 * the rule it holds: a bare back-reference ("undersök saken", "det då?") must
 * never reach a search engine verbatim, in either language. A second
 * hand-written seeder would drift from this one.
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

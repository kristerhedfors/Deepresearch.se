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

// The seeder itself moved to the SERVED pure core so Se/cure's client graph
// can import the same bilingual back-reference rules (one seeder, both tiers
// — see the core's header). This façade keeps the import path every server
// caller already uses; the same direction src/research-tools-run.js takes for
// lypning-exec-core.
export { seedFromConversation } from "../public/js/query-seed-core.js";

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


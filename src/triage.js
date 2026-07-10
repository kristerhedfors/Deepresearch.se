// @ts-check
// The pipeline's JSON-hardening layer: the declared schemas for every JSON
// planning phase (triage, gap check, validation, the claim checks), the
// hardenJson runner that applies them, and normalizeTriage — the triage
// verdict's normalization plus its model-free fallback when the JSON is
// unusable.
//
// Seam with pipeline.js: pipeline.js owns the phase FLOW and runs each
// phase's parsed model JSON through hardenJson(SCHEMA, …) before its own
// fail-soft handling; this module is pure — no I/O, no SSE events, no model
// calls — so the shapes and the fallback logic are testable on their own
// (src/pipeline.test.js's normalizeTriage suite imports from here).

import { arrayOf, boolean, object, oneOf, string, stringEnum, validate } from "./schema.js";

/**
 * normalizeTriage's hardened verdict: exactly one of the three actions,
 * with the optional decomposition/quiz fields riding on research/direct.
 * @typedef {{ action: "direct", quiz?: boolean }
 *   | { action: "clarify", question: string, quiz?: boolean }
 *   | ResearchDecision} TriageDecision
 */
/**
 * @typedef {{
 *   action: "research",
 *   queries: string[],
 *   complexity?: string,
 *   subquestions?: string[],
 *   quiz?: boolean,
 * }} ResearchDecision
 */

// ---- JSON-phase schemas --------------------------------------------------

// Declared shapes for the three JSON planning phases — a hardening layer over
// the raw model JSON (src/schema.js), applied BEHIND the existing fail-soft
// fallbacks (normalizeTriage etc. stay the last-ditch net). On a clean match
// hardenJson() returns the normalized object; on ANY miss it returns the raw
// value untouched, so a malformed shape degrades exactly as it did before the
// schema existed (single search / accept draft) and never throws.
export const TRIAGE_SCHEMA = oneOf([
  // `quiz` (optional on direct AND research): triage's fail-soft backup for
  // the deterministic quizIntent gate — the first production quiz request
  // arrived with a typo ("wuiz") the regexes missed; a model reads through
  // typos and paraphrases that no pattern list can enumerate. Never the
  // primary gate: quizIntent still decides when it matches, and a stray
  // false `quiz:true` on a non-request costs one fail-soft generation
  // attempt at worst (schema.js's object() strips unknown fields, so the
  // flag must be declared here to survive hardening).
  // The `optional` casts here and below: schema.js's `optional = []` default
  // makes tsc infer never[] for the option in unannotated schema.js.
  object({ action: stringEnum(["direct"]), quiz: boolean() }, /** @type {any} */ ({ optional: ["quiz"] })),
  object({ action: stringEnum(["clarify"]), question: string({ allowEmpty: false }) }),
  object(
    {
      action: stringEnum(["research"]),
      queries: arrayOf(string({ allowEmpty: false })),
      // Decomposition fields (prompts.js DECOMPOSITION_RULE) — both optional:
      // a model that omits them (or an unknown complexity value falling
      // through normalizeTriage's lenient extraction) degrades exactly to the
      // pre-decomposition flow.
      complexity: stringEnum(["simple", "multihop", "comparison", "survey"]),
      subquestions: arrayOf(string({ allowEmpty: false })),
      quiz: boolean(),
    },
    /** @type {any} */ ({ optional: ["queries", "complexity", "subquestions", "quiz"] }),
  ),
]);
export const GAP_SCHEMA = object(
  {
    complete: boolean(),
    queries: arrayOf(string({ allowEmpty: false })),
    // Source disagreements the audit noticed (display + synthesis hint) —
    // optional, and independent of `complete`.
    conflicts: arrayOf(string({ coerce: true })),
  },
  /** @type {any} */ ({ optional: ["complete", "queries", "conflicts"] }),
);
export const VALIDATE_SCHEMA = object(
  {
    verdict: stringEnum(["pass", "revise"]),
    // Display-only list; coerce leniently to match the pipeline's historical
    // `.map(String)` treatment of a stray non-string issue.
    issues: arrayOf(string({ coerce: true })),
    revised_answer: string(),
  },
  /** @type {any} */ ({ optional: ["issues", "revised_answer"] }),
);
// Claim-level validation (high tiers): per-claim verdict and the revision.
export const CLAIM_VERIFY_SCHEMA = object(
  { verdict: stringEnum(["supported", "unsupported"]), issue: string({ coerce: true }) },
  /** @type {any} */ ({ optional: ["issue"] }),
);
export const REVISE_SCHEMA = object({ revised_answer: string() });

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
 * Hardens the raw triage JSON into a usable decision, with a model-free
 * fallback (see below) when the JSON is unusable.
 * @param {any} triage Raw triage JSON (may be anything).
 * @param {string} lastUser The latest user message's text.
 * @param {string} [priorUser] The previous user turn's text ("" when none).
 * @returns {TriageDecision}
 */
export function normalizeTriage(triage, lastUser, priorUser = "") {
  // The optional quiz flag (triage's fail-soft backup for quizIntent —
  // see TRIAGE_SCHEMA) rides along on direct/research decisions; lenient
  // strict-boolean extraction so it survives the raw (schema-miss) path.
  const quiz = triage?.quiz === true ? { quiz: true } : {};
  if (triage?.action === "clarify" && typeof triage.question === "string" && triage.question.trim()) {
    return { action: "clarify", question: triage.question.trim() };
  }
  if (triage?.action === "research") {
    const queries = (Array.isArray(triage.queries) ? triage.queries : [])
      .filter((/** @type {any} */ q) => typeof q === "string" && q.trim());
    if (queries.length > 0) {
      /** @type {ResearchDecision} */
      const out = { action: "research", queries, ...quiz };
      // Optional decomposition fields (prompts.js DECOMPOSITION_RULE) —
      // lenient extraction so they survive the raw (schema-miss) path too.
      // Only attached when usable: their absence is the pre-decomposition
      // behavior everywhere downstream.
      if (["simple", "multihop", "comparison", "survey"].includes(triage.complexity)) {
        out.complexity = triage.complexity;
      }
      const subs = (Array.isArray(triage.subquestions) ? triage.subquestions : [])
        .filter((/** @type {any} */ s) => typeof s === "string" && s.trim())
        .map((/** @type {string} */ s) => s.trim())
        .slice(0, 5);
      if (subs.length) out.subquestions = subs;
      return out;
    }
  }
  if (triage?.action === "direct") return { action: "direct", ...quiz };

  // Triage failed to produce usable JSON — decide a fallback WITHOUT a model.
  // A SHORT latest message in an ongoing conversation is almost always a
  // pure back-reference ("undersök saken", "det då?") with no searchable
  // content of its own, so seed the search from the prior question (the
  // established, self-contained topic) rather than the referential phrase.
  // A LONGER follow-up is deliberately left as-is: it carries its own
  // content words (e.g. "…hur det ser ut för sd" — the entity "sd" is right
  // there), which a fuzzy search can use, so replacing it with the prior
  // topic would only DROP that focus. The real fix for an ugly unresolved
  // query is triage itself producing a clean one (triagePrompt's
  // FOLLOWUP_RESOLUTION_RULE + per-model JSON reliability, model-profiles.js)
  // — this fallback only runs on the rare parse-failure path and just avoids
  // the worst case (a bare pronoun going to the web). A short message with no
  // prior context has nothing to resolve against, so answer directly.
  const cur = lastUser.trim();
  const prior = (priorUser || "").trim();
  const looksLikeFollowup = cur.length < 40 && cur.split(/\s+/).filter(Boolean).length <= 6;
  if (prior && looksLikeFollowup) {
    return { action: "research", queries: [prior.slice(0, 300)] };
  }
  return cur.length >= 12
    ? { action: "research", queries: [cur.slice(0, 300)] }
    : { action: "direct" };
}

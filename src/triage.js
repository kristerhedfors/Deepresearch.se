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
 *   decomposition?: string,
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
      // Task SHAPE, asked separately from difficulty (docs/AGENTIC-GRAPHS.md
      // §5.2): can the sub-questions be researched in parallel, or does one
      // need another's answer first? Absent = fall back to inferring it from
      // `complexity`, which is what the pipeline did before this field existed.
      decomposition: stringEnum(["independent", "sequential"]),
      quiz: boolean(),
    },
    /** @type {any} */ ({ optional: ["queries", "complexity", "subquestions", "decomposition", "quiz"] }),
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
// A clarification this pipeline asked is emitted ALONE (pipeline.js
// runClarify streams the question and nothing else), so it is short, it asks
// something, and it carries none of a synthesized answer's furniture — no
// headings, no numbered citations. That is the whole signal available: the
// client posts back roles and content only, so the previous turn's route is
// not in the request and its reply text is the only trace of it.
//
// Deliberately language-agnostic — it keys on punctuation and markdown
// structure, never on English phrasing — so it holds for Swedish exactly as it
// does for English (CLAUDE.md invariant 6), which the parity test pins.
const CLARIFY_MAX_CHARS = 700;

/**
 * Whether an assistant turn looks like a clarifying question rather than an
 * answer. Pure.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeClarifyTurn(text) {
  const s = String(text || "").trim();
  if (!s.includes("?")) return false;
  if (s.length > CLARIFY_MAX_CHARS) return false;
  if (/(^|\n)#{1,6}\s/.test(s)) return false; // a heading: a synthesized answer
  if (/\[\d+\]/.test(s)) return false; // a numbered citation: an answer with sources
  return true;
}

/**
 * The model-free triage fallback: seed a search from the conversation without
 * asking anything. Used both when triage's JSON is unusable and when a second
 * clarification in a row has to be escaped (see normalizeTriage).
 *
 * Exported because the standard pipeline's query-plan node
 * (src/pipeline-standard.js normalizeQueryPlan) needs the SAME fallback: its
 * planner is one JSON call on the same model, so it fails the same way, and a
 * second hand-written seeder would drift from this one — the rule that a bare
 * back-reference ("undersök saken", "det då?") must never reach a search
 * engine verbatim is the one this function exists to hold, in both languages.
 * @param {string} lastUser
 * @param {string} priorUser
 * @param {{ forceResearch?: boolean }} [opts]
 * @returns {TriageDecision}
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
  // answer directly; on the escape path there is no direct answer to give —
  // the user has already been asked once — so search what there is.
  if (!forceResearch) return { action: "direct" };
  const query = cur || prior;
  return query ? { action: "research", queries: [query.slice(0, 300)] } : { action: "direct" };
}

/**
 * @param {any} triage
 * @param {string} lastUser
 * @param {string} [priorUser]
 * @param {{ priorWasClarify?: boolean, demoMounted?: boolean }} [opts]
 * @returns {TriageDecision}
 */
export function normalizeTriage(
  triage,
  lastUser,
  priorUser = "",
  { priorWasClarify = false, demoMounted = false } = {},
) {
  // The optional quiz flag (triage's fail-soft backup for quizIntent —
  // see TRIAGE_SCHEMA) rides along on direct/research decisions; lenient
  // strict-boolean extraction so it survives the raw (schema-miss) path.
  const quiz = triage?.quiz === true ? { quiz: true } : {};
  if (triage?.action === "clarify" && typeof triage.question === "string" && triage.question.trim()) {
    // One clarifying question is help; two in a row is a loop. The user
    // answered the first one with something else — a new topic, an
    // instruction, an exasperated "search the web!" — and asking again spends
    // another turn without searching anything. Reported as exactly that
    // (feedback #47: three clarifying turns in a row with web search
    // explicitly on, and not one query run). So a second clarification
    // becomes a search, seeded from the conversation without a model.
    if (priorWasClarify) return seedFromConversation(lastUser, priorUser, { forceResearch: true });
    // The client already mounted what was asked for — an animation, a builder,
    // a page card — and it is on screen while this question is being asked.
    // "Lets see a starship launch" was answered with "do you want to see a live
    // launch or a past one?" over a playing Starship launch (feedback #58).
    // The demo IS the answer to the ambiguity, so there is nothing left to
    // narrow: reply directly, with the surface named in the answer prompt.
    if (demoMounted) return { action: "direct", ...quiz };
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
      if (["independent", "sequential"].includes(triage.decomposition)) {
        out.decomposition = triage.decomposition;
      }
      return out;
    }
  }
  if (triage?.action === "direct") return { action: "direct", ...quiz };

  // Triage failed to produce usable JSON — decide a fallback WITHOUT a model.
  // The real fix for an ugly unresolved query is triage itself producing a
  // clean one (triagePrompt's FOLLOWUP_RESOLUTION_RULE + per-model JSON
  // reliability, model-profiles.js); this path only runs on the rare
  // parse-failure and just avoids the worst case (a bare pronoun going to the
  // web). A short message with no prior context has nothing to resolve
  // against, so answer directly.
  return seedFromConversation(lastUser, priorUser);
}

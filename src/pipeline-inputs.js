// @ts-check
// The pipeline's PURE input-block builders and output parsers — the string/
// array shaping the phase functions in pipeline.js hand to (and take back
// from) the model, with zero ctx/env/emit/await. Split out of pipeline.js so
// the orchestration flow there reads as the flow, and these behavior-defining
// pure helpers get their own home and direct unit coverage. Mirrors the
// project's `-text.js` convention (googlemaps-text.js).
//
// Byte-identical-input discipline: every builder here returns "" (or []) in
// the default-budget / no-decomposition case, so the message arrays are
// byte-identical to the pre-feature pipeline. Do not change that without
// re-checking the pipeline's model-input snapshots.

import { notesDigest } from "./notes.js";

/** @typedef {import('./types.js').Message} Message */
/**
 * The slice of the pipeline's request state `takeSearchBatch` reads/mutates
 * (the full shape is pipeline.js's local `PipelineState` typedef).
 * @typedef {{ ranQueries: Set<string>, searchCount: number, plan: { maxSearches: number } }} SearchBatchState
 */

// The extra system message carrying the bash-lite sandbox transcript into a
// non-synthesis reply (direct / search-off), framed as ground truth. Empty
// (and thus omitted) when the sandbox didn't run, so the message array is
// byte-identical to a run without the feature.
/**
 * @param {string} shellBlock
 * @returns {Message[]}
 */
export function shellReplyMessages(shellBlock) {
  if (!shellBlock) return [];
  return [
    {
      role: "system",
      content:
        shellBlock +
        "\n\nUse this real sandbox output directly in your reply — it is ground truth you produced by running commands (no citation needed).",
    },
  ];
}

// Distilled-notes preamble for the gap/synth inputs — only present when the
// budget-gated digest phase actually produced notes (never at default budget,
// so the input string is byte-identical there).
/**
 * @param {object[] | undefined} notes
 * @returns {string}
 */
export function notesSection(notes) {
  const block = notesDigest(notes, 6000);
  return block ? `Distilled research notes so far:\n${block}\n\n` : "";
}

// Accumulates the gap check's reported source disagreements onto the request
// state (deduped, capped) so synthesis can be told to address them explicitly
// instead of silently picking a side. Pure state bookkeeping. Lenient by
// design: a missing/malformed conflicts field is simply no conflicts.
/**
 * @param {{ conflicts?: string[] }} state The request state (only `conflicts` is touched).
 * @param {any} gap Raw gap-check JSON.
 * @returns {string[]} The accumulated conflict list.
 */
export function collectConflicts(state, gap) {
  const list = Array.isArray(gap?.conflicts) ? gap.conflicts : [];
  state.conflicts ||= [];
  for (const raw of list) {
    const c = typeof raw === "string" ? raw.trim() : "";
    if (!c || state.conflicts.includes(c)) continue;
    state.conflicts.push(c);
    if (state.conflicts.length >= 6) break;
  }
  return state.conflicts;
}

// The sub-question and source-conflict preambles for the synthesis input —
// both empty (and thus absent, keeping the input byte-identical to the
// pre-decomposition pipeline) unless triage decomposed the question or a gap
// round reported disagreeing sources.
/**
 * @param {string[] | undefined} subquestions
 * @returns {string}
 */
export function subquestionsSection(subquestions) {
  const list = Array.isArray(subquestions) ? subquestions.filter(Boolean) : [];
  if (!list.length) return "";
  return `Sub-questions the answer must address:\n${list.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n`;
}

/**
 * @param {string[] | undefined} conflicts
 * @returns {string}
 */
export function conflictsSection(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts.filter(Boolean) : [];
  if (!list.length) return "";
  return `Source conflicts detected during research (address each explicitly — cite both sides, never silently pick one):\n${list.map((c) => `- ${c}`).join("\n")}\n\n`;
}

/** @typedef {{ claim: string, source_ids: number[] }} Claim */

// Pure, lenient parse of the claim-extraction JSON ({claims:[{claim,
// source_ids}]} or a bare array) — drops junk, caps at 12, never throws.
/**
 * @param {any} value Raw claim-extraction JSON.
 * @returns {Claim[]}
 */
export function extractClaims(value) {
  const list = value && Array.isArray(value.claims) ? value.claims : Array.isArray(value) ? value : [];
  /** @type {Claim[]} */
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const claim = typeof c.claim === "string" ? c.claim.trim() : "";
    if (!claim) continue;
    const source_ids = (Array.isArray(c.source_ids) ? c.source_ids : [])
      .map((/** @type {any} */ n) => (typeof n === "number" ? Math.trunc(n) : Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : NaN))
      .filter((/** @type {number} */ n) => Number.isFinite(n) && n >= 1);
    out.push({ claim, source_ids });
    if (out.length >= 12) break;
  }
  return out;
}

// The round's runnable slice of the planned queries: trimmed, deduped
// against every query already run this request (state.ranQueries — marked
// as run here), and cut off at plan.maxSearches. Filtering happens BEFORE
// firing anything (not as a mid-loop break) so a batch can't overrun the
// cap.
/**
 * @param {SearchBatchState} state
 * @param {string[]} queries
 * @returns {string[]}
 */
export function takeSearchBatch(state, queries) {
  const batch = [];
  for (const raw of queries) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (state.ranQueries.has(key)) continue;
    if (state.searchCount + batch.length >= state.plan.maxSearches) break;
    state.ranQueries.add(key);
    batch.push(query);
  }
  return batch;
}

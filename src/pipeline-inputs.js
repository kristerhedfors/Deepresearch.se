// @ts-check
// The pipeline's PURE input-block builders and output parsers — the string/
// array shaping the phase functions in pipeline.js hand to (and take back
// from) the model, with zero ctx/env/emit/await. Split out of pipeline.js so
// the orchestration flow there reads as the flow, and these behavior-defining
// pure helpers get their own home and direct unit coverage. Mirrors the
// project's `-text.js` convention.
//
// Byte-identical-input discipline: every builder here returns "" (or []) in
// the default-budget / no-decomposition case, so the message arrays are
// byte-identical to the pre-feature pipeline. Do not change that without
// re-checking the pipeline's model-input snapshots.

import { notesDigest } from "./notes.js";
import { replyLinksTo } from "./build-pub.js";

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
//
// `sdkBuild` (feedback #7, 2026-07-24): on an Agent Studio build turn the
// ground-truth framing backfired — a transcript showing app files heredoc'd
// into /workspace read as "already built", so the model shipped nothing. The
// build variant frames the transcript as context ONLY and says outright that
// sandbox files are never published.
/**
 * @param {string} shellBlock
 * @param {{ sdkBuild?: boolean }} [opts]
 * @returns {Message[]}
 */
export function shellReplyMessages(shellBlock, opts = {}) {
  if (!shellBlock) return [];
  return [
    {
      role: "system",
      content:
        shellBlock +
        (opts.sdkBuild
          ? "\n\nThis sandbox transcript is CONTEXT ONLY: files created inside the sandbox are NOT part of the build and are NEVER published. Nothing has shipped yet — emit every file of the app through this turn's shipping mechanism yourself."
          : "\n\nUse this real sandbox output directly in your reply — it is ground truth you produced by running commands (no citation needed)."),
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

// What was actually SEARCHED, handed to synthesis so a report can say where it
// looked instead of asserting bare absence.
//
// Reported as feedback #61 (chat_logs #1656, 2026-08-05): a founder profile
// came back with eleven claims marked "self-reported only" or "unverifiable",
// and the user asked that each such conclusion be shown to have been attacked
// from several angles first. Sixteen angles HAD been run — the report simply
// had no way to know, so it wrote absence as a property of the world rather
// than of its own search. docs/PERSON-RESEARCH.md §6 already requires the
// opposite ("Say where you looked when you found nothing, so a reader can tell
// a thin record from a thin search"); nothing supplied the information.
//
// Deliberately NOT more retrieval: the de-noised benchmark behind
// budget.js's DEEP_TIER_FEATURES_ENABLED found extra pre-synthesis material
// net-negative (2.65 → 2.43, by context dilution), and the ground-truth
// battery puts the loss at 14:1 synthesis-over-retrieval. This adds a bounded
// list of queries already run — no search, no model call, no new sources.
// The planner allows up to 34 searches (budget.js searchCeiling); the cap here
// sits above that, so a normal request is never truncated at all and the
// exhaustive wording is the one that actually gets used.
const LEDGER_MAX = 40;

/**
 * @param {Set<string> | string[] | undefined} issuedQueries queries actually DISPATCHED (state.issuedQueries), never the planned set
 * @returns {string}
 */
export function searchLedgerSection(issuedQueries) {
  const all = issuedQueries instanceof Set ? [...issuedQueries] : Array.isArray(issuedQueries) ? issuedQueries : [];
  const clean = all.filter((q) => typeof q === "string" && q.trim());
  const list = clean.slice(0, LEDGER_MAX);
  if (!list.length) return "";
  // Say what this list IS, exactly. The first version claimed "the whole
  // search, not a sample" unconditionally, and was wrong two ways: it was
  // built from the PLANNED angles rather than the issued ones, and it silently
  // cut at 24 while the planner allows up to 34 searches. A prompt that
  // overstates its own evidence is the same defect as an answer that does —
  // which is the defect this block exists to prevent, so it does not get to
  // commit it. Truncation now says so rather than being smoothed over.
  const complete = clean.length === list.length;
  const head = complete
    ? "Search angles already run for this question (this is every angle that was issued, not a sample):\n"
    : `Search angles already run for this question — showing ${list.length} of ${clean.length} issued:\n`;
  return (
    head +
    `${list.map((q) => `- ${q}`).join("\n")}\n` +
    "When a claim remains uncorroborated, say which of these angles were tried and came back empty — " +
    "a reader must be able to tell a thin public record from a thin search. Never write that no source " +
    (complete
      ? "exists for something none of these angles targeted; say it was not searched for.\n\n"
      : "exists for something none of these angles targeted; say it was not searched for. This list is partial, so do not describe it as exhaustive.\n\n")
  );
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
//
// `cap` is the answering agent's declared `capability.search.maxQueries`
// (AgentSpec 0.2.0), which narrows the budget planner's own number and never
// widens it — the effective limit is the lower of the two. Omitted means the
// agent declared none, which is what the budget planner alone used to mean.
/**
 * @param {SearchBatchState} state
 * @param {string[]} queries
 * @param {number} [cap] the agent's declared query ceiling, if it declared one
 * @returns {string[]}
 */
export function takeSearchBatch(state, queries, cap = Infinity) {
  const limit = Math.min(state.plan.maxSearches, cap);
  const batch = [];
  for (const raw of queries) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (state.ranQueries.has(key)) continue;
    if (state.searchCount + batch.length >= limit) break;
    state.ranQueries.add(key);
    batch.push(query);
  }
  return batch;
}

// Sub-question fan-out merge (pipeline.js runSubquestionFanout): interleave
// the per-sub-question audit query lists round-robin in sub-question order —
// every sub-question gets its first pick before any gets a second, so one
// verbose audit can't starve the others out of the wave — deduped
// case-insensitively within the wave and capped. Deduping against queries
// already run (and the maxSearches cap) stays takeSearchBatch's job when the
// wave fires. Pure so the ordering rule that keeps the fan-out wave's source
// numbering deterministic is unit-pinned independent of the flag gating the
// phase.
/**
 * @param {(string[] | null | undefined)[]} queryLists Per-sub-question query lists, in sub-question order.
 * @param {number} cap Max queries in the merged wave.
 * @returns {string[]}
 */
export function mergeFanoutQueries(queryLists, cap) {
  const lists = queryLists.map((list) =>
    Array.isArray(list) ? list.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()) : [],
  );
  const merged = [];
  const seen = new Set();
  const deepest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let depth = 0; depth < deepest && merged.length < cap; depth++) {
    for (const list of lists) {
      if (merged.length >= cap) break;
      const query = list[depth];
      if (!query) continue;
      const key = query.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(query);
    }
  }
  return merged;
}

// The canned iteration question every build turn ends on (feedback #13 asked
// for exactly this closing). The prompts instruct the model to ask it in the
// user's own language; this English form is only the deterministic fallback
// when the reply didn't end by asking one.
export const SDK_ITERATION_QUESTION = "Does the app work as you hoped, or would you like to add or change anything?";

/** @param {string} text */
export const endsWithQuestion = (text) => /[?？][*_`")\]]*$/.test(String(text || "").trim());

/**
 * The reply tail a successful build turn ends on — feedback #13's requested
 * shape: a build summary, the live link (unless the prose already links it),
 * and the iteration question (unless the prose already asked one). Shared by
 * both build paths. With `published` null: the honest no-publish note.
 * @param {string} prose The model-written reply text already emitted ("" when none).
 * @param {{ slug: string, url: string, files: number, bytes: number, paths: string[] } | null} published
 * @returns {string}
 */
export function sdkReplyTail(prose, published) {
  /** @type {string[]} */
  const parts = [];
  if (published) {
    const kb = (published.bytes / 1024).toFixed(1);
    // What SHIPPED, not what the model staged: the publish layer injects the
    // app kit (feedback #66), so the staged list would undercount the summary
    // it is printed beside. src/build-pub.js publishBuild always returns
    // `paths`, and it is the only producer of this value — so there is no
    // staged-list fallback to keep, and the staged list is not what this
    // summary is documented to describe.
    const paths = published.paths || [];
    parts.push(`**Build summary:** ${published.files} file${published.files === 1 ? "" : "s"}, ${kb} KB — ${paths.join(" · ")}`);
    if (!replyLinksTo(prose, published.url)) {
      parts.push(`**Try it live:** [${published.url}](${published.url})`);
    }
    if (!endsWithQuestion(prose)) parts.push(SDK_ITERATION_QUESTION);
  } else {
    parts.push("_(Publishing was unavailable this turn — no live URL yet.)_");
  }
  return `${prose ? "\n\n" : ""}${parts.join("\n\n")}`;
}

/**
 * The note a build turn ends on when the model's output hit the token ceiling
 * mid-file and the continuation could not close it either (feedback #30,
 * chat_logs #650). Says what happened and what to do next — the one thing it
 * must never do is show the half-written file, which is what shipped instead
 * of a link.
 * @param {string} path The file that was cut off.
 * @param {boolean} anyPublished Whether other, complete files did publish.
 * @returns {string}
 */
export function sdkCutOffNote(path, anyPublished = false) {
  return anyPublished
    ? `\n\n_(\`${path}\` ran past the length limit and is not part of the published build. Ask me to write just that file and I'll add it to the same app.)_`
    : `\n\n_(The build ran past the length limit while writing \`${path}\`, so there's no live app to link this turn. Ask me to build it again in smaller pieces — a shorter first version, or one file at a time — and each piece gets published as it lands.)_`;
}

// How much of the cut-off file to hand back as the continuation's context. The
// model needs enough to resume mid-syntax, not the whole file — the draft it is
// continuing already cost a full output budget.
const CONTINUE_TAIL_CHARS = 4_000;

/**
 * The two turns that ask for the remainder of a truncated file: the fragment as
 * an assistant turn (so the roles still alternate — consecutive user turns are
 * rejected by some backends) and the instruction to resume from it.
 *
 * The one builder here that never returns []: it is called only on the
 * truncation branch, so the byte-identical-input discipline above is unaffected.
 * @param {{ path: string, content: string }} cut
 * @returns {import('./conversation.js').Msg[]}
 */
export function buildContinuationTurns(cut) {
  return /** @type {any} */ ([
    { role: "assistant", content: `…${cut.content.slice(-CONTINUE_TAIL_CHARS)}` },
    {
      role: "user",
      content:
        `That reply was cut off by the output limit, part-way through \`${cut.path}\`. ` +
        `Continue from exactly where it stopped: output ONLY the remaining content of ${cut.path} — no preamble, ` +
        "no explanation, and do not repeat or restart what is already written above. Close the fenced block with ```, " +
        "then write any files still missing in the same FILE: convention, then your short report.",
    },
  ]);
}

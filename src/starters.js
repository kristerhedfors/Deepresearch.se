// @ts-check
// Starter prompts — the SERVER FAÇADE. The implementation lives in ONE shared
// module, public/js/starters-core.js, with the registry itself in
// public/js/starters-data.js (the agent-spec-core.js / bash-core.js /
// introspect-core.js pattern), so both tiers' browsers, the CLI
// (scripts/starters), the eval harness (tests/starter-eval.mjs) and the Worker
// all read one source of truth. The core lives under public/ because the
// browser can only import served modules; the Worker bundler can import from
// anywhere, so the server reaches it through this re-export.
//
// New shared starter logic goes in starters-core.js; do not reintroduce a copy
// here. New starters go in starters-data.js — either into an agent's queue, or
// into the CANDIDATES trial pool that evaluation mode reviews before anything
// is promoted into a queue.

export {
  SLOT_COUNT,
  QUEUE_MIN,
  EXPLOIT_SLOTS,
  UNRANKED_SCORE,
  RANK_MIN,
  RANK_MAX,
  MIN_SV,
  MIN_ASPECTS,
  DEAD_END_CAP,
  SHORTLIST_FLOOR,
  MODE_AGENTS,
  agentForMode,
  resolveQueue,
  agentIds,
  starterStanding,
  isProven,
  selectStarters,
  nextCursor,
  recordStarterUse,
  shortlistFor,
  starterScore,
  rankStarters,
  starterJudgePrompt,
  parseJudgeReply,
  validateStarters,
  registryReport,
  EVAL_BANDS,
  bandOf,
  evalPool,
  selectEvalBatch,
  recordVerdict,
  verdictReport,
  coverageReport,
} from "../public/js/starters-core.js";

export { STARTERS, STARTERS_VERSION, ASPECTS, CANDIDATES } from "../public/js/starters-data.js";

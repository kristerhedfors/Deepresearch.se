// @ts-check
// Worker façade for the query-focus core. The logic lives under public/js/ so
// the Se/cure tier can import it as a served module (the same reason
// bash-core.js and introspect-core.js live there); this file is the seam
// src/pipeline.js imports, and adds nothing of its own.
//
// What it is for: feedback #65 — keeping the planner's search angles pointed at
// the subject rather than at the report format the user named. See the core for
// the measurement that made deterministic code necessary.
export {
  contentWords,
  focusQueriesOnSubject,
  isFormatChasingQuery,
  isFormatWord,
  subjectTokens,
} from "../public/js/query-focus-core.js";

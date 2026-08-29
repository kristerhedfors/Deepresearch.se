// @ts-check
// Worker-side façade for the research brief. The implementation is
// public/js/research-brief-core.js because BOTH tiers build this prompt and the
// browser can only import served modules (CLAUDE.md, "Code layout"); this file
// exists so Worker code imports it like any other src module.
//
// Re-export only — no wrapper, no default, no server-side variant. A façade
// that redefined a name would be a second brief, which is the drift the core
// was extracted to end; src/facade-contract.test.js discovers this pair
// automatically and asserts each shared name is the SAME function object.
export { BRIEF_EXEMPLARS, REPORT_TIER_STRUCTURE, briefFingerprint, researchBrief } from "../public/js/research-brief-core.js";

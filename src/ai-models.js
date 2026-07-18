// @ts-check
// SERVER FAÇADE for the AI/LLM model-name recognizer. The implementation — the
// family patterns, aiModelIntent/aiModelMentions, and the two prompt notes —
// lives in ONE shared pure module, public/js/ai-models.js, because the browser
// can only import modules the Worker serves (DRC's public/js/drc-research.js
// and public/js/stream.js import it directly). The Worker's bundler can import
// from any repo path, so the server reaches the same single source of truth
// through this re-export. Same arrangement as src/bash-agent.js ⇄
// public/js/bash-core.js — do NOT reintroduce a second copy.
//
// Server consumers: src/prompts.js (AI_MODEL_NOT_A_PACKAGE_NOTE in
// bashAgentPrompt, AI_MODEL_RESEARCH_NOTE in triagePrompt).

export {
  aiModelIntent,
  aiModelMentions,
  AI_MODEL_NOT_A_PACKAGE_NOTE,
  AI_MODEL_RESEARCH_NOTE,
} from "../public/js/ai-models.js";

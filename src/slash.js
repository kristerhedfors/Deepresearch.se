// @ts-check
// Se/rver façade for the slash-command registry. The implementation is the
// shared pure core public/js/slash-core.js — it lives under public/ because the
// browser can only import served modules, and this module re-exports it so the
// Worker (src/chat.js's routing, src/pipeline.js's feedback gate) resolves a
// command with the SAME table the two composers offer. Same convention as
// src/feedback.js → feedback-core.js and src/bash-agent.js → bash-core.js; the
// façade-IS-the-core contract is enforced by src/facade-contract.test.js.
//
// Nothing is added here. A slash command is platform baseline: it is resolved
// before the mode/agent dispatch, so every agent honors it identically.
export {
  SLASH,
  SLASH_COMMANDS,
  SLASH_COMMAND_NAMES,
  SLASH_EFFECTS,
  moveSlashIndex,
  parseSlashCommand,
  slashArgs,
  slashCommand,
  slashEffect,
  slashMenuItems,
  slashQuery,
  slashSuggestions,
} from "../public/js/slash-core.js";

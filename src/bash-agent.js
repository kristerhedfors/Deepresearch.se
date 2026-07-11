// @ts-check
// The bash-lite agent's SERVER FAÇADE. The actual implementation — the intent
// heuristic, the fenced-block parser, exec-result normalization, the synthesis
// transcript block, the shared step user-message, and the caps — lives in ONE
// shared pure module: public/js/bash-core.js. It sits under public/ because
// the browser can only import modules the Worker serves (the DRS loop driver
// public/js/bash-agent.js and DRC's drc-research.js both import it directly),
// while the Worker's bundler (wrangler/esbuild) can import from any repo path
// — so the server reaches the same single source of truth through this
// re-export. See bash-core.js's header for the full arrangement.
//
// Until 2026-07-11 this file carried its own copy, hand-mirrored against the
// client with "keep in lock-step" comments and a parity test. Don't
// reintroduce that: new shared logic goes in bash-core.js; anything genuinely
// server-only (like the /api/bash/step handler, src/bash-api.js) stays in src/.
//
// Server consumers and what they use:
//   - src/bash-api.js:  parseShellRequest, buildShellTranscript,
//                        buildStepUserMessage, normalizeExecResult, caps
//   - src/pipeline.js:  buildShellTranscript (ctx.shellBlock)
//   - src/chat.js:      MAX_SHELL_ROUNDS (shell_transcript bounding)

export {
  MAX_SHELL_ROUNDS,
  MAX_COMMANDS_PER_ROUND,
  MAX_OUTPUT_CHARS,
  MAX_COMMAND_CHARS,
  bashIntent,
  parseShellRequest,
  normalizeExecResult,
  formatShellResult,
  buildShellTranscript,
  buildStepUserMessage,
} from "../public/js/bash-core.js";

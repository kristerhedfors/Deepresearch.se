// @ts-check
// The CONVERSATIONAL watch builder's server FAÇADE: a pure re-export of the ONE
// shared core public/js/watch-chat-core.js (the text-command parser, the
// conversation walk that carries a build forward, the what-changed and
// suggestion text, and the answer-prompt block). No endpoint of its own — two
// consumers reach it from the Worker side:
//
//   src/pipeline.js   re-runs the SAME walk over the SAME messages the chat
//                     client did, so the answer prompt knows which watch is on
//                     screen and what the last message changed. No drift is
//                     possible: one implementation.
//   src/watch-tools.js  the MCP tool family, which is this parser with a
//                     JSON-RPC face on it (feedback #52 asked for both).
//
// The core lives under public/ for the reason watch-core.js does: the browser
// can only import served modules, the Worker bundler imports from anywhere.

export {
  WATCH_SLOT_KEYS,
  builderLink,
  changeSummary,
  commandFor,
  commandVocabulary,
  isContinuationFragment,
  isWatchTalk,
  parseWatchCommand,
  randomBuild,
  specLine,
  suggestCommands,
  watchPromptBlock,
  watchThread,
} from "../public/js/watch-chat-core.js";

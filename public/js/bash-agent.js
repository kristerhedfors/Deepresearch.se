// @ts-check
// The DRS client driver of the experimental bash-lite agent (the
// `bash_lite_mcp` knob). The sandbox is an x86 Linux emulator running in THIS
// browser (public/js/sandbox.js, CheerpX); the shared pure core — parsing,
// normalization, transcript building, and the generic agentic loop — lives in
// public/js/bash-core.js (one source of truth for server, DRS, and DRC alike).
//
// What is DRS-SPECIFIC, and therefore lives here, is where the step decision
// comes from: on DRS the command choice runs server-side (/api/bash/step —
// the keys are there), so this module supplies the fetch-backed step function
// and a runShellLoop wrapper stream.js drives before a /api/chat send:
//
//   1. runShellLoop asks the server (/api/bash/step) what to run next, runs it
//      in the sandbox, and repeats until the model is done or the round cap is
//      hit (the loop mechanics themselves are bash-core.js's runShellLoop).
//   2. The collected transcript (commands + real output) is handed back to
//      stream.js, which attaches it to /api/chat as `shell_transcript` so the
//      answer is written from the real results.
//
// NO function calling — the server's step endpoint returns a plain command
// list parsed from a fenced block. Fully fail-soft: any failure ends the loop
// with whatever was gathered and the answer proceeds normally.

import { MAX_SHELL_ROUNDS, runShellLoop as coreRunShellLoop } from "./bash-core.js";

// Re-export the shared pure API so existing consumers (and tests) can keep
// importing everything bash-lite from this module.
export {
  MAX_SHELL_ROUNDS,
  MAX_COMMANDS_PER_ROUND,
  MAX_OUTPUT_CHARS,
  MAX_COMMAND_CHARS,
  bashIntent,
  parseShellRequest,
  normalizeExecResult,
  formatShellResult,
  shellCommandLabel,
  buildShellTranscript,
  buildStepUserMessage,
} from "./bash-core.js";

/** @typedef {import('./bash-core.js').ShellRun} ShellRun */

// Ask the server for the next command(s), given the conversation and the runs
// so far. Returns the parsed proposal or a done signal on any failure (the
// loop then stops and the answer proceeds normally). Exported for tests.
/**
 * @param {object[]} messages
 * @param {ShellRun[]} transcript
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ commands: string[], done: boolean, reasoning: string }>}
 */
export async function fetchShellStep(messages, transcript, fetchImpl = fetch) {
  try {
    const res = await fetchImpl("/api/bash/step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, transcript }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { commands: [], done: true, reasoning: "" };
    return {
      commands: Array.isArray(data.commands) ? data.commands.filter((/** @type {any} */ c) => typeof c === "string") : [],
      done: data.done === true,
      reasoning: typeof data.reasoning === "string" ? data.reasoning : "",
    };
  } catch {
    return { commands: [], done: true, reasoning: "" };
  }
}

/**
 * The DRS-shaped agentic shell loop: bash-core.js's generic runShellLoop with
 * the step decision wired to /api/bash/step. The MODEL decides whether a shell
 * is needed at all (round 1 asks it cold; it returns done for anything that
 * doesn't need one), and `ensureReady` boots the VM lazily only once a command
 * is actually proposed — see the core driver for the full semantics. Never
 * throws.
 * @param {{
 *   messages: object[],
 *   exec: (command: string) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   ensureReady?: () => Promise<boolean>,
 *   onStep?: (info: { round: number, reasoning: string, commands: string[] }) => void,
 *   onExec?: (command: string, info: { round: number, index: number }) => void,
 *   onResult?: (run: ShellRun) => void,
 *   maxRounds?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 * @returns {Promise<ShellRun[]>}
 */
export function runShellLoop({ messages, exec, ensureReady, onStep, onExec, onResult, maxRounds = MAX_SHELL_ROUNDS, fetchImpl = fetch }) {
  return coreRunShellLoop({
    step: (transcript) => fetchShellStep(messages, transcript, fetchImpl),
    exec,
    ensureReady,
    onStep,
    onExec,
    onResult,
    maxRounds,
  });
}

// @ts-check
// The DRS client half of the experimental bash-lite agent (the
// `bash_lite_mcp` knob). The sandbox is an x86 Linux emulator running in THIS
// browser (public/js/sandbox.js, CheerpX); this module owns the agentic loop
// that drives it before a /api/chat send:
//
//   1. bashIntent decides whether the latest message wants a shell at all.
//   2. runShellLoop asks the server (/api/bash/step) what command to run
//      next, runs it in the sandbox, and repeats until the model is done or
//      MAX_SHELL_ROUNDS is hit.
//   3. The collected transcript (commands + real output) is handed back to
//      stream.js, which attaches it to /api/chat as `shell_transcript` so the
//      answer is written from the real results.
//
// The command DECISIONS live server-side (the keys are there); only EXECUTION
// is client-side (the sandbox is here). NO function calling — the server's
// step endpoint returns a plain command list parsed from a fenced block.
//
// The intent gate below MIRRORS src/bash-agent.js's bashIntent — the server
// has no say in whether the client boots the sandbox, so the two must agree.
// Keep them in lock-step (EN+SV parity, invariant 6); the parity is asserted
// in both this module's test and the server's.

export const MAX_SHELL_ROUNDS = 6;
export const MAX_COMMANDS_PER_ROUND = 6;
export const MAX_OUTPUT_CHARS = 4000;
export const MAX_COMMAND_CHARS = 2000;

// Mirror of src/bash-agent.js SHELL_PATTERNS — see that file for the rationale
// behind each pair. English and Swedish side by side, one pair per concept.
const SHELL_PATTERNS = [
  /\b(shell|bash|zsh|command[- ]?line|command[- ]?prompt|terminal|console)\b/,
  /\b(skal(et)?|kommando ?rad(en)?|kommandotolk(en)?|terminal(en)?|konsol(en)?)\b/,
  /\b(run|execute|exec)\b[^.\n]{0,40}\b(command|commands|code|script|scripts|program|programs|snippet|snippets|binary|binaries|calculation|calculations|computation|computations)\b/,
  /\b(command|code|script|program|snippet|calculation|computation)\b[^.\n]{0,20}\b(run|execute|exec)\b/,
  /\b(kör|köra|exekvera|exekvering)\b[^.\n]{0,40}\b(kommando(t|n)?|kod(en)?|skript(et|en)?|program(met)?|snutt(en)?|beräkning(en|ar|arna)?)\b/,
  /\b(kommando(t|n)?|kod(en)?|skript(et|en)?|program(met)?|beräkning(en)?)\b[^.\n]{0,20}\b(kör|köra|exekvera)\b/,
  /\bin (the |a |your )?(sandbox|linux(-| )?(vm|box)?|vm|emulator)\b/,
  /\bi (en |din )?(sandlåd(a|an)|linux(-| )?(vm|burk)?|vm|emulator(n)?)\b/,
  /\b(compute|calculate|crunch|evaluate)\b[^.\n]{0,30}\b(this|the|these|for me)\b/,
  /\b(beräkna|räkna ut|räkna ?ut|evaluera)\b[^.\n]{0,30}\b(det|den|det här|dessa|åt mig)\b/,
  /\b(pipe (this|it|the)|grep (through|the|for)|use (jq|awk|sed|grep) (on|to|for))\b/,
];

/**
 * Does this message ask to run a shell / execute code / compute in the
 * sandbox? Mirrors the server gate; EN+SV parity.
 * @param {string} text
 * @returns {boolean}
 */
export function bashIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  return SHELL_PATTERNS.some((re) => re.test(t));
}

/**
 * @typedef {{ command: string, exitCode: number, stdout: string, stderr: string }} ShellRun
 */

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

// ---- fenced-block parsing + transcript (mirror of src/bash-agent.js) --------
// DRC (public/cure/) has NO server, so it parses the model's fenced ```bash
// proposal and builds the synthesis transcript block in the browser. These
// mirror the server's src/bash-agent.js exactly; keep them in lock-step.

const SHELL_LANGS = new Set(["bash", "sh", "shell", "console", "zsh", "shellsession"]);

/**
 * @param {string} text
 * @returns {{ commands: string[], done: boolean, reasoning: string }}
 */
export function parseShellRequest(text) {
  const raw = String(text || "");
  const doneMarker = /(^|\s)(SHELL_DONE|\[done\]|<<done>>)(\s|$)/i.test(raw);
  const block = extractFirstCodeBlock(raw);
  const reasoning = reasoningText(raw, block);
  if (!block) return { commands: [], done: true, reasoning };
  const commands = splitCommands(block.body);
  if (!commands.length) return { commands: [], done: true, reasoning };
  return { commands, done: doneMarker && !commands.length, reasoning };
}

/** @param {string} text */
function extractFirstCodeBlock(text) {
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) {
    const lang = (m[1] || "").trim().toLowerCase();
    if (lang === "" || SHELL_LANGS.has(lang)) return { lang, body: m[2] || "" };
  }
  return null;
}

/** @param {string} raw @param {{ body: string } | null} block */
function reasoningText(raw, block) {
  let prose = raw;
  if (block) prose = raw.replace(/```[^\n`]*\n[\s\S]*?```/g, " ");
  return prose.replace(/(^|\s)(SHELL_DONE|\[done\]|<<done>>)(\s|$)/gi, " ").replace(/\s+/g, " ").trim().slice(0, 400);
}

/** @param {string} body */
function splitCommands(body) {
  const joined = String(body || "").replace(/\\\n/g, " ");
  const out = [];
  for (const line of joined.split("\n")) {
    const cmd = line.trim();
    if (!cmd || cmd.startsWith("#")) continue;
    out.push(cmd.slice(0, MAX_COMMAND_CHARS));
    if (out.length >= MAX_COMMANDS_PER_ROUND) break;
  }
  return out;
}

/**
 * @param {string} command
 * @param {any} result
 * @returns {ShellRun}
 */
export function normalizeExecResult(command, result) {
  const r = result && typeof result === "object" ? result : {};
  const exitCode = Number.isFinite(Number(r.exitCode)) ? Math.trunc(Number(r.exitCode)) : 1;
  return {
    command: String(command || "").slice(0, MAX_COMMAND_CHARS),
    exitCode,
    stdout: clampOutput(r.stdout),
    stderr: clampOutput(r.stderr),
  };
}

/** @param {any} s */
function clampOutput(s) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  if (str.length <= MAX_OUTPUT_CHARS) return str;
  return str.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${str.length - MAX_OUTPUT_CHARS} chars]`;
}

/**
 * @param {ShellRun} run
 * @returns {string}
 */
export function formatShellResult(run) {
  const r = normalizeExecResult(run.command, run);
  const parts = [`$ ${r.command}`, `exit: ${r.exitCode}`];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.replace(/\s+$/, "")}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.replace(/\s+$/, "")}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}

/**
 * @param {ShellRun[]} runs
 * @returns {string}
 */
export function buildShellTranscript(runs) {
  const list = Array.isArray(runs) ? runs.filter((r) => r && r.command) : [];
  if (!list.length) return "";
  const body = list.map((r) => formatShellResult(r)).join("\n\n");
  return (
    "Linux sandbox session (commands the assistant ran in the in-browser " +
    "execution sandbox and their real output — treat this as ground truth " +
    "you produced, and refer to it as \"the sandbox\" when you use it):\n" +
    body
  );
}

/**
 * Run the agentic shell loop: repeatedly ask the server what to run, execute
 * each command in the sandbox, and accumulate a transcript, until the model is
 * done or the round cap is hit. Never throws — a failing step or exec ends the
 * loop with whatever was gathered so far.
 * @param {{
 *   messages: object[],
 *   exec: (command: string) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   onStep?: (info: { round: number, reasoning: string, commands: string[] }) => void,
 *   onResult?: (run: ShellRun) => void,
 *   maxRounds?: number,
 *   fetchImpl?: typeof fetch,
 * }} params
 * @returns {Promise<ShellRun[]>}
 */
export async function runShellLoop({ messages, exec, onStep, onResult, maxRounds = MAX_SHELL_ROUNDS, fetchImpl = fetch }) {
  /** @type {ShellRun[]} */
  const transcript = [];
  for (let round = 1; round <= maxRounds; round++) {
    const step = await fetchShellStep(messages, transcript, fetchImpl);
    if (step.done || !step.commands.length) break;
    if (onStep) onStep({ round, reasoning: step.reasoning, commands: step.commands });
    for (const command of step.commands) {
      let res;
      try {
        res = await exec(command);
      } catch (err) {
        res = { exitCode: 1, stdout: "", stderr: String((/** @type {any} */ (err))?.message || err) };
      }
      const run = {
        command,
        exitCode: Number.isFinite(Number(res?.exitCode)) ? Math.trunc(Number(res.exitCode)) : 1,
        stdout: typeof res?.stdout === "string" ? res.stdout : "",
        stderr: typeof res?.stderr === "string" ? res.stderr : "",
      };
      transcript.push(run);
      if (onResult) onResult(run);
    }
  }
  return transcript;
}

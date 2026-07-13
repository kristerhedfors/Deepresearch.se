// @ts-check
// The bash-lite agent's SHARED PURE CORE — the single source of truth for the
// experimental in-browser Linux execution sandbox (the `bash_lite_mcp` knob on
// DRS, `bashLite` on DRC).
//
// The sandbox is a JavaScript x86 Linux emulator (CheerpX) that boots IN THE
// BROWSER (public/js/sandbox.js) — the server never runs a shell — so the
// agentic loop is client-orchestrated. The model proposes shell commands in a
// plain fenced ```bash block (a TEXT convention — NO function calling,
// invariant 1, so this works on any model in the catalog), the browser sandbox
// runs them, the output feeds back, and it loops until the model is done. The
// collected transcript then rides into synthesis as one more labeled research-
// context block, exactly like an enrichment (src/enrichment.js).
//
// WHY THIS FILE LIVES UNDER public/js/: the exact same deterministic logic is
// needed in THREE places — the Worker (src/bash-api.js parses the model's
// step; src/pipeline.js builds the synthesis block), the DRS client
// (public/js/bash-agent.js drives the loop against /api/bash/step), and the
// DRC client (public/js/drc-research.js drives the loop against the user's own
// provider). A browser can only import modules the Worker actually serves
// (public/), while the Worker's bundler (wrangler/esbuild) can import from any
// repo path — so the shared module must live here, and src/bash-agent.js is a
// thin re-export façade over it. Until 2026-07-11 the server and client each
// kept a hand-mirrored copy with "keep in lock-step" comments and a parity
// test; this module replaces that mirror discipline with one implementation.
// Do NOT reintroduce a copy — import (or re-export) this file instead.
//
// What lives here (pure, I/O-free, Node-tested in bash-core.test.js):
//   - bashIntent:            does a message LOOK like it wants a shell? (EN+SV)
//   - parseShellRequest:     read the model's fenced-block command proposal
//   - normalizeExecResult:   clamp an untrusted {exitCode,stdout,stderr}
//   - formatShellResult:     render one executed command back for the next turn
//   - buildShellTranscript:  the labeled context block synthesis reads
//   - buildStepUserMessage:  the per-round user message both step callers send
//   - runShellLoop:          the generic agentic driver (step fn injected)
//
// The whole capability is fail-soft: a missed intent, an empty proposal, a
// failing step call, or a sandbox that never boots all degrade to a normal
// answer.

// Hard caps — the loop and every rendered chunk are bounded so a runaway
// command (or a hostile model) cannot blow the context window or spin
// forever. Shared by both tiers so DRS and DRC agree on the limits.
export const MAX_SHELL_ROUNDS = 6; // agentic iterations before we synthesize regardless
export const MAX_COMMANDS_PER_ROUND = 6; // commands accepted from one model turn
export const MAX_OUTPUT_CHARS = 4000; // per-command stdout/stderr kept in the transcript
export const MAX_COMMAND_CHARS = 2000; // a single command line is clamped to this

// ---- intent gate ----------------------------------------------------------

// Does the latest user message LOOK like it asks to run a shell / execute code
// / compute something in the sandbox? A non-authoritative HEURISTIC — NOT the
// execution gate. The MODEL decides whether a shell is actually needed (it is
// asked cold each turn via bashAgentPrompt and returns SHELL_DONE for anything
// that doesn't need one), because a regex misses obvious asks like "list
// files" or "run la -la" (the production defect, chat_logs #200/#201). This is
// kept as a cheap classifier for callers that want a quick signal without a
// model call; deterministic and typo-tolerant with FULL Swedish parity.
// Exported for unit tests.
//
// The gate matches when the message contains an execution VERB/NOUN that is
// about running commands or code — not the many innocent senses of "run"
// ("run a marathon", "in the long run"), which is why "run" alone never
// matches; it needs a shell/command/code/script object or an explicit
// sandbox/terminal reference.
/**
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function bashIntent(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  return SHELL_PATTERNS.some((re) => re.test(t));
}

// The intent patterns. English and Swedish are kept side by side, one pair
// per concept, so parity is auditable at a glance (and enforced by the
// parity unit test). Typos mirror the English typo sets per invariant 6.
const SHELL_PATTERNS = [
  // "shell" / "bash" / "command line" / "terminal" — the tool itself.
  // EN: shell, bash, zsh, command line/prompt, terminal, console
  /\b(shell|bash|zsh|command[- ]?line|command[- ]?prompt|terminal|console)\b/,
  // SV: skal(et), skal-kommando, kommandorad(en), terminal(en), konsol(en)
  /\b(skal(et)?|kommando ?rad(en)?|kommandotolk(en)?|terminal(en)?|konsol(en)?)\b/,

  // run / execute + a command/code/script/computation object.
  // EN: run/execute this command|code|script|program|snippet|calculation
  /\b(run|execute|exec)\b[^.\n]{0,40}\b(command|commands|code|script|scripts|program|programs|snippet|snippets|binary|binaries|calculation|calculations|computation|computations)\b/,
  // EN: run/execute the command|code|... (command first is covered above; the
  // reverse "the code, run it" order):
  /\b(command|code|script|program|snippet|calculation|computation)\b[^.\n]{0,20}\b(run|execute|exec)\b/,
  // SV: kör/köra/exekvera det här kommandot|koden|skriptet|programmet|beräkningen
  /\b(kör|köra|exekvera|exekvering)\b[^.\n]{0,40}\b(kommando(t|n)?|kod(en)?|skript(et|en)?|program(met)?|snutt(en)?|beräkning(en|ar|arna)?)\b/,
  // SV: reverse order "koden, kör den"
  /\b(kommando(t|n)?|kod(en)?|skript(et|en)?|program(met)?|beräkning(en)?)\b[^.\n]{0,20}\b(kör|köra|exekvera)\b/,

  // explicit "in the sandbox / in a linux vm / on the emulator".
  // EN: in the sandbox / in a VM / linux vm / emulator
  /\bin (the |a |your )?(sandbox|linux(-| )?(vm|box)?|vm|emulator)\b/,
  // SV: i sandlådan / i en linux-vm / i emulatorn
  /\bi (en |din )?(sandlåd(a|an)|linux(-| )?(vm|burk)?|vm|emulator(n)?)\b/,

  // compute / calculate + (this|the) — a request to actually work a number
  // out rather than explain it. Kept explicit (needs a "this/the/for me"
  // object) so "how do you calculate X" (a knowledge question) doesn't match.
  // EN: compute/calculate this/the …, work this out, crunch the numbers
  /\b(compute|calculate|crunch|evaluate)\b[^.\n]{0,30}\b(this|the|these|for me)\b/,
  // SV: beräkna/räkna ut det här, kör beräkningen
  /\b(beräkna|räkna ut|räkna ?ut|evaluera)\b[^.\n]{0,30}\b(det|den|det här|dessa|åt mig)\b/,

  // pipe/grep/awk/sed and friends spelled out as a request ("pipe this
  // through jq", "grep the file for …") — a strong shell signal in any
  // language. Command names are language-neutral, so this one pattern serves
  // both; the surrounding verb parity is covered by the rules above.
  /\b(pipe (this|it|the)|grep (through|the|for)|use (jq|awk|sed|grep) (on|to|for))\b/,
];

// ---- the model's command proposal -----------------------------------------

/**
 * One executed command and what the sandbox returned.
 * @typedef {{ command: string, exitCode: number, stdout: string, stderr: string }} ShellRun
 */

/**
 * The model's parsed step: the commands to run this round, whether it has
 * declared itself done, and its plain-language reasoning (the prose outside
 * the code block — surfaced in the activity UI so the run is legible).
 * @typedef {{ commands: string[], done: boolean, reasoning: string }} ShellProposal
 */

// Parse one agent turn. The convention (see prompts.js bashAgentPrompt): the
// model writes brief reasoning, then EITHER a fenced ```bash (or ```sh /
// ```shell / ```console) block whose non-comment lines are the commands to
// run, OR — when it has everything it needs — the literal marker SHELL_DONE
// and no block. Lenient and never throws: no block AND no explicit request
// means done (there's nothing left to run), which is the natural terminator.
//
// Commands are split on newlines (one command per line; a multi-line command
// can still use trailing `\` continuations, joined here), comments and blanks
// dropped, each clamped to MAX_COMMAND_CHARS, and the batch capped at
// MAX_COMMANDS_PER_ROUND. Exported for unit tests.
/**
 * @param {string} text the model's raw completion for this step
 * @returns {ShellProposal}
 */
export function parseShellRequest(text) {
  const raw = String(text || "");
  const doneMarker = /(^|\s)(SHELL_DONE|\[done\]|<<done>>)(\s|$)/i.test(raw);

  const block = extractFirstCodeBlock(raw);
  const reasoning = reasoningText(raw, block);

  if (!block) {
    // No command block: the model is done (explicit marker or simply nothing
    // more to run). Either way the loop terminates.
    return { commands: [], done: true, reasoning };
  }

  const commands = splitCommands(block.body);
  if (!commands.length) {
    // A block with no runnable lines is treated as done rather than looping
    // on an empty request.
    return { commands: [], done: true, reasoning };
  }
  // A done marker alongside a block is contradictory; honor the block (run
  // these, then the next turn decides) unless the block is empty.
  return { commands, done: doneMarker && !commands.length, reasoning };
}

// Pull the first fenced code block whose info-string names a shell language
// (bash/sh/shell/console/zsh) or is bare (```). Returns {lang, body} or null.
/**
 * @param {string} text
 * @returns {{ lang: string, body: string } | null}
 */
function extractFirstCodeBlock(text) {
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) {
    const lang = (m[1] || "").trim().toLowerCase();
    if (lang === "" || SHELL_LANGS.has(lang)) {
      return { lang, body: m[2] || "" };
    }
  }
  return null;
}

const SHELL_LANGS = new Set(["bash", "sh", "shell", "console", "zsh", "shellsession"]);

// The prose outside the (first) code block — the model's reasoning, trimmed
// and collapsed to one line for the activity UI. Empty when there's nothing.
/**
 * @param {string} raw
 * @param {{ body: string } | null} block
 * @returns {string}
 */
function reasoningText(raw, block) {
  let prose = raw;
  if (block) prose = raw.replace(/```[^\n`]*\n[\s\S]*?```/g, " ");
  return prose
    .replace(/(^|\s)(SHELL_DONE|\[done\]|<<done>>)(\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

// Split a shell block into individual command lines: join `\`-continuations,
// drop comments (# …) and blank lines, clamp each, cap the batch.
/**
 * @param {string} body
 * @returns {string[]}
 */
function splitCommands(body) {
  const joined = String(body || "").replace(/\\\n/g, " ");
  const out = [];
  for (const line of joined.split("\n")) {
    const cmd = line.trim();
    if (!cmd) continue;
    if (cmd.startsWith("#")) continue;
    out.push(cmd.slice(0, MAX_COMMAND_CHARS));
    if (out.length >= MAX_COMMANDS_PER_ROUND) break;
  }
  return out;
}

// ---- execution results ----------------------------------------------------

// Coerce an untrusted exec result (it comes back from the browser sandbox
// bridge, or — in DRS — round-trips through the client) into a clean ShellRun:
// numeric exit code, string streams clamped to MAX_OUTPUT_CHARS with a
// truncation marker. Never throws. Exported for unit tests.
/**
 * @param {string} command
 * @param {any} result the raw {exitCode,stdout,stderr} from the sandbox
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

/**
 * @param {any} s
 * @returns {string}
 */
function clampOutput(s) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  if (str.length <= MAX_OUTPUT_CHARS) return str;
  return str.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${str.length - MAX_OUTPUT_CHARS} chars]`;
}

// Render one executed command + result back into the transcript the model
// sees on the next agent turn (and that buildShellTranscript folds into the
// synthesis context). Deterministic formatting so both tiers read identically.
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

// Shorten a command to a single line fit for a live activity label — both
// tiers surface WHICH command is running (not just a count), so a long command
// is collapsed to one line and clipped with an ellipsis. Pure; never throws.
/**
 * @param {string} command
 * @param {number} [max]
 * @returns {string}
 */
export function shellCommandLabel(command, max = 72) {
  const one = String(command == null ? "" : command).replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(1, max - 1)).replace(/\s+$/, "") + "…";
}

// ---- the transcript block synthesis reads ---------------------------------

// The labeled context block appended to the synthesis input (pipeline.js
// shellSection / drc-research.js), mirroring the enrichment-block convention:
// a titled block the answer prompt is told it may use and cite as "the
// sandbox". Empty string when no command ran — so the synthesis input is
// byte-identical to a run without the sandbox. Exported for unit tests.
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

// ---- the per-round step message --------------------------------------------

// The USER message for one agent-step model call, shared by both step callers
// (src/bash-api.js on DRS, drc-research.js's provider call on DRC) so the two
// tiers ask the model the exact same question: the task, the conversation
// context, and — after the first round — the transcript so far. The system
// half stays tier-specific (prompts.js bashAgentPrompt / drcBashAgentPrompt).
/**
 * @param {{ task: string, context: string, priorBlock?: string }} params
 * @returns {string}
 */
export function buildStepUserMessage({ task, context, priorBlock = "" }) {
  return (
    `Task (latest user message):\n${task}\n\nConversation context:\n${context}\n\n` +
    (priorBlock
      ? `${priorBlock}\n\nDecide the next command(s), or reply SHELL_DONE if the answer has everything it needs.`
      : "No commands have run yet. Decide the first command(s) to run, or reply SHELL_DONE if a shell is not actually needed.")
  );
}

// ---- the agentic loop driver ------------------------------------------------

/**
 * Run the agentic shell loop: repeatedly ask the MODEL what to run next (via
 * the injected `step`) and execute it in the sandbox, until the model is done
 * or the round cap is hit. Generic over WHO answers the step — DRS injects a
 * /api/bash/step fetch (public/js/bash-agent.js), DRC injects a direct call to
 * the user's own provider (drc-research.js) — so both tiers share one driver.
 *
 * The MODEL decides whether a shell is needed at all — round 1 asks it cold,
 * and it returns done immediately for anything that doesn't need a shell, so
 * this is safe to run for every message when the knob is on (no brittle
 * client-side keyword gate). `ensureReady` boots the VM LAZILY — it's called
 * only once the model actually proposes a command, so a message that needs no
 * shell never boots the (expensive) VM. Never throws — a failing step or exec
 * ends the loop with whatever was gathered so far.
 *
 * The optional callbacks report progress for the activity UI: `onStep` fires
 * once per round with the model's reasoning + the whole batch; `onExec` fires
 * just before each individual command runs (the live "$ command" line); and
 * `onResult` fires after each command with the full ShellRun (command + exit +
 * output). All three are wrapped fail-soft so decoration can't break the loop.
 * @param {{
 *   step: (transcript: ShellRun[], round: number) => Promise<ShellProposal>,
 *   exec: (command: string) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   ensureReady?: () => Promise<boolean>,
 *   onStep?: (info: { round: number, reasoning: string, commands: string[] }) => void,
 *   onExec?: (command: string, info: { round: number, index: number }) => void,
 *   onResult?: (run: ShellRun) => void,
 *   maxRounds?: number,
 * }} params
 * @returns {Promise<ShellRun[]>}
 */
export async function runShellLoop({ step, exec, ensureReady, onStep, onExec, onResult, maxRounds = MAX_SHELL_ROUNDS }) {
  /** @type {ShellRun[]} */
  const transcript = [];
  // null = not yet booted; true/false = boot outcome. No ensureReady → ready.
  let ready = ensureReady ? null : true;
  for (let round = 1; round <= maxRounds; round++) {
    /** @type {ShellProposal} */
    let proposal;
    try {
      proposal = await step(transcript, round);
    } catch {
      break; // a failing step ends the loop with what we have (fail-soft)
    }
    const commands = Array.isArray(proposal?.commands)
      ? proposal.commands.filter((c) => typeof c === "string" && c)
      : [];
    if (proposal?.done === true || !commands.length) break;
    // The model wants to run something — boot the VM now (once). If it can't
    // boot, stop with whatever we have rather than looping on failures.
    if (ready === null && ensureReady) ready = await ensureReady();
    if (!ready) break;
    if (onStep) { try { onStep({ round, reasoning: typeof proposal.reasoning === "string" ? proposal.reasoning : "", commands }); } catch { /* ignore */ } }
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      // Surface WHICH command is about to run (before it does) so the UI can
      // show the live command, not just a counter. Fail-soft — a decoration
      // callback must never break execution.
      if (onExec) { try { onExec(command, { round, index }); } catch { /* ignore */ } }
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
      if (onResult) { try { onResult(run); } catch { /* ignore */ } }
    }
  }
  return transcript;
}

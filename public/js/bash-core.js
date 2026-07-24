// @ts-check
// The bash-lite agent's SHARED PURE CORE — the single source of truth for the
// experimental in-browser Linux execution sandbox (the `bash_lite_mcp` knob on
// DRS, `bashLite` on DRC). The sandbox is the INTEGRATED LINUX ENVIRONMENT of
// the DeepResearch Agents SDK (docs/AGENT-PLATFORM.md) — the surface where an
// agent or an Agent Studio build runs and tests code. It is execution-only:
// files created in the sandbox are never published; shipping goes through
// Agent Studio's build tools (sdk-core.js BUILD_TOOLS).
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
export const MAX_COMMAND_CHARS = 8000; // one command clamped to this (heredoc file writes need room; a mid-body truncation would leave the doc unterminated)
// Total wall-clock budget for the WHOLE loop (the lazy first boot — a ~25 s cold
// Debian stream, slower still on iOS where the persistent /workspace IndexedDB
// mount alone can take 20–30 s — plus every round's model call and command). A
// backstop against a slow-but-not-wedged run piling rounds up until the client
// gives the connection up for stalled (the 2026-07-13 iOS "stream stalled"
// failure); a single wedged command is caught faster by the teardown check below.
export const MAX_SHELL_WALL_MS = 120000;
// The default per-command ceiling the executor races every guest command
// against (public/js/sandbox.js execInSandbox), and its floor when scoped
// down. Defined HERE (not in sandbox.js) so the budget clamp below and both
// tiers' drivers agree on the numbers without importing browser glue.
export const DEFAULT_EXEC_TIMEOUT_MS = 30000;
export const MIN_EXEC_TIMEOUT_MS = 5000;

// How long the FIRST command after a cold boot waits for the one-time file
// seed (the /src source tree above all — a ~6.8 MB extraction that legitimately
// takes ~80 s on iOS: chat_logs #526, fs.ms 80401) to finish before giving up.
// This is deliberately DECOUPLED from the per-command exec ceiling: the seed is
// BOOT/setup latency, not command runtime, so judging it by the 30 s command
// ceiling (which exists to catch a wedged RUNNING command) is what made
// `ls -l /src` soft-fail ("still preparing") on every FIRST boot after a deploy
// — the stamp changes, forcing a full re-seed — even though the seed was a few
// seconds from finishing (it already had a ~45 s head start inside the boot's
// "mounting files" stage). Larger than DEFAULT_EXEC_TIMEOUT_MS so the tail is
// covered, but well under MAX_SHELL_WALL_MS so a slow first boot still leaves
// budget for real commands; a seed older than sandbox.js SEED_WEDGE_MS (180 s)
// is declared wedged and fast-failed regardless, never waited on this long.
export const SEED_WAIT_MS = 60000;

/**
 * Scope the per-command exec ceiling to the user's research time budget.
 * A question scoped to 15 s must not sit 30 s on one wedged command
 * (chat_logs #522: budget_s 15, `ls -l /src` timed out at the fixed 30 s) —
 * the ceiling becomes min(budget, default), floored at MIN_EXEC_TIMEOUT_MS so
 * a tiny budget still lets a real command finish. No/invalid budget keeps the
 * default — behavior is byte-identical for callers that never had a budget.
 * @param {number | null | undefined} budgetS research time budget in seconds
 * @returns {number} the per-command timeout in ms
 */
export function execTimeoutForBudget(budgetS) {
  const n = Number(budgetS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.max(MIN_EXEC_TIMEOUT_MS, Math.min(DEFAULT_EXEC_TIMEOUT_MS, Math.round(n * 1000)));
}

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

// Find the here-document delimiters opened on one logical command line, in the
// order they appear. Each entry is { delim, stripTabs } — stripTabs is the
// `<<-` form (leading tabs stripped from the terminator). Recognizes the quoted
// (`<< 'EOF'`, `<<"EOF"`) and unquoted (`<< EOF`, `<<EOF`, `<<-EOF`) forms.
// A here-STRING (`<<<`) is NOT a heredoc — it consumes no following lines — so
// it is deliberately skipped. Scanned by hand (not one regex) so `<<<` and the
// several spacing/quoting variants are all handled without lookbehind. Exported
// for unit tests.
/**
 * @param {string} line one logical command line
 * @returns {Array<{ delim: string, stripTabs: boolean }>}
 */
export function heredocDelimiters(line) {
  const s = String(line || "");
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] !== "<" || s[i + 1] !== "<") continue;
    // `<<<` is a here-string, not a heredoc — skip past it entirely.
    if (s[i + 2] === "<") { i += 2; continue; }
    let j = i + 2;
    let stripTabs = false;
    if (s[j] === "-") { stripTabs = true; j++; }
    while (s[j] === " " || s[j] === "\t") j++;
    let quote = "";
    if (s[j] === "'" || s[j] === '"') { quote = s[j]; j++; }
    let delim = "";
    if (quote) {
      while (j < s.length && s[j] !== quote) { delim += s[j]; j++; }
    } else {
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) { delim += s[j]; j++; }
    }
    if (delim) { out.push({ delim, stripTabs }); i = j - 1; }
  }
  return out;
}

// Split a shell block into individual commands. One command per line, EXCEPT a
// here-document (`cat > file << 'EOF'` … `EOF`) is kept WHOLE — opener plus its
// literal body plus the terminator — as a single multi-line command, so the
// body reaches /bin/sh intact instead of each line running as its own command
// (the "import: not found / class: not found" symptom when a model writes a
// file via a heredoc — feedback #3, 2026-07-23). Outside a heredoc: join
// `\`-continuations, drop comments (# …) and blank lines. Each command is
// clamped to MAX_COMMAND_CHARS and the batch capped at MAX_COMMANDS_PER_ROUND.
// Exported (indirectly via parseShellRequest) — unit-tested there.
/**
 * @param {string} body
 * @returns {string[]}
 */
function splitCommands(body) {
  const lines = String(body || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    // Build the logical opener line, joining trailing-`\` continuations — but
    // stop the moment the line opens a heredoc (its body is literal, consumed
    // below, and must NOT have continuations collapsed).
    let logical = lines[i];
    while (/\\\s*$/.test(logical) && i + 1 < lines.length && !heredocDelimiters(logical).length) {
      i++;
      logical = logical.replace(/\\\s*$/, " ") + lines[i];
    }
    const delims = heredocDelimiters(logical);
    if (delims.length) {
      // Consume body lines until every opened delimiter has been closed (or the
      // block ends — an unterminated heredoc still fails soft as one command).
      const parts = [logical];
      let d = 0;
      while (d < delims.length && i + 1 < lines.length) {
        i++;
        const bodyLine = lines[i];
        parts.push(bodyLine);
        const cur = delims[d];
        const cmp = cur.stripTabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
        if (cmp === cur.delim) d++;
      }
      const cmd = parts.join("\n").trim();
      if (cmd) out.push(cmd.slice(0, MAX_COMMAND_CHARS));
    } else {
      const cmd = logical.trim();
      if (cmd && !cmd.startsWith("#")) out.push(cmd.slice(0, MAX_COMMAND_CHARS));
    }
    if (out.length >= MAX_COMMANDS_PER_ROUND) break;
    i++;
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

// ---- outbox deliverables ----------------------------------------------------

// The DOWNLOAD FLOW's guest-side convention: a special folder the agent copies
// finished artifacts into. Files sitting in /workspace/outbox when the shell
// loop ends are exported OUT of the VM (sandbox.js collectDeliverables →
// exportFile's base64-through-exec round-trip — the one documented host-read
// route now that /workspace lives in the root overlay) and attached to the
// reply as downloadable chips (turns.js renderDeliverables), each with an
// add-to-project menu. The folder is created by the AGENT (`mkdir -p`, per
// bashAgentPrompt) — one mechanism, no seed-script dependency, so it works on
// bare pre-warmed boots too. Everything here is pure and Node-tested; the
// caps keep a hostile/runaway guest from flooding the page with blobs.
export const OUTBOX_PATH = "/workspace/outbox";
export const MAX_DELIVERABLES = 5; // files handed over per reply
export const MAX_DELIVERABLE_BYTES = 4 * 1024 * 1024; // per file (base64 rides the exec console)
export const MAX_DELIVERABLES_TOTAL_BYTES = 8 * 1024 * 1024; // whole reply

// The one listing command the host runs after the loop: byte size + full path,
// tab-separated, one file per line. GNU findutils (the sandbox is Debian);
// a missing dir or an image without -printf degrades to empty output → no
// deliverables (fail-soft, like every helper here).
/**
 * @returns {string}
 */
export function outboxListCommand() {
  return `find ${OUTBOX_PATH} -maxdepth 1 -type f -printf '%s\\t%p\\n' 2>/dev/null || true`;
}

// Cheap guard so the extra listing exec only runs when the agent actually
// used the convention: some command this loop ran must mention the outbox
// path (the prompt tells the model to use the literal path).
/**
 * @param {Array<{ command?: string }>} runs
 * @returns {boolean}
 */
export function wantsOutboxCollect(runs) {
  return Array.isArray(runs) && runs.some((r) => typeof r?.command === "string" && r.command.includes(OUTBOX_PATH));
}

/**
 * One file the sandbox is handing to the user (metadata only; the bytes are
 * exported separately).
 * @typedef {{ name: string, size: number }} DeliverableMeta
 */

// Parse the outbox listing (`size\tpath` lines) into bounded, sanitized
// deliverable metadata. Basename only (the export re-derives the path under
// OUTBOX_PATH, so a crafted path can't escape it), control chars stripped,
// oversize files skipped, count/total caps enforced, duplicate names dropped
// keep-first. Never throws; garbage lines are ignored.
/**
 * @param {string} stdout the listing command's raw stdout
 * @returns {{ files: DeliverableMeta[], dropped: number }}
 */
export function parseOutboxListing(stdout) {
  /** @type {DeliverableMeta[]} */
  const files = [];
  let dropped = 0;
  const seen = new Set();
  let total = 0;
  for (const line of String(stdout || "").split("\n")) {
    const m = line.match(/^(\d+)\t(.+)$/);
    if (!m) continue;
    const size = Number(m[1]);
    // eslint-disable-next-line no-control-regex
    const name = (m[2].split("/").pop() || "").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 120);
    if (!name || name === "." || name === ".." || seen.has(name)) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    if (
      size > MAX_DELIVERABLE_BYTES ||
      files.length >= MAX_DELIVERABLES ||
      total + size > MAX_DELIVERABLES_TOTAL_BYTES
    ) {
      dropped++;
      continue;
    }
    seen.add(name);
    total += size;
    files.push({ name, size });
  }
  return { files, dropped };
}

// Human-readable size for the chips and the synthesis note ("12.3 kB").
/**
 * @param {number} n bytes
 * @returns {string}
 */
export function formatByteSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1).replace(/\.0$/, "") + " kB";
  return (b / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " MB";
}

// Best-effort MIME from the filename extension — for the download anchor and
// the File handed to addFilesToProject (which routes docs to indexing by
// name/type). Unknown → octet-stream.
/**
 * @param {string} name
 * @returns {string}
 */
export function mimeForName(name) {
  const ext = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** @type {Record<string, string>} */
const MIME_BY_EXT = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", xml: "application/xml", html: "text/html", css: "text/css",
  js: "text/javascript", py: "text/x-python", sh: "text/x-shellscript",
  yaml: "text/yaml", yml: "text/yaml", pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
};

// The synthetic transcript entry appended AFTER the real runs once files were
// actually exported, so the SYNTHESIS model knows the hand-over happened and
// refers to the attachments instead of pasting their content or denying the
// capability. It rides the existing `shell_transcript` contract untouched
// (src/validation.js resolveShellTranscript passes any non-empty command
// through), so no new API field, and it lands in the chat_logs meta.shell
// record like every other run — an honest part of the session record, not
// fabricated guest output.
/**
 * @param {DeliverableMeta[]} files
 * @returns {ShellRun}
 */
export function deliverablesRun(files) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => `${f.name} (${formatByteSize(f.size)})`)
    .join(", ");
  return {
    command: `# deliverables collected from ${OUTBOX_PATH}`,
    exitCode: 0,
    stdout:
      `These sandbox files are attached to this reply as downloadable attachments the user can save or add to a project: ${list}. ` +
      "Refer to them by filename — do not paste their full contents into the answer.",
    stderr: "",
  };
}

// ---- exec bridge protocol ----------------------------------------------------

// The marker+base64 envelope the sandbox's exec bridge speaks: the pure codec
// half of public/js/sandbox.js's execInSandbox (the VM/console orchestration
// stays there). One command's stdout/stderr/RC ride the shared interactive
// console as a single `###EXEC<id>:<b64 out>:<b64 err>:<rc>###` line, so the
// captured output survives any stray banner the interactive shell emits.

/**
 * Builds the wrapped /bin/sh command line + its unique capture marker.
 * Redirect stdout AND stderr to files, capture $? IMMEDIATELY (before any
 * pipe), THEN base64 the files. The prior form piped stdout into base64
 * and read $? after the pipe, so RC was base64's exit (always 0) — the
 * command's real exit code was lost. /bin/sh here is dash (no PIPESTATUS),
 * so the temp-file form is the correct way to preserve it. The
 * marker+base64 envelope is unchanged (base64 emits no ':' or '#').
 *
 * The command is placed on its OWN lines inside the subshell —
 * `(\n<command>\n) >…` — never inline `( <command> )`. A here-document's
 * terminator must sit on a line by itself, so an inline close would land
 * `) >/tmp/…` on the same line as `EOF` and break the heredoc (the file write
 * would swallow the rest of the wrapper as body). The leading/trailing
 * newlines are transparent to every ordinary one-line command too.
 * @param {string} command
 * @param {string} id a unique run id (uniqueness is the caller's job)
 * @returns {{ marker: string, wrapped: string }}
 */
export function execEnvelope(command, id) {
  const marker = "###EXEC" + id + ":";
  const of = "/tmp/_o" + id;
  const ef = "/tmp/_e" + id;
  const wrapped =
    "(\n" + command + "\n) >" + of + " 2>" + ef + "; RC=$?; " +
    "O=$(base64 -w0 " + of + " 2>/dev/null); E=$(base64 -w0 " + ef + " 2>/dev/null); " +
    "rm -f " + of + " " + ef + "; " +
    'printf "' + marker + '%s:%s:%d###\\n" "$O" "$E" "$RC"';
  return { marker, wrapped };
}

/**
 * Joins the captured console chunks into one buffer.
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
export function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const combined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { combined.set(c, off); off += c.length; }
  return combined;
}

/**
 * Parses the envelope back out of the raw captured console text. Returns the
 * command's {exitCode, stdout, stderr}, or null when the marker never made it
 * through (the caller owns that failure's shape and telemetry).
 * @param {string} raw the decoded console capture
 * @param {string} marker the run's marker from execEnvelope
 * @returns {{ exitCode: number, stdout: string, stderr: string } | null}
 */
export function parseExecEnvelope(raw, marker) {
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^:]*):([^:]*):(-?\\d+)###");
  const m = String(raw || "").match(re);
  if (!m) return null;
  let stdout = "";
  let stderr = "";
  try { stdout = m[1] ? atob(m[1]) : ""; } catch {}
  try { stderr = m[2] ? atob(m[2]) : ""; } catch {}
  return { exitCode: parseInt(m[3], 10), stdout, stderr };
}

/**
 * Decodes a base64 capture (e.g. `base64 -w0 <file>` piped out through the
 * exec bridge) into bytes, tolerating the wrapping whitespace base64 emits.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  const bin = atob(String(b64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * The host-read policy: only round-trip files out of the mount tree — never
 * arbitrary guest paths. Lives next to OUTBOX_PATH so the "which guest paths
 * may leave the VM" surface is defined (and tested) in one place.
 * @param {string} path
 * @returns {boolean}
 */
export function isExportablePath(path) {
  return /^\/(workspace|mnt|root|tmp)\//.test(String(path || ""));
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

/** Wall-clock reader for the loop budget; injectable so tests stay deterministic. */
const defaultNow = () => Date.now();

/**
 * Does a command result mean the sandbox VM is GONE (not merely that the command
 * failed)? Two signals, both produced by the browser executor (public/js/sandbox.js):
 * exit 124 is the EXEC_TIMEOUT fail-soft, which discards the wedged, unabortable
 * VM; "sandbox not ready" is what every exec returns once the VM is torn down or
 * never booted. Either way the loop must stop — see the call site. Exported for tests.
 * @param {{ exitCode?: number, stderr?: string }} [run]
 * @returns {boolean}
 */
export function sandboxTornDown(run) {
  return !!run && (run.exitCode === 124 || run.stderr === "sandbox not ready");
}

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
 *   maxWallMs?: number,
 *   now?: () => number,
 * }} params
 * @returns {Promise<ShellRun[]>}
 */
export async function runShellLoop({ step, exec, ensureReady, onStep, onExec, onResult, maxRounds = MAX_SHELL_ROUNDS, maxWallMs = MAX_SHELL_WALL_MS, now = defaultNow }) {
  /** @type {ShellRun[]} */
  const transcript = [];
  // null = not yet booted; true/false = boot outcome. No ensureReady → ready.
  let ready = ensureReady ? null : true;
  const startedAt = now();
  for (let round = 1; round <= maxRounds; round++) {
    // Total wall-clock spent (boot + every prior round) — stop before the client
    // decides the connection stalled rather than grinding out more slow rounds.
    if (maxWallMs && now() - startedAt >= maxWallMs) break;
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
      // The VM tore itself down (an exec timeout discards the wedged instance)
      // or was already gone: every command after this one would only return the
      // same dead-VM error. Stop the whole loop — running out the rest of the
      // round/maxRounds produced the 2026-07-13 iOS cascade of "6 commands, all
      // sandbox not ready". Synthesis still runs with the transcript so far.
      if (sandboxTornDown(run)) return transcript;
    }
  }
  return transcript;
}

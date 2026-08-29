// @ts-check
// THE LYPNING EXEC LADDER — the one implementation of "run a Python program in
// a sandbox that might carry lypning", shared by both tiers.
//
// It lives under public/js/ for the standing reason (the bash-core.js
// arrangement): the Se/cure research loop runs IN THE BROWSER
// (public/js/drc-research.js), and the browser can only import served modules,
// while the Worker bundler can import from anywhere — so the served copy is the
// only copy and src/research-tools-run.js re-exports it as a façade. The thing
// being protected is the REFUSAL CONTRACT: exit 90, one
// `<engine>: unsupported: <kind>: <detail>` line on stderr, nothing on stdout,
// retried on CPython. Two copies of that contract are two contracts, and the
// first time they drift one tier retries a program that already answered — or
// swallows a refusal as a failure.
//
// Everything here is a function of its arguments: no DOM, no fetch, no env, no
// node:*. The one execution seam is DREE/1 — an injected
// `exec(command, { timeoutMs })` the caller has already bound to an
// environment (the browser VM, a runner on the user's own machine, the Se/rver
// container). This module never resolves an environment itself; that stays the
// caller's decision, because WHERE code runs is each tier's privacy posture
// (invariant 4: Se/cure's exec never touches this server).

import { EXEC_CEILING_MS, STEP_BUDGET_MS } from "./lypning-core.js";

/** How much of a program's output comes back. Beyond this the model is reading
 * a log, not an answer, and paying for it every round. */
export const MAX_OUTPUT_CHARS = 4000;
/** The interpreters a run_python call tries, in fall-through order. lypning
 * first because in the sandbox image CPython cannot run a one-liner at all
 * (docs/LYPNING.md §2); python3 last because it is always correct. */
export const ENGINE_ORDER = ["lypning", "lypning-mp", "python3"];
/** lypning's refusal: exit 90, one line on stderr, NOTHING on stdout — which is
 * what makes the CPython retry safe rather than a second guess. */
export const REFUSAL_EXIT = 90;

/**
 * One attempt's record, as `runPythonLadder` keeps it: which engine actually
 * answered (read off the stderr marker, never assumed), the program's own
 * streams with the marker stripped, and the parsed refusal when there was one.
 * @typedef {{ engine: string, exitCode: number, stdout: string, stderr: string, refusal: { engine: string, kind: string, detail: string } | null }} PythonRun
 */

/**
 * The in-guest budget: what the command's own `timeout` gets.
 * Clamped under the ceiling with room for the WIRE margin below, so the pair
 * can never straddle the ceiling however large a budget a caller asks for.
 * @param {number} [budgetMs]
 * @returns {number}
 */
export function guestBudgetMs(budgetMs) {
  return Math.min(budgetMs || STEP_BUDGET_MS, EXEC_CEILING_MS - 5_000);
}

/**
 * The transport deadline for the SAME run — and it must lose every race.
 *
 * The two timeouts guard different things: the in-guest `timeout` bounds the
 * PROGRAM, and expiring is a clean exit 124 with the streams intact; the wire
 * deadline bounds the TRANSPORT, and on the browser VM its expiry path is
 * resetSandbox — the ceiling that does not fail a command but DESTROYS the VM,
 * taking every later call of the answer with it. So the wire must always
 * outlast the guest: the guest budget plus a spawn/probe/heredoc margin,
 * which by guestBudgetMs's clamp lands exactly at the ceiling and never past
 * it. Sending them EQUAL was the shipped bug — the guest clock starts after
 * the probe overhead, so the equal wire deadline fired first on every program
 * that used its whole budget, on the one tier that always carries this tool.
 * The proof harness knew the rule ("the command's own timeout should always
 * fire first") and had applied it only to its own fake runner.
 * @param {number} [budgetMs]
 * @returns {number}
 */
export function wireTimeoutMs(budgetMs) {
  return guestBudgetMs(budgetMs) + 5_000;
}

/**
 * The shell program that runs one Python program.
 *
 * Three things it must get right, all of them paid for already:
 *
 *  · **Probe, never assume.** The stock sandbox image has CPython only; an
 *    image built by scripts/build-sandbox-image.sh also has lypning. Resolving
 *    the engine INSIDE the command costs one round trip instead of two and
 *    cannot go stale between the probe and the run.
 *  · **Say which engine answered.** The marker line on stderr is stripped
 *    before the model sees the output; without it a subset refusal and a
 *    CPython answer are indistinguishable, which is the whole value of the
 *    refusal contract.
 *  · **Never cross the ceiling.** A command that crosses the VM's exec ceiling
 *    does not fail, it DESTROYS the VM (EXEC_CEILING_MS). Every program is run
 *    under `timeout` with its own budget, well inside it.
 *
 * @param {string} source
 * @param {{ engine?: string, stdin?: string, budgetMs?: number }} [opts]
 * @returns {string}
 */
export function pythonCommand(source, opts = {}) {
  const budgetMs = guestBudgetMs(opts.budgetMs);
  const seconds = Math.max(1, Math.round(budgetMs / 1000));
  const engines = opts.engine ? [opts.engine] : ENGINE_ORDER;
  // THE PROBE IS A BUILTIN TEST ON ABSOLUTE PATHS, NEVER `command -v`.
  //
  // This is the trap this repository has already paid for once and written
  // down: docs/SANDBOX-LOCAL-IMAGE.md records a `command -v` for a tool that
  // was NOT INSTALLED consuming the entire 30 s exec ceiling — which calls
  // resetSandbox and destroys the VM, taking every later command with it. A
  // missing interpreter is exactly the case here (the stock image carries none
  // of the two fast engines), so a PATH walk is the one thing this must not do.
  // tests/e2e/sandbox-perf.spec.js probes the same binaries the same way for
  // the same reason. Builtin `[ -x … ]` is ~0.1 ms and cannot walk anything.
  //
  // The path list is small and closed rather than derived: the image installer
  // (scripts/build-sandbox-image.sh) puts both engines in /usr/local/bin, and a
  // distro python3 is in one of two places. An engine somewhere else reads as
  // absent, which costs a fall-through to the next tier — the cheap failure,
  // against a destroyed VM as the expensive one.
  const probe = engines
    .flatMap((e) => (e === "python3" ? [`/usr/local/bin/${e}`, `/usr/bin/${e}`] : [`/usr/local/bin/${e}`]))
    // `if … then … fi` rather than a `&&` chain: a chain whose last link is
    // false leaves a non-zero $? behind, which is a trap under any shell
    // invoked with -e and noise in the exit code either way.
    .map((path) => `if [ -z "$E" ] && [ -x ${path} ]; then E=${path}; fi`)
    .join("\n");
  const src = heredoc("DRPY_SRC", source);
  const stdin = opts.stdin ? heredoc("DRPY_IN", opts.stdin) : null;
  return [
    `E=`,
    probe,
    `[ -n "$E" ] || { echo "no Python interpreter is installed in this sandbox" >&2; exit 127; }`,
    `printf 'drpy-engine:%s\\n' "\${E##*/}" >&2`,
    `P=/tmp/drpy-$$.py`,
    `cat >"$P" ${src}`,
    stdin ? `timeout ${seconds} "$E" "$P" ${stdin}` : `timeout ${seconds} "$E" "$P" </dev/null`,
    `S=$?`,
    `rm -f "$P"`,
    `exit $S`,
  ].join("\n");
}

/**
 * A quoted heredoc, with the one guard it needs: a body containing its own
 * delimiter would end the document early and the rest of the program would be
 * executed as shell. The delimiter is extended until it does not occur in the
 * body, which always terminates.
 * @param {string} tag
 * @param {string} body
 * @returns {string}
 */
function heredoc(tag, body) {
  let delim = tag;
  while (body.includes(delim)) delim += "_X";
  return `<<'${delim}'\n${body.replace(/\n$/, "")}\n${delim}`;
}

/**
 * lypning's refusal line: `<engine>: unsupported: <kind>: <detail>`, one line on
 * stderr with nothing on stdout. Null for anything else — a traceback is the
 * program's own failure, not the engine's refusal, and confusing the two would
 * retry a program that already answered.
 * @param {string} line
 * @returns {{ engine: string, kind: string, detail: string } | null}
 */
export function parseRefusalLine(line) {
  const m = /^([A-Za-z0-9_-]+):\s*unsupported:\s*([^:]+):\s*(.*)$/.exec(String(line || "").trim());
  return m ? { engine: m[1], kind: m[2].trim(), detail: m[3].trim() } : null;
}

/**
 * What the model reads back. It states WHICH engine answered and, when the
 * first one refused, why — so a subset gap costs a fallback the model can see
 * rather than a mystery. A generic "python failed" would throw the refusal
 * contract away.
 * @param {PythonRun[]} runs
 * @param {string} where
 * @returns {string}
 */
export function formatPythonResult(runs, where) {
  const out = [];
  const last = runs[runs.length - 1];
  for (const r of runs.slice(0, -1)) {
    out.push(
      r.refusal
        ? `${r.engine} refused this program (${r.refusal.kind}: ${r.refusal.detail}) and ran nothing, so it was retried on the next interpreter.`
        : `${r.engine} exited ${r.exitCode}; retried on the next interpreter.`,
    );
  }
  out.push(`Ran on ${last.engine} in ${where}. Exit code ${last.exitCode}.`);
  if (last.exitCode === 124) {
    out.push("The program was killed for running past its time budget — nothing was returned. Make it cheaper, not longer.");
  }
  const stdout = last.stdout.slice(0, MAX_OUTPUT_CHARS);
  const stderr = last.stderr.slice(0, MAX_OUTPUT_CHARS);
  out.push(`STDOUT:\n${stdout || "(empty)"}`);
  if (stderr.trim()) out.push(`STDERR:\n${stderr}`);
  return out.join("\n");
}

/**
 * The ladder itself: build the command, run it, read the engine marker off
 * stderr, and on a REFUSAL — exit 90 with the contract line — run the SAME
 * program again pinned to full CPython, reporting both runs. This used to live
 * inline in src/research-tools-run.js's runPython; lifted here so the two
 * tiers cannot drift on when a retry is allowed.
 *
 * A refusal is a FORK, not a wall: the engine exited 90 having run nothing and
 * written nothing to stdout, so retrying the identical program on CPython is
 * always safe and always correct. Anything else — an answer, a traceback, a
 * timeout — is the program's own result and is returned as it is. That
 * asymmetry is the whole contract; an eager retry on exit 1 would run a
 * program TWICE that already had its say (and its side effects).
 *
 * It never throws (invariant 2): a runner that rejects becomes a run whose
 * stderr is the error sentence, and the model reads it next round.
 *
 * @param {(command: string, opts: { timeoutMs: number }) => Promise<{ exitCode: number, stdout: string, stderr: string }>} exec
 *   the DREE/1 seam — a runner the caller already bound to an environment
 * @param {string} source the Python program
 * @param {{ stdin?: string, budgetMs?: number, where?: string }} [opts]
 *   `where` names the environment in the text the model reads
 * @returns {Promise<{ runs: PythonRun[], text: string, isError: boolean }>}
 */
export async function runPythonLadder(exec, source, opts = {}) {
  const stdin = String(opts.stdin || "");
  const where = opts.where || "the sandbox";
  /** @type {PythonRun[]} */
  const runs = [];
  let engine = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const command = pythonCommand(source, { engine, stdin, budgetMs: opts.budgetMs });
    const res = await exec(command, { timeoutMs: wireTimeoutMs(opts.budgetMs) }).catch((/** @type {any} */ err) => ({
      exitCode: 1,
      stdout: "",
      stderr: String(err?.message || err),
    }));
    const stderr = String(res.stderr || "");
    // Which engine ACTUALLY answered — read off the marker the command printed,
    // never assumed from the probe order. The marker is stripped before the
    // model sees the streams: it is bookkeeping, not program output.
    const ran = /^drpy-engine:(\S+)/m.exec(stderr);
    const cleanErr = stderr.replace(/^drpy-engine:\S+\n?/m, "");
    const used = ran ? ran[1] : "unknown";
    const refusal = res.exitCode === REFUSAL_EXIT ? parseRefusalLine(cleanErr.trim().split("\n")[0] || "") : null;
    runs.push({ engine: used, exitCode: res.exitCode, stdout: String(res.stdout || ""), stderr: cleanErr, refusal });
    // Fall onward only on the FULL refusal contract, not the exit code alone:
    // exit 90 AND the parsed one-line refusal AND nothing on stdout. A program
    // can exit 90 itself — after printing, after writing a file — and re-running
    // it on CPython would repeat its side effects; the contract's whole point is
    // that a true refusal is observably a no-op, which is what makes the retry
    // safe. Anything else at exit 90 is the program's own exit, reported as-is.
    const trueRefusal = refusal !== null && String(res.stdout || "") === "";
    if (res.exitCode !== REFUSAL_EXIT || !trueRefusal || used === "python3") break;
    engine = "python3";
  }
  return {
    runs,
    text: formatPythonResult(runs, where),
    isError: runs[runs.length - 1].exitCode !== 0,
  };
}

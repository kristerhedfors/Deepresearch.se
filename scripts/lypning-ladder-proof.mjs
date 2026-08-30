#!/usr/bin/env node
// PROVE THE LADDER AGAINST REAL INTERPRETERS.
//
// Every unit test of runPythonLadder fakes the exec, which proves the
// bookkeeping and nothing else. lypning's own third invariant — never present a
// remembered behaviour as a measured one — applies to our plumbing too: until a
// real `sh` has run a real Python program through pythonCommand's probe,
// heredocs and marker line, the refusal contract (exit 90, one line on stderr,
// nothing on stdout, retried on CPython) is a claim, not a fact. This script
// makes it a fact on THIS machine.
//
// It drives public/js/lypning-exec-core.js's runPythonLadder — the one shared
// implementation both tiers use — with a real exec (node:child_process spawning
// `sh`), against whatever interpreters this machine actually carries:
//
//   · CPython alone (the stock case): every scenario answers on python3.
//   · CPython + a pip-installed lypning (`pip install
//     git+https://github.com/kristerhedfors/lypning` puts the CLI at
//     /usr/local/bin/lypning, one of the exact paths the probe tests; the Rust
//     core then needs `lypning build --rust` once): the subset answers the
//     cheap scenarios and the REFUSAL FORK is exercised for real.
//
// Expectations are written from OBSERVED behaviour of lypning 0.1.0 run by
// hand (2026-08-29), not from its README:
//   $ lypning -c 'print(sum(range(100)))'            → 4950, exit 0
//   $ lypning /tmp/t.py   # import subprocess        → exit 90, stdout empty,
//        stderr: `lypning: unsupported: module: import subprocess`
//   $ lypning /tmp/t.py   # print(1/0)               → exit 1, Traceback +
//        ZeroDivisionError on stderr (shorter than CPython's, same class name)
//   åäö and a sys.stdin round-trip both run INSIDE the subset, byte-clean.
//
// Opt-in (`npm run proof:lypning`), not part of `npm test`: it spawns real
// processes and its strongest assertions only fire where lypning is installed.
// What it can and cannot prove is recorded in docs/LYPNING.md §3 — the CheerpX
// VM and the container image still have to be measured in place.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { runPythonLadder, REFUSAL_EXIT } from "../public/js/lypning-exec-core.js";

/** The same closed path list pythonCommand probes — the proof must agree with
 * the command about where an engine counts as installed, or it would assert
 * the wrong fork. */
const LYPNING_PATHS = ["/usr/local/bin/lypning"];
const PYTHON3_PATHS = ["/usr/local/bin/python3", "/usr/bin/python3"];

function installed(paths) {
  return paths.some((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** A REAL exec: `sh` running the ladder's command, exactly as a DREE/1 runner
 * on a user's machine would. No shell:true indirection — the command IS the
 * program, sh -c is the seam. */
function realExec(command, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // The outer guard the runner contract promises; the command's own
    // `timeout` should always fire first.
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

const failures = [];
let checks = 0;
function assert(cond, label) {
  checks++;
  const mark = cond ? "ok " : "FAIL";
  console.log(`  ${mark} ${label}`);
  if (!cond) failures.push(label);
}

const haveLypning = installed(LYPNING_PATHS);
const havePython3 = installed(PYTHON3_PATHS);

console.log(`lypning ladder proof — real interpreters on this machine`);
console.log(`  /usr/local/bin/lypning: ${haveLypning ? "installed" : "absent"}`);
console.log(`  python3 (${PYTHON3_PATHS.join(" or ")}): ${havePython3 ? "installed" : "absent"}`);

if (!havePython3 && !haveLypning) {
  // Nothing to prove against — and saying "proven" here would be the exact
  // lie this script exists to prevent.
  console.error("no interpreter at any probed path; the ladder cannot be proven on this machine");
  process.exit(2);
}

// The engine the ladder should land on for a program every tier can answer.
const fastEngine = haveLypning ? "lypning" : "python3";

async function run(source, opts) {
  const res = await runPythonLadder(realExec, source, { where: "this machine", ...opts });
  console.log(res.text.replace(/^/gm, "    | "));
  return res;
}

// ── 1. A subset one-liner: the fast engine answers when present ──────────────
console.log("\n[1] subset one-liner: print(sum(range(100)))");
{
  const r = await run("print(sum(range(100)))");
  assert(r.runs.length === 1, "answered in one run (no fall-through)");
  assert(r.runs[0].engine === fastEngine, `drpy-engine marker names ${fastEngine}`);
  assert(r.runs[0].exitCode === 0 && !r.isError, "exit 0");
  assert(r.runs[0].stdout.trim() === "4950", "stdout is 4950");
  assert(!r.runs[0].stderr.includes("drpy-engine"), "marker stripped from surfaced stderr");
  assert(r.text.includes(`Ran on ${fastEngine} in this machine`), "text names the engine that ran");
}

// ── 2. Outside the subset: the refusal fork, both runs reported ──────────────
console.log("\n[2] outside the subset: import subprocess");
{
  const src = 'import subprocess\nprint("cpython answered")';
  const r = await run(src);
  if (haveLypning) {
    assert(r.runs.length === 2, "two runs: refusal then CPython");
    const [first, second] = r.runs;
    assert(first.engine === "lypning" && first.exitCode === REFUSAL_EXIT, "lypning exited 90");
    assert(first.stdout === "", "refusal wrote nothing to stdout");
    assert(
      first.refusal?.engine === "lypning" && first.refusal?.kind === "module",
      `refusal line parsed (kind: ${first.refusal?.kind ?? "none"})`,
    );
    assert(first.refusal?.detail.includes("subprocess") ?? false, "refusal detail names the import");
    assert(second.engine === "python3" && second.exitCode === 0, "same program answered by python3");
    assert(second.stdout.trim() === "cpython answered", "CPython's answer came back");
    assert(r.text.includes("refused this program"), "text reports the refusal, not just the answer");
  } else {
    assert(r.runs.length === 1 && r.runs[0].engine === "python3", "CPython answered directly (lypning absent)");
    assert(r.runs[0].stdout.trim() === "cpython answered", "CPython's answer came back");
  }
}

// ── 3. The program's own error: exit 1, NO fall-onward ───────────────────────
console.log("\n[3] the program raises: print(1/0)");
{
  const r = await run("print(1/0)");
  assert(r.runs.length === 1, "one run only — a traceback is an answer, never retried");
  assert(r.runs[0].exitCode === 1 && r.isError, "exit 1, reported as an error");
  assert(r.runs[0].stderr.includes("ZeroDivisionError"), "traceback surfaced on stderr");
  assert(r.runs[0].refusal === null, "not mistaken for a refusal");
}

// ── 4. Non-ASCII byte-cleanliness (invariant 6's alphabet, end to end) ───────
console.log("\n[4] Swedish through the envelope: print of åäö");
{
  const r = await run('print("räksmörgås åäö")');
  assert(r.runs[0].exitCode === 0, "exit 0");
  assert(r.runs[0].stdout.trim() === "räksmörgås åäö", "åäö came back byte-clean");
}

// ── 5. stdin round-trip through the heredoc ──────────────────────────────────
console.log("\n[5] stdin round-trip: upcase Swedish lines");
{
  const r = await run("import sys\nfor line in sys.stdin: print(line.strip().upper())", {
    stdin: "hej\nvärlden\n",
  });
  assert(r.runs[0].exitCode === 0, "exit 0");
  assert(r.runs[0].stdout.trim() === "HEJ\nVÄRLDEN", "stdin reached the program and came back transformed");
}

console.log(
  `\n${checks - failures.length}/${checks} checks passed` +
    (haveLypning ? " (refusal fork exercised against real lypning)" : " (lypning absent — CPython arm only; the refusal fork was NOT exercised)"),
);
if (failures.length) {
  console.error(`FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

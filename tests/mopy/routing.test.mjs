// Unit tests for the mixture: the classifier's decisions and the pieces of the
// conformance runner that grade them.
//
// The corpus-wide measurement lives in tests/mopy/conformance.mjs and needs
// three built interpreters. These tests need at most one, and the pure-function
// half needs none — so the scoring rules stay covered in `npm test` even on a
// machine where nothing has been built.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyAgainst, mopyBin, repoDirtyList, reportRepoDamage, scoreRoute } from "./conformance.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = mopyBin();
const built = existsSync(BIN);
const skip = built ? false : `mopy not built (${BIN}) — run: bash scripts/mopy-build.sh`;

function route(program) {
  const out = execFileSync(BIN, ["route", "-c", program, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PYGRAM_CAPTURE: "0" },
  });
  return JSON.parse(out);
}

/** Run in a throwaway directory. A test that writes into the repository is the
 *  same defect the runner's repo-damage net exists to catch — a `t.txt` in the
 *  root got as far as `git add` once. */
function run(args, input = "") {
  const cwd = mkdtempSync(join(tmpdir(), "mopy-unit-"));
  try {
    return execFileSync(BIN, args, {
      encoding: "utf8",
      input,
      cwd,
      env: {
        ...process.env,
        PYGRAM_CAPTURE: "0",
        MOPY_PYGRAM: join(ROOT, "pygram/build/pygram"),
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- the scoring rules (no binary needed) ---------------------------------

test("scoreRoute: the cheapest matching engine is IDEAL", () => {
  const by = { mopy: { verdict: "MATCH" }, pygram: { verdict: "MATCH" }, cpython: { verdict: "MATCH" } };
  assert.equal(scoreRoute("mopy", by).verdict, "IDEAL");
  assert.equal(scoreRoute("pygram", by).verdict, "LATE");
});

test("scoreRoute: a refusal is WASTED, a wrong answer is UNSAFE", () => {
  const by = {
    mopy: { verdict: "UNSUPPORTED" },
    pygram: { verdict: "MISMATCH", why: "stdout differs" },
    cpython: { verdict: "MATCH" },
  };
  assert.equal(scoreRoute("mopy", by).verdict, "WASTED");
  assert.equal(scoreRoute("pygram", by).verdict, "UNSAFE");
  assert.equal(scoreRoute("cpython", by).verdict, "IDEAL");
});

test("scoreRoute: nothing to grade when no engine matched", () => {
  const by = { mopy: { verdict: "UNSUPPORTED" }, pygram: { verdict: "UNSUPPORTED" }, cpython: { verdict: "UNSUPPORTED" } };
  assert.equal(scoreRoute("mopy", by).verdict, "NO-ENGINE");
});

test("classifyAgainst: exit 90 WITHOUT the contract line is a mismatch, not coverage", () => {
  const ref = { stdout: "x\n", stderr: "", code: 0 };
  const bare = classifyAgainst(ref, { stdout: "", stderr: "boom", code: 90 }, "mopy", null);
  assert.equal(bare.verdict, "MISMATCH");
  const proper = classifyAgainst(
    ref,
    { stdout: "", stderr: "mopy: unsupported: module: import re\n", code: 90 },
    "mopy",
    null,
  );
  assert.equal(proper.verdict, "UNSUPPORTED");
  assert.equal(proper.kind, "module");
});

// ---- the repo-damage net --------------------------------------------------

test("repoDirtyList reports git's porcelain paths, or null outside a repo", () => {
  const here = repoDirtyList(ROOT);
  assert.ok(Array.isArray(here), "the repository itself must be readable by git");
  assert.equal(repoDirtyList("/"), null);
});

test("reportRepoDamage only flags files that were NOT already dirty", () => {
  // Restore is off: this asserts the DIFFERENCE, and must never touch the tree.
  const before = repoDirtyList(ROOT);
  const unchanged = reportRepoDamage(before, ROOT, false);
  assert.deepEqual(unchanged, [], "a run that changed nothing must report nothing");

  // A file that was already dirty before the run is not collateral.
  const pretend = before.filter((f) => f !== before[0]);
  const flagged = reportRepoDamage(pretend, ROOT, false);
  if (before.length) {
    assert.deepEqual(flagged, [before[0]]);
  }
  process.exitCode = 0; // reportRepoDamage sets it when it flags anything
});

// ---- the classifier -------------------------------------------------------

test("routes a plain one-liner to mopy", { skip }, () => {
  assert.equal(route("print(1 + 1)").engine, "mopy");
  assert.equal(route("import json\nprint(json.dumps({'a': 1}))").engine, "mopy");
});

test("routes an import pygram has to pygram, and names the blocker", { skip }, () => {
  const r = route("import re\nprint(re.findall(r'\\d+', 'a1'))");
  assert.equal(r.engine, "pygram");
  assert.equal(r.kind, "module");
  assert.deepEqual(r.imports, ["re"]);
});

test("routes an import nobody but CPython has straight to CPython", { skip }, () => {
  // Not via pygram: the import fails there first, so a pygram spawn is pure waste.
  assert.equal(route("import subprocess\nsubprocess.run(['true'])").engine, "cpython");
  assert.equal(route("import argparse").engine, "cpython");
});

test("a syntax error goes to CPython, whose message is the one expected", { skip }, () => {
  const r = route("def (");
  assert.equal(r.engine, "cpython");
  assert.equal(r.kind, "syntax");
});

test("constructs no MicroPython-derived runtime has skip pygram", { skip }, () => {
  assert.equal(route("@dec\ndef f(): pass").engine, "cpython");
  assert.equal(route("async def f(): pass").engine, "cpython");
});

// ---- the refusal contract -------------------------------------------------

test("a refusal is exit 90, one line, on stderr", { skip }, () => {
  let code = 0;
  let stderr = "";
  let stdout = "";
  try {
    stdout = execFileSync(BIN, ["-c", "import subprocess"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
    stderr = e.stderr;
    stdout = e.stdout;
  }
  assert.equal(code, 90);
  assert.equal(stdout, "", "the refusal must not reach stdout — it would poison a pipeline");
  assert.match(stderr, /^mopy: unsupported: module: import subprocess\n$/);
});

test("a program's OWN exception keeps its traceback and exit 1", { skip }, () => {
  let code = 0;
  let stderr = "";
  try {
    execFileSync(BIN, ["-c", "raise ValueError('mine')"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    code = e.status;
    stderr = e.stderr;
  }
  assert.equal(code, 1, "a program exception is not a capability gap");
  assert.match(stderr, /ValueError: mine/);
});

// ---- the commit barrier ---------------------------------------------------

test("a refused run leaves no output behind", { skip }, () => {
  // The program prints, then hits a gap. Exit 90 must mean the program was
  // observably a no-op, or the dispatcher's retry would print twice.
  let stdout = "x";
  let code = 0;
  try {
    stdout = execFileSync(BIN, ["-c", "print('first')\nimport subprocess"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    code = e.status;
    stdout = e.stdout;
  }
  assert.equal(code, 90);
  assert.equal(stdout, "", "output staged before the refusal must be discarded");
});

test("the barrier is invisible to the program: it reads back its own writes", { skip }, () => {
  const out = run(["-c", "open('t.txt','w').write('hi')\nprint(open('t.txt').read())"]);
  assert.equal(out, "hi\n");
});

// ---- the dispatcher -------------------------------------------------------

const dispatchSkip = skip || (existsSync(join(ROOT, "pygram/build/pygram")) ? false : "pygram not built");

test("mopy run answers a mopy program in-process", { skip: dispatchSkip }, () => {
  assert.equal(run(["run", "-c", "print(2 ** 10)"]), "1024\n");
});

test("mopy run falls onward when a value-dependent gap fires at runtime", { skip: dispatchSkip }, () => {
  // The route is optimistic — nothing in the source says the integer will grow
  // past 64 bits. mopy refuses mid-run, the barrier discards, the next engine
  // answers, and the caller sees only the answer.
  assert.equal(run(["run", "-c", "print(2 ** 200)"]), `${2n ** 200n}\n`);
});

test("mopy run passes stdin through to the engine it picked", { skip: dispatchSkip }, () => {
  const out = run(["run", "-c", "import re, sys\nprint(re.findall(r'\\d+', sys.stdin.read()))"], "a1 b22\n");
    assert.equal(out, "['1', '22']\n");
});

test("mopy run replays stdin when mopy consumed it before refusing", { skip: dispatchSkip }, () => {
  // A consumed pipe cannot be rewound, so this path forks and re-feeds the
  // captured bytes rather than exec'ing.
  const out = run(["run", "-c", "import sys\nprint(2 ** (int(sys.stdin.read()) * 20))"], "5\n");
  assert.equal(out, `${2n ** 100n}\n`);
});

test("sys.argv has Python's shape, not the dispatcher's", { skip: dispatchSkip }, () => {
  assert.equal(run(["run", "-c", "import sys\nprint(sys.argv)", "a", "b c"]), "['-c', 'a', 'b c']\n");
  assert.equal(run(["-c", "import sys\nprint(sys.argv)", "a"]), "['-c', 'a']\n");
});

test("mopy run relays the exit code of whichever engine answered", { skip: dispatchSkip }, () => {
  for (const [program, want] of [
    ["import sys\nsys.exit(7)", 7],
    ["import re, sys\nsys.exit(len(re.findall(r'a', 'aaa')))", 3],
  ]) {
    let code = 0;
    try {
      run(["run", "-c", program]);
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, want, program);
  }
});

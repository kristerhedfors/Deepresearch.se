// Unit tests for the shared lypning exec ladder (lypning-exec-core.js) — the
// ONE implementation behind the Se/rver research runner (src/research-tools-run.js
// re-exports it as a façade) and the Se/cure browser loop. Two things carry the
// weight here:
//
//  · **The command shape.** The probe is a builtin `[ -x … ]` on absolute
//    paths, never `command -v` — a PATH walk for a missing tool once consumed
//    the whole 30 s exec ceiling, which DESTROYS the VM — and every program
//    runs under `timeout` well inside that ceiling.
//  · **The refusal contract.** Exit 90 + one `<engine>: unsupported: …` line on
//    stderr means the engine ran NOTHING, so the same program is retried on
//    CPython and both runs are reported. Anything else — a traceback, an
//    answer, a timeout — is the program's own result and must never be retried.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_ORDER,
  REFUSAL_EXIT,
  formatPythonResult,
  parseRefusalLine,
  pythonCommand,
  runPythonLadder,
} from "./lypning-exec-core.js";
import { EXEC_CEILING_MS } from "./lypning-core.js";

describe("the command the ladder builds", () => {
  test("resolves the engine in the command, so the probe cannot go stale", () => {
    const cmd = pythonCommand("print(1)");
    for (const engine of ENGINE_ORDER) assert.ok(cmd.includes(`/${engine} ]`), engine);
    assert.match(cmd, /drpy-engine/);
  });

  test("the probe is a builtin test, never a PATH walk", () => {
    // docs/SANDBOX-LOCAL-IMAGE.md records a `command -v` for a tool that was
    // NOT INSTALLED consuming the whole 30 s exec ceiling — which calls
    // resetSandbox and DESTROYS the VM, taking every later command with it. A
    // missing interpreter is exactly the case here: the stock image carries
    // neither fast engine. tests/e2e/sandbox-perf.spec.js probes the same
    // binaries the same way for the same reason.
    const cmd = pythonCommand("print(1)");
    assert.ok(!/command -v/.test(cmd), "a PATH walk for a missing tool once destroyed the VM");
    assert.match(cmd, /\[ -x \/usr\/local\/bin\/lypning \]/);
    // Every probed path is absolute — a bare name would be a PATH walk by
    // another spelling.
    for (const m of cmd.matchAll(/\[ -x ([^\]]+) \]/g)) {
      assert.match(m[1].trim(), /^\//, `${m[1]} is not an absolute path`);
    }
  });

  test("stays well inside the ceiling that destroys the VM", () => {
    // Crossing EXEC_CEILING_MS does not fail the command, it destroys the VM
    // mid-answer.
    const seconds = Number(/timeout (\d+)/.exec(pythonCommand("print(1)"))?.[1]);
    assert.ok(seconds * 1000 < EXEC_CEILING_MS - 4_000, `${seconds}s is too close to the ceiling`);
  });

  test("a program containing the heredoc delimiter cannot break out of it", () => {
    // Otherwise the rest of the program is executed as shell.
    const nasty = "print('DRPY_SRC')\nDRPY_SRC\nrm -rf /\n";
    const cmd = pythonCommand(nasty);
    const delim = /cat >"\$P" <<'([A-Z_X]+)'/.exec(cmd)?.[1];
    assert.ok(delim && delim !== "DRPY_SRC", "the delimiter is extended past the collision");
    assert.equal(nasty.includes(delim), false);
  });

  test("stdin is a separate document, so a program can read what it was given", () => {
    const cmd = pythonCommand("import sys; print(sys.stdin.read())", { stdin: "hello" });
    assert.match(cmd, /<<'DRPY_IN'\nhello\nDRPY_IN/);
    assert.equal(pythonCommand("print(1)").includes("DRPY_IN"), false);
    assert.match(pythonCommand("print(1)"), /<\/dev\/null/);
  });
});

describe("the refusal contract", () => {
  test("a refusal line parses into its three parts", () => {
    assert.deepEqual(parseRefusalLine("lypning: unsupported: module: subprocess"), {
      engine: "lypning",
      kind: "module",
      detail: "subprocess",
    });
  });

  test("a traceback is not a refusal", () => {
    // Confusing the two retries a program that already answered.
    assert.equal(parseRefusalLine("Traceback (most recent call last):"), null);
    assert.equal(parseRefusalLine(""), null);
    assert.equal(parseRefusalLine("python3: can't open file '/tmp/x.py'"), null);
  });

  test("the result always names which engine answered", () => {
    const text = formatPythonResult(
      [{ engine: "lypning", exitCode: 0, stdout: "4\n", stderr: "", refusal: null }],
      "the browser sandbox",
    );
    assert.match(text, /Ran on lypning in the browser sandbox/);
    assert.match(text, /STDOUT:\n4/);
  });

  test("a killed program says it was killed rather than returning silence", () => {
    const text = formatPythonResult([{ engine: "python3", exitCode: 124, stdout: "", stderr: "", refusal: null }], "x");
    assert.match(text, /past its time budget/);
    assert.match(text, /\(empty\)/);
  });
});

describe("runPythonLadder — the fall-onward logic, lifted so the tiers cannot drift", () => {
  test("a refusal falls onward to CPython and both runs are reported", async () => {
    const commands = [];
    const exec = async (command) => {
      commands.push(command);
      return commands.length === 1
        ? { exitCode: REFUSAL_EXIT, stdout: "", stderr: "drpy-engine:lypning\nlypning: unsupported: module: subprocess\n" }
        : { exitCode: 0, stdout: "4\n", stderr: "drpy-engine:python3\n" };
    };
    const r = await runPythonLadder(exec, "import subprocess", { where: "the test runner" });
    assert.equal(commands.length, 2);
    // The retry is PINNED to CPython: it probes python3's two paths and no
    // longer mentions the subset engines at all.
    assert.match(commands[1], /\[ -x \/usr\/bin\/python3 \]/);
    assert.equal(commands[1].includes("/usr/local/bin/lypning ]"), false, "the retry is forced onto CPython");
    assert.equal(r.runs.length, 2, "both runs are kept, not just the winner");
    assert.deepEqual(r.runs[0].refusal, { engine: "lypning", kind: "module", detail: "subprocess" });
    assert.match(r.text, /lypning refused this program \(module: subprocess\)/);
    assert.match(r.text, /Ran on python3 in the test runner/);
    assert.equal(r.isError, false);
  });

  test("a real error (exit 1) does NOT fall onward — the traceback is the answer", async () => {
    // A program that exited 1 RAN: it may have printed, written files, had its
    // say. Retrying it on CPython would run side effects twice and bury the
    // traceback the model needs to fix its own program.
    let calls = 0;
    const exec = async () => {
      calls++;
      return { exitCode: 1, stdout: "", stderr: "drpy-engine:lypning\nTraceback (most recent call last):\nZeroDivisionError\n" };
    };
    const r = await runPythonLadder(exec, "1/0");
    assert.equal(calls, 1, "a traceback is the program's own result, not the engine refusing");
    assert.equal(r.runs.length, 1);
    assert.equal(r.isError, true);
    assert.match(r.text, /ZeroDivisionError/);
  });

  test("exit 0 answers directly, one run, no retry", async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { exitCode: 0, stdout: "42\n", stderr: "drpy-engine:lypning\n" };
    };
    const r = await runPythonLadder(exec, "print(42)", { where: "the browser sandbox" });
    assert.equal(calls, 1);
    assert.equal(r.isError, false);
    assert.match(r.text, /Ran on lypning in the browser sandbox\. Exit code 0\./);
    assert.match(r.text, /STDOUT:\n42/);
  });

  test("the engine marker is parsed from stderr and stripped from what the model reads", async () => {
    // The marker is bookkeeping; without stripping it, every result would open
    // its STDERR block with a line the program never wrote.
    const exec = async () => ({ exitCode: 0, stdout: "ok\n", stderr: "drpy-engine:lypning-mp\nwarning: something\n" });
    const r = await runPythonLadder(exec, "print('ok')");
    assert.equal(r.runs[0].engine, "lypning-mp", "the engine is read off the marker, never assumed");
    assert.equal(r.runs[0].stderr.includes("drpy-engine"), false);
    assert.equal(r.text.includes("drpy-engine:"), false, "the marker is stripped before the model reads it");
    assert.match(r.text, /STDERR:\nwarning: something/);
  });

  test("a refusal claiming to come from python3 is final — the ladder cannot loop", async () => {
    // CPython is the last rung: an exit-90 there has nothing left to fall to,
    // so it is returned as the result rather than retried forever.
    let calls = 0;
    const exec = async () => {
      calls++;
      return { exitCode: REFUSAL_EXIT, stdout: "", stderr: "drpy-engine:python3\npython3: unsupported: weird: case\n" };
    };
    const r = await runPythonLadder(exec, "x");
    assert.equal(calls, 1);
    assert.equal(r.isError, true);
  });

  test("a rejecting runner becomes a run whose stderr is the sentence (invariant 2)", async () => {
    const r = await runPythonLadder(async () => { throw new Error("VM gone"); }, "print(1)");
    assert.equal(r.isError, true);
    assert.match(r.text, /VM gone/);
  });
});

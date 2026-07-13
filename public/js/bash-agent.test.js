// Unit tests for the DRS client driver of the bash-lite agent
// (public/js/bash-agent.js): the /api/bash/step fetch wrapper and the
// DRS-shaped runShellLoop over the shared core driver, against a mock step
// endpoint + mock sandbox. The pure logic (intent gate, parser, transcript,
// generic loop) is implemented once in bash-core.js and tested in
// bash-core.test.js; here we also pin the re-export contract (the client
// surface IS the core, not a mirror).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as driver from "./bash-agent.js";
import * as core from "./bash-core.js";
import { fetchShellStep, runShellLoop } from "./bash-agent.js";

// ---- the re-export contract (replaces the old hand-mirror parity suite) ---

describe("DRS driver re-exports the shared core", () => {
  test("every pure export IS the core's implementation (same function object)", () => {
    for (const name of [
      "bashIntent",
      "parseShellRequest",
      "normalizeExecResult",
      "formatShellResult",
      "shellCommandLabel",
      "buildShellTranscript",
      "buildStepUserMessage",
    ]) {
      assert.equal(driver[name], core[name], `${name} must be re-exported, not re-implemented`);
    }
    for (const name of ["MAX_SHELL_ROUNDS", "MAX_COMMANDS_PER_ROUND", "MAX_OUTPUT_CHARS", "MAX_COMMAND_CHARS"]) {
      assert.equal(driver[name], core[name], name);
    }
  });

  test("runShellLoop is the DRS wrapper, not the generic core driver", () => {
    assert.notEqual(driver.runShellLoop, core.runShellLoop);
  });
});

// ---- fetchShellStep ------------------------------------------------------

describe("fetchShellStep", () => {
  test("returns the parsed proposal on success", async () => {
    const fake = async () => ({ ok: true, json: async () => ({ commands: ["echo hi"], done: false, reasoning: "check" }) });
    const r = await fetchShellStep([], [], /** @type {any} */ (fake));
    assert.deepEqual(r.commands, ["echo hi"]);
    assert.equal(r.done, false);
  });

  test("degrades to done on a non-ok response", async () => {
    const fake = async () => ({ ok: false, json: async () => ({ error: "nope" }) });
    const r = await fetchShellStep([], [], /** @type {any} */ (fake));
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
  });

  test("degrades to done when fetch throws", async () => {
    const fake = async () => { throw new Error("network"); };
    const r = await fetchShellStep([], [], /** @type {any} */ (fake));
    assert.equal(r.done, true);
  });

  test("coerces junk fields", async () => {
    const fake = async () => ({ ok: true, json: async () => ({ commands: ["ok", 5, null], done: "yes", reasoning: 3 }) });
    const r = await fetchShellStep([], [], /** @type {any} */ (fake));
    assert.deepEqual(r.commands, ["ok"]);
    assert.equal(r.done, false); // only strict true is done
    assert.equal(r.reasoning, "");
  });

  test("POSTs the conversation and the transcript so far to /api/bash/step", async () => {
    let captured;
    const fake = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) };
    };
    const messages = [{ role: "user", content: "ls /" }];
    const transcript = [{ command: "pwd", exitCode: 0, stdout: "/root\n", stderr: "" }];
    await fetchShellStep(messages, transcript, /** @type {any} */ (fake));
    assert.equal(captured.url, "/api/bash/step");
    assert.deepEqual(captured.body, { messages, transcript });
  });
});

// ---- runShellLoop (DRS shape: step = /api/bash/step) ----------------------

describe("runShellLoop (DRS)", () => {
  test("runs proposed commands, feeds results back, stops when done", async () => {
    // Step 1 proposes two commands, step 2 says done.
    const steps = [
      { ok: true, json: async () => ({ commands: ["echo a", "echo b"], done: false, reasoning: "" }) },
      { ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) },
    ];
    let i = 0;
    const fetchImpl = async () => steps[i++];
    const execCalls = [];
    const exec = async (cmd) => { execCalls.push(cmd); return { exitCode: 0, stdout: cmd + "-out", stderr: "" }; };

    const transcript = await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.deepEqual(execCalls, ["echo a", "echo b"]);
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].command, "echo a");
    assert.equal(transcript[0].stdout, "echo a-out");
  });

  test("the second round's request carries the first round's transcript", async () => {
    const bodies = [];
    const steps = [
      { ok: true, json: async () => ({ commands: ["echo a"], done: false, reasoning: "" }) },
      { ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) },
    ];
    let i = 0;
    const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return steps[i++]; };
    const exec = async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" });
    await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(bodies[0].transcript.length, 0);
    assert.equal(bodies[1].transcript.length, 1);
    assert.equal(bodies[1].transcript[0].command, "echo a");
  });

  test("honors the round cap even if the model never says done", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ commands: ["echo x"], done: false, reasoning: "" }) });
    const exec = async () => ({ exitCode: 0, stdout: "x", stderr: "" });
    const transcript = await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl), maxRounds: 3 });
    assert.equal(transcript.length, 3); // one command per round, capped at 3
  });

  test("ensureReady is NOT called when the model needs no shell (lazy boot)", async () => {
    // The model decides: immediate done → the VM must never boot.
    const fetchImpl = async () => ({ ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) });
    let booted = 0;
    const ensureReady = async () => { booted++; return true; };
    const exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const transcript = await runShellLoop({ messages: [], exec, ensureReady, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(booted, 0);
    assert.deepEqual(transcript, []);
  });

  test("ensureReady is called ONCE on the first proposed command", async () => {
    const steps = [
      { ok: true, json: async () => ({ commands: ["echo a"], done: false, reasoning: "" }) },
      { ok: true, json: async () => ({ commands: ["echo b"], done: false, reasoning: "" }) },
      { ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) },
    ];
    let i = 0;
    const fetchImpl = async () => steps[i++];
    let booted = 0;
    const ensureReady = async () => { booted++; return true; };
    const exec = async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" });
    const transcript = await runShellLoop({ messages: [], exec, ensureReady, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(booted, 1); // booted once, not per round
    assert.equal(transcript.length, 2);
  });

  test("a failed boot stops the loop with an empty transcript", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ commands: ["echo a"], done: false, reasoning: "" }) });
    const ensureReady = async () => false; // can't boot
    let execCalls = 0;
    const exec = async () => { execCalls++; return { exitCode: 0, stdout: "", stderr: "" }; };
    const transcript = await runShellLoop({ messages: [], exec, ensureReady, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(execCalls, 0);
    assert.deepEqual(transcript, []);
  });
});

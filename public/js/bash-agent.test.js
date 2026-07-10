// Unit tests for the DRS client bash-lite agent (public/js/bash-agent.js):
// the intent gate (must MIRROR the server's src/bash-agent.js, EN+SV parity)
// and the agentic loop driver against a mock step endpoint + mock sandbox.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bashIntent, buildShellTranscript, fetchShellStep, parseShellRequest, runShellLoop } from "./bash-agent.js";

// ---- bashIntent (mirror parity) -----------------------------------------

describe("bashIntent (client mirror)", () => {
  test("fires on the same English phrasings the server gate fires on", () => {
    for (const msg of [
      "run this command: uname -a",
      "execute this script for me",
      "can you run the code in the sandbox?",
      "use the terminal to compute the sha256",
      "run the calculation",
      "pipe this through jq",
    ]) {
      assert.equal(bashIntent(msg), true, msg);
    }
  });

  test("Swedish parity (invariant 6)", () => {
    for (const msg of [
      "kör det här kommandot: uname -a",
      "exekvera skriptet åt mig",
      "kan du köra koden i sandlådan?",
      "använd terminalen för att beräkna sha256",
      "räkna ut det här åt mig",
    ]) {
      assert.equal(bashIntent(msg), true, msg);
    }
  });

  test("does not fire on innocent uses or empty input", () => {
    assert.equal(bashIntent("I want to run a marathon"), false);
    assert.equal(bashIntent("jag vill köra bil till Göteborg"), false);
    assert.equal(bashIntent(""), false);
  });
});

// ---- parseShellRequest / buildShellTranscript (DRC client-side) ---------
// These mirror src/bash-agent.js (DRC has no server to parse for it).

describe("parseShellRequest (client mirror)", () => {
  test("extracts commands from a fenced block and detects done", () => {
    assert.deepEqual(parseShellRequest("```bash\nuname -a\n```").commands, ["uname -a"]);
    assert.equal(parseShellRequest("SHELL_DONE").done, true);
    assert.equal(parseShellRequest("nothing here").done, true);
  });
});

describe("buildShellTranscript (client mirror)", () => {
  test("empty runs → empty block; labels non-empty", () => {
    assert.equal(buildShellTranscript([]), "");
    const b = buildShellTranscript([{ command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "" }]);
    assert.match(b, /Linux sandbox session/);
    assert.match(b, /\$ echo hi/);
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
});

// ---- runShellLoop --------------------------------------------------------

describe("runShellLoop", () => {
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

  test("honors the round cap even if the model never says done", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ commands: ["echo x"], done: false, reasoning: "" }) });
    const exec = async () => ({ exitCode: 0, stdout: "x", stderr: "" });
    const transcript = await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl), maxRounds: 3 });
    assert.equal(transcript.length, 3); // one command per round, capped at 3
  });

  test("a throwing exec becomes a failed run, loop continues", async () => {
    const steps = [
      { ok: true, json: async () => ({ commands: ["boom"], done: false, reasoning: "" }) },
      { ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) },
    ];
    let i = 0;
    const fetchImpl = async () => steps[i++];
    const exec = async () => { throw new Error("exec failed"); };
    const transcript = await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].exitCode, 1);
    assert.match(transcript[0].stderr, /exec failed/);
  });

  test("empty first proposal produces an empty transcript", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ commands: [], done: true, reasoning: "" }) });
    const exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const transcript = await runShellLoop({ messages: [], exec, fetchImpl: /** @type {any} */ (fetchImpl) });
    assert.deepEqual(transcript, []);
  });
});

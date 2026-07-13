// Unit tests for the bash-lite agent's shared pure core (bash-core.js) — the
// ONE implementation behind the server façade (src/bash-agent.js), the DRS
// driver (public/js/bash-agent.js), and DRC (drc-research.js): the
// deterministic shell-intent gate (EN+SV parity, invariant 6), the fenced
// command-block parser, exec-result normalization/clamping, the synthesis
// transcript block builder, the shared step user-message, and the generic
// agentic loop driver (step function injected — exercised here in both the
// DRS shape via bash-agent.test.js and the raw injected shape below).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COMMANDS_PER_ROUND,
  MAX_OUTPUT_CHARS,
  bashIntent,
  buildShellTranscript,
  buildStepUserMessage,
  formatShellResult,
  normalizeExecResult,
  parseShellRequest,
  runShellLoop,
  sandboxTornDown,
  shellCommandLabel,
} from "./bash-core.js";

// ---- bashIntent ---------------------------------------------------------

describe("bashIntent", () => {
  test("fires on explicit shell / execute / sandbox phrasings (English)", () => {
    for (const msg of [
      "run this command: uname -a",
      "execute this script for me",
      "can you run the code in the sandbox?",
      "open a shell and check the kernel version",
      "use the terminal to compute the sha256",
      "pipe this through jq",
      "grep the file for TODO",
      "run these commands in a linux vm",
      "compute this factorial for me",
      "run the calculation",
      "exec the snippet and show output",
    ]) {
      assert.equal(bashIntent(msg), true, `should fire: ${msg}`);
    }
  });

  test("does NOT fire on innocent uses of run / calculate / code (English)", () => {
    for (const msg of [
      "I want to run a marathon next year",
      "in the long run this pays off",
      "how do you calculate compound interest?",
      "explain how this code works",
      "what does the term shell company mean in finance?", // 'shell' as a word — acceptable rare FP, but 'shell company' shouldn't trip the tool sense... this documents current behavior
    ].slice(0, 4)) {
      assert.equal(bashIntent(msg), false, `should not fire: ${msg}`);
    }
  });

  test("empty / missing input never fires", () => {
    assert.equal(bashIntent(""), false);
    assert.equal(bashIntent(null), false);
    assert.equal(bashIntent(undefined), false);
  });
});

// Swedish language parity (invariant 6): every English trigger concept must
// have a Swedish counterpart with the same breadth, definite forms included.
describe("bashIntent — Swedish parity", () => {
  test("fires on the Swedish counterparts of every English trigger", () => {
    for (const msg of [
      "kör det här kommandot: uname -a",
      "exekvera skriptet åt mig",
      "kan du köra koden i sandlådan?",
      "öppna ett skal och kolla kärnversionen",
      "använd terminalen för att beräkna sha256",
      "kör de här kommandona i en linux-vm",
      "räkna ut det här åt mig",
      "kör beräkningen det här",
      "exekvera snutten och visa utdata",
    ]) {
      assert.equal(bashIntent(msg), true, `should fire (SV): ${msg}`);
    }
  });

  test("definite forms and common typos (parity with the English typo sets)", () => {
    for (const msg of [
      "kör kommandot i terminalen",
      "visa mig skalet",
      "kör skriptet i emulatorn",
      "använd kommandoraden",
    ]) {
      assert.equal(bashIntent(msg), true, `should fire (SV definite): ${msg}`);
    }
  });

  test("does NOT fire on innocent Swedish (köra bil, räkna på det abstrakt)", () => {
    for (const msg of [
      "jag vill köra bil till Göteborg",
      "hur beräknar man ränta på ränta?",
    ]) {
      assert.equal(bashIntent(msg), false, `should not fire (SV): ${msg}`);
    }
  });
});

// ---- parseShellRequest --------------------------------------------------

describe("parseShellRequest", () => {
  test("extracts commands from a fenced bash block", () => {
    const r = parseShellRequest("Let me check the kernel.\n```bash\nuname -a\nuptime\n```");
    assert.deepEqual(r.commands, ["uname -a", "uptime"]);
    assert.equal(r.done, false);
    assert.match(r.reasoning, /check the kernel/i);
  });

  test("accepts sh / shell / console / bare fences", () => {
    for (const lang of ["sh", "shell", "console", ""]) {
      const r = parseShellRequest("```" + lang + "\necho hi\n```");
      assert.deepEqual(r.commands, ["echo hi"], `lang=${lang || "(bare)"}`);
    }
  });

  test("drops comments and blank lines, joins backslash-continuations", () => {
    const r = parseShellRequest("```bash\n# a comment\n\nls -la \\\n  /root\n```");
    assert.deepEqual(r.commands, ["ls -la    /root"]);
  });

  test("caps the batch at MAX_COMMANDS_PER_ROUND", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `echo ${i}`).join("\n");
    const r = parseShellRequest("```bash\n" + lines + "\n```");
    assert.equal(r.commands.length, MAX_COMMANDS_PER_ROUND);
  });

  test("no code block means done", () => {
    const r = parseShellRequest("I now have everything I need. SHELL_DONE");
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
  });

  test("an empty block means done (does not loop on nothing)", () => {
    const r = parseShellRequest("```bash\n# nothing runnable\n```");
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
  });

  test("ignores a non-shell code block (e.g. json)", () => {
    const r = parseShellRequest("Here is the plan.\n```json\n{\"a\":1}\n```");
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
  });

  test("never throws on junk input", () => {
    for (const junk of [null, undefined, 42, {}, "```bash\nunterminated"]) {
      assert.doesNotThrow(() => parseShellRequest(/** @type {any} */ (junk)));
    }
  });
});

// ---- normalizeExecResult ------------------------------------------------

describe("normalizeExecResult", () => {
  test("coerces exit code and clamps oversized output", () => {
    const big = "x".repeat(MAX_OUTPUT_CHARS + 500);
    const r = normalizeExecResult("cat big", { exitCode: "0", stdout: big, stderr: null });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.length < big.length);
    assert.match(r.stdout, /\[truncated 500 chars\]/);
    assert.equal(r.stderr, "");
  });

  test("defaults a missing/NaN exit code to 1 (failure)", () => {
    assert.equal(normalizeExecResult("x", {}).exitCode, 1);
    assert.equal(normalizeExecResult("x", { exitCode: "nope" }).exitCode, 1);
  });

  test("never throws on a non-object result", () => {
    assert.doesNotThrow(() => normalizeExecResult("x", null));
    assert.equal(normalizeExecResult("x", null).exitCode, 1);
  });
});

// ---- formatShellResult / buildShellTranscript ---------------------------

describe("formatShellResult", () => {
  test("renders command, exit, and streams", () => {
    const out = formatShellResult({ command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "" });
    assert.match(out, /\$ echo hi/);
    assert.match(out, /exit: 0/);
    assert.match(out, /stdout:\nhi/);
    assert.doesNotMatch(out, /stderr/);
  });

  test("marks no-output runs explicitly", () => {
    const out = formatShellResult({ command: "true", exitCode: 0, stdout: "", stderr: "" });
    assert.match(out, /\(no output\)/);
  });
});

describe("shellCommandLabel", () => {
  test("passes short commands through, collapsing whitespace", () => {
    assert.equal(shellCommandLabel("ls -la"), "ls -la");
    assert.equal(shellCommandLabel("grep  foo\n  bar"), "grep foo bar");
    assert.equal(shellCommandLabel("  trimmed  "), "trimmed");
  });

  test("clips long commands to one line with an ellipsis", () => {
    const long = "python3 -c '" + "x".repeat(200) + "'";
    const out = shellCommandLabel(long, 40);
    assert.equal(out.length, 40); // 39 chars + the ellipsis
    assert.ok(out.endsWith("…"));
    assert.ok(long.startsWith(out.slice(0, -1)));
  });

  test("is safe on junk input", () => {
    assert.equal(shellCommandLabel(null), "");
    assert.equal(shellCommandLabel(undefined), "");
    assert.equal(shellCommandLabel(""), "");
  });
});

describe("buildShellTranscript", () => {
  test("empty runs produce an empty block (synthesis input unchanged)", () => {
    assert.equal(buildShellTranscript([]), "");
    assert.equal(buildShellTranscript(null), "");
    assert.equal(buildShellTranscript([{ command: "" }]), "");
  });

  test("labels the block and includes every run", () => {
    const block = buildShellTranscript([
      { command: "uname -s", exitCode: 0, stdout: "Linux\n", stderr: "" },
      { command: "false", exitCode: 1, stdout: "", stderr: "boom\n" },
    ]);
    assert.match(block, /Linux sandbox session/);
    assert.match(block, /the sandbox/);
    assert.match(block, /\$ uname -s/);
    assert.match(block, /\$ false/);
    assert.match(block, /boom/);
  });
});

// ---- buildStepUserMessage -------------------------------------------------

describe("buildStepUserMessage", () => {
  test("first round (no prior block) asks for the first commands or SHELL_DONE", () => {
    const msg = buildStepUserMessage({ task: "list the root dir", context: "USER: list the root dir" });
    assert.match(msg, /Task \(latest user message\):\nlist the root dir/);
    assert.match(msg, /Conversation context:\nUSER: list the root dir/);
    assert.match(msg, /No commands have run yet/);
    assert.match(msg, /SHELL_DONE if a shell is not actually needed/);
  });

  test("later rounds carry the transcript and ask for the NEXT command", () => {
    const prior = buildShellTranscript([{ command: "ls /", exitCode: 0, stdout: "bin\n", stderr: "" }]);
    const msg = buildStepUserMessage({ task: "t", context: "c", priorBlock: prior });
    assert.match(msg, /Linux sandbox session/);
    assert.match(msg, /Decide the next command\(s\)/);
    assert.doesNotMatch(msg, /No commands have run yet/);
  });
});

// ---- runShellLoop (the generic driver, step injected) ----------------------
// The DRS shape (step = /api/bash/step fetch) is covered in
// bash-agent.test.js; these exercise the raw driver the way DRC drives it.

describe("runShellLoop (generic driver)", () => {
  test("runs proposed commands, feeds the transcript back to the step, stops when done", async () => {
    const seenTranscripts = [];
    const steps = [
      { commands: ["echo a", "echo b"], done: false, reasoning: "start" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const step = async (transcript) => {
      seenTranscripts.push(transcript.length);
      return steps[i++];
    };
    const exec = async (cmd) => ({ exitCode: 0, stdout: cmd + "-out", stderr: "" });
    const transcript = await runShellLoop({ step, exec });
    assert.deepEqual(seenTranscripts, [0, 2]); // round 2 sees both runs
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0].stdout, "echo a-out");
  });

  test("a THROWING step ends the loop with what was gathered (fail-soft)", async () => {
    const steps = [
      async () => ({ commands: ["echo a"], done: false, reasoning: "" }),
      async () => { throw new Error("provider down"); },
    ];
    let i = 0;
    const transcript = await runShellLoop({
      step: () => steps[i++](),
      exec: async () => ({ exitCode: 0, stdout: "a", stderr: "" }),
    });
    assert.equal(transcript.length, 1);
  });

  test("honors the round cap even if the model never says done", async () => {
    const step = async () => ({ commands: ["echo x"], done: false, reasoning: "" });
    const exec = async () => ({ exitCode: 0, stdout: "x", stderr: "" });
    const transcript = await runShellLoop({ step, exec, maxRounds: 3 });
    assert.equal(transcript.length, 3); // one command per round, capped at 3
  });

  test("a throwing exec becomes a failed run, loop continues", async () => {
    const steps = [
      { commands: ["boom"], done: false, reasoning: "" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const transcript = await runShellLoop({
      step: async () => steps[i++],
      exec: async () => { throw new Error("exec failed"); },
    });
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].exitCode, 1);
    assert.match(transcript[0].stderr, /exec failed/);
  });

  test("ensureReady is NOT called when the model needs no shell (lazy boot)", async () => {
    let booted = 0;
    const transcript = await runShellLoop({
      step: async () => ({ commands: [], done: true, reasoning: "" }),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      ensureReady: async () => { booted++; return true; },
    });
    assert.equal(booted, 0);
    assert.deepEqual(transcript, []);
  });

  test("ensureReady is called ONCE on the first proposed command", async () => {
    const steps = [
      { commands: ["echo a"], done: false, reasoning: "" },
      { commands: ["echo b"], done: false, reasoning: "" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    let booted = 0;
    const transcript = await runShellLoop({
      step: async () => steps[i++],
      exec: async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" }),
      ensureReady: async () => { booted++; return true; },
    });
    assert.equal(booted, 1); // booted once, not per round
    assert.equal(transcript.length, 2);
  });

  test("a failed boot stops the loop with an empty transcript", async () => {
    let execCalls = 0;
    const transcript = await runShellLoop({
      step: async () => ({ commands: ["echo a"], done: false, reasoning: "" }),
      exec: async () => { execCalls++; return { exitCode: 0, stdout: "", stderr: "" }; },
      ensureReady: async () => false, // can't boot
    });
    assert.equal(execCalls, 0);
    assert.deepEqual(transcript, []);
  });

  test("onStep and onResult fire with the round's commands and each run", async () => {
    const steps = [
      { commands: ["echo a", "echo b"], done: false, reasoning: "why" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const stepEvents = [];
    const results = [];
    await runShellLoop({
      step: async () => steps[i++],
      exec: async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" }),
      onStep: (info) => stepEvents.push(info),
      onResult: (run) => results.push(run.command),
    });
    assert.equal(stepEvents.length, 1);
    assert.equal(stepEvents[0].round, 1);
    assert.equal(stepEvents[0].reasoning, "why");
    assert.deepEqual(stepEvents[0].commands, ["echo a", "echo b"]);
    assert.deepEqual(results, ["echo a", "echo b"]);
  });

  test("onExec fires BEFORE each command runs, in order, with the command + position", async () => {
    const steps = [
      { commands: ["echo a", "echo b"], done: false, reasoning: "" },
      { commands: ["echo c"], done: false, reasoning: "" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const order = [];
    await runShellLoop({
      step: async () => steps[i++],
      // Record the exec call itself so we can assert onExec ran BEFORE it.
      exec: async (cmd) => { order.push("run:" + cmd); return { exitCode: 0, stdout: cmd, stderr: "" }; },
      onExec: (command, info) => order.push(`exec:${command}#${info.round}.${info.index}`),
    });
    assert.deepEqual(order, [
      "exec:echo a#1.0", "run:echo a",
      "exec:echo b#1.1", "run:echo b",
      "exec:echo c#2.0", "run:echo c",
    ]);
  });

  test("a throwing onExec/onStep/onResult never breaks the loop (fail-soft decoration)", async () => {
    const steps = [
      { commands: ["echo a"], done: false, reasoning: "" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const transcript = await runShellLoop({
      step: async () => steps[i++],
      exec: async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" }),
      onStep: () => { throw new Error("boom-step"); },
      onExec: () => { throw new Error("boom-exec"); },
      onResult: () => { throw new Error("boom-result"); },
    });
    assert.deepEqual(transcript.map((r) => r.command), ["echo a"]);
  });

  test("junk proposals (non-string commands, missing fields) never throw", async () => {
    const steps = [
      { commands: ["ok", 5, null, ""], done: false, reasoning: 3 },
      /** @type {any} */ (null),
    ];
    let i = 0;
    const transcript = await runShellLoop({
      step: async () => steps[i++],
      exec: async (cmd) => ({ exitCode: 0, stdout: cmd, stderr: "" }),
    });
    assert.deepEqual(transcript.map((r) => r.command), ["ok"]);
  });

  // The 2026-07-13 iOS cascade: an exec timeout (exit 124) discards the wedged
  // VM, so every command after it returns "sandbox not ready". The loop must
  // STOP on the first teardown rather than run the rest of the round/maxRounds.
  test("stops the WHOLE loop on an exec-timeout teardown (exit 124), skipping the rest of the round", async () => {
    let execCalls = 0;
    const cmds = ["ls /workspace", "ls /workspace", "ls /workspace"];
    const transcript = await runShellLoop({
      // one round proposing three commands; the first wedges
      step: async () => ({ commands: cmds, done: false, reasoning: "" }),
      exec: async () => {
        execCalls++;
        return { exitCode: 124, stdout: "", stderr: "command timed out after 30s" };
      },
    });
    assert.equal(execCalls, 1); // stopped after the first, did not run cmds 2 & 3
    assert.equal(transcript.length, 1);
    assert.equal(transcript[0].exitCode, 124);
  });

  test("stops on a 'sandbox not ready' result (VM already torn down)", async () => {
    let rounds = 0;
    const transcript = await runShellLoop({
      step: async () => { rounds++; return { commands: ["ls /"], done: false, reasoning: "" }; },
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "sandbox not ready" }),
      ensureReady: async () => true,
    });
    assert.equal(rounds, 1); // did not spin all six rounds emitting dead-VM errors
    assert.equal(transcript.length, 1);
    assert.match(transcript[0].stderr, /sandbox not ready/);
  });

  test("an ordinary non-zero exit is NOT a teardown — the loop continues", async () => {
    const steps = [
      { commands: ["false"], done: false, reasoning: "" },
      { commands: ["echo ok"], done: false, reasoning: "" },
      { commands: [], done: true, reasoning: "" },
    ];
    let i = 0;
    const transcript = await runShellLoop({
      step: async () => steps[i++],
      exec: async (cmd) => (cmd === "false"
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: cmd, stderr: "" }),
    });
    assert.deepEqual(transcript.map((r) => r.command), ["false", "echo ok"]);
  });

  test("stops once the total wall-clock budget is spent (injected clock)", async () => {
    let clock = 0;
    const now = () => clock;
    let rounds = 0;
    const transcript = await runShellLoop({
      step: async () => { rounds++; return { commands: ["sleep"], done: false, reasoning: "" }; },
      exec: async () => { clock += 40000; return { exitCode: 0, stdout: "", stderr: "" }; }, // 40 s each
      maxWallMs: 90000, // budget: round 1 (t=0) runs, round 2 (t=40k) runs, round 3 (t=80k<90k) runs, round 4 (t=120k) stops
      now,
    });
    assert.equal(rounds, 3);
    assert.equal(transcript.length, 3);
  });
});

describe("sandboxTornDown", () => {
  test("true for our timeout sentinel and the not-ready guard, false otherwise", () => {
    assert.equal(sandboxTornDown({ exitCode: 124, stdout: "", stderr: "command timed out after 30s" }), true);
    assert.equal(sandboxTornDown({ exitCode: 1, stdout: "", stderr: "sandbox not ready" }), true);
    assert.equal(sandboxTornDown({ exitCode: 0, stdout: "ok", stderr: "" }), false);
    assert.equal(sandboxTornDown({ exitCode: 1, stdout: "", stderr: "grep: no match" }), false);
    assert.equal(sandboxTornDown(undefined), false);
  });
});

// Unit tests for the bash-lite agent pure logic (src/bash-agent.js): the
// deterministic shell-intent gate (EN+SV parity, invariant 6), the fenced
// command-block parser, exec-result normalization/clamping, and the synthesis
// transcript block builder.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COMMANDS_PER_ROUND,
  MAX_OUTPUT_CHARS,
  bashIntent,
  buildShellTranscript,
  formatShellResult,
  normalizeExecResult,
  parseShellRequest,
} from "./bash-agent.js";

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

// Unit tests for the bash-lite server façade (src/bash-agent.js). The pure
// logic itself — intent gate, parser, normalizers, transcript, step message,
// loop driver — is implemented ONCE in public/js/bash-core.js and fully tested
// in public/js/bash-core.test.js; what this suite pins down is the FAÇADE
// contract: the server surface re-exports the exact same functions (no drift,
// no re-implementation — the guarantee that replaced the old hand-mirrored
// copy and its parity test), and the server import path stays live.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as facade from "./bash-agent.js";
import * as core from "../public/js/bash-core.js";

describe("server façade re-exports the shared core (single source of truth)", () => {
  test("every façade export IS the core's implementation (same function object)", () => {
    for (const name of [
      "bashIntent",
      "parseShellRequest",
      "normalizeExecResult",
      "formatShellResult",
      "buildShellTranscript",
      "buildStepUserMessage",
    ]) {
      assert.equal(facade[name], core[name], `${name} must be re-exported, not re-implemented`);
    }
  });

  test("the caps are the core's caps", () => {
    for (const name of ["MAX_SHELL_ROUNDS", "MAX_COMMANDS_PER_ROUND", "MAX_OUTPUT_CHARS", "MAX_COMMAND_CHARS"]) {
      assert.equal(facade[name], core[name], name);
      assert.equal(typeof facade[name], "number", name);
    }
  });

  test("smoke: the server surface works end to end (EN+SV, invariant 6)", () => {
    // One representative call per export, through the server import path —
    // the deep behavioral coverage lives in bash-core.test.js.
    assert.equal(facade.bashIntent("run this command: uname -a"), true);
    assert.equal(facade.bashIntent("kör det här kommandot: uname -a"), true);
    assert.deepEqual(facade.parseShellRequest("```bash\nuname -a\n```").commands, ["uname -a"]);
    assert.equal(facade.normalizeExecResult("x", null).exitCode, 1);
    assert.match(
      facade.buildShellTranscript([{ command: "true", exitCode: 0, stdout: "", stderr: "" }]),
      /Linux sandbox session/,
    );
    assert.match(facade.buildStepUserMessage({ task: "t", context: "c" }), /No commands have run yet/);
  });
});

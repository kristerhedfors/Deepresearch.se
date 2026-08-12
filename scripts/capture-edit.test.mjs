// Unit tests for the edit CLI's own logic — the argument parser and the
// verification gate. The PLANNING is tested in capture-core.test.mjs; this file
// covers only what capture-edit.mjs adds on top of it, which is the part that
// decides whether a recorded run is allowed to become a clip at all.

import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "./capture-edit.mjs";

test("--force parses as a flag, not as a value-taking option", () => {
  // The bug this pins: an unlisted key falls through to `opts[key] = argv[++i]`,
  // so `--force` would swallow the directory that follows it and the run would
  // then be planned with no dirs at all.
  const opts = parseArgs(["--force", "captures/2026-08-12/run"]);
  assert.equal(opts.force, true);
  assert.deepEqual(opts.dirs, ["captures/2026-08-12/run"]);
});

test("the flags that take a value still do", () => {
  const opts = parseArgs(["dir", "--speed", "1.25", "--wait", "speed", "--end-hold", "0", "--dry-run"]);
  assert.deepEqual(opts.dirs, ["dir"]);
  assert.equal(opts.speed, "1.25");
  assert.equal(opts.wait, "speed");
  assert.equal(opts["end-hold"], "0");
  assert.equal(opts["dry-run"], true);
  assert.equal(opts.force, undefined);
});

test("--all and --force compose, and neither eats the directory", () => {
  const opts = parseArgs(["--all", "captures/2026-08-12", "--force"]);
  assert.equal(opts.all, true);
  assert.equal(opts.force, true);
  assert.deepEqual(opts.dirs, ["captures/2026-08-12"]);
});

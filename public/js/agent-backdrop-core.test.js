// Tests for the agent-activity backdrop's pure core (agent-backdrop-core.js):
// the multi-channel ring-buffer transcript, the round-robin that clips between
// agents, the ShellRun→lines formatting, and the transparency-preference
// parsing/clamping. Runs in plain Node — no DOM. The DOM glue (agent-backdrop.js)
// is browser-only and deliberately untested here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPACITY_PCT,
  MAX_LINES,
  MAX_LINE_CHARS,
  activeLines,
  backdropEnabled,
  channelCount,
  channelLines,
  clampLine,
  clampOpacityPct,
  clipToNextChannel,
  createBackdropModel,
  ensureChannel,
  formatResultLines,
  opacityCss,
  parseOpacityPref,
  pushCommand,
  pushLines,
  pushResult,
} from "./agent-backdrop-core.js";

test("clampLine collapses whitespace and caps length", () => {
  assert.equal(clampLine("a\nb\tc  "), "a b c");
  const long = "x".repeat(MAX_LINE_CHARS + 50);
  const out = clampLine(long);
  assert.equal(out.length, MAX_LINE_CHARS);
  assert.ok(out.endsWith("…"));
  assert.equal(clampLine(null), "");
  assert.equal(clampLine(undefined), "");
});

test("createBackdropModel starts empty with the default cap", () => {
  const m = createBackdropModel();
  assert.equal(m.maxLines, MAX_LINES);
  assert.equal(channelCount(m), 0);
  assert.equal(m.active, null);
  assert.deepEqual(activeLines(m), []);
  // custom cap honored; garbage falls back to default
  assert.equal(createBackdropModel({ maxLines: 5 }).maxLines, 5);
  assert.equal(createBackdropModel({ maxLines: -3 }).maxLines, MAX_LINES);
});

test("ensureChannel registers once and sets the first as active", () => {
  const m = createBackdropModel();
  assert.equal(ensureChannel(m, "a"), "a");
  assert.equal(m.active, "a");
  ensureChannel(m, "a"); // idempotent
  ensureChannel(m, "b");
  assert.equal(channelCount(m), 2);
  assert.equal(m.active, "a"); // adding a channel doesn't steal focus
  // empty/nullish channel names collapse to "shell"
  assert.equal(ensureChannel(m, ""), "shell");
  assert.equal(ensureChannel(m, null), "shell");
});

test("pushCommand renders a prompt line and focuses the channel", () => {
  const m = createBackdropModel();
  ensureChannel(m, "a");
  ensureChannel(m, "b");
  assert.equal(m.active, "a");
  pushCommand(m, "b", "ls -la /etc");
  assert.equal(m.active, "b"); // newest activity wins
  assert.deepEqual(channelLines(m, "b"), ["$ ls -la /etc"]);
});

test("pushLines caps the ring to maxLines (oldest dropped)", () => {
  const m = createBackdropModel({ maxLines: 3 });
  pushLines(m, "a", ["1", "2", "3", "4", "5"]);
  assert.deepEqual(channelLines(m, "a"), ["3", "4", "5"]);
});

test("formatResultLines yields stdout then stderr, drops trailing blanks, marks failure", () => {
  assert.deepEqual(
    formatResultLines({ command: "x", exitCode: 0, stdout: "one\ntwo\n", stderr: "" }),
    ["one", "two"],
  );
  const withErr = formatResultLines({ command: "x", exitCode: 2, stdout: "out", stderr: "boom" });
  assert.deepEqual(withErr, ["out", "boom", "[exit 2]"]);
  // exit 0 => no marker; all-empty => no lines
  assert.deepEqual(formatResultLines({ command: "x", exitCode: 0, stdout: "", stderr: "" }), []);
});

test("pushResult stores formatted output into the channel", () => {
  const m = createBackdropModel();
  pushResult(m, "shell", { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "" });
  assert.deepEqual(channelLines(m, "shell"), ["hi"]);
});

test("clipToNextChannel round-robins only when >1 channel", () => {
  const m = createBackdropModel();
  // zero/one channel: no-op
  assert.equal(clipToNextChannel(m), null);
  ensureChannel(m, "a");
  assert.equal(clipToNextChannel(m), "a");
  ensureChannel(m, "b");
  ensureChannel(m, "c");
  m.active = "a";
  assert.equal(clipToNextChannel(m), "b");
  assert.equal(clipToNextChannel(m), "c");
  assert.equal(clipToNextChannel(m), "a"); // wraps
});

test("clampOpacityPct clamps to [0,100] and rounds; garbage => default", () => {
  assert.equal(clampOpacityPct(50), 50);
  assert.equal(clampOpacityPct(-10), 0);
  assert.equal(clampOpacityPct(250), 100);
  assert.equal(clampOpacityPct(33.6), 34);
  assert.equal(clampOpacityPct("nope"), DEFAULT_OPACITY_PCT);
});

test("parseOpacityPref falls back to default for unset/garbage, else clamps", () => {
  assert.equal(parseOpacityPref(null), DEFAULT_OPACITY_PCT);
  assert.equal(parseOpacityPref(""), DEFAULT_OPACITY_PCT);
  assert.equal(parseOpacityPref("abc"), DEFAULT_OPACITY_PCT);
  assert.equal(parseOpacityPref("40"), 40);
  assert.equal(parseOpacityPref(0), 0);
  assert.equal(parseOpacityPref(999), 100);
});

test("backdropEnabled is false only at 0", () => {
  assert.equal(backdropEnabled(0), false);
  assert.equal(backdropEnabled(1), true);
  assert.equal(backdropEnabled(100), true);
});

test("opacityCss maps 0..100 into the faint band 0..0.55", () => {
  assert.equal(opacityCss(0), 0);
  assert.equal(opacityCss(100), 0.55);
  assert.ok(opacityCss(50) > 0 && opacityCss(50) < 0.55);
});

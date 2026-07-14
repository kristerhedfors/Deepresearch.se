// Tests for the agent-activity backdrop's pure core (agent-backdrop-core.js):
// the multi-channel ring-buffer transcript, the round-robin that clips between
// agents, the ShellRun→lines formatting, and the transparency-preference
// parsing/clamping. Runs in plain Node — no DOM. The DOM glue (agent-backdrop.js)
// is browser-only and deliberately untested here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPACITY_PCT,
  FOLLOW_CAP_PX,
  LAYER_CONVO,
  LAYER_TERMINAL,
  MAX_LINES,
  MAX_LINE_CHARS,
  OPACITY_CEILING,
  PARALLAX_CAP_PX,
  activeLines,
  backdropEnabled,
  channelCount,
  channelLines,
  clampLine,
  clampOpacityPct,
  clampScrollOffset,
  clipToNextChannel,
  convoSyncOffset,
  createBackdropModel,
  ensureChannel,
  formatResultLines,
  isTapGesture,
  nextLayerMode,
  opacityCss,
  parallaxFollow,
  parallaxNudge,
  parseOpacityPref,
  pushCommand,
  pushLines,
  replaceLastLine,
  stripAnsi,
  pushResult,
  scrollStep,
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

test("opacityCss maps 0..100 into the faint band 0..OPACITY_CEILING", () => {
  assert.equal(opacityCss(0), 0);
  assert.equal(opacityCss(100), OPACITY_CEILING);
  assert.ok(opacityCss(50) > 0 && opacityCss(50) < OPACITY_CEILING);
  assert.ok(OPACITY_CEILING < 1); // still a backdrop, never a wall
});

test("stripAnsi removes escape sequences and stray controls, keeps text", () => {
  assert.equal(stripAnsi("\x1b[0;32mroot@box\x1b[0m:~# "), "root@box:~# ");
  assert.equal(stripAnsi("a\x1b]0;title\x07b"), "ab"); // OSC title
  assert.equal(stripAnsi("x\x1b[2Ky"), "xy"); // erase-line CSI
  assert.equal(stripAnsi("one\r\ntwo\rthree"), "one\ntwo\nthree"); // CR/CRLF → LF
  assert.equal(stripAnsi("keep\ttab\nline"), "keep\ttab\nline"); // tab + newline survive
  assert.equal(stripAnsi("bell\x07here"), "bellhere"); // control byte dropped
  assert.equal(stripAnsi(null), "");
  assert.equal(stripAnsi(undefined), "");
});

test("replaceLastLine updates the tail in place, pushes on an empty channel", () => {
  const m = createBackdropModel();
  replaceLastLine(m, "shell", "root@box:~"); // empty → push
  assert.deepEqual(channelLines(m, "shell"), ["root@box:~"]);
  replaceLastLine(m, "shell", "root@box:~#"); // grow the same prompt in place
  assert.deepEqual(channelLines(m, "shell"), ["root@box:~#"]);
  pushLines(m, "shell", ["$ ls"]);
  replaceLastLine(m, "shell", "$ ls -la"); // replaces the newest, not the prompt
  assert.deepEqual(channelLines(m, "shell"), ["root@box:~#", "$ ls -la"]);
  assert.equal(m.active, "shell");
});

test("clampScrollOffset keeps the offset within the scrollable range", () => {
  // content 300, viewport 100 → 200px of history to reveal
  assert.equal(clampScrollOffset(50, 300, 100), 50);
  assert.equal(clampScrollOffset(-10, 300, 100), 0); // never past the tail
  assert.equal(clampScrollOffset(999, 300, 100), 200); // never past the top
  // content shorter than the viewport → nothing to scroll
  assert.equal(clampScrollOffset(40, 80, 100), 0);
  // garbage coerces to 0, not NaN
  assert.equal(clampScrollOffset("x", "y", "z"), 0);
});

test("scrollStep walks toward the tail on positive delta, into history on negative", () => {
  // start pinned; wheel up (negative) reveals older → offset grows, unpinned
  const up = scrollStep(0, -60, 300, 100);
  assert.equal(up.offset, 60);
  assert.equal(up.pinned, false);
  // wheel down (positive) walks back toward newest, clamped at 0 → pinned again
  const down = scrollStep(60, 90, 300, 100);
  assert.equal(down.offset, 0);
  assert.equal(down.pinned, true);
  // clamped at the top of the buffer
  assert.equal(scrollStep(150, -200, 300, 100).offset, 200);
});

test("convoSyncOffset maps the conversation scroll onto the backdrop's history", () => {
  // conversation: 1000px content, 400px viewport → 600px scrollable.
  // backdrop: 300px content, 100px viewport → 200px of history to reveal.
  // At the bottom (newest, scrollTop=600) → pinned tail, offset 0.
  const bottom = convoSyncOffset(600, 1000, 400, 300, 100);
  assert.equal(bottom.offset, 0);
  assert.equal(bottom.pinned, true);
  // At the top (oldest, scrollTop=0) → fully back through the history (max 200).
  const top = convoSyncOffset(0, 1000, 400, 300, 100);
  assert.equal(top.offset, 200);
  assert.equal(top.pinned, false);
  // Halfway up (scrollTop=300) → halfway through the backdrop history (100).
  const mid = convoSyncOffset(300, 1000, 400, 300, 100);
  assert.equal(mid.offset, 100);
  assert.equal(mid.pinned, false);
  // No scrollable conversation → pinned tail (no division by zero).
  assert.equal(convoSyncOffset(0, 400, 400, 300, 100).offset, 0);
  // Backdrop shorter than its viewport → nothing to reveal, stays pinned.
  assert.equal(convoSyncOffset(0, 1000, 400, 80, 100).offset, 0);
  // Garbage coerces to a pinned tail, never NaN.
  assert.equal(convoSyncOffset("x", "y", "z", "w", "v").offset, 0);
});

test("parallaxNudge opposes the gesture, clamped to ±cap, finite on garbage", () => {
  assert.ok(parallaxNudge(100) < 0); // scroll one way → lean the other
  assert.ok(parallaxNudge(-100) > 0);
  assert.equal(parallaxNudge(100000), -PARALLAX_CAP_PX); // capped
  assert.equal(parallaxNudge(-100000), PARALLAX_CAP_PX);
  assert.equal(parallaxNudge(0), 0);
  assert.equal(parallaxNudge("nope"), 0); // never NaN
});

test("nextLayerMode toggles convo ↔ terminal; unknown → terminal first", () => {
  assert.equal(nextLayerMode(LAYER_CONVO), LAYER_TERMINAL);
  assert.equal(nextLayerMode(LAYER_TERMINAL), LAYER_CONVO);
  // a first background tap (mode unset/garbage) always brings the terminal up
  assert.equal(nextLayerMode(undefined), LAYER_TERMINAL);
  assert.equal(nextLayerMode("nope"), LAYER_TERMINAL);
});

test("isTapGesture accepts small quick presses, rejects drags and long holds", () => {
  assert.equal(isTapGesture(0, 0, 40), true);
  assert.equal(isTapGesture(8, -6, 200), true); // within move + time tolerance
  assert.equal(isTapGesture(40, 0, 100), false); // horizontal drag
  assert.equal(isTapGesture(0, 60, 100), false); // vertical swipe
  assert.equal(isTapGesture(2, 2, 900), false); // held too long (text select)
  assert.equal(isTapGesture("x", "y", "z"), true); // garbage coerces to 0 → a tap
});

test("parallaxFollow keeps the gesture's direction, clamped to ±cap, finite", () => {
  assert.ok(parallaxFollow(100) > 0); // same direction (background follows along)
  assert.ok(parallaxFollow(-100) < 0);
  assert.equal(parallaxFollow(100000), FOLLOW_CAP_PX); // capped, sign preserved
  assert.equal(parallaxFollow(-100000), -FOLLOW_CAP_PX);
  assert.equal(parallaxFollow(0), 0);
  assert.equal(parallaxFollow("nope"), 0); // never NaN
  // weaker than the raw delta
  assert.ok(Math.abs(parallaxFollow(20)) < 20);
});

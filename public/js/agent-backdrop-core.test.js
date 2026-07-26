// Tests for the agent-activity backdrop's pure core (agent-backdrop-core.js):
// the multi-channel ring-buffer transcript, the round-robin that clips between
// agents, the ShellRun→lines formatting, and the transparency-preference
// parsing/clamping. Runs in plain Node — no DOM. The DOM glue (agent-backdrop.js)
// is browser-only and deliberately untested here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OPACITY_PCT,
  EMPTY_PANE_LINE,
  FOLLOW_CAP_PX,
  LAYER_BOTH,
  LAYER_CONVO,
  LAYER_GRAPH,
  LAYER_HIDDEN,
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
  clipboardPassthrough,
  clipToNextChannel,
  composePaneLines,
  convoSyncOffset,
  createBackdropModel,
  ensureChannel,
  forGraphAvailability,
  formatResultLines,
  graphShownIn,
  hasPaneContent,
  isTapGesture,
  terminalLayerOf,
  nextLayerMode,
  opacityCss,
  parallaxFollow,
  parallaxNudge,
  parseOpacityPref,
  pushCommand,
  pushLines,
  replaceLastLine,
  stripAnsi,
  termKeySequence,
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

test("nextLayerMode cycles convo → terminal → hidden → convo; unknown → terminal first", () => {
  assert.equal(nextLayerMode(LAYER_CONVO), LAYER_TERMINAL);
  assert.equal(nextLayerMode(LAYER_TERMINAL), LAYER_HIDDEN);
  assert.equal(nextLayerMode(LAYER_HIDDEN), LAYER_CONVO);
  // one full loop returns to the start
  assert.equal(
    nextLayerMode(nextLayerMode(nextLayerMode(LAYER_CONVO))),
    LAYER_CONVO,
  );
  // the three modes are distinct
  assert.equal(new Set([LAYER_CONVO, LAYER_TERMINAL, LAYER_HIDDEN]).size, 3);
  // a first background tap (mode unset/garbage) always brings the terminal up
  assert.equal(nextLayerMode(undefined), LAYER_TERMINAL);
  assert.equal(nextLayerMode("nope"), LAYER_TERMINAL);
});

// Feedback #38 — "terminal button does not work, I don't get to see what
// happens in terminal". The header icon is revealed the moment the sandbox is
// enabled, ~24-80 s before a cold VM prints anything, so the pane must have
// something to show for that whole window. These pin the two pieces that made
// the tap a silent no-op.
test("hasPaneContent counts a live status line, not just buffered output", () => {
  const m = createBackdropModel();
  // the cold-boot window: nothing printed yet, no status → genuinely empty
  assert.equal(hasPaneContent(m, ""), false);
  assert.equal(hasPaneContent(m, null), false);
  assert.equal(hasPaneContent(m, "   "), false); // whitespace is not content
  // the VM is booting: the progress line alone is enough to show a pane
  assert.equal(hasPaneContent(m, "booting the Linux sandbox — 12s"), true);
  // and real output counts with or without a status
  pushCommand(m, "shell", "ls /");
  assert.equal(hasPaneContent(m, ""), true);
  assert.equal(hasPaneContent(m, "still booting"), true);
});

test("composePaneLines stacks output, live tail and status; never renders blank", () => {
  // output only
  assert.deepEqual(composePaneLines(["$ ls /", "bin"], "", ""), ["$ ls /", "bin"]);
  // output + the unterminated raw tail (the live shell prompt)
  assert.deepEqual(
    composePaneLines(["$ ls /"], "root@vm:~# ", ""),
    ["$ ls /", "root@vm:~#"],
  );
  // the status line always trails
  assert.deepEqual(
    composePaneLines(["$ ls /"], "", "booting — 3s"),
    ["$ ls /", "booting — 3s"],
  );
  assert.deepEqual(
    composePaneLines([], "", "booting — 3s"),
    ["booting — 3s"],
  );
  // status is clamped like any other line
  assert.equal(composePaneLines([], "", "a\nb")[0], "a b");
  // NOTHING at all still renders a line — a black void reads as a broken switch
  assert.deepEqual(composePaneLines([], "", ""), [EMPTY_PANE_LINE]);
  assert.deepEqual(composePaneLines(null, null, null), [EMPTY_PANE_LINE]);
});

// 2026-07-26 owner directive: in a mode that ALSO has a graph backdrop
// (Orchestrator), the one header icon owns both layers, so the cycle covers
// every combination the user can see rather than only the terminal's three.
test("nextLayerMode with a graph cycles all five combinations", () => {
  const g = (m) => nextLayerMode(m, true);
  assert.equal(g(LAYER_BOTH), LAYER_TERMINAL);
  assert.equal(g(LAYER_TERMINAL), LAYER_CONVO);
  assert.equal(g(LAYER_CONVO), LAYER_GRAPH);
  assert.equal(g(LAYER_GRAPH), LAYER_HIDDEN);
  assert.equal(g(LAYER_HIDDEN), LAYER_BOTH);
  // one full loop returns to the start, and visits every state exactly once
  const seen = [];
  let m = LAYER_BOTH;
  for (let i = 0; i < 5; i++) { seen.push(m); m = g(m); }
  assert.equal(m, LAYER_BOTH);
  assert.equal(new Set(seen).size, 5);
  // every distinguishable pair of (terminal state, graph shown) is reachable
  const pairs = new Set(seen.map((s) => `${terminalLayerOf(s)}/${graphShownIn(s)}`));
  assert.ok(pairs.has("convo/true")); // both, faint
  assert.ok(pairs.has("convo/false")); // terminal faint, no graph
  assert.ok(pairs.has("hidden/true")); // graph alone
  assert.ok(pairs.has("hidden/false")); // neither
  assert.ok(pairs.has("terminal/false")); // terminal forward (covers the graph)
  // the graph-only modes never leak into a mode with no graph available
  assert.equal(nextLayerMode(LAYER_BOTH), LAYER_TERMINAL);
  assert.equal(nextLayerMode(LAYER_GRAPH), LAYER_TERMINAL);
});

test("terminalLayerOf / graphShownIn decompose a mode into its two layers", () => {
  assert.equal(terminalLayerOf(LAYER_BOTH), LAYER_CONVO);
  assert.equal(terminalLayerOf(LAYER_CONVO), LAYER_CONVO);
  assert.equal(terminalLayerOf(LAYER_TERMINAL), LAYER_TERMINAL);
  assert.equal(terminalLayerOf(LAYER_GRAPH), LAYER_HIDDEN);
  assert.equal(terminalLayerOf(LAYER_HIDDEN), LAYER_HIDDEN);
  assert.equal(terminalLayerOf("nope"), LAYER_CONVO); // total
  assert.equal(graphShownIn(LAYER_BOTH), true);
  assert.equal(graphShownIn(LAYER_GRAPH), true);
  for (const m of [LAYER_CONVO, LAYER_TERMINAL, LAYER_HIDDEN, "nope", null]) {
    assert.equal(graphShownIn(m), false);
  }
});

test("forGraphAvailability re-homes a mode when the layers change", () => {
  // entering a graph mode SHOWS the graph — the mode's own background used to
  // mount unconditionally, so Orchestrator still looks as it always did — while
  // the terminal half is left exactly as the user set it
  assert.equal(forGraphAvailability(LAYER_CONVO, true), LAYER_BOTH);
  assert.equal(forGraphAvailability(LAYER_HIDDEN, true), LAYER_GRAPH);
  assert.equal(graphShownIn(forGraphAvailability(LAYER_CONVO, true)), true);
  assert.equal(graphShownIn(forGraphAvailability(LAYER_HIDDEN, true)), true);
  // hiding the TERMINAL stays hiding the terminal — the graph rides alongside
  assert.equal(terminalLayerOf(forGraphAvailability(LAYER_HIDDEN, true)), LAYER_HIDDEN);
  assert.equal(terminalLayerOf(forGraphAvailability(LAYER_CONVO, true)), LAYER_CONVO);
  // terminal-forward is left alone: its near-opaque field covers a graph anyway
  assert.equal(forGraphAvailability(LAYER_TERMINAL, true), LAYER_TERMINAL);
  assert.equal(forGraphAvailability(LAYER_GRAPH, true), LAYER_GRAPH);
  // leaving one: the graph half is dropped, the terminal half survives
  assert.equal(forGraphAvailability(LAYER_BOTH, false), LAYER_CONVO);
  assert.equal(forGraphAvailability(LAYER_GRAPH, false), LAYER_HIDDEN);
  assert.equal(forGraphAvailability(LAYER_TERMINAL, false), LAYER_TERMINAL);
  // garbage lands somewhere valid for the cycle in force
  assert.equal(forGraphAvailability("nope", false), LAYER_CONVO);
  assert.equal(forGraphAvailability("nope", true), LAYER_BOTH);
  // whatever it is handed, the result belongs to the cycle in force — and
  // without a graph that means no mode can still be showing one
  const GRAPH_CYCLE = new Set([LAYER_BOTH, LAYER_TERMINAL, LAYER_CONVO, LAYER_GRAPH, LAYER_HIDDEN]);
  const PLAIN_CYCLE = new Set([LAYER_CONVO, LAYER_TERMINAL, LAYER_HIDDEN]);
  for (const m of [LAYER_CONVO, LAYER_TERMINAL, LAYER_HIDDEN, LAYER_BOTH, LAYER_GRAPH, "nope", null]) {
    assert.ok(GRAPH_CYCLE.has(forGraphAvailability(m, true)));
    assert.ok(PLAIN_CYCLE.has(forGraphAvailability(m, false)));
    assert.equal(graphShownIn(forGraphAvailability(m, false)), false);
    // re-homing is idempotent — a mode change that repeats does not drift
    const homed = forGraphAvailability(m, true);
    assert.equal(forGraphAvailability(homed, true), homed);
  }
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

test("termKeySequence maps named keys to terminal byte sequences", () => {
  assert.equal(termKeySequence("Enter"), "\r");
  assert.equal(termKeySequence("Backspace"), "\x7f");
  assert.equal(termKeySequence("Tab"), "\t");
  assert.equal(termKeySequence("Escape"), "\x1b");
  assert.equal(termKeySequence("ArrowUp"), "\x1b[A");
  assert.equal(termKeySequence("ArrowDown"), "\x1b[B");
  assert.equal(termKeySequence("ArrowRight"), "\x1b[C");
  assert.equal(termKeySequence("ArrowLeft"), "\x1b[D");
  assert.equal(termKeySequence("Home"), "\x1b[H");
  assert.equal(termKeySequence("End"), "\x1b[F");
  assert.equal(termKeySequence("Delete"), "\x1b[3~");
});

test("termKeySequence maps Ctrl+letter to the control byte (Ctrl+C interrupts)", () => {
  assert.equal(termKeySequence("c", { ctrl: true }), "\x03");
  assert.equal(termKeySequence("C", { ctrl: true }), "\x03"); // case-insensitive
  assert.equal(termKeySequence("a", { ctrl: true }), "\x01");
  assert.equal(termKeySequence("z", { ctrl: true }), "\x1a");
  assert.equal(termKeySequence("d", { ctrl: true }), "\x04"); // EOF
});

test("clipboardPassthrough: Ctrl/Cmd+C copies only while a selection exists", () => {
  // with a selection the chord is the browser's copy, not the ^C interrupt
  assert.equal(clipboardPassthrough("c", { ctrl: true }, true), true);
  assert.equal(clipboardPassthrough("C", { ctrl: true }, true), true);
  assert.equal(clipboardPassthrough("c", { meta: true }, true), true);
  // without a selection Ctrl+C stays the terminal interrupt
  assert.equal(clipboardPassthrough("c", { ctrl: true }, false), false);
  assert.equal(clipboardPassthrough("c", { ctrl: true }), false);
  // the classic terminal-emulator copy chord passes regardless
  assert.equal(clipboardPassthrough("C", { ctrl: true, shift: true }, false), true);
});

test("clipboardPassthrough: Ctrl/Cmd+V is always the browser's paste", () => {
  assert.equal(clipboardPassthrough("v", { ctrl: true }, false), true);
  assert.equal(clipboardPassthrough("V", { ctrl: true, shift: true }, false), true);
  assert.equal(clipboardPassthrough("v", { meta: true }, false), true);
});

test("clipboardPassthrough: everything else stays with the terminal mapping", () => {
  assert.equal(clipboardPassthrough("v", {}, true), false); // bare printable
  assert.equal(clipboardPassthrough("c", {}, true), false);
  assert.equal(clipboardPassthrough("x", { ctrl: true }, true), false); // Ctrl+X → ^X
  assert.equal(clipboardPassthrough("c", { ctrl: true, alt: true }, true), false);
  assert.equal(clipboardPassthrough("v", { alt: true }, true), false);
  // garbage degrades to false, never throws
  assert.equal(clipboardPassthrough(null, null, false), false);
  assert.equal(clipboardPassthrough(undefined, undefined, undefined), false);
});

test("termKeySequence leaves printables and foreign chords with the browser", () => {
  // printable characters ride the input event (IME-safe), not keydown
  assert.equal(termKeySequence("a"), null);
  assert.equal(termKeySequence("Q"), null);
  assert.equal(termKeySequence(" "), null);
  // modifier chords that aren't Ctrl+letter stay browser shortcuts
  assert.equal(termKeySequence("c", { meta: true }), null); // Cmd+C copy
  assert.equal(termKeySequence("c", { ctrl: true, alt: true }), null);
  assert.equal(termKeySequence("Enter", { ctrl: true }), null);
  assert.equal(termKeySequence("ArrowUp", { alt: true }), null);
  // unknown named keys and garbage degrade to null, never throw
  assert.equal(termKeySequence("F5"), null);
  assert.equal(termKeySequence("Shift"), null);
  assert.equal(termKeySequence(null), null);
  assert.equal(termKeySequence(undefined, null), null);
  // proto-chain names must not leak through the lookup table
  assert.equal(termKeySequence("toString"), null);
  assert.equal(termKeySequence("hasOwnProperty"), null);
});

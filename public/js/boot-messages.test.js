// Tests for the Linux-sandbox boot quip rotator (public/js/boot-messages.js) —
// the pure phrase list + no-immediate-repeat rotator behind the notification
// bar's "please wait, a whole Linux is booting" entertainment. The DOM timer
// that ticks it (sandbox.js) is browser-only and not covered here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_MESSAGES,
  BOOT_MESSAGE_INTERVAL_MS,
  BOOT_STAGE_COUNT,
  BOOT_STAGE_STEPS,
  bootLogLine,
  createBootMessageRotator,
  formatBootProgress,
} from "./boot-messages.js";

test("BOOT_MESSAGES is a non-empty list of short, unique strings", () => {
  assert.ok(Array.isArray(BOOT_MESSAGES));
  assert.ok(BOOT_MESSAGES.length >= 8, "want a decent variety of quips");
  for (const m of BOOT_MESSAGES) {
    assert.equal(typeof m, "string");
    assert.ok(m.length > 0, "no empty quip");
    assert.ok(m.length <= 80, `quip too long for a status line: ${m}`);
  }
  assert.equal(new Set(BOOT_MESSAGES).size, BOOT_MESSAGES.length, "quips must be unique");
});

test("BOOT_MESSAGE_INTERVAL_MS is a sane tick interval", () => {
  assert.equal(typeof BOOT_MESSAGE_INTERVAL_MS, "number");
  assert.ok(BOOT_MESSAGE_INTERVAL_MS >= 1000 && BOOT_MESSAGE_INTERVAL_MS <= 10000);
});

test("first next() reveals the starting phrase, then it advances", () => {
  // rng() => 0 → deterministic start at index 0.
  const r = createBootMessageRotator({ rng: () => 0 });
  assert.equal(r.next(), BOOT_MESSAGES[0]);
  assert.equal(r.next(), BOOT_MESSAGES[1]);
  assert.equal(r.next(), BOOT_MESSAGES[2]);
});

test("a random start offset is honored", () => {
  // rng just under 0.5 with a 4-item list lands on index 1.
  const list = ["a", "b", "c", "d"];
  const r = createBootMessageRotator({ messages: list, rng: () => 0.49 });
  assert.equal(r.next(), "b");
  assert.equal(r.next(), "c");
});

test("every phrase shows once before any repeat, and no immediate repeats", () => {
  const r = createBootMessageRotator({ rng: () => 0.37 });
  const seen = [];
  for (let n = 0; n < BOOT_MESSAGES.length; n++) seen.push(r.next());
  assert.equal(new Set(seen).size, BOOT_MESSAGES.length, "one full cycle covers every phrase");
  // Wrapping around continues without an immediate repeat at the seam.
  let prev = seen[seen.length - 1];
  for (let n = 0; n < BOOT_MESSAGES.length + 3; n++) {
    const cur = r.next();
    assert.ok(BOOT_MESSAGES.includes(cur));
    assert.notEqual(cur, prev, "no phrase repeats back-to-back");
    prev = cur;
  }
});

test("degrades safely for an empty/invalid message list", () => {
  // An empty list, a null (which the destructuring default can't catch), and
  // outright garbage all fall back to the built-in quips instead of blanking.
  const r = createBootMessageRotator({ messages: [], rng: () => 0 });
  assert.ok(BOOT_MESSAGES.includes(r.next()), "empty list falls back to BOOT_MESSAGES");
  const r2 = createBootMessageRotator({ messages: /** @type {any} */ (null), rng: () => 0 });
  assert.ok(BOOT_MESSAGES.includes(r2.next()), "null list falls back to BOOT_MESSAGES");
  const r3 = createBootMessageRotator({ messages: /** @type {any} */ ("nope"), rng: () => 0 });
  assert.ok(BOOT_MESSAGES.includes(r3.next()), "non-array falls back to BOOT_MESSAGES");
});

test("formatBootProgress: stage → step, bar fill, elapsed seconds", () => {
  // The bar has BOOT_STAGE_COUNT cells; filled equals the stage's step.
  const line = formatBootProgress("connecting disk…", 7400);
  assert.match(line, /connecting disk…/);
  assert.match(line, /3\/6/, "connecting disk is step 3 of 6");
  assert.match(line, /· 7s$/, "elapsed rounds to whole seconds");
  assert.equal((line.match(/▮/g) || []).length, 3, "three filled cells");
  assert.equal((line.match(/▯/g) || []).length, BOOT_STAGE_COUNT - 3, "rest empty");
});

test("formatBootProgress: monotonic across the real stage order", () => {
  const order = ["booting", "loading CheerpX…", "connecting disk…", "starting Linux…", "mounting files…", "ready"];
  let last = 0;
  for (const s of order) {
    const step = BOOT_STAGE_STEPS[s];
    assert.ok(step >= last, `step for ${s} does not go backwards`);
    last = step;
  }
  assert.equal(BOOT_STAGE_STEPS["ready"], BOOT_STAGE_COUNT, "ready is the final step");
});

test("formatBootProgress: unknown/early stage holds at step 1, never negative time", () => {
  const line = formatBootProgress("", -50);
  assert.match(line, /1\/6/, "unknown stage holds at step 1");
  assert.match(line, /· 0s/, "negative elapsed clamps to 0s");
  assert.match(line, /starting up…/, "empty stage gets a friendly label");
});

// ---- bootLogLine: the PERMANENT boot-log lines (feedback #42) --------------

test("bootLogLine: stamps the stage with elapsed seconds", () => {
  assert.equal(bootLogLine("connecting disk…", 900), "[  0.9s] connecting disk…");
  assert.equal(bootLogLine("mounting files…", 12_340), "[ 12.3s] mounting files…");
});

test("bootLogLine: the stamp column is fixed so the log lines up", () => {
  const widths = new Set(
    [0, 900, 9_800, 65_000].map((ms) => bootLogLine("x", ms).indexOf("] ")),
  );
  assert.equal(widths.size, 1, "the ] column must not move across plausible boot times");
});

test("bootLogLine: closing phrases are lines too, not just stage names", () => {
  assert.match(bootLogLine("boot failed: disk unreachable", 4_000), /boot failed: disk unreachable$/);
  assert.match(bootLogLine("boot timed out at connecting disk…", 90_000), /^\[ 90\.0s\]/);
});

test("bootLogLine: nothing to say → nothing committed", () => {
  // An empty label must not push a blank line into the terminal log.
  assert.equal(bootLogLine("", 1000), "");
  assert.equal(bootLogLine("   ", 1000), "");
  assert.equal(bootLogLine(null, 1000), "");
  assert.equal(bootLogLine(undefined, 1000), "");
});

test("bootLogLine: bad/negative elapsed clamps to 0.0s", () => {
  assert.equal(bootLogLine("ready", -50), "[  0.0s] ready");
  assert.equal(bootLogLine("ready", NaN), "[  0.0s] ready");
  assert.equal(bootLogLine("ready", /** @type {any} */ ("nope")), "[  0.0s] ready");
});

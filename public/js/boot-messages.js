// Rotating, on-brand "please wait" quips shown on the notification bar while
// the experimental in-browser Linux sandbox (CheerpX) streams and boots its
// Debian image. That boot takes a while — a whole x86 Linux is coming up
// inside the tab, its disk streamed block-by-block — so instead of freezing on
// one dead label we entertain a little, in the spirit of the project (a
// private computer booting in YOUR browser, no server in the loop) and of the
// coding agents that keep you company through a long task.
//
// PURE and Node-testable: just the phrase list + a sequential, no-immediate-
// repeat rotator. The DOM timer that ticks it lives in the boot owner
// (public/js/sandbox.js), matching the recovery-step ticker pattern that
// already updates a step label in place (public/js/activity.js).

// Short enough to fit a status line; several lean on the privacy angle (no
// server, never leaves your browser) because that IS the point here.
export const BOOT_MESSAGES = [
  "Booting a whole Linux inside your browser tab…",
  "Streaming a Debian disk over the wire, block by block…",
  "Waking the penguin. It boots when it boots…",
  "Teaching your tab to speak fluent bash…",
  "Running x86 inside JavaScript — weirder than it sounds…",
  "No server involved — your computer is doing all of this…",
  "Summoning a shell from the WASM aether…",
  "Mounting a filesystem that never leaves your browser…",
  "init is doing init things…",
  "Compiling excuses for how long this is taking…",
  "Warming up the sandbox. It's cozy in there…",
  "Downloading just enough Debian to be dangerous…",
  "This would be instant on a server. We don't use one…",
  "Spinning up a private little computer, just for you…",
  "Fetching penguins. Slow, but sincere…",
  "Untangling kernel modules like holiday lights…",
  "The bytes are almost done arranging themselves…",
  "Convincing a browser it's a Linux box. Nearly there…",
];

// How often the notification bar swaps to the next quip. Boots run many
// seconds, so a leisurely tick reads as alive without churning too fast.
export const BOOT_MESSAGE_INTERVAL_MS = 2600;

/**
 * A rotator that walks the phrase list with no immediate repeats. It starts on
 * a RANDOM phrase (so back-to-back boots don't always open on the same line)
 * then advances one step per `next()`, wrapping around — so every phrase shows
 * once before any repeats. `rng` is injectable purely for deterministic tests.
 *
 * @param {{ messages?: string[], rng?: () => number }} [opts]
 * @returns {{ next: () => string }}
 */
export function createBootMessageRotator({ messages = BOOT_MESSAGES, rng = Math.random } = {}) {
  // Any invalid/empty list (incl. an explicit null the default can't catch)
  // degrades to the built-in quips rather than a blank bar.
  const list = Array.isArray(messages) && messages.length ? messages : BOOT_MESSAGES;
  let i = Math.floor((rng() || 0) * list.length) % list.length;
  if (i < 0) i = 0;
  let started = false;
  return {
    next() {
      // First call reveals the starting phrase; later calls advance.
      if (started) i = (i + 1) % list.length;
      started = true;
      return list[i];
    },
  };
}

// The boot advances through these labeled stages (public/js/sandbox.js
// setStatus). Mapping each to an ordered step lets the boot line render a REAL
// progress indicator — a bar, step N/total, and elapsed seconds — instead of
// only quips, so a slow-but-alive boot is visibly moving and the user knows
// roughly how long is left. iOS needs this most: there's no console, and a
// dead-looking label is what drives the reload/background that wedges the boot.
// "preparing files…" and "starting Linux…" share a step (they interleave); an
// unknown/early stage holds at step 1 so the bar never runs backwards.
export const BOOT_STAGE_STEPS = {
  booting: 1,
  "loading CheerpX…": 2,
  "connecting disk…": 3,
  "preparing files…": 4,
  "starting Linux…": 4,
  "mounting files…": 5,
  ready: 6,
};
export const BOOT_STAGE_COUNT = 6;

/**
 * PURE: render one boot progress line for a stage + elapsed time — e.g.
 * "Booting Linux · connecting disk… ▮▮▮▯▯▯ 3/6 · 7s". Node-tested. The DOM
 * ticker that calls this each second lives in the boot owner (sandbox.js),
 * matching the quip-ticker pattern.
 * @param {string} stage the current setStatus stage
 * @param {number} elapsedMs milliseconds since boot start
 * @returns {string}
 */
export function formatBootProgress(stage, elapsedMs) {
  const step = BOOT_STAGE_STEPS[stage] || 1;
  const secs = Math.max(0, Math.round((Number(elapsedMs) || 0) / 1000));
  const filled = Math.max(0, Math.min(BOOT_STAGE_COUNT, step));
  const bar = "▮".repeat(filled) + "▯".repeat(BOOT_STAGE_COUNT - filled);
  const label = stage && stage !== "booting" ? stage : "starting up…";
  return `Booting Linux · ${label} ${bar} ${step}/${BOOT_STAGE_COUNT} · ${secs}s`;
}

// @ts-check
// iOS Safari bar tint — the shared re-assert helper both tiers boot with.
//
// iOS Safari can keep the PREVIOUS page's `theme-color` chrome tint across
// same-window navigation: crossing between the tiers (the ghost button's
// `location.assign` from the blue Se/rver app to the khaki /cure page, or
// back) leaves the status bar AND the bottom toolbar painted in the page you
// LEFT. First reported live 2026-07-10 (top bar only) and fixed with a single
// changed-then-target meta flip across two animation frames at DRC boot.
// RECURRED 2026-07-17 (iPhone, iOS 18.x Safari): the khaki page under a
// still-blue top bar and a still-blue bottom toolbar — the one early flip
// fires inside Safari's own navigation chrome transition and gets swallowed.
//
// So the nudge is now LAYERED instead of one-shot: the proven flip runs at
// first frame (unchanged), then again on `load`, on every `pageshow` (which
// also covers back/forward-cache restores, where module code does NOT rerun),
// on the tab becoming visible again, and on two lagged timers placed after
// Safari's chrome-transition window. Each nudge is the same two-step — set a
// one-off shade, then the real color on the next frame — because WebKit only
// re-evaluates the tint when the meta's content actually CHANGES. Re-running
// a nudge when the tint is already right is a no-op the user can't see, so
// firing generously is safe; on every non-WebKit browser the whole thing is
// invisible. (on-device-trace skill, "iOS keeps the previous page's
// theme-color".)
//
// Import-free leaf module: it is part of the PUBLIC /cure module graph
// (allowlisted in src/assets.js — a 401 on any module drc.js statically
// imports takes the whole client tier dark), and the Se/rver app imports the
// same implementation for the reverse crossing.

// Lagged re-asserts, in ms after wiring: past Safari's post-navigation chrome
// transition (~a few hundred ms), plus one late catch-all.
export const BAR_TINT_DELAYS_MS = [600, 1600];

/**
 * The one-off "changed" shade for the two-step flip: the target color with
 * its last hex digit moved one step (f→e, everything else +1) — visually
 * indistinguishable, but a real content change WebKit must re-evaluate.
 *
 * @param {string} target e.g. "#c3b091"
 * @returns {string} e.g. "#c3b092"
 */
export function offTint(target) {
  const s = String(target);
  const last = s.slice(-1).toLowerCase();
  if (!/^[0-9a-f]$/.test(last)) return s;
  const off = last === "f" ? "e" : (parseInt(last, 16) + 1).toString(16);
  return s.slice(0, -1) + off;
}

/**
 * Build the two-step nudge for a page's theme-color meta: set the one-off
 * "changed" shade now, the real color on the next frame. Shared by the boot
 * wiring (wireBarTint) and the in-page switch nudge (nudgeTint).
 * @param {*} meta the theme-color meta element
 * @param {() => string} resolve current target color
 * @param {*} w window (rAF source)
 * @returns {() => void}
 */
function makeNudge(meta, resolve, w) {
  return () => {
    const now = resolve();
    meta.setAttribute("content", offTint(now));
    w.requestAnimationFrame(() => meta.setAttribute("content", now));
  };
}

/**
 * One layered re-assertion of the bar tint, for an IN-PAGE theme change (the
 * chat-mode switch). The 2026-07-24 report (feedback #20, iPhone) showed the
 * switch path's single direct meta set can leave the status-bar strip on the
 * previous mode's color — the same swallowing the 2026-07-10/17 navigation
 * fixes hit — so a switch now gets the proven treatment too: the two-step
 * changed-then-target flip immediately, then again on the lagged timers.
 * `target` may be a getter (re-read on every step, so a rapid second switch
 * repaints its OWN color, never a stale one). Returns the nudge (for tests)
 * or null when the page has no theme-color meta.
 * @param {string | (() => string)} target
 * @param {*} [doc]
 * @param {*} [win]
 * @returns {(() => void) | null}
 */
export function nudgeTint(target, doc, win) {
  const d = doc || document;
  const w = win || window;
  const meta = d.querySelector('meta[name="theme-color"]');
  if (!meta) return null;
  const resolve = () => (typeof target === "function" ? target() : target);
  const nudge = makeNudge(meta, resolve, w);
  nudge();
  for (const ms of BAR_TINT_DELAYS_MS) w.setTimeout(nudge, ms);
  return nudge;
}

/**
 * Wire the layered bar-tint re-assertion for `target` onto the page's
 * `theme-color` meta. Safe to call once at boot on any page; returns the
 * nudge function (for tests) or null when the page has no theme-color meta.
 *
 * `target` may be a constant color OR a getter re-read on every nudge — the
 * Se/rver app passes a getter so the layered re-asserts (load / pageshow /
 * visibility / timers) always paint the CURRENT chat mode's tint, not a stale
 * boot-time one (introspection titanium, Agent Studio green, Normal blue).
 *
 * `doc`/`win` are injectable for the Node unit test; real callers pass
 * `document` and `window`.
 *
 * @param {string | (() => string)} target the page's theme color, or a getter
 * @param {*} [doc]
 * @param {*} [win]
 * @returns {(() => void) | null}
 */
export function wireBarTint(target, doc, win) {
  const d = doc || document;
  const w = win || window;
  const meta = d.querySelector('meta[name="theme-color"]');
  if (!meta) return null;
  const resolve = () => (typeof target === "function" ? target() : target);
  const nudge = makeNudge(meta, resolve, w);
  // The original 2026-07-10 flip: first frame after boot.
  w.requestAnimationFrame(nudge);
  // After the document (images, css) has fully loaded — Safari's chrome has
  // usually finished its own transition by here.
  w.addEventListener("load", nudge);
  // Fires after `load` on a normal navigation AND — crucially — on a
  // back/forward-cache restore, where this module's top-level code does not
  // run again but the stale-tint bug applies just the same.
  w.addEventListener("pageshow", nudge);
  // Returning to the tab (app switcher, another tab and back).
  d.addEventListener("visibilitychange", () => {
    if (d.visibilityState === "visible") nudge();
  });
  for (const ms of BAR_TINT_DELAYS_MS) w.setTimeout(nudge, ms);
  return nudge;
}

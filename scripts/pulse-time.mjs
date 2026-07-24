// Shared CET/CEST (Europe/Stockholm) normalisation for the pulse builders.
// build-pulse.mjs and build-pulse-timeline.mjs both bucket commits by calendar
// day, and they MUST agree on which day a given instant falls in — the timeline
// page and the main dashboard are read side by side. This module was extracted
// from build-pulse.mjs (the timeline copy carried a "mirrored from
// build-pulse.mjs" comment) so a fix to the offset arithmetic reaches both.
//
// The whole dashboard measures time in CET/CEST (Europe/Stockholm), the repo
// owner's wall clock. Git records each commit with its OWN UTC offset —
// remote build containers commit in +00:00, the owner's devices in +02:00 —
// so slicing the raw author-date would bucket the same instant onto different
// calendar days depending on where it was made. We normalise every commit to
// Stockholm wall-clock ISO up front, so both the per-day `date` key here and
// the client's hour/day slicing of `t` land on the CET day the owner saw.
const CET_TZ = "Europe/Stockholm";
const CET_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: CET_TZ,
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** Minutes Stockholm is ahead of UTC for a given instant (+120 CEST, +60 CET). */
export function cetOffsetMinutes(instant) {
  const asUTC = new Date(instant.toLocaleString("en-US", { timeZone: "UTC" }));
  const asCET = new Date(instant.toLocaleString("en-US", { timeZone: CET_TZ }));
  return Math.round((asCET.getTime() - asUTC.getTime()) / 60000);
}

/**
 * Convert a git author-date ISO (any offset) to the same instant expressed in
 * Stockholm wall-clock, e.g. "2026-07-13T18:20:10+00:00" → "2026-07-13T20:20:10+02:00".
 * Slicing [0,10] then yields the CET day and [11,13] the CET hour.
 * @param {string} gitIso @returns {string}
 */
export function toCetIso(gitIso) {
  if (!gitIso) return "";
  const instant = new Date(gitIso);
  if (Number.isNaN(instant.getTime())) return gitIso;
  const p = Object.fromEntries(CET_PARTS.formatToParts(instant).map((x) => [x.type, x.value]));
  const off = cetOffsetMinutes(instant);
  const sign = off >= 0 ? "+" : "-";
  const oh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const om = String(Math.abs(off) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}

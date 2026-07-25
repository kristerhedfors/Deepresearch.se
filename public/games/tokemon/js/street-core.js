// The street pane's PURE presentation logic — no DOM, so it is Node-tested
// (street-core.test.js) the way the rest of the project tests its client
// cores. street.js owns the elements and the event wiring; everything that
// turns a server payload into text, markup or style lives here.

/** Escape text for interpolation into innerHTML. @type {(s: unknown) => string} */
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Base overlay size in px at scale 1 (SCALE_REF_M away). */
export const OVERLAY_BASE_PX = 30;

/**
 * The heading line over the frame: "NE 45° · imagery 2025-06".
 * @param {number} heading  Degrees, any range.
 * @param {string} [date]   The imagery's capture date, when Google gave one.
 * @returns {string}
 */
export function compassLabel(heading, date) {
  const deg = Math.round(((Number(heading) || 0) % 360 + 360) % 360);
  const point = COMPASS_POINTS[Math.round(deg / 45) % 8];
  return `${point} ${deg}°${date ? ` · imagery ${date}` : ""}`;
}

/**
 * The caption under a spawn: what it is, its level (creatures only), and how
 * far away it stands. Escaped — the name is server data, but this string goes
 * straight into innerHTML.
 * @param {{kind?: string, name?: string, level?: number, distM?: number}} overlay
 * @returns {string}
 */
export function overlayLabel(overlay) {
  const parts = [esc(overlay?.name || "")];
  if (overlay?.kind === "creature" && Number.isFinite(overlay.level)) parts.push(` Lv ${Number(overlay.level)}`);
  if (Number.isFinite(overlay?.distM)) parts.push(` · ${Math.round(Number(overlay.distM))} m`);
  return parts.join("");
}

/**
 * The overlay button's inner markup.
 * @param {{emoji?: string}} overlay
 * @returns {string}
 */
export function overlayHtml(overlay) {
  return `<span>${esc(overlay?.emoji || "❔")}</span><i>${overlayLabel(overlay)}</i>`;
}

/**
 * Where the overlay sits in the frame and how big it draws. The server
 * projected xPct/yPct/scale through the same pinhole camera the imagery was
 * shot with (src/tokemon-nav.js projectSpawns) — the client only applies it.
 * @param {{xPct?: number, yPct?: number, scale?: number}} overlay
 * @returns {{left: string, top: string, fontSize: string}}
 */
export function overlayStyle(overlay) {
  const num = (v, fallback, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.max(lo, Math.min(hi, Number(v))) : fallback);
  const pct = (v) => num(v, 50, 0, 100);
  const scale = num(overlay?.scale, 1, 0.2, 4);
  return {
    left: `${pct(overlay?.xPct)}%`,
    top: `${pct(overlay?.yPct)}%`,
    fontSize: `${Math.round(OVERLAY_BASE_PX * scale)}px`,
  };
}

// @ts-check
// Tokemon navigation — the PURE text-command + geometry side of the game's
// street-view mode (no I/O, Node-tested):
//
//   - parseGoCommand: the deterministic text-command grammar the player
//     navigates the real world with ("go north 200 m", "gå till Kungsgatan 1",
//     "look right"). EQUAL ENGLISH AND SWEDISH support, like every
//     deterministic intent gate in this project (CLAUDE.md invariant 6) —
//     the parity unit tests live in src/tokemon-nav.test.js.
//   - destinationPoint / bearingBetween / angleDiff: spherical geodesy for
//     executing moves and aiming the camera.
//   - projectSpawns: places spawns INSIDE a Street View frame — bearing
//     relative to the camera heading → x, distance → y and size — so the
//     client can overlay creatures/items on the real imagery.
//
// The server (tokemon-api.js) executes parsed commands and captures the
// frames; the client only renders.

import { haversineM } from "./tokemon.js";

/**
 * A parsed navigation command. `sv` marks Swedish vocabulary so replies can
 * come back in the command's language. A "look" carries exactly one of
 * `turn` (relative degrees) or `bearing` (absolute compass direction).
 * @typedef {{kind: "move", bearing: number, distanceM: number, sv: boolean}} GoMove
 * @typedef {{kind: "goto", query: string, sv: boolean}} GoGoto
 * @typedef {{kind: "look", turn: number, bearing?: undefined, sv: boolean}} GoLookTurn
 * @typedef {{kind: "look", bearing: number, turn?: undefined, sv: boolean}} GoLookBearing
 * @typedef {GoMove | GoGoto | GoLookTurn | GoLookBearing} GoCommand
 */

/**
 * One spawn placed inside a Street View frame (projectSpawns). xPct/yPct are
 * percentages of the frame; scale multiplies the overlay's base size.
 * @typedef {{id: string, kind: string, xPct: number, yPct: number, scale: number, distM: number, bearing: number}} SpawnOverlay
 */

const EARTH_R = 6371000;
/** @type {(d: number) => number} */
const toRad = (d) => (d * Math.PI) / 180;
/** @type {(r: number) => number} */
const toDeg = (r) => (r * 180) / Math.PI;

/** Wrap any heading into [0, 360). @type {(h: number) => number} */
export const normalizeHeading = (h) => ((h % 360) + 360) % 360;

/**
 * Signed smallest difference a-b in degrees, -180..180.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Great-circle destination from (lat,lng) along a bearing for `meters`.
 * @param {number} lat
 * @param {number} lng
 * @param {number} bearingDeg
 * @param {number} meters
 * @returns {{lat: number, lng: number}}
 */
export function destinationPoint(lat, lng, bearingDeg, meters) {
  const δ = meters / EARTH_R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: normalizeLng(toDeg(λ2)) };
}

/** Wrap any longitude into [-180, 180). @type {(l: number) => number} */
const normalizeLng = (l) => ((l + 540) % 360) - 180;

/**
 * Initial great-circle bearing from point 1 to point 2, 0..360.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export function bearingBetween(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeHeading(toDeg(Math.atan2(y, x)));
}

// ---------------------------------------------------------------------------
// The command grammar. Every vocabulary set carries English AND Swedish
// forms with the same breadth — including definite/adverbial Swedish forms
// (norrut/västerut), unaccented typo variants (soder, oster, vaster,
// sydvast), and common English slips (nroth is NOT covered; keep variants
// realistic: torwards→towards-class typos don't change routing here).

// Compass words → bearing. Swedish mirrors English incl. combined forms.
/** @type {Record<string, number>} */
const DIRECTIONS = {
  // English
  north: 0, n: 0, northeast: 45, ne: 45, east: 90, e: 90, southeast: 135, se: 135,
  south: 180, s: 180, southwest: 225, sw: 225, west: 270, w: 270, northwest: 315, nw: 315,
  // Swedish (plain, adverbial -ut, and unaccented typo forms)
  norr: 0, norrut: 0, nord: 0,
  nordost: 45, nordöst: 45, nordosten: 45, nordostut: 45,
  öster: 90, österut: 90, öst: 90, oster: 90, osterut: 90, ost: 90,
  sydost: 135, sydöst: 135, sydostut: 135,
  söder: 180, söderut: 180, syd: 180, soder: 180, soderut: 180,
  sydväst: 225, sydvast: 225, sydvästut: 225,
  väster: 270, västerut: 270, väst: 270, vaster: 270, vasterut: 270, vast: 270,
  nordväst: 315, nordvast: 315, nordvästut: 315,
};

// Movement verbs (a bare direction also counts as a move).
const MOVE_VERBS = [
  // English
  "go", "walk", "head", "move", "run", "continue", "keep going", "stroll",
  // Swedish
  "gå", "ga", "promenera", "spring", "fortsätt", "fortsatt", "vandra", "rör dig", "ror dig",
];

// "travel to <place>" verbs — anything followed by to/till and a free query.
const GOTO_RES = [
  /^(?:go|walk|travel|head|move|navigate|teleport)\s+to\s+(.+)$/,
  /^(?:take\s+me\s+to)\s+(.+)$/,
  /^(?:goto)\s+(.+)$/,
  // Swedish
  /^(?:gå|ga|promenera|åk|ak|res|vandra|ta\s+mig)\s+till\s+(.+)$/,
  /^(?:navigera)\s+till\s+(.+)$/,
];

// Relative turns for look/turn commands.
/** @type {Record<string, number>} */
const TURNS = {
  // English
  left: -90, right: 90, back: 180, around: 180, behind: 180,
  // Swedish
  vänster: -90, vanster: -90, höger: 90, hoger: 90, bakåt: 180, bakat: 180, om: 180, runt: 180,
};

const LOOK_VERBS = ["look", "turn", "face", "titta", "vänd", "vand", "kika", "se"];

// Swedish-vocabulary detection so replies can come back in the command's
// language. Derived from the SAME token sets the grammar matches on (not a
// separate regex), so the flag can never drift from the vocabulary: any
// Swedish-only token in the text marks the command Swedish.
const SV_TOKENS = new Set([
  // verbs & connectives
  "gå", "ga", "promenera", "spring", "fortsätt", "fortsatt", "vandra", "rör", "ror", "dig",
  "åk", "ak", "res", "ta", "mig", "till", "navigera",
  "titta", "vänd", "vand", "kika",
  // directions (Swedish-only keys of DIRECTIONS)
  "norr", "norrut", "nord", "nordost", "nordöst", "nordosten", "nordostut",
  "öster", "österut", "öst", "oster", "osterut", "ost",
  "sydost", "sydöst", "sydostut", "söder", "söderut", "syd", "soder", "soderut",
  "sydväst", "sydvast", "sydvästut", "väster", "västerut", "väst", "vaster", "vasterut", "vast",
  "nordväst", "nordvast", "nordvästut",
  // turns & units
  "vänster", "vanster", "höger", "hoger", "bakåt", "bakat", "runt", "meter", "grader",
]);
/** @type {(text: string) => boolean} */
const isSwedish = (text) => text.split(/[\s,]+/).some((w) => SV_TOKENS.has(w));

// "200 m", "0,5 km", "150 meter/meters/metres"
const DIST_RE = /(\d+(?:[.,]\d+)?)\s*(km|kilometer|kilometers|kilometre|kilometres|m|meter|meters|metre|metres)\b/;

export const DEFAULT_MOVE_M = 100;
export const MAX_MOVE_M = 1000;

/**
 * @param {string} text
 * @returns {number | null} Meters, clamped to 1..MAX_MOVE_M; null when no
 *   distance appears in the text.
 */
function parseDistance(text) {
  const m = DIST_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const meters = m[2].startsWith("k") ? value * 1000 : value;
  return Math.max(1, Math.min(MAX_MOVE_M, Math.round(meters)));
}

/**
 * @param {string} text
 * @returns {number | null} The first compass word's bearing, or null.
 */
function findDirection(text) {
  for (const word of text.split(/[\s,]+/)) {
    if (word in DIRECTIONS) return DIRECTIONS[word];
  }
  return null;
}

/**
 * Parse a player navigation command. Examples:
 *   "gå norrut 200 m"      → {kind:"move", bearing:0, distanceM:200, sv:true}
 *   "go to Kungsgatan 1"   → {kind:"goto", query:"kungsgatan 1", sv:false}
 *   "turn right" / "look west" → {kind:"look", turn:90} / {kind:"look", bearing:270}
 * @param {unknown} input  Raw client text (untrusted).
 * @returns {GoCommand | null} null when the text isn't a navigation command.
 */
export function parseGoCommand(input) {
  const text = String(input || "").trim().toLowerCase().replace(/[!.?]+$/, "");
  if (!text || text.length > 200) return null;
  const sv = isSwedish(text);

  // look/turn/face — check before moves ("turn left" must not be a move).
  for (const verb of LOOK_VERBS) {
    if (text === verb) continue;
    if (text.startsWith(verb + " ")) {
      const rest = text.slice(verb.length + 1);
      for (const word of rest.split(/[\s,]+/)) {
        if (word in TURNS) return { kind: "look", turn: TURNS[word], sv };
      }
      const dir = findDirection(rest);
      if (dir !== null) return { kind: "look", bearing: dir, sv };
      const deg = /^(-?\d{1,3})(?:\s*(?:degrees|deg|grader))?$/.exec(rest.trim());
      if (deg) return { kind: "look", turn: Math.max(-180, Math.min(180, Number(deg[1]))), sv };
      return null;
    }
  }
  // "vänd om" / "turn around" handled above; bare "turn"/"vänd" is nothing.

  // goto — a to/till phrase wins over a direction ONLY when no compass word
  // follows the verb ("go to the north entrance" is a goto; "go north" a move).
  for (const re of GOTO_RES) {
    const m = re.exec(text);
    if (m && findDirection(m[1]) === null) {
      const query = m[1].trim();
      if (query.length >= 2) return { kind: "goto", query, sv };
    }
  }

  // move — verb + direction, or a bare direction ("north", "norrut").
  const dir = findDirection(text);
  if (dir !== null) {
    const verbed = MOVE_VERBS.some((v) => text === v || text.startsWith(v + " ") || text.includes(" " + v + " "));
    const bare = text.split(/[\s,]+/).every((w) => w in DIRECTIONS || DIST_RE.test(w) || /^(m|km)$/.test(w) || /^\d/.test(w));
    if (verbed || bare) {
      return { kind: "move", bearing: dir, distanceM: parseDistance(text) || DEFAULT_MOVE_M, sv };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn projection into a Street View frame.
//
// x: relative bearing across the field of view (50% = dead ahead).
// y/scale: distance — near spawns sit low and large, far ones near the
// horizon and small. Values are percentages of the frame, clamped so an
// overlay never leaves the image.

export const SCENE_FOV = 90;
export const SCENE_VIEW_DIST_M = 130;

/**
 * Place spawns inside a Street View frame shot from (camLat,camLng) facing
 * headingDeg. Off-frame and too-distant spawns are dropped.
 * @param {number} camLat
 * @param {number} camLng
 * @param {number} headingDeg
 * @param {Array<{id: string, kind: string, lat: number, lng: number}>} spawns
 * @param {{fov?: number, maxDist?: number}} [opts]
 * @returns {SpawnOverlay[]} Sorted far-to-near so near overlays paint on top.
 */
export function projectSpawns(camLat, camLng, headingDeg, spawns, { fov = SCENE_FOV, maxDist = SCENE_VIEW_DIST_M } = {}) {
  /** @type {SpawnOverlay[]} */
  const out = [];
  for (const s of spawns) {
    const distM = haversineM(camLat, camLng, s.lat, s.lng);
    if (distM > maxDist) continue;
    const bearing = bearingBetween(camLat, camLng, s.lat, s.lng);
    const rel = angleDiff(bearing, headingDeg);
    if (Math.abs(rel) > fov / 2 + 6) continue; // small margin so edge spawns peek in
    const frac = Math.min(1, distM / maxDist);
    out.push({
      id: s.id,
      kind: s.kind,
      xPct: clamp(50 + (rel / fov) * 100, 3, 97),
      yPct: clamp(80 - 28 * frac, 50, 82),
      scale: clamp(1.7 - 1.2 * frac, 0.5, 1.7),
      distM: Math.round(distM),
      bearing: Math.round(bearing),
    });
  }
  // Far first so near overlays paint on top.
  out.sort((a, b) => b.distM - a.distM);
  return out;
}

/** @type {(v: number, lo: number, hi: number) => number} */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

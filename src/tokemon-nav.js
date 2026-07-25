// @ts-check
// Tokemon navigation — the PURE text-command + geometry side of the game's
// street-view mode (no I/O, Node-tested):
//
//   - parseGoCommand: the deterministic text-command grammar the player
//     navigates the real world with ("go north 200 m", "gå till Kungsgatan 1",
//     "look right", "continue 50 m"). EQUAL ENGLISH AND SWEDISH support, like
//     every deterministic intent gate in this project (CLAUDE.md invariant 6)
//     — the parity unit tests live in src/tokemon-nav.test.js.
//   - destinationPoint / bearingBetween / angleDiff / absoluteBearing:
//     spherical geodesy for executing moves and aiming the camera.
//   - projectSpawns: places spawns INSIDE a Street View frame under the same
//     pinhole camera the imagery was shot with — bearing → x, distance → y
//     and size — so the client can overlay creatures/items on real imagery.
//
// The server (tokemon-api.js) executes parsed commands and captures the
// frames; the client only renders.

import { haversineM } from "./tokemon.js";

/**
 * A parsed navigation command. `sv` marks Swedish vocabulary so replies can
 * come back in the command's language. Moves and looks each carry exactly one
 * of `bearing` (absolute compass direction) or `turn` (degrees off the
 * current heading) — absoluteBearing() resolves either against a heading.
 * @typedef {{kind: "move", bearing: number, turn?: undefined, distanceM: number, sv: boolean}} GoMoveBearing
 * @typedef {{kind: "move", turn: number, bearing?: undefined, distanceM: number, sv: boolean}} GoMoveTurn
 * @typedef {GoMoveBearing | GoMoveTurn} GoMove
 * @typedef {{kind: "goto", query: string, sv: boolean}} GoGoto
 * @typedef {{kind: "look", turn: number, bearing?: undefined, sv: boolean}} GoLookTurn
 * @typedef {{kind: "look", bearing: number, turn?: undefined, sv: boolean}} GoLookBearing
 * @typedef {GoLookTurn | GoLookBearing} GoLook
 * @typedef {GoMove | GoGoto | GoLook} GoCommand
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
/** @type {(v: number, lo: number, hi: number) => number} */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
 * The compass bearing a move/look command means, given where the player is
 * currently facing: absolute commands ("north") ignore the heading, relative
 * ones ("right", "framåt") turn off it.
 * @param {{bearing?: number, turn?: number}} cmd
 * @param {number} heading
 * @returns {number}
 */
export function absoluteBearing(cmd, heading) {
  return cmd.bearing !== undefined ? normalizeHeading(cmd.bearing) : normalizeHeading(heading + (cmd.turn || 0));
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
// The vocabulary.
//
// ONE table per word class, English and Swedish declared SIDE BY SIDE, so
// CLAUDE.md invariant 6 (equal EN+SV breadth in every deterministic gate) is
// a property of the data instead of two lists someone has to keep in sync.
// Everything downstream is derived from these tables: the lookup maps the
// parser uses, the Swedish reply-language flag (a word that appears in BOTH
// languages — "meter", "m" — is by construction not a Swedish marker), and
// the structural parity test in src/tokemon-nav.test.js, which walks the
// tables rather than a hand-written list of examples.
//
// Breadth rule for Swedish: plain and adverbial forms (öster/österut),
// definite forms where they occur, and the unaccented shapes a phone
// keyboard produces (soder, oster, vaster, sydvast, hoger, bakat).

/** @typedef {{en: string[], sv: string[]}} WordSet */

/** Compass words → an absolute bearing. @type {Array<WordSet & {bearing: number}>} */
const DIRECTIONS = [
  { bearing: 0, en: ["north", "n"], sv: ["norr", "norrut", "nord"] },
  { bearing: 45, en: ["northeast", "ne"], sv: ["nordost", "nordöst", "nordosten", "nordostut"] },
  { bearing: 90, en: ["east", "e"], sv: ["öster", "österut", "öst", "oster", "osterut", "ost"] },
  { bearing: 135, en: ["southeast", "se"], sv: ["sydost", "sydöst", "sydostut"] },
  { bearing: 180, en: ["south", "s"], sv: ["söder", "söderut", "syd", "soder", "soderut"] },
  { bearing: 225, en: ["southwest", "sw"], sv: ["sydväst", "sydvast", "sydvästut"] },
  { bearing: 270, en: ["west", "w"], sv: ["väster", "västerut", "väst", "vaster", "vasterut", "vast"] },
  { bearing: 315, en: ["northwest", "nw"], sv: ["nordväst", "nordvast", "nordvästut"] },
];

/**
 * Relative words → degrees off the CURRENT heading. Shared by looks
 * ("turn right") and moves ("go right", "fortsätt framåt") — one table, so a
 * word can never mean one thing to the camera and another to the feet.
 * @type {Array<WordSet & {turn: number}>}
 */
const RELATIVES = [
  { turn: 0, en: ["forward", "forwards", "ahead", "straight", "on"], sv: ["framåt", "framat", "fram", "rakt", "vidare"] },
  { turn: 90, en: ["right"], sv: ["höger", "hoger"] },
  { turn: -90, en: ["left"], sv: ["vänster", "vanster"] },
  { turn: 180, en: ["back", "backward", "backwards", "around", "behind"], sv: ["bakåt", "bakat", "tillbaka", "runt", "om"] },
];

/**
 * Verb classes. Multi-word verbs ("keep going", "rör dig") are declared as
 * phrases and split into tokens on the way into the lookup sets — the parser
 * classifies word by word.
 * @type {Record<"move" | "look" | "goto", WordSet>}
 */
const VERBS = {
  move: {
    en: ["go", "walk", "head", "move", "run", "continue", "keep going", "stroll", "proceed"],
    sv: ["gå", "ga", "promenera", "spring", "fortsätt", "fortsatt", "vandra", "rör", "ror"],
  },
  look: { en: ["look", "turn", "face"], sv: ["titta", "vänd", "vand", "sväng", "svang", "kika", "se"] },
  // The goto GRAMMAR is the regex list below (it has to capture a free-text
  // query); this set exists so its vocabulary still feeds the Swedish flag.
  goto: { en: ["travel", "navigate", "teleport", "goto", "take"], sv: ["åk", "ak", "res", "navigera", "till"] },
};

/** Units of distance. "m"/"meter"/"km" are shared, so they mark no language. */
const UNITS = {
  en: ["m", "km", "meter", "meters", "metre", "metres", "kilometer", "kilometers", "kilometre", "kilometres"],
  sv: ["m", "km", "meter", "kilometer"],
};

/** Angle words for "turn 45 degrees". */
const DEGREE_WORDS = { en: ["degrees", "degree", "deg"], sv: ["grader", "grad"] };

/** Words that carry no routing meaning but are normal to type. */
const FILLER = {
  en: ["the", "a", "an", "to", "and", "then", "me", "please", "about", "approx", "for"],
  sv: ["den", "det", "dig", "dej", "mig", "och", "sedan", "sen", "tack", "snälla", "ungefär", "cirka", "ca"],
};

/** @type {(sets: Array<WordSet>) => string[]} */
const phrasesOf = (sets) => sets.flatMap((s) => [...s.en, ...s.sv]);
/** Phrases → individual tokens ("keep going" → "keep", "going"). @type {(phrases: string[]) => string[]} */
const tokensOf = (phrases) => phrases.flatMap((p) => p.split(" "));

/** @type {(sets: Array<WordSet & {bearing?: number, turn?: number}>, key: "bearing" | "turn") => Map<string, number>} */
function wordMap(sets, key) {
  const map = new Map();
  for (const set of sets) {
    for (const word of tokensOf([...set.en, ...set.sv])) map.set(word, /** @type {number} */ (set[key]));
  }
  return map;
}

const DIR_BY_WORD = wordMap(DIRECTIONS, "bearing");
const REL_BY_WORD = wordMap(RELATIVES, "turn");
const MOVE_WORDS = new Set(tokensOf([...VERBS.move.en, ...VERBS.move.sv]));
const LOOK_WORDS = new Set(tokensOf([...VERBS.look.en, ...VERBS.look.sv]));
const GOTO_WORDS = new Set(tokensOf([...VERBS.goto.en, ...VERBS.goto.sv]));
const UNIT_WORDS = new Set(tokensOf([...UNITS.en, ...UNITS.sv]));
const DEG_WORDS = new Set(tokensOf([...DEGREE_WORDS.en, ...DEGREE_WORDS.sv]));
const FILLER_WORDS = new Set(tokensOf([...FILLER.en, ...FILLER.sv]));

/** Every word set the grammar knows, for the derivations below. */
const ALL_SETS = [...DIRECTIONS, ...RELATIVES, ...Object.values(VERBS), UNITS, DEGREE_WORDS, FILLER];

/**
 * The Swedish-ONLY vocabulary: every Swedish token minus every English one,
 * so shared spellings ("meter", "m", "ost") never flip the reply language on
 * their own. Exported for the parity test.
 * @type {Set<string>}
 */
export const SV_ONLY_WORDS = (() => {
  const en = new Set(tokensOf(ALL_SETS.flatMap((s) => s.en)));
  return new Set(tokensOf(ALL_SETS.flatMap((s) => s.sv)).filter((w) => !en.has(w)));
})();

/** The vocabulary tables, exported so the parity test walks the real data. */
export const NAV_VOCAB = { DIRECTIONS, RELATIVES, VERBS, UNITS, DEGREE_WORDS, FILLER };

// ---------------------------------------------------------------------------
// The command grammar.

// "travel to <place>" — anything that takes a free-text destination. Kept as
// regexes because they capture a query the token classifier can't.
const GOTO_RES = [
  /^(?:go|walk|travel|head|move|navigate|teleport)\s+to\s+(.+)$/,
  /^(?:take\s+me\s+to)\s+(.+)$/,
  /^(?:goto)\s+(.+)$/,
  // Swedish
  /^(?:gå|ga|promenera|åk|ak|res|vandra|ta\s+mig)\s+till\s+(.+)$/,
  /^(?:navigera)\s+till\s+(.+)$/,
];

// "200 m", "0,5 km", "150 meter/meters/metres"
const DIST_RE = /(\d+(?:[.,]\d+)?)\s*(km|kilometer|kilometers|kilometre|kilometres|m|meter|meters|metre|metres)\b/;
const NUM_RE = /^-?\d+(?:[.,]\d+)?$/;

export const DEFAULT_MOVE_M = 100;
export const MAX_MOVE_M = 1000;
const MAX_COMMAND_LEN = 200;

/** @type {(text: string) => string[]} */
const tokenize = (text) => text.split(/[\s,]+/).filter(Boolean);

/** @type {(text: string) => boolean} */
const isSwedish = (text) => tokenize(text).some((w) => SV_ONLY_WORDS.has(w));

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
 * What role a single word plays. "unknown" is the one that matters: a phrase
 * with no unknown words can be routed on its shape alone.
 * @param {string} word
 * @returns {"dir" | "rel" | "move" | "look" | "num" | "unit" | "deg" | "filler" | "unknown"}
 */
function classify(word) {
  if (DIR_BY_WORD.has(word)) return "dir";
  if (REL_BY_WORD.has(word)) return "rel";
  if (MOVE_WORDS.has(word)) return "move";
  if (LOOK_WORDS.has(word)) return "look";
  // A goto verb whose to/till phrase didn't match is routing-neutral from
  // here on ("travel north" is just a move; "gå till norr" likewise).
  if (GOTO_WORDS.has(word)) return "filler";
  if (UNIT_WORDS.has(word)) return "unit";
  if (DEG_WORDS.has(word)) return "deg";
  if (FILLER_WORDS.has(word)) return "filler";
  if (NUM_RE.test(word) || DIST_RE.test(word)) return "num";
  return "unknown";
}

/**
 * A phrase that is nothing but a direction ("the north", "norrut", "right").
 * Used to keep "go to the north" a MOVE while "go to the north entrance"
 * stays a place lookup — the old rule looked for a compass word ANYWHERE in
 * the query and sent players walking north instead of to North Station.
 * @param {string[]} words
 * @returns {boolean}
 */
function isDirectionalPhrase(words) {
  if (!words.length) return false;
  let directional = false;
  for (const w of words) {
    const role = classify(w);
    if (role === "dir" || role === "rel") directional = true;
    else if (role !== "filler" && role !== "num" && role !== "unit") return false;
  }
  return directional;
}

/**
 * "look right" / "titta västerut" / "turn 45 degrees".
 * @param {string[]} words
 * @param {boolean} sv
 * @returns {GoLook | null | undefined} undefined when the phrase isn't
 *   look-led at all; null when it is but says nothing the camera can do
 *   (which must NOT fall through to the move rules — "look at the sky" is
 *   not a walk).
 */
function parseLook(words, sv) {
  if (!LOOK_WORDS.has(words[0])) return undefined;
  const rest = words.slice(1);
  if (!rest.length) return null;
  for (const w of rest) {
    const turn = REL_BY_WORD.get(w);
    if (turn !== undefined) return { kind: "look", turn, sv };
  }
  for (const w of rest) {
    const bearing = DIR_BY_WORD.get(w);
    if (bearing !== undefined) return { kind: "look", bearing, sv };
  }
  // "turn 45", "vänd 45 grader"
  if (/^-?\d{1,3}$/.test(rest[0]) && (rest.length === 1 || (rest.length === 2 && DEG_WORDS.has(rest[1])))) {
    return { kind: "look", turn: clamp(Number(rest[0]), -180, 180), sv };
  }
  return null;
}

/**
 * "go north 200 m" / "norrut" / "continue 50 m" / "gå tillbaka".
 * @param {string[]} words
 * @param {string} text  The whole command, for the distance.
 * @param {boolean} sv
 * @returns {GoMove | null}
 */
function parseMove(words, text, sv) {
  const distanceM = parseDistance(text) || DEFAULT_MOVE_M;
  /** @type {(extra: {bearing: number} | {turn: number}) => GoMove} */
  const move = (extra) => /** @type {GoMove} */ ({ kind: "move", ...extra, distanceM, sv });

  const roles = words.map(classify);
  const firstDir = words.find((w) => DIR_BY_WORD.has(w));
  // Strict: every word is understood, so the shape alone decides. This is
  // what makes bare "norrut", verb-only "fortsätt", and relative "go left"
  // all parse without a hand-written phrase list.
  if (!roles.includes("unknown") && !roles.includes("look")) {
    if (firstDir !== undefined) return move({ bearing: /** @type {number} */ (DIR_BY_WORD.get(firstDir)) });
    const firstRel = words.find((w) => REL_BY_WORD.has(w));
    if (firstRel !== undefined) return move({ turn: /** @type {number} */ (REL_BY_WORD.get(firstRel)) });
    if (roles.includes("move")) return move({ turn: 0 }); // "continue", "gå 50 m" → straight on
    return null;
  }
  // Lenient: an explicit move verb plus a compass word still routes even with
  // words the grammar doesn't know ("walk northwest past the church").
  if (roles.includes("move") && firstDir !== undefined) {
    return move({ bearing: /** @type {number} */ (DIR_BY_WORD.get(firstDir)) });
  }
  return null;
}

/**
 * Parse a player navigation command. Examples:
 *   "gå norrut 200 m"      → {kind:"move", bearing:0, distanceM:200, sv:true}
 *   "continue 50 m"        → {kind:"move", turn:0, distanceM:50, sv:false}
 *   "go to Kungsgatan 1"   → {kind:"goto", query:"kungsgatan 1", sv:false}
 *   "turn right" / "look west" → {kind:"look", turn:90} / {kind:"look", bearing:270}
 * @param {unknown} input  Raw client text (untrusted).
 * @returns {GoCommand | null} null when the text isn't a navigation command.
 */
export function parseGoCommand(input) {
  const text = String(input || "").trim().toLowerCase().replace(/[!.?]+$/, "");
  if (!text || text.length > MAX_COMMAND_LEN) return null;
  const sv = isSwedish(text);
  const words = tokenize(text);

  // look/turn/face first — "turn left" must never read as a move.
  const look = parseLook(words, sv);
  if (look !== undefined) return look;

  // goto — a to/till phrase wins UNLESS the whole query is just a direction
  // ("go to the north" is a move; "go to the north entrance" is a place).
  for (const re of GOTO_RES) {
    const m = re.exec(text);
    if (!m) continue;
    const query = m[1].trim();
    if (isDirectionalPhrase(tokenize(query))) break; // "go to the north" → a move
    return query.length >= 2 ? { kind: "goto", query, sv } : null;
  }

  return parseMove(words, text, sv);
}

// ---------------------------------------------------------------------------
// Spawn projection into a Street View frame.
//
// The frames are square (STREETVIEW_SIZE 512×512) rectilinear renders at
// SCENE_FOV, so the same PINHOLE CAMERA that produced the imagery places the
// overlays — a tangent law, not a linear sweep. The difference is not
// cosmetic: at the edge of a 90° frame a linear mapping is ~8% of the frame
// width off, enough to park a creature on the wrong building.
//
//   x: tan(bearing off the camera heading) / tan(fov/2)
//   y: the spawn stands on the ROAD, so its ground point sits below the
//      horizon by atan(camera height / distance) — near spawns low in the
//      frame, distant ones converging on the horizon at 50%.
//   scale: apparent size falls off as 1/distance, clamped so the far end of
//      the view stays big enough to tap.
//
// The client anchors an overlay at its FEET (translate(-50%, -90%)), which is
// exactly the ground point y describes.

export const SCENE_FOV = 90;
export const SCENE_VIEW_DIST_M = 130;
/** Street View's car-roof camera height above the road, in metres. */
export const CAMERA_HEIGHT_M = 2.5;
/** Distance at which an overlay renders at its base size. */
export const SCALE_REF_M = 30;

const EDGE_MARGIN_DEG = 6; // spawns just outside the frame still peek in at the edge
const X_MIN_PCT = 3;
const X_MAX_PCT = 97;
const Y_MAX_PCT = 92; // a spawn closer than ~camera height would fall out of frame
const SCALE_MIN = 0.5;
const SCALE_MAX = 2;

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
  const halfFovTan = Math.tan(toRad(Math.min(fov, 170) / 2));
  /** @type {SpawnOverlay[]} */
  const out = [];
  for (const s of spawns) {
    const distM = haversineM(camLat, camLng, s.lat, s.lng);
    if (distM > maxDist) continue;
    const bearing = bearingBetween(camLat, camLng, s.lat, s.lng);
    const rel = angleDiff(bearing, headingDeg);
    if (Math.abs(rel) > fov / 2 + EDGE_MARGIN_DEG) continue;
    out.push({
      id: s.id,
      kind: s.kind,
      xPct: clamp(50 + (50 * Math.tan(toRad(rel))) / halfFovTan, X_MIN_PCT, X_MAX_PCT),
      yPct: clamp(50 + (50 * (CAMERA_HEIGHT_M / Math.max(distM, 0.1))) / halfFovTan, 50, Y_MAX_PCT),
      scale: clamp(SCALE_REF_M / Math.max(distM, 0.1), SCALE_MIN, SCALE_MAX),
      distM: Math.round(distM),
      // % 360 because rounding 359.6 must not report a 360° bearing.
      bearing: Math.round(bearing) % 360,
    });
  }
  // Far first so near overlays paint on top.
  out.sort((a, b) => b.distM - a.distM);
  return out;
}

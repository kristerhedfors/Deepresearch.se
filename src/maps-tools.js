// @ts-check
// THE STREET-IMAGERY MCP TOOLS — "walk me down this road and tell me what you
// see", answered in words.
//
// WHY THESE EXIST. The site can already stand at a coordinate, look in a chosen
// direction, and have a vision model say what is actually in the frame
// (src/maps-enrichment.js describeStreetView). In the browser that is driven by
// the panorama the user is looking at: the client sends its live point of view
// and the enrichment reads the rest off the conversation. A VOICE caller has
// none of that — no panorama, no device location, no scroll-back — so the same
// capability was unreachable from the one surface where a spoken description of
// a place is worth the most.
//
// THE MISSING PIECE WAS STATE, NOT CAPABILITY, and MCP's own answer is the one
// taken here: revision 2026-07-28 removed protocol sessions and says
// cross-request state travels as an ordinary tool argument. So every look
// returns a `view` HANDLE — where it stood, which way it faced, which panorama
// it used — and the next call passes it back. "A hundred metres south on this
// road" and "now look right" are two calls, each self-contained, neither
// remembering anything on the server.
//
// THIS MODULE IS PURE — it imports nothing. Schemas, the direction vocabulary,
// the handle codec and the spoken renderers live here; everything that reaches
// Google or a vision model lives in src/extension-tools-run.js behind a dynamic
// import. That split is what lets src/mcp.js name none of it (invariant 7: core
// modules must not name a third-party service) and what makes the parsing below
// testable with plain strings.
//
// ---- WHAT A VOICE ANSWER MAY CONTAIN ---------------------------------------
//
// Not the images. Every frame the maps layer produces is a base64 data: URL
// (512×512 per Street View frame); returning one from a tool result would blow
// the response and be useless to a caller reading aloud. The frames go to the
// vision helper and only its TEXT comes back. Nor the model-facing context
// blocks of src/googlemaps-blocks.js: those are written AT an answer model
// ("displayed to the user directly beside this reply", "ALWAYS include the Map
// link as a markdown link") and would put instructions and markdown into
// someone's ear. Hence the renderers at the bottom of this file.

/**
 * A resolved standpoint: where the panorama is, which way it faces, and which
 * panorama it is. This is what a `view` handle encodes.
 * @typedef {{ lat: number, lng: number, heading: number, panoId: string }} StreetViewHandle
 */

/** How far one `move` may go. The floor stops a "move" that lands inside the
 * same panorama; the ceiling keeps a jump inside the neighbourhood a caller can
 * still be said to be looking around in — beyond that, ask for the place by
 * name instead. Same window the conversational relative-move parser uses. */
export const MIN_MOVE_M = 5;
export const MAX_MOVE_M = 3000;
export const DEFAULT_MOVE_M = 100;

/** How far the underlying place search biases toward the standpoint. Beyond
 * this a result is still returned, but calling it "nearby" needs a caveat. */
export const NEARBY_BIAS_M = 5000;

/** Places returned by one nearby search. Three is what the underlying search
 * asks Google for, and more than three is not a list anyone hears. */
export const MAX_NEARBY = 3;

// ---------------------------------------------------------------------------
// The direction vocabulary — EN + SV, at equal breadth (invariant 6)
// ---------------------------------------------------------------------------
//
// Both languages get the definite and adverbial forms Swedish actually uses
// ("söder", "söderut", "åt söder", "mot söder"), because a caller — or the model
// speaking for them — will produce them and a gate that only knows "south"
// silently answers the wrong question rather than failing loudly.
//
// The matching is TOKEN-based rather than regex-based on purpose. The value
// arrives as a short argument ("till höger", "north-east", "90"), so it is
// lowercased, split on anything that is not a letter or digit, and looked up
// word by word. That sidesteps the JS `\b` trap that has broken bilingual gates
// in this repo before: `\b` sits between `r` and `ö` in "söderut", so
// /\bsöder\b/ matches nothing a Swede would type.

/** Absolute compass bearings, in degrees clockwise from north. */
export const COMPASS_BEARINGS = {
  north: 0,
  norr: 0,
  nord: 0,
  norrut: 0,
  northeast: 45,
  "north-east": 45,
  nordost: 45,
  nordöst: 45,
  nordostlig: 45,
  east: 90,
  öster: 90,
  öst: 90,
  österut: 90,
  southeast: 135,
  "south-east": 135,
  sydost: 135,
  sydöst: 135,
  south: 180,
  söder: 180,
  syd: 180,
  söderut: 180,
  southwest: 225,
  "south-west": 225,
  sydväst: 225,
  sydvest: 225,
  west: 270,
  väster: 270,
  väst: 270,
  västerut: 270,
  northwest: 315,
  "north-west": 315,
  nordväst: 315,
  nordvest: 315,
};

/** Turns relative to the direction currently faced, in degrees. */
export const RELATIVE_TURNS = {
  // straight on
  forward: 0,
  ahead: 0,
  straight: 0,
  onward: 0,
  framåt: 0,
  fram: 0,
  rakt: 0,
  frammåt: 0,
  vidare: 0,
  framför: 0,
  // to the right
  right: 90,
  höger: 90,
  hoger: 90,
  högerut: 90,
  starboard: 90,
  styrbord: 90,
  // to the left
  left: -90,
  vänster: -90,
  vanster: -90,
  vänsterut: -90,
  port: -90,
  babord: -90,
  // behind
  back: 180,
  backward: 180,
  backwards: 180,
  behind: 180,
  bakåt: 180,
  bakom: 180,
  tillbaka: 180,
  omvänt: 180,
};

/** Half-turns, for "slightly right" / "snett vänster". */
export const HALF_TURN_WORDS = new Set([
  "slightly", "slight", "half",
  "snett", "lite", "något", "aningen", "halvt", "halv",
]);

/** Vertical looks, expressed as a camera pitch in degrees. Worth having for a
 * spoken tour: "look up" is how anyone asks about the top of a building. */
export const PITCH_WORDS = {
  up: 25,
  upward: 25,
  upp: 25,
  uppåt: 25,
  sky: 25,
  himlen: 25,
  taket: 25,
  down: -25,
  downward: -25,
  ner: -25,
  ned: -25,
  neråt: -25,
  nedåt: -25,
  ground: -25,
  marken: -25,
  gatan: -25,
};

/**
 * Split a short argument value into comparable tokens: lowercase, Unicode
 * letters and digits only. Deliberately NOT a regex over prose — see the note
 * about `\b` above.
 * @param {unknown} value
 * @returns {string[]}
 */
export function directionTokens(value) {
  if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
  if (typeof value !== "string") return [];
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    // A LEADING minus is kept — "-90" is a bearing and dropping its sign turns
    // the camera the wrong way — while a trailing one is punctuation.
    .map((t) => t.replace(/-+$/g, ""))
    .map((t) => (t === "-" ? "" : t))
    .filter(Boolean);
}

/**
 * Resolve a direction argument into an absolute bearing.
 *
 * Three vocabularies, in the order a caller means them:
 *   1. a number — "225" is a bearing, and a model that knows the geometry
 *      should be able to say so directly;
 *   2. a compass word (EN or SV) — absolute, ignores where we face now;
 *   3. a relative turn (EN or SV) — applied to `currentHeading`, which is what
 *      makes "now look right" mean anything at all.
 *
 * Returns null when nothing matched, and the caller then keeps the heading it
 * had: an unparsed direction must not silently spin the camera somewhere.
 *
 * @param {unknown} value
 * @param {number} currentHeading degrees clockwise from north
 * @returns {{ bearing: number, absolute: boolean } | null}
 */
export function resolveDirection(value, currentHeading = 0) {
  const tokens = directionTokens(value);
  if (!tokens.length) return null;

  // A bare bearing.
  if (tokens.length === 1) {
    const n = Number(tokens[0]);
    if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(tokens[0])) {
      return { bearing: normalizeBearing(n), absolute: true };
    }
  }

  for (const token of tokens) {
    const compass = /** @type {Record<string, number>} */ (COMPASS_BEARINGS)[token];
    if (compass !== undefined) return { bearing: normalizeBearing(compass), absolute: true };
  }

  const half = tokens.some((t) => HALF_TURN_WORDS.has(t));
  for (const token of tokens) {
    const turn = /** @type {Record<string, number>} */ (RELATIVE_TURNS)[token];
    if (turn === undefined) continue;
    // "slightly right" is 45°, not 90°; a half-turn of 180 stays 180 (there is
    // no such thing as slightly behind you).
    const applied = half && turn !== 0 && Math.abs(turn) === 90 ? turn / 2 : turn;
    return { bearing: normalizeBearing(currentHeading + applied), absolute: false };
  }
  return null;
}

/**
 * The camera pitch a look asks for, or 0 (level) when it asks for none.
 * @param {unknown} value
 * @returns {number}
 */
export function resolvePitch(value) {
  for (const token of directionTokens(value)) {
    const pitch = /** @type {Record<string, number>} */ (PITCH_WORDS)[token];
    if (pitch !== undefined) return pitch;
  }
  return 0;
}

/** @param {number} deg @returns {number} */
export function normalizeBearing(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return 0;
  return Math.round(((n % 360) + 360) % 360);
}

/** A bearing as the compass point a person would say. 16 points, because "just
 * north of east" is the kind of precision a spoken direction wants and
 * "northeast" alone throws away half of it. */
const COMPASS_POINTS = [
  "north", "north-northeast", "northeast", "east-northeast",
  "east", "east-southeast", "southeast", "south-southeast",
  "south", "south-southwest", "southwest", "west-southwest",
  "west", "west-northwest", "northwest", "north-northwest",
];
/** @param {number} bearing @returns {string} */
export function compassPoint(bearing) {
  return COMPASS_POINTS[Math.round(normalizeBearing(bearing) / 22.5) % 16];
}

/**
 * Clamp a move distance into the window above, defaulting when unsaid.
 * @param {unknown} meters
 * @returns {number}
 */
export function clampMoveMeters(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MOVE_M;
  return Math.min(MAX_MOVE_M, Math.max(MIN_MOVE_M, Math.round(n)));
}

// ---------------------------------------------------------------------------
// The view handle — the whole of this family's "session"
// ---------------------------------------------------------------------------
//
// One opaque-looking but deliberately readable string: `sv1:lat,lng,heading,pano`.
// Readable because a caller reading it aloud or logging it should not be holding
// a mystery, and because a debugging session with a handle in hand can go
// straight to the coordinates. It carries NOTHING about the account, the
// question, or the conversation — there is no server-side record it points at,
// so a handle that leaks is a public coordinate and nothing more.

const HANDLE_PREFIX = "sv1:";

/**
 * @param {StreetViewHandle} view
 * @returns {string}
 */
export function formatViewHandle(view) {
  const lat = Number(view.lat).toFixed(6);
  const lng = Number(view.lng).toFixed(6);
  const heading = normalizeBearing(view.heading);
  const pano = typeof view.panoId === "string" ? view.panoId.replace(/[^A-Za-z0-9_-]/g, "") : "";
  return `${HANDLE_PREFIX}${lat},${lng},${heading},${pano}`;
}

/**
 * Parse a handle back, tolerantly: a caller that echoes a slightly mangled
 * string (a voice pipeline that lost the prefix, a model that added a space)
 * still gets its standpoint back if the numbers survived. Returns null when
 * there is no usable coordinate — never a partly-filled handle, because a
 * silent 0,0 is the Atlantic.
 * @param {unknown} raw
 * @returns {StreetViewHandle | null}
 */
export function parseViewHandle(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const body = raw.trim().replace(/^sv1\s*:\s*/i, "");
  const parts = body.split(",").map((p) => p.trim());
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const heading = normalizeBearing(Number(parts[2]) || 0);
  const pano = typeof parts[3] === "string" ? parts[3].replace(/[^A-Za-z0-9_-]/g, "") : "";
  return { lat, lng, heading, panoId: pano };
}

/**
 * Are these coordinates usable? Rejects the (0,0) that a mis-parsed argument
 * produces, which is in the Gulf of Guinea and has no Street View.
 * @param {unknown} lat
 * @param {unknown} lng
 * @returns {boolean}
 */
export function usableCoords(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return false;
  return !(a === 0 && b === 0);
}

// ---------------------------------------------------------------------------
// The tool definitions
// ---------------------------------------------------------------------------

export const STREET_VIEW_TOOL = {
  name: "street_view_look",
  description:
    "Stand at a place and describe what is actually visible there, in words — for a " +
    "caller with no screen. Anchor the first call with `place` (an address or place name) " +
    "or `lat`/`lng`. Every result returns a `view` handle; pass it back as `view` on the " +
    "next call to keep standing where you were. `move` walks from there before looking " +
    "(\"south\", \"forward\", \"left\", or a bearing in degrees, with `move_meters`), and " +
    "`look` turns to face a direction (the same vocabulary, plus \"up\" and \"down\"). " +
    "So \"a hundred metres south along this road, then describe what is on your right\" is " +
    "one call with move=south, move_meters=100, look=right. `question` is answered from " +
    "the imagery itself before anything is described. Swedish direction words are " +
    "understood throughout. Returns spoken prose, never an image.",
  input_schema: {
    type: "object",
    properties: {
      place: {
        type: "string",
        description:
          "Address or place name to stand at, e.g. \"Basaltvägen 1, Enköping\". Ignored when `view` is given.",
      },
      lat: { type: "number", description: "Latitude to stand at, if you have coordinates instead of a name." },
      lng: { type: "number", description: "Longitude to stand at." },
      view: {
        type: "string",
        description:
          "A `view` handle returned by a previous street_view_look call — where you were standing and " +
          "which way you faced. This is how a follow-up (\"now look right\") stays anchored; there is no " +
          "server-side session.",
      },
      move: {
        type: "string",
        description:
          "Walk this way before looking: a compass direction (north/söderut/northeast…), a turn relative " +
          "to the direction currently faced (forward/back/left/right, framåt/bakåt/vänster/höger), or a " +
          "bearing in degrees. Snaps to the nearest panorama, so the standpoint you get back may differ " +
          "slightly from the exact metres asked for.",
      },
      move_meters: {
        type: "number",
        description: `How far to walk, in metres (${MIN_MOVE_M}–${MAX_MOVE_M}, default ${DEFAULT_MOVE_M}). Only used with \`move\`.`,
        default: DEFAULT_MOVE_M,
      },
      look: {
        type: "string",
        description:
          "Which way to face when describing: the same vocabulary as `move`, plus \"up\"/\"down\" " +
          "(\"upp\"/\"ner\") to tilt. Defaults to the direction of travel, or to the direction the " +
          "`view` handle was already facing.",
      },
      question: {
        type: "string",
        description:
          "What you want to know about this view — answered strictly from what is visible, and answered " +
          "first. Omit for a plain description of the scene.",
      },
    },
    required: [],
  },
};

export const PLACE_NEARBY_TOOL = {
  name: "place_nearby",
  description:
    "Find places near a standpoint and report each one's distance and compass direction from it, " +
    "in words — \"a petrol station 400 metres north-east\". Anchor it with a `view` handle from " +
    "street_view_look, with `lat`/`lng`, or with `near` (a place name to search around). " +
    "`query` is what to look for (\"pharmacy\", \"bageri\", \"charging station\"). Contacts no " +
    "imagery and describes nothing visual — to SEE one of the places it names, call " +
    "street_view_look with that place's name as `place`.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, e.g. \"petrol station\" or \"apotek\"." },
      view: { type: "string", description: "A `view` handle from street_view_look, to search around that standpoint." },
      lat: { type: "number", description: "Latitude to search around." },
      lng: { type: "number", description: "Longitude to search around." },
      near: { type: "string", description: "A place name or address to search around, when you have no coordinates." },
      limit: {
        type: "number",
        description: `How many places to report (1–${MAX_NEARBY}, default ${MAX_NEARBY}).`,
        default: MAX_NEARBY,
      },
    },
    required: ["query"],
  },
};

export const MAPS_MCP_TOOLS = [STREET_VIEW_TOOL, PLACE_NEARBY_TOOL];

// ---------------------------------------------------------------------------
// The spoken renderers
// ---------------------------------------------------------------------------

/**
 * One sentence naming where the standpoint is, for a listener who cannot see a
 * map. The place name when one was resolved, the coordinates otherwise — never
 * both, because a spoken answer that reads out six decimal places has stopped
 * being a spoken answer.
 * @param {{ label?: string, lat: number, lng: number }} at
 * @returns {string}
 */
export function standpointSentence(at) {
  if (at.label) return at.label;
  return `${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`;
}

/**
 * The whole street_view_look answer, assembled for speech.
 *
 * Order is the order a person needs it: where you are, which way you are facing,
 * then what is there (the vision helper's answer, which already leads with the
 * caller's question), then the two practicalities — how old the imagery is, and
 * the handle to carry into the next call.
 *
 * @param {{
 *   at: { label?: string, lat: number, lng: number },
 *   heading: number,
 *   moved?: { bearing: number, meters: number, actual: number } | null,
 *   description: string,
 *   date?: string,
 *   handle: string,
 *   imagery: boolean,
 *   unparsed?: string[],
 * }} view
 * @returns {string}
 */
export function renderStreetViewAnswer(view) {
  const lines = [];
  const facing = compassPoint(view.heading);
  if (view.moved) {
    const asked = view.moved.meters;
    const actual = view.moved.actual;
    // Say the real distance when the snap moved us meaningfully off the asked-for
    // one. Reporting the requested figure as if it were the achieved one is the
    // kind of small lie that makes a whole spoken tour untrustworthy.
    const drift = Math.abs(actual - asked);
    const moved =
      drift > Math.max(15, asked * 0.2)
        ? `Moved ${compassPoint(view.moved.bearing)} — the nearest imagery is about ${actual} metres from where you were, not the ${asked} asked for.`
        : `Moved about ${actual} metres ${compassPoint(view.moved.bearing)}.`;
    lines.push(moved);
  }
  lines.push(`Standing at ${standpointSentence(view.at)}, facing ${facing}.`);
  if (view.description) lines.push(view.description);
  else if (view.imagery) lines.push("There is imagery here, but it could not be described just now.");
  else lines.push("There is no street-level imagery at this spot.");
  if (view.date) lines.push(`The imagery was captured ${spokenDate(view.date)}.`);
  if (view.unparsed?.length) {
    lines.push(
      `(${view.unparsed.join(" and ")} was not understood, so nothing was done with it — use a compass ` +
        `direction, left/right/forward/back, or a bearing in degrees.)`,
    );
  }
  // The handle is machinery, not narration: it is marked as such so the model
  // driving a spoken session carries it into the next call instead of reading a
  // panorama id out loud. It stays in the text rather than in structuredContent
  // because a client that ignores structured output would otherwise lose the
  // ability to follow up at all.
  lines.push(`[for the next call: view=${view.handle}]`);
  return lines.join(" ");
}

/**
 * A Street View capture date (`2023-07`, `2023-07-15`) as something to say out
 * loud. Unparseable input comes back as-is rather than being dropped: a wrong
 * shape is still information, and inventing a date is worse.
 * @param {string} raw
 * @returns {string}
 */
export function spokenDate(raw) {
  const m = /^(\d{4})-(\d{2})/.exec(String(raw || ""));
  if (!m) return String(raw || "");
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const month = months[Number(m[2]) - 1];
  return month ? `in ${month} ${m[1]}` : `in ${m[1]}`;
}

/**
 * The place_nearby answer. Each place gets one clause a listener can act on:
 * what it is, how far, and which way — bearing first in words, because "north-east
 * of you" is the part that steers someone and "412 metres" is the part they
 * round anyway.
 * @param {{ query: string, at: { label?: string, lat: number, lng: number }, places: Array<{ name: string, type?: string, address?: string, meters: number, bearing: number }> }} found
 * @returns {string}
 */
export function renderNearbyAnswer(found) {
  if (!found.places.length) {
    return `Nothing matching "${found.query}" was found near ${standpointSentence(found.at)}.`;
  }
  const parts = found.places.map((p) => {
    const what = p.type ? `${p.name} (${p.type})` : p.name;
    return `${what}, about ${spokenDistance(p.meters)} ${compassPoint(p.bearing)}${p.address ? `, at ${p.address}` : ""}`;
  });
  const head = `Near ${standpointSentence(found.at)}: `;
  // The underlying search BIASES toward the standpoint rather than restricting
  // to it, so a thin local result set can come back with something far away.
  // Reporting that as "nearby" is the kind of confident wrongness a listener
  // cannot check.
  const far = found.places.filter((p) => p.meters > NEARBY_BIAS_M).length;
  const caveat = far
    ? ` ${far === found.places.length ? "None of these is" : "Not all of these are"} close by — the search widens ` +
      `when there is nothing nearer.`
    : "";
  return head + parts.join("; ") + "." + caveat;
}

/**
 * A distance as a person says it: metres rounded to something sayable below a
 * kilometre, kilometres with one decimal above it.
 * @param {number} meters
 * @returns {string}
 */
export function spokenDistance(meters) {
  const m = Math.max(0, Math.round(Number(meters) || 0));
  // Never "0 metres": below the rounding floor the honest word is "a few".
  if (m < 5) return "a few metres";
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} metres`;
  if (m < 1000) return `${Math.round(m / 50) * 50} metres`;
  // Rounded in metres before the divide: `(1450 / 1000).toFixed(1)` is "1.4",
  // because 1.45 is not 1.45 in binary floating point.
  const km = Math.round(m / 100) / 10;
  return `${km} ${km === 1 ? "kilometre" : "kilometres"}`;
}

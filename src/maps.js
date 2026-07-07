// Maps enrichment via OpenStreetMap Nominatim — the text-driven half of this
// app's mapping capability. Its sibling src/geocode.js handles the ONE
// location a photo carries in its own EXIF (coordinates → place name); this
// module handles the locations a user's *message* names in words:
//
//   1. Reverse geocoding of coordinates typed into the message
//      ("what's at 59.3293, 18.0686?") — coordinates → place name, the same
//      Nominatim /reverse call geocode.js makes (reused, not duplicated).
//   2. Forward geocoding / place search of a named place or address
//      ("where is the Eiffel Tower?", "coordinates of 1600 Pennsylvania Ave")
//      — place name → canonical name, coordinates, OSM category, and a
//      citable OSM link, via Nominatim /search.
//
// Same deterministic, no-function-calling wiring as the geocoder and the
// Shodan enrichment (src/shodan.js): the Worker extracts targets from the
// latest user message with pure, unit-tested heuristics and resolves them
// into a labeled context block every downstream phase (triage/search/
// synthesis) can reason and search with — never blended into the user's text.
//
// Runs server-side, Worker-mediated (logged, timeout-bounded, rate-limit
// aware), same as Berget/Exa/Shodan. Only the extracted place token or
// coordinate pair crosses the wire to Nominatim — never the user's full
// question, filename, or any account/session identifier.
//
// Privacy boundary, stated once because it is the design:
//   - REVERSE geocoding of coordinates runs independent of the web-search
//     toggle, exactly like the photo geocoder: it resolves numbers the
//     message already contains, revealing nothing beyond a point on a map.
//   - FORWARD geocoding of a *named place* is gated behind the web-search
//     toggle, exactly like Exa: the place token is derived from the user's
//     question/topic, so a privacy-minded user who turned search OFF should
//     not have it sent to a third party either.
//
// Fails soft in every branch: a bad coordinate, an unresolvable place, a
// Nominatim timeout or error all degrade to "no location context" — never a
// blocked or delayed chat. Mapping is enrichment, never a hard requirement.

import { reverseGeocode } from "./geocode.js";
import { textOf, lastUserMessage, withAppendedText } from "./conversation.js";

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 4000;
const GENERIC_USER_AGENT = "geocode-client/1.0";

// Bounds on how far one message can fan out to Nominatim — keeps latency and
// polite-usage predictable regardless of how many location-shaped tokens a
// message happens to contain.
const MAX_COORDS = 4;
const MAX_PLACES = 3;
const MAX_QUERY_CHARS = 90;

// ---- coordinate extraction (pure — exported for unit tests) ----------------

// Explicit hemisphere form: "59.3293° N, 18.0686° E" / "40.7128 N 74.006 W".
// Degrees symbol optional; the N/S/E/W letters carry the sign.
const COORD_HEMI_RE =
  /(\d{1,2}(?:\.\d+)?)\s*°?\s*([NSns])[\s,]+(\d{1,3}(?:\.\d+)?)\s*°?\s*([EWew])/g;
// Labeled form: "lat 40.71, lon -74.00" / "latitude: 40.71 longitude: -74".
const COORD_LABELED_RE =
  /lat(?:itude)?\.?[\s:=]*(-?\d{1,2}(?:\.\d+)?)[\s,;]+lon(?:g|gitude)?\.?[\s:=]*(-?\d{1,3}(?:\.\d+)?)/gi;
// Plain decimal pair: "59.3293, 18.0686". A decimal fraction on BOTH numbers
// plus a comma separator is required, AND — since this notation is otherwise
// indistinguishable from a "version 3.14, 2.71" / "pH 7.4, 6.9" style list —
// a location cue must be present somewhere in the message (COORD_CUE below).
// The hemisphere and labeled forms are self-evidently coordinates and need no
// such cue. The range check discards anything that still isn't a lat/lon.
const COORD_PLAIN_RE = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/g;
// Cues that the numbers are a geographic point, split by strength. A STRONG
// cue (the word is unambiguously about coordinates) accepts a plain pair at
// any precision. A WEAK cue (locational but also common in prose — "at",
// "near", "distance") accepts a plain pair ONLY when it carries GPS-like
// precision (≥3 decimals on a number), so "the ratio settled at 1.5, 2.5"
// stays quiet while "what's at 59.3293, 18.0686" resolves. Words like
// "point"/"spot"/"place" are excluded entirely — they fire on data-speak.
const STRONG_COORD_CUE =
  /\b(?:co[oö]?ordinates?|coords?|gps|lat(?:itude)?|long?(?:itude)?|geo(?:code\w*|coding|locat\w*))\b|°/i;
const WEAK_COORD_CUE =
  /\b(?:locat\w*|maps?|pinpoint|where|here|nearby|near|distance|far|route|directions?|driving|navigat\w*|elevation|altitude)\b|\bat\s+-?\d/i;

const decimalPlaces = (s) => (String(s).split(".")[1] || "").length;

function inRange(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// Extracts explicit coordinate pairs from free text in the three common
// notations. Range-checked, deduped (to ~5 decimal places), capped. Returns
// an array of { lat, lon, raw } — `raw` is the matched text, shown to the
// user in the resolved-location line so they can see what was picked up.
export function extractCoordinates(text) {
  const raw = typeof text === "string" ? text : "";
  const out = [];
  const seen = new Set();
  const push = (lat, lon, matched) => {
    if (out.length >= MAX_COORDS || !inRange(lat, lon)) return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ lat, lon, raw: matched.trim() });
  };

  for (const m of raw.matchAll(COORD_HEMI_RE)) {
    const lat = Number(m[1]) * (/[sS]/.test(m[2]) ? -1 : 1);
    const lon = Number(m[3]) * (/[wW]/.test(m[4]) ? -1 : 1);
    push(lat, lon, m[0]);
  }
  for (const m of raw.matchAll(COORD_LABELED_RE)) {
    push(Number(m[1]), Number(m[2]), m[0]);
  }
  const strongCue = STRONG_COORD_CUE.test(raw);
  if (strongCue || WEAK_COORD_CUE.test(raw)) {
    for (const m of raw.matchAll(COORD_PLAIN_RE)) {
      const precise = decimalPlaces(m[1]) >= 3 || decimalPlaces(m[2]) >= 3;
      if (strongCue || precise) push(Number(m[1]), Number(m[2]), m[0]);
    }
  }
  return out;
}

// ---- place-query extraction (pure — exported for unit tests) ---------------

// Words a captured phrase might trail with that aren't part of the place name.
const TRAILING_FILLER =
  /\s+(?:located|situated|exactly|precisely|right now|now|today|please|on (?:a|the) maps?|on maps?|in the world|geographically)+$/i;
// A capture that is really a pronoun / generic noun, not a place — reject it
// so a weak "where is X" cue can't fire on "where is my phone".
const NON_PLACE = new Set([
  "it", "this", "that", "these", "those", "there", "here", "them", "they",
  "he", "she", "we", "i", "you", "one", "someone", "everyone", "anybody",
  "my phone", "my car", "my keys", "my order", "my package", "my dog",
  "my house", "my home", "my office", "my location", "my hotel", "my place",
  "work", "home", "the office", "the bug", "the error", "the problem",
  "the issue", "the file", "the author", "the moon",
]);

// Cleans a raw captured phrase into a geocodable query, or returns "" to
// reject it. Strips surrounding quotes/punctuation, trailing filler, and a
// leading article; caps length; rejects empties, pronouns, and phrases with
// no letters.
function cleanPlace(sRaw) {
  let s = String(sRaw || "").trim();
  s = s.replace(/^["'`(]+|["'`).,;:!?]+$/g, "").trim();
  s = s.replace(TRAILING_FILLER, "").trim();
  s = s.replace(/[.,;:!?]+$/g, "").trim();
  s = s.replace(/^(?:the|a|an)\s+/i, "").trim();
  s = s.slice(0, MAX_QUERY_CHARS).trim();
  if (s.length < 2) return "";
  if (!/[a-z]/i.test(s)) return ""; // must contain a letter (not bare coords)
  if (NON_PLACE.has(s.toLowerCase())) return "";
  return s;
}

// "Proper-noun-ish" gate for the WEAK "where is X" cue only: a bare
// where-question is only treated as a place lookup when the capture looks like
// a real place — it contains a capitalized word, a comma (city, region), or a
// leading street number. Strong cues ("coordinates of", "map of", "directions
// to", "distance from…to") already guarantee location intent, so they accept a
// lowercase capture as-is.
function looksLikePlace(s) {
  if (/[A-Z]/.test(s)) return true; // a capitalized token (Eiffel Tower, Paris)
  if (/,/.test(s)) return true; // "springfield, illinois"
  if (/^\d{1,5}\s+\S/.test(s)) return true; // a street address ("10 downing st")
  return false;
}

// Each cue: a prefix regex whose match is immediately followed by the place
// phrase. `strong` cues accept any cleaned capture; the one weak cue
// ("where is") additionally requires looksLikePlace(). The capture runs
// lazily up to a clause boundary (punctuation or a conjunction) so
// "where is Paris and what's the population" stops at "Paris".
const PLACE_CUES = [
  { re: /\bcoordinates?\s+(?:of|for)\s+/i, strong: true },
  { re: /\bgps\s+(?:coordinates?\s+)?(?:of|for)\s+/i, strong: true },
  { re: /\b(?:the\s+)?(?:lat(?:itude)?\s+and\s+long?(?:itude)?|long?(?:itude)?\s+and\s+lat(?:itude)?)\s+(?:of|for)\s+/i, strong: true },
  { re: /\blocation\s+of\s+/i, strong: true },
  { re: /\blocated\s+(?:in|at|near|on|within)\s+/i, strong: true },
  { re: /\bmaps?\s+of\s+/i, strong: true },
  { re: /\bdirections?\s+(?:to|from)\s+/i, strong: true },
  { re: /\b(?:how\s+(?:do|can)\s+i|how\s+to)\s+get\s+to\s+/i, strong: true },
  { re: /\broute\s+(?:to|from)\s+/i, strong: true },
  { re: /\bwhere(?:\s+(?:is|are|was|were|abouts?)|'s|s)\s+/i, strong: false },
];

// Boundary at which a captured place phrase ends: a conjunction/clause word, a
// travel preposition (so "route from Berlin to Munich" captures only "Berlin"
// here and leaves the A→B pair to the distance extractor), or any sentence
// punctuation. Kept out of the capture itself.
const PLACE_STOP =
  /\s+(?:and|but|or|so|because|then|which|that|who|whose|located|situated|to|from|toward|towards)\b|[?.!,;:\n]/i;

function captureAfter(text, cueRe) {
  const m = cueRe.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const stop = rest.search(PLACE_STOP);
  return stop === -1 ? rest : rest.slice(0, stop);
}

// Distance / travel questions name TWO places: "how far from A to B",
// "distance between A and B", "how long to drive from A to B". Only mined when
// a distance/travel cue is present, so an ordinary "from Monday to Friday"
// never geocodes.
const DISTANCE_CUE =
  /\b(?:how far|distance|how long.*?\b(?:drive|fly|walk|travel|cycl|bike)|travel time|driving time|route|directions?|navigate|commute)\b/i;
const FROM_TO_RE = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:$|[?.!,;]|\s+(?:and|but|or|so|because|then|which|that|located)\b)/i;
const BETWEEN_AND_RE = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:$|[?.!,;]|\s+(?:but|so|because|then|which|that|located)\b)/i;
// "how far is A from B" (as opposed to "from A to B") — the other common
// distance phrasing. Only tried when the "from A to B" / "between A and B"
// forms didn't match, so "from Paris to Rome" isn't re-mined here.
const IS_FROM_RE = /\b(?:is|are|'s|was|were)\s+(.+?)\s+from\s+(.+?)(?:$|[?.!,;]|\s+(?:and|but|or|so|because|then|which|that|located)\b)/i;

// "What country is Kilimanjaro in?" / "which city is the Louvre located in" —
// the place sits between the verb and a trailing "in"/"located". Weak (gated
// by looksLikePlace) so "what country is the author in" doesn't fire.
const WHAT_REGION_RE =
  /\b(?:what|which)\s+(?:country|city|town|state|province|region|continent|county|nation|island)\s+(?:is|are|was|were)\s+(.+?)\s+(?:in|located|situated)\b/i;

// Street-address form: "1600 Pennsylvania Avenue", optionally ", City" —
// captured whole (street number included) because Nominatim geocodes the full
// address string better than a trimmed one.
// The house number may carry a letter suffix ("221B") or be a range ("45-47").
const ADDRESS_RE =
  /\b\d{1,5}[a-z]?(?:-\d{1,5}[a-z]?)?\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|square|sq|terrace|ter|highway|hwy|parkway|pkwy|route|rte)\b(?:,\s*[A-Za-z.'\- ]+){0,2}/gi;

// Extracts geocodable place queries from free text. Returns a deduped,
// capped array of query strings. Order of precedence: distance pairs and
// addresses (most specific) first, then the cue phrases.
export function extractPlaceQueries(text) {
  const raw = typeof text === "string" ? text : "";
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const q = cleanPlace(s);
    if (!q) return;
    const key = q.toLowerCase();
    if (seen.has(key) || out.length >= MAX_PLACES) return;
    seen.add(key);
    out.push(q);
  };

  if (DISTANCE_CUE.test(raw)) {
    const pair = FROM_TO_RE.exec(raw) || BETWEEN_AND_RE.exec(raw) || IS_FROM_RE.exec(raw);
    if (pair) {
      add(pair[1]);
      add(pair[2]);
    }
  }

  for (const m of raw.matchAll(ADDRESS_RE)) add(m[0]);

  const region = WHAT_REGION_RE.exec(raw);
  if (region) {
    const q = cleanPlace(region[1]);
    if (q && looksLikePlace(q)) add(q);
  }

  for (const cue of PLACE_CUES) {
    if (out.length >= MAX_PLACES) break;
    const captured = captureAfter(raw, cue.re);
    if (captured == null) continue;
    const q = cleanPlace(captured);
    if (!q) continue;
    if (!cue.strong && !looksLikePlace(q)) continue;
    add(q);
  }
  return out;
}

// True when the latest message names anything mappable — used by the pipeline
// to decide whether to run (and show a step for) the maps phase at all,
// without doing the network work. `webSearch` gates only the forward path.
export function messageHasMapTargets(text, webSearch) {
  if (extractCoordinates(text).length) return true;
  if (webSearch && extractPlaceQueries(text).length) return true;
  return false;
}

// ---- Nominatim forward geocode ---------------------------------------------

// Resolves a place name/address to its canonical OSM record. Returns
// { query, name, lat, lon, kind, url } or null on any failure/timeout.
export async function forwardGeocode(env, log, query) {
  try {
    const url = `${SEARCH_URL}?format=jsonv2&q=${encodeURIComponent(query)}&limit=1&addressdetails=0`;
    const resp = await fetch(url, {
      headers: { "User-Agent": GENERIC_USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("maps.forward_error", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit || typeof hit.display_name !== "string" || !hit.display_name) return null;
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (!inRange(lat, lon)) return null;
    // Nominatim's category/type (e.g. "tourism"/"attraction", "place"/"city")
    // is a compact, useful hint about what kind of thing resolved.
    const kind = [hit.category || hit.class, hit.type].filter((s) => typeof s === "string" && s).join("/");
    return {
      query,
      name: hit.display_name,
      lat,
      lon,
      kind,
      url: hit.osm_type && hit.osm_id ? `https://www.openstreetmap.org/${hit.osm_type}/${hit.osm_id}` : "",
    };
  } catch (err) {
    log.warn("maps.forward_error", { error: err?.message || String(err) });
    return null;
  }
}

// ---- orchestration ---------------------------------------------------------

// Runs the whole maps lookup for one message's worth of targets. Returns null
// when there's nothing to do or nothing resolved, otherwise
//   { block, details, forwardCount, reverseCount, durationMs }
// where `block` is the labeled context text to append and `details` are the
// one-liners for the UI step's expandable list.
export async function runMapsLookup(env, log, conversation, webSearch) {
  const startedAt = Date.now();
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const coords = extractCoordinates(lastUser);
  const places = webSearch ? extractPlaceQueries(lastUser) : [];
  if (!coords.length && !places.length) return null;

  const [reverse, forward] = await Promise.all([
    Promise.all(coords.map(async (c) => ({ ...c, place: await reverseGeocode(env, log, c.lat, c.lon) }))),
    Promise.all(places.map((q) => forwardGeocode(env, log, q))),
  ]);

  const reverseHits = reverse.filter((r) => r.place);
  const forwardHits = forward.filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log.info("maps.lookup", {
    duration_ms: durationMs,
    coords: coords.length,
    places: places.length,
    reverse_hits: reverseHits.length,
    forward_hits: forwardHits.length,
  });

  const details = [];
  const lines = [];
  for (const r of reverseHits) {
    details.push(`${r.raw} → ${r.place}`);
    lines.push(`Coordinates ${r.raw} are near ${r.place}.`);
  }
  for (const f of forwardHits) {
    const coordStr = `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`;
    details.push(`${f.query} → ${f.name}`);
    const kindStr = f.kind ? ` [${f.kind}]` : "";
    const urlStr = f.url ? ` (${f.url})` : "";
    lines.push(`"${f.query}" resolves to ${f.name} at ${coordStr}${kindStr}${urlStr}.`);
  }
  // Places the user named that Nominatim couldn't resolve — surfaced so the
  // model doesn't silently invent a location for a query that found nothing.
  const unresolved = places.filter((q) => !forwardHits.some((f) => f.query === q));
  if (unresolved.length) lines.push(`No map match was found for: ${unresolved.map((q) => `"${q}"`).join(", ")}.`);

  if (!reverseHits.length && !forwardHits.length) {
    // Everything the message named came back empty — still surface it (an
    // honest "no match" instead of silence), matching the Shodan convention.
    const block =
      "\n\n--- Map lookup (via OpenStreetMap Nominatim) ---\n" +
      lines.join("\n") +
      "\n--- End of map lookup ---";
    return {
      block,
      details: unresolved.map((q) => `${q} — no map match`),
      forwardCount: 0,
      reverseCount: 0,
      durationMs,
    };
  }

  const block =
    "\n\n--- Map lookup (via OpenStreetMap Nominatim) ---\n" +
    lines.join("\n") +
    "\n--- End of map lookup ---";
  return {
    block,
    details,
    forwardCount: forwardHits.length,
    reverseCount: reverseHits.length,
    durationMs,
  };
}

// Maps capability, built on the Google Maps Platform APIs configured for this
// Worker (the GOOGLE_MAPS_API_KEY secret): Places API (New), Maps Static API,
// and Street View Static API. It resolves the locations a user names — in a
// photo's GPS EXIF, in typed coordinates, or in words — into rich place data
// AND actual map / Street View imagery.
//
// Two Nominatim-era functions live on here in spirit but now speak Google:
//   1. Reverse geocode of coordinates (a photo's EXIF or coordinates typed
//      into the message) — Places Nearby Search names what's at the point.
//      Falls back to OpenStreetMap Nominatim (src/geocode.js) when the Google
//      key is absent or the call fails, so a photo's location still resolves
//      without a key.
//   2. Forward geocode of a named place / address ("where is the Eiffel
//      Tower?") — Places Text Search returns the canonical name, formatted
//      address, coordinates, place types, rating, and a Google Maps link.
//
// For every resolved location the Worker also builds a **Maps Static** map
// image and (when Street View imagery exists there — checked via the free
// metadata endpoint) a **Street View** image. The API key must never reach
// the browser, so these are served through the Worker's own key-free proxy
// endpoints (/api/maps/static, /api/maps/streetview — handleMapsProxy below);
// the client only ever sees a Worker path, never a Google URL with the key.
//
// Same deterministic, no-function-calling wiring as before: pure, unit-tested
// extractors pull targets from the latest user message; the Worker resolves
// them, appends ONE labeled text context block every pipeline phase can reason
// with (the model gets rich text, not images — keeping it model-agnostic), and
// emits the imagery to the client as a `map` SSE event to render + embed in
// the PDF report.
//
// Privacy boundary (unchanged): reverse geocoding resolves numbers already in
// the message and runs independent of the web-search toggle; forward geocoding
// sends a place token derived from the user's question, so it is gated behind
// the web-search toggle, exactly like Exa. Only the extracted token /
// coordinates ever cross the wire — never the full question or any identifier.
//
// Fails soft in every branch: no key, an unresolvable place, a timeout, or a
// Google error all degrade to "no location context" — never a blocked chat.

import { reverseGeocode as nominatimReverse } from "./geocode.js";
import { textOf, lastUserMessage, withAppendedText } from "./conversation.js";
import { validateImageLocations } from "./validation.js";

const PLACES_BASE = "https://places.googleapis.com/v1/places";
const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const STREETVIEW_URL = "https://maps.googleapis.com/maps/api/streetview";
const STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const TIMEOUT_MS = 5000;

// Bounds on how far one message can fan out — keeps latency, Google spend, and
// image count predictable regardless of how many targets a message contains.
const MAX_COORDS = 4;
const MAX_PLACES = 3;
const MAX_QUERY_CHARS = 90;
const NEARBY_RADIUS_M = 200; // reverse: nearest place within this radius

export function mapsAvailable(env) {
  return !!env.GOOGLE_MAPS_API_KEY;
}

// ---- coordinate extraction (pure — exported for unit tests) ----------------

const COORD_HEMI_RE =
  /(\d{1,2}(?:\.\d+)?)\s*°?\s*([NSns])[\s,]+(\d{1,3}(?:\.\d+)?)\s*°?\s*([EWew])/g;
const COORD_LABELED_RE =
  /lat(?:itude)?\.?[\s:=]*(-?\d{1,2}(?:\.\d+)?)[\s,;]+lon(?:g|gitude)?\.?[\s:=]*(-?\d{1,3}(?:\.\d+)?)/gi;
const COORD_PLAIN_RE = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/g;
// Cues that plain numbers are a geographic point, split by strength. A STRONG
// cue accepts a plain pair at any precision; a WEAK cue (also common in prose)
// accepts one only when it carries GPS-like ≥3-decimal precision, so "the
// ratio settled at 1.5, 2.5" stays quiet while "what's at 59.3293, 18.0686"
// resolves. Words like "point"/"spot"/"place" are excluded — they fire on
// data-speak. Hemisphere/labeled forms are self-evident and need no cue.
const STRONG_COORD_CUE =
  /\b(?:co[oö]?ordinates?|coords?|gps|lat(?:itude)?|long?(?:itude)?|geo(?:code\w*|coding|locat\w*))\b|°/i;
const WEAK_COORD_CUE =
  /\b(?:locat\w*|maps?|pinpoint|where|here|nearby|near|distance|far|route|directions?|driving|navigat\w*|elevation|altitude)\b|\bat\s+-?\d/i;

const decimalPlaces = (s) => (String(s).split(".")[1] || "").length;

function inRange(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

// Extracts explicit coordinate pairs from free text (hemisphere, labeled, and
// plain-decimal notations). Range-checked, deduped, capped. Returns an array
// of { lat, lon, raw }.
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

const TRAILING_FILLER =
  /\s+(?:located|situated|exactly|precisely|right now|now|today|please|on (?:a|the) maps?|on maps?|in the world|geographically)+$/i;
const NON_PLACE = new Set([
  "it", "this", "that", "these", "those", "there", "here", "them", "they",
  "he", "she", "we", "i", "you", "one", "someone", "everyone", "anybody",
  "my phone", "my car", "my keys", "my order", "my package", "my dog",
  "my house", "my home", "my office", "my location", "my hotel", "my place",
  "work", "home", "the office", "the bug", "the error", "the problem",
  "the issue", "the file", "the author", "the moon",
]);

function cleanPlace(sRaw) {
  let s = String(sRaw || "").trim();
  s = s.replace(/^["'`(]+|["'`).,;:!?]+$/g, "").trim();
  s = s.replace(TRAILING_FILLER, "").trim();
  s = s.replace(/[.,;:!?]+$/g, "").trim();
  s = s.replace(/^(?:the|a|an)\s+/i, "").trim();
  s = s.slice(0, MAX_QUERY_CHARS).trim();
  if (s.length < 2) return "";
  if (!/[a-z]/i.test(s)) return "";
  if (NON_PLACE.has(s.toLowerCase())) return "";
  return s;
}

function looksLikePlace(s) {
  if (/[A-Z]/.test(s)) return true;
  if (/,/.test(s)) return true;
  if (/^\d{1,5}\s+\S/.test(s)) return true;
  return false;
}

const PLACE_CUES = [
  { re: /\bcoordinates?\s+(?:of|for)\s+/i, strong: true },
  { re: /\bgps\s+(?:coordinates?\s+)?(?:of|for)\s+/i, strong: true },
  { re: /\b(?:the\s+)?(?:lat(?:itude)?\s+and\s+long?(?:itude)?|long?(?:itude)?\s+and\s+lat(?:itude)?)\s+(?:of|for)\s+/i, strong: true },
  { re: /\blocation\s+of\s+/i, strong: true },
  { re: /\blocated\s+(?:in|at|near|on|within)\s+/i, strong: true },
  { re: /\bmaps?\s+of\s+/i, strong: true },
  { re: /\bstreet\s*view\s+(?:of|for|at)\s+/i, strong: true },
  { re: /\bdirections?\s+(?:to|from)\s+/i, strong: true },
  { re: /\b(?:how\s+(?:do|can)\s+i|how\s+to)\s+get\s+to\s+/i, strong: true },
  { re: /\broute\s+(?:to|from)\s+/i, strong: true },
  { re: /\bwhere(?:\s+(?:is|are|was|were|abouts?)|'s|s)\s+/i, strong: false },
];

const PLACE_STOP =
  /\s+(?:and|but|or|so|because|then|which|that|who|whose|located|situated|to|from|toward|towards)\b|[?.!,;:\n]/i;

function captureAfter(text, cueRe) {
  const m = cueRe.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const stop = rest.search(PLACE_STOP);
  return stop === -1 ? rest : rest.slice(0, stop);
}

const DISTANCE_CUE =
  /\b(?:how far|distance|how long.*?\b(?:drive|fly|walk|travel|cycl|bike)|travel time|driving time|route|directions?|navigate|commute)\b/i;
const FROM_TO_RE = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:$|[?.!,;]|\s+(?:and|but|or|so|because|then|which|that|located)\b)/i;
const BETWEEN_AND_RE = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:$|[?.!,;]|\s+(?:but|so|because|then|which|that|located)\b)/i;
const IS_FROM_RE = /\b(?:is|are|'s|was|were)\s+(.+?)\s+from\s+(.+?)(?:$|[?.!,;]|\s+(?:and|but|or|so|because|then|which|that|located)\b)/i;

const WHAT_REGION_RE =
  /\b(?:what|which)\s+(?:country|city|town|state|province|region|continent|county|nation|island)\s+(?:is|are|was|were)\s+(.+?)\s+(?:in|located|situated)\b/i;

const ADDRESS_RE =
  /\b\d{1,5}[a-z]?(?:-\d{1,5}[a-z]?)?\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|square|sq|terrace|ter|highway|hwy|parkway|pkwy|route|rte)\b(?:,\s*[A-Za-z.'\- ]+){0,2}/gi;

// Extracts geocodable place queries from free text. Deduped, capped.
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
// to decide whether to run (and show a step for) the maps phase, without doing
// the network work. `webSearch` gates only the forward (place-name) path.
export function messageHasMapTargets(text, webSearch) {
  if (extractCoordinates(text).length) return true;
  if (webSearch && extractPlaceQueries(text).length) return true;
  return false;
}

// ---- Google Places API (New) -----------------------------------------------

async function placesPost(env, log, path, body, fieldMask) {
  const resp = await fetch(`${PLACES_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    log.warn("maps.places_error", { path, status: resp.status });
    return null;
  }
  return resp.json().catch(() => null);
}

// Normalizes one Places API place object into the fields a research summary
// and the UI actually use.
function normalizePlace(p) {
  if (!p || !p.location) return null;
  const lat = Number(p.location.latitude);
  const lon = Number(p.location.longitude);
  if (!inRange(lat, lon)) return null;
  return {
    name: p.displayName?.text || p.formattedAddress || "",
    address: typeof p.formattedAddress === "string" ? p.formattedAddress : "",
    lat,
    lon,
    types: Array.isArray(p.types) ? p.types.slice(0, 4) : [],
    rating: Number.isFinite(p.rating) ? p.rating : null,
    mapsUri: typeof p.googleMapsUri === "string" ? p.googleMapsUri : "",
  };
}

const PLACE_FIELD_MASK =
  "places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.googleMapsUri";

// Forward geocode: place name / address → canonical Google place, or null.
export async function placesTextSearch(env, log, query) {
  if (!mapsAvailable(env)) return null;
  try {
    const data = await placesPost(env, log, ":searchText", { textQuery: query, pageSize: 1 }, PLACE_FIELD_MASK);
    const hit = Array.isArray(data?.places) ? data.places[0] : null;
    const place = normalizePlace(hit);
    return place ? { query, ...place } : null;
  } catch (err) {
    log.warn("maps.places_error", { path: ":searchText", error: err?.message || String(err) });
    return null;
  }
}

// Reverse: coordinates → nearest named Google place, or null. Uses Nearby
// Search ranked by distance within a small radius.
export async function reverseNearby(env, log, lat, lon) {
  if (!mapsAvailable(env)) return null;
  try {
    const body = {
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: NEARBY_RADIUS_M } },
      rankPreference: "DISTANCE",
      maxResultCount: 1,
    };
    const data = await placesPost(env, log, ":searchNearby", body, PLACE_FIELD_MASK);
    const hit = Array.isArray(data?.places) ? data.places[0] : null;
    return normalizePlace(hit);
  } catch (err) {
    log.warn("maps.places_error", { path: ":searchNearby", error: err?.message || String(err) });
    return null;
  }
}

// Resolves coordinates to a place NAME, preferring Google, falling back to
// OpenStreetMap Nominatim (src/geocode.js) so a photo's location still
// resolves without a Google key. Returns { name, address, lat, lon, ... } or
// null. `lat`/`lon` on the return are the ORIGINAL coordinates (so the map /
// Street View image is centered on the actual point, not the nearest POI).
export async function resolveCoordinate(env, log, lat, lon) {
  const g = await reverseNearby(env, log, lat, lon);
  if (g) return { ...g, lat, lon };
  const nom = await nominatimReverse(env, log, lat, lon);
  return nom ? { name: nom, address: nom, lat, lon, types: [], rating: null, mapsUri: "" } : null;
}

// ---- Street View availability (free metadata endpoint) ---------------------

// True when Google has Street View imagery near the point. The metadata call
// costs nothing and no quota — used to avoid offering a "no imagery" grey tile.
export async function streetViewAvailable(env, log, lat, lon) {
  if (!mapsAvailable(env)) return false;
  try {
    const url = `${STREETVIEW_META_URL}?location=${lat},${lon}&key=${env.GOOGLE_MAPS_API_KEY}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    return data?.status === "OK";
  } catch {
    return false;
  }
}

// ---- image proxy paths (key-free, safe for the browser) --------------------

// The client and the context block reference these Worker paths, NEVER a
// Google URL — the API key stays server-side. handleMapsProxy resolves them.
export function staticMapProxyPath({ lat, lon, zoom = 14 }) {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon), zoom: String(zoom) });
  return `/api/maps/static?${qs}`;
}
export function streetViewProxyPath({ lat, lon }) {
  const qs = new URLSearchParams({ lat: String(lat), lon: String(lon) });
  return `/api/maps/streetview?${qs}`;
}

// ---- Worker image proxy handler (routed from src/index.js) ------------------

const SIZE = "640x400";
const SCALE = "2";

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// Serves /api/maps/static and /api/maps/streetview: validates the safe params,
// injects the API key server-side, and streams the Google image back. Tight
// param validation (range-checked lat/lon, bounded zoom, FIXED size) keeps it
// from being an open, arbitrary Google-billing relay. Fails to 404/502 rather
// than leaking anything.
export async function handleMapsProxy(request, env, url, log) {
  if (!mapsAvailable(env)) return new Response("Maps not configured", { status: 404 });
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!inRange(lat, lon)) return new Response("Bad coordinates", { status: 400 });

  let googleUrl;
  if (url.pathname === "/api/maps/static") {
    const zoom = clampNum(url.searchParams.get("zoom"), 1, 20, 14);
    const p = new URLSearchParams({
      center: `${lat},${lon}`,
      zoom: String(zoom),
      size: SIZE,
      scale: SCALE,
      markers: `color:red|${lat},${lon}`,
      key: env.GOOGLE_MAPS_API_KEY,
    });
    googleUrl = `${STATIC_MAP_URL}?${p}`;
  } else if (url.pathname === "/api/maps/streetview") {
    const heading = clampNum(url.searchParams.get("heading"), 0, 360, "");
    const fov = clampNum(url.searchParams.get("fov"), 10, 120, 90);
    const pitch = clampNum(url.searchParams.get("pitch"), -90, 90, 0);
    const p = new URLSearchParams({
      location: `${lat},${lon}`,
      size: SIZE,
      fov: String(fov),
      pitch: String(pitch),
      key: env.GOOGLE_MAPS_API_KEY,
      return_error_code: "true",
    });
    if (heading !== "") p.set("heading", String(heading));
    googleUrl = `${STREETVIEW_URL}?${p}`;
  } else {
    return new Response("Not found", { status: 404 });
  }

  try {
    const resp = await fetch(googleUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) {
      log.warn("maps.image_error", { path: url.pathname, status: resp.status });
      return new Response("Image unavailable", { status: 502 });
    }
    return new Response(resp.body, {
      status: 200,
      headers: {
        "content-type": resp.headers.get("content-type") || "image/png",
        // Immutable content for a given coordinate — cache hard, per user.
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    log.warn("maps.image_error", { path: url.pathname, error: err?.message || String(err) });
    return new Response("Image unavailable", { status: 502 });
  }
}

// ---- orchestration ---------------------------------------------------------

// Builds the map + Street View figures for one resolved location. Adds a map
// always; adds Street View only when imagery exists there. Returns [] without
// the Google key — the proxy couldn't serve the tiles anyway (Nominatim, the
// reverse fallback, has no imagery), so a resolved name still lands as text.
async function imagesFor(env, log, place, labelPrefix) {
  if (!mapsAvailable(env)) return [];
  const images = [
    {
      kind: "map",
      url: staticMapProxyPath({ lat: place.lat, lon: place.lon }),
      label: place.name || labelPrefix,
      caption: `Map — ${place.name || labelPrefix}`,
      lat: place.lat,
      lon: place.lon,
    },
  ];
  if (await streetViewAvailable(env, log, place.lat, place.lon)) {
    images.push({
      kind: "streetview",
      url: streetViewProxyPath({ lat: place.lat, lon: place.lon }),
      label: place.name || labelPrefix,
      caption: `Street View — ${place.name || labelPrefix}`,
      lat: place.lat,
      lon: place.lon,
    });
  }
  return images;
}

// Renders a resolved place as a compact context line for the model.
function placeLine(prefix, place) {
  const bits = [];
  if (place.address && place.address !== place.name) bits.push(place.address);
  if (place.types.length) bits.push(place.types.join("/"));
  const detail = bits.length ? ` (${bits.join("; ")})` : "";
  const coord = `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
  const rating = place.rating ? `, rated ${place.rating}★ on Google` : "";
  const uri = place.mapsUri ? ` Google Maps: ${place.mapsUri}` : "";
  return `${prefix} ${place.name}${detail} at ${coord}${rating}.${uri}`;
}

// Runs the whole text-driven maps lookup for one message's targets. Returns
// null when there's nothing to do, otherwise
//   { block, details, images, forwardCount, reverseCount }.
export async function runMapsLookup(env, log, conversation, webSearch) {
  const startedAt = Date.now();
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const coords = extractCoordinates(lastUser);
  const places = webSearch ? extractPlaceQueries(lastUser) : [];
  if (!coords.length && !places.length) return null;

  const [reverse, forward] = await Promise.all([
    Promise.all(coords.map((c) => resolveCoordinate(env, log, c.lat, c.lon).then((p) => (p ? { raw: c.raw, place: p } : null)))),
    Promise.all(places.map((q) => placesTextSearch(env, log, q))),
  ]);

  const reverseHits = reverse.filter(Boolean);
  const forwardHits = forward.filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log.info("maps.lookup", {
    duration_ms: durationMs,
    coords: coords.length,
    places: places.length,
    reverse_hits: reverseHits.length,
    forward_hits: forwardHits.length,
    key: mapsAvailable(env),
  });

  const lines = [];
  const details = [];
  const images = [];
  for (const r of reverseHits) {
    lines.push(placeLine(`Coordinates ${r.raw} are at/near`, r.place));
    details.push(`${r.raw} → ${r.place.name}`);
    images.push(...(await imagesFor(env, log, r.place, r.raw)));
  }
  for (const f of forwardHits) {
    lines.push(placeLine(`"${f.query}" resolves to`, f));
    details.push(`${f.query} → ${f.name}`);
    images.push(...(await imagesFor(env, log, f, f.query)));
  }
  const unresolved = places.filter((q) => !forwardHits.some((f) => f.query === q));
  if (unresolved.length) lines.push(`No map match was found for: ${unresolved.map((q) => `"${q}"`).join(", ")}.`);

  if (!reverseHits.length && !forwardHits.length) {
    const block =
      "\n\n--- Map lookup (via Google Maps) ---\n" + lines.join("\n") + "\n--- End of map lookup ---";
    return { block, details: unresolved.map((q) => `${q} — no map match`), images: [], forwardCount: 0, reverseCount: 0, durationMs };
  }

  if (images.length) lines.push("A map image" + (images.some((i) => i.kind === "streetview") ? " and Street View" : "") + " of the resolved location(s) are shown to the user.");
  const block =
    "\n\n--- Map lookup (via Google Maps) ---\n" + lines.join("\n") + "\n--- End of map lookup ---";
  return { block, details, images, forwardCount: forwardHits.length, reverseCount: reverseHits.length, durationMs };
}

// Photo-EXIF path (called from src/chat.js before the pipeline, independent of
// the web-search toggle): reverse-geocodes each attached photo's GPS EXIF into
// a place name + map/Street View imagery, emits a visible `geocode` step and a
// `map` image event, and appends the resolved-location context block. Returns
// the conversation UNCHANGED when there's nothing valid to resolve. `emit` is
// optional so the function stays usable/testable outside the SSE path.
export async function augmentWithLocations(env, log, emit, conversation, rawLocations) {
  const locations = validateImageLocations(rawLocations);
  if (!locations.length) return conversation;

  const step = typeof emit === "function" ? emit : () => {};
  step({ status: { type: "step_start", id: "geocode", label: "Resolving photo location (Google Maps)…" } });

  const resolved = await Promise.all(
    locations.map(async ({ name, lat, lon }) => ({ name, place: await resolveCoordinate(env, log, lat, lon) })),
  );
  const usable = resolved.filter((r) => r.place);
  const details = usable.map((r) => `${r.name}: near ${r.place.name}`);

  const images = [];
  for (const r of usable) images.push(...(await imagesFor(env, log, r.place, r.name)));

  step({
    status: {
      type: "step_done",
      id: "geocode",
      label: usable.length
        ? `Resolved ${usable.length} photo location${usable.length === 1 ? "" : "s"} via Google Maps`
        : "No place name resolved for the photo location(s)",
      details,
    },
  });
  if (images.length) step({ status: { type: "map", id: "geocode", images } });

  if (!usable.length) return conversation;
  const block =
    "\n\n--- Resolved photo location(s) (via Google Maps) ---\n" +
    usable.map((r) => placeLine(`${r.name} was taken at/near`, r.place)).join("\n") +
    "\n--- End of resolved photo location(s) ---";
  return withAppendedText(conversation, block);
}

// @ts-check
// Google Maps Platform integration ("Google Maps & Street View" in the UI) —
// an opt-in per-user knob (src/settings.js's `google_maps`, default OFF).
// When the knob is on and the GOOGLE_MAPS_API_KEY secret is set, the Worker
// resolves a location the research question is about — either a street address
// named in the message, or an attached photo's GPS EXIF coordinates — into
// Google Maps data across four Maps Platform APIs that share the one key:
//
//   • Places API (places.googleapis.com) — resolve a named address into a
//     canonical place: display name, formatted address, precise coordinates,
//     place type, rating and business status. This both enriches the answer
//     and yields the exact coordinates the two imagery APIs below key off.
//   • Street View Static API (street-view-image-backend.googleapis.com) —
//     confirm panorama coverage, its capture date, and fetch the actual
//     street-level photo for a vision model to describe.
//   • Maps Static API (static-maps-backend.googleapis.com) — a road-map image
//     of the spot (or of a whole route with markers) for spatial context.
//   • Routes API (routes.googleapis.com) — along-road walking distance/time
//     and the road polyline the travel mode's photo waypoints follow;
//     optional: when not enabled on the key, the blocks honestly report
//     straight-line figures only.
//
// Wired the same deterministic, no-function-calling way as the reverse-
// geocoder (src/geocode.js) and Shodan (src/shodan.js): the location is
// extracted deterministically (a photo's coordinates, or an address parsed
// from the message — the pure text analysis lives in src/googlemaps-text.js),
// the lookups run server-side, and the result is appended as one labeled
// context block every downstream phase can reason and search with — never
// silently blended into the user's text.
//
// This module owns the REST side: the Maps Platform clients and the
// edge-cached lookup orchestration. The pure labeled context-block builders
// live in src/googlemaps-blocks.js.
//
// Runs server-side, same as every other third-party call: Worker-mediated so
// it's logged and timeout-bounded, and the API key NEVER reaches the browser
// or any log/context block (the keyed image URLs are used only for the
// internal fetches — the citable links handed to the model/user are Google's
// keyless Maps URLs).
//
// Fails soft in every branch: no key, no location, no coverage there, a
// timeout or an API error all degrade to the conversation unchanged — Maps
// enrichment is never a hard requirement for the chat to work.

import { cacheGet, cachePut } from "./edge-cache.js";
import { decodePolyline, movePoint } from "./googlemaps-text.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').StreetViewPov} StreetViewPov */
/** @typedef {import('./googlemaps-text.js').LatLng} LatLng */
/** @typedef {import('./googlemaps-text.js').MapView} MapView */
/** @typedef {import('./googlemaps-text.js').JumpTarget} JumpTarget */
/** @typedef {import('./googlemaps-text.js').CrossBarrierTarget} CrossBarrierTarget */
/**
 * A canonical place parsed out of a Places API (New) Text Search response —
 * see parsePlace. lat/lng are null when Google returned no usable location.
 * @typedef {{ name: string, address: string, lat: number | null, lng: number | null,
 *   type: string, rating: number | null, ratingCount: number, status: string }} Place
 */
/** A Place whose coordinates are known-present (placesNearbySearch filters). */
/** @typedef {Place & { lat: number, lng: number }} PlaceWithCoords */
/** A panorama found along a barrier-crossing probe ray — see runBarrierCrossing. */
/** @typedef {{ lat: number, lng: number, panoId: string, distance: number }} PanoPoint */
/** A Routes API walking route — see computeWalkingRoute. */
/** @typedef {{ distanceMeters: number, durationS: number | null, polyline: LatLng[] }} WalkingRoute */
/**
 * What runGoogleMapsLookup resolves a target into (null on any failure):
 * the display string, the canonical place (address lookups only), the
 * coordinates, Street View metadata + optional fetched imagery, and the
 * embed point for the client's interactive panorama.
 * @typedef {{
 *   displayQuery: string,
 *   place: Place | null,
 *   lat: number | null,
 *   lng: number | null,
 *   streetView: { date: string, lat: number | null, lng: number | null } | null,
 *   streetViewFrames: Array<{ dir: string, url: string }>,
 *   staticMapImage: string | null,
 *   embed: LatLng | null,
 *   details: string[],
 *   count: number,
 * }} MapsLookupResult
 */

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const STREETVIEW_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const STATICMAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const TIMEOUT_MS = 6000;
// How far from the resolved coordinates to search for a panorama. Google's
// default is 50m, which misses real coverage when Places returns a rooftop/
// parcel coordinate set back from the road (reported 2026-07-09: "Street view
// basaltvägen 1 enköping" resolved to a business lot whose metadata check
// came back ZERO_RESULTS — no imagery shown — while the street outside had
// coverage). 150m reaches the street outside any normal lot without jumping
// to a different block.
const STREETVIEW_SEARCH_RADIUS_M = 150;
const STREETVIEW_SIZE = "512x512"; // per frame; 4 frames + a map must fit Berget's ~1MB body
const STATICMAP_SIZE = "600x400"; // JPEG below — small enough to attach alongside Street View
// Cross-request result-cache TTL (Workers Cache API via edge-cache.js), the
// exact pattern src/exa.js uses for searches: a follow-up turn is a SEPARATE
// /api/chat request, and the follow-up flow (pickLookup's walk-back)
// re-looks-up the SAME location on every gated follow-up — without a cache
// each one re-bills Places + five imagery fetches at Google. Shared by the
// address lookup and the POV/map-view captures. Short TTL only — enough to
// absorb a whole session of follow-ups about one address (raised from 10 to
// 30 min after a user asking repeatedly about the same address in one
// sitting), still comfortably inside Google's performance-caching allowance
// (Street View imagery itself changes on a timescale of years).
const LOOKUP_CACHE_TTL_S = 1800;
// Four cardinal headings give the vision model a full look around the spot
// (what's across the street, the façade, neighbours) — the "multi-angle
// capture" that makes Street View actually queryable, not one fixed frame.
// Exported for buildMapsBlock (src/googlemaps-blocks.js), which names the
// frame directions when handing them to a vision answer model.
export const STREETVIEW_HEADINGS = [
  { deg: 0, dir: "north" },
  { deg: 90, dir: "east" },
  { deg: 180, dir: "south" },
  { deg: 270, dir: "west" },
];

// The server API key, typed non-null for the keyed URL/header builders:
// every caller runs behind a googleMapsAvailable gate, so the key is
// present whenever a billed request is actually built.
/**
 * @param {Env} env
 * @returns {string}
 */
const mapsApiKey = (env) => /** @type {string} */ (env.GOOGLE_MAPS_API_KEY);

/**
 * @param {Env} env
 * @returns {boolean}
 */
export function googleMapsAvailable(env) {
  return !!env.GOOGLE_MAPS_API_KEY;
}

// The browser-exposed key for the interactive Maps Embed iframe. Prefers a
// dedicated GOOGLE_MAPS_EMBED_KEY when set (ideal: a key restricted to the Maps
// Embed API only); otherwise FALLS BACK to the main GOOGLE_MAPS_API_KEY. The
// fallback is safe only because that key is HTTP-referrer-locked to the site
// (*.deepresearch.se/*), which is the mitigation for exposing it to the
// browser — without that referrer restriction, exposing the server key would
// let anyone run its billed Places/Static APIs. Empty string when neither is
// set — the client then shows only the keyless Street View link, no embed.
/**
 * @param {Env} env
 * @returns {string}
 */
export function googleMapsEmbedKey(env) {
  const embed = typeof env.GOOGLE_MAPS_EMBED_KEY === "string" ? env.GOOGLE_MAPS_EMBED_KEY : "";
  if (embed) return embed;
  return typeof env.GOOGLE_MAPS_API_KEY === "string" ? env.GOOGLE_MAPS_API_KEY : "";
}

// ---- REST calls ------------------------------------------------------------

// Base64-encode bytes in chunks so a large image doesn't blow the argument
// limit of String.fromCharCode (Workers have btoa but not Buffer).
/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} url
 * @param {string} event the log event name for a failed fetch
 * @returns {Promise<string | null>} a data: URL, or null on any failure
 */
async function fetchImageDataUrl(env, log, url, event) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) {
      log.warn(event, { status: resp.status });
      return null;
    }
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    return `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(buf))}`;
  } catch (/** @type {any} */ err) {
    log.warn(event, { error: err?.message || String(err) });
    return null;
  }
}

// Field mask shared by both Places Text Search calls — keeps the response,
// and the billing tier, minimal.
const PLACES_FIELD_MASK =
  "places.displayName,places.formattedAddress,places.location,places.primaryType,places.rating,places.userRatingCount,places.businessStatus";

// One raw Places API place object → the Place shape the blocks consume.
/**
 * @param {any} place
 * @returns {Place}
 */
function parsePlace(place) {
  const lat = Number(place.location?.latitude);
  const lng = Number(place.location?.longitude);
  return {
    name: place.displayName?.text || "",
    address: place.formattedAddress || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    type: typeof place.primaryType === "string" ? place.primaryType.replace(/_/g, " ") : "",
    rating: Number.isFinite(place.rating) ? place.rating : null,
    ratingCount: Number.isFinite(place.userRatingCount) ? place.userRatingCount : 0,
    status: typeof place.businessStatus === "string" ? place.businessStatus : "",
  };
}

// Places API (New) Text Search: resolve an address/place string into a single
// canonical place.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query
 * @returns {Promise<Place | null>}
 */
export async function placesTextSearch(env, log, query) {
  try {
    const resp = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsApiKey(env),
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("googlemaps.places_error", { status: resp.status });
      return null;
    }
    /** @type {any} */
    const data = await resp.json().catch(() => null);
    const place = data?.places?.[0];
    if (!place) {
      log.info("googlemaps.places", { found: false });
      return null;
    }
    log.info("googlemaps.places", { found: true });
    return parsePlace(place);
  } catch (/** @type {any} */ err) {
    log.warn("googlemaps.places_error", { error: err?.message || String(err) });
    return null;
  }
}

// Places API (New) Text Search biased around a position — the NEARBY-place
// search ("Gas station near e18 there" from a live panorama): same endpoint
// and field mask as placesTextSearch, plus a locationBias circle at the
// anchor (bias, not restriction — Places may still return the best match
// slightly outside) and up to 3 results so the answer can name
// alternatives. Returns an array (possibly empty) or null on failure.
const NEARBY_BIAS_RADIUS_M = 5000;
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<PlaceWithCoords[] | null>}
 */
export async function placesNearbySearch(env, log, query, lat, lng) {
  try {
    const resp = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsApiKey(env),
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: 3,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: NEARBY_BIAS_RADIUS_M } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("googlemaps.places_nearby_error", { status: resp.status });
      return null;
    }
    /** @type {any} */
    const data = await resp.json().catch(() => null);
    /** @type {any[]} */
    const places = Array.isArray(data?.places) ? data.places : [];
    log.info("googlemaps.places_nearby", { found: places.length });
    return /** @type {PlaceWithCoords[]} */ (
      places.map(parsePlace).filter((p) => p.lat != null && p.lng != null)
    );
  } catch (/** @type {any} */ err) {
    log.warn("googlemaps.places_nearby_error", { error: err?.message || String(err) });
    return null;
  }
}

// Street View metadata is FREE (Google does not bill metadata requests) and
// tells us whether a panorama exists at `location` before we spend on an
// image. A pano id (from the client's live panorama) takes precedence over
// the location string when given. Returns the parsed metadata (status "OK"
// means imagery exists) or null.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} location "lat,lng" or a raw address (Google geocodes it)
 * @param {string} [pano] a pano id, taking precedence over `location`
 * @param {number} [radius] widened search radius in meters (0 = Google's default)
 * @returns {Promise<any | null>} the raw metadata JSON (status "OK" = imagery exists)
 */
export async function streetViewMetadata(env, log, location, pano = "", radius = 0) {
  try {
    const qs = new URLSearchParams({ key: mapsApiKey(env) });
    if (pano) qs.set("pano", pano);
    else {
      qs.set("location", location);
      if (radius > 0) {
        // Widened panorama search (see STREETVIEW_SEARCH_RADIUS_M) — outdoor
        // collections only, so a business's indoor photosphere can't outrank
        // the street outside.
        qs.set("radius", String(radius));
        qs.set("source", "outdoor");
      }
    }
    const resp = await fetch(`${STREETVIEW_META_URL}?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) {
      log.warn("googlemaps.streetview_meta_error", { status: resp.status });
      return null;
    }
    const data = await resp.json().catch(() => null);
    log.info("googlemaps.streetview_meta", { status: data?.status || "unknown" });
    return data;
  } catch (/** @type {any} */ err) {
    log.warn("googlemaps.streetview_meta_error", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * @param {Env} env
 * @param {string} location
 * @param {number} heading
 * @param {string} [pano]
 */
function streetViewImageUrl(env, location, heading, pano = "") {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    heading: String(heading),
    fov: "90",
    key: mapsApiKey(env),
    return_error_code: "true",
  });
  // Pin the very panorama the metadata check found: the image API's own
  // default search radius (50m) would otherwise re-miss a pano the widened
  // metadata search located beyond it.
  if (pano) qs.set("pano", pano);
  else {
    qs.set("location", location);
    qs.set("radius", String(STREETVIEW_SEARCH_RADIUS_M));
    qs.set("source", "outdoor");
  }
  return `${STREETVIEW_IMAGE_URL}?${qs}`;
}

// The Street View Static URL for an exact point of view — the pano id (when
// the client's live panorama reported one) pins the very panorama the user is
// standing in, and heading/pitch/fov reproduce where they panned to.
/**
 * @param {Env} env
 * @param {StreetViewPov} pov
 */
function streetViewPovImageUrl(env, pov) {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    heading: String(pov.heading),
    pitch: String(pov.pitch),
    fov: String(pov.fov),
    key: mapsApiKey(env),
    return_error_code: "true",
  });
  if (pov.panoId) qs.set("pano", pov.panoId);
  else qs.set("location", `${pov.lat},${pov.lng}`);
  return `${STREETVIEW_IMAGE_URL}?${qs}`;
}

// Captures the exact frame the user currently sees in the inline panorama
// (validated POV from body.street_view_pov): one billed Street View Static
// fetch at their heading/pitch/fov, plus the free metadata check for the
// capture date. Cached like the address lookup (the POV is integer-rounded
// client-side, so re-asking about the same view is a free hit). Returns
// { image, date } or null on any failure — fail-soft, the caller degrades.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {StreetViewPov} pov
 * @returns {Promise<{ image: string, date: string } | null>}
 */
export async function runStreetViewPovCapture(env, log, pov) {
  if (!googleMapsAvailable(env)) return null;

  const params = new URLSearchParams({
    p: pov.panoId || "",
    ll: `${pov.lat},${pov.lng}`,
    h: String(pov.heading),
    pt: String(pov.pitch),
    f: String(pov.fov),
  });
  const cacheKey = `https://googlemaps-pov-cache.internal/frame?${params.toString()}`;
  const cached = await cacheGet(log, "googlemaps.cache", cacheKey);
  if (cached && typeof cached === "object" && cached.image) {
    log.info("googlemaps.pov_cache_hit", {});
    return cached;
  }

  const [meta, image] = await Promise.all([
    streetViewMetadata(env, log, `${pov.lat},${pov.lng}`, pov.panoId),
    fetchImageDataUrl(env, log, streetViewPovImageUrl(env, pov), "googlemaps.streetview_pov_error"),
  ]);
  if (!image) return null;

  const result = { image, date: meta?.status === "OK" ? meta.date || "" : "" };
  await cachePut(log, "googlemaps.cache", cacheKey, result, LOOKUP_CACHE_TTL_S);
  return result;
}

// A road-map image of exactly the map area the user is viewing (center +
// zoom from the client's live interactive map) — the map-view sibling of
// streetViewPovImageUrl. No marker: the user panned freely, there is no
// resolved place to mark.
/**
 * @param {Env} env
 * @param {MapView} view
 */
function staticMapViewUrl(env, view) {
  const qs = new URLSearchParams({
    center: `${view.lat},${view.lng}`,
    zoom: String(view.zoom),
    size: STATICMAP_SIZE,
    scale: "1",
    format: "jpg",
    maptype: "roadmap",
    key: mapsApiKey(env),
  });
  return `${STATICMAP_URL}?${qs}`;
}

// How far around a jump destination to search for a panorama. Scales with
// the jump distance: a 1km "go north" lands wherever the math says — often
// a field or water — and the useful behavior is snapping to the nearest
// covered road, not "no Street View" (live report 2026-07-09, "Ol north
// 1km" → ZERO_RESULTS at 150m while roads sat within a few hundred
// meters). Half the jump distance keeps the snap meaningfully "about that
// far in that direction"; short jumps and here-pops keep the 150m floor.
/**
 * @param {number} meters
 * @returns {number}
 */
export function jumpSearchRadius(meters) {
  const m = Number.isFinite(meters) ? meters : 0;
  return Math.min(1000, Math.max(STREETVIEW_SEARCH_RADIUS_M, Math.round(m / 2)));
}

// Finds the panorama nearest a JUMPED-to point (a "street view here" popup
// or a relative move like "100 meters along this road") and captures one
// frame facing the travel bearing — reusing the POV capture's cached
// metadata+frame fetch. Returns { lat, lng, panoId, heading, date, image }
// (lat/lng snapped to the found panorama's own position) or null when
// Google has no panorama within the search radius of the destination.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {{ lat: number, lng: number, heading: number, meters: number }} point
 * @returns {Promise<{ lat: number, lng: number, panoId: string, heading: number,
 *   date: string, image: string | null } | null>}
 */
export async function runStreetViewJumpLookup(env, log, point) {
  if (!googleMapsAvailable(env)) return null;
  const meta = await streetViewMetadata(env, log, `${point.lat},${point.lng}`, "", jumpSearchRadius(point.meters));
  if (meta?.status !== "OK") return null;
  const panoId = typeof meta.pano_id === "string" ? meta.pano_id : "";
  const mLat = Number(meta.location?.lat);
  const mLng = Number(meta.location?.lng);
  const lat = Number.isFinite(mLat) ? mLat : point.lat;
  const lng = Number.isFinite(mLng) ? mLng : point.lng;
  let capture = null;
  try {
    capture = await runStreetViewPovCapture(env, log, { panoId, lat, lng, heading: point.heading, pitch: 0, fov: 90 });
  } catch {
    // frame capture is an enhancement — the jump itself still resolves
  }
  return { lat, lng, panoId, heading: point.heading, date: capture?.date || meta.date || "", image: capture?.image || null };
}

// Cross-barrier probe ("get to the other side of the railway"): Street View
// covers ROADS, so a rail corridor / river between two roads shows up as a
// coverage GAP along a ray of metadata probes — covered panos, then
// nothing, then covered panos again. The first renewed-coverage pano after
// a gap IS "the other side". Metadata requests are FREE (Google doesn't
// bill them), so a whole ray probes concurrently; with a panorama heading
// the ray follows the view (±45° fallbacks), from a map/device anchor the
// four cardinals are tried. Returns { bearing, before, after } (each
// { lat, lng, panoId, distance }) or null when no gap-then-coverage
// signature exists within CROSS_MAX_M.
const CROSS_STEP_M = 40;
// Exported for buildCrossBarrierBlock (src/googlemaps-blocks.js), whose
// honest no-coverage line reports how far the probe actually reached.
export const CROSS_MAX_M = 640;
const CROSS_PROBE_RADIUS_M = 30;
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {CrossBarrierTarget} anchor
 * @returns {Promise<{ bearing: number, before: PanoPoint, after: PanoPoint } | null>}
 */
export async function runBarrierCrossing(env, log, anchor) {
  if (!googleMapsAvailable(env)) return null;
  const bearings = anchor.hasHeading
    ? [anchor.heading, (anchor.heading + 315) % 360, (anchor.heading + 45) % 360]
    : [0, 90, 180, 270];
  const steps = [];
  for (let d = CROSS_STEP_M; d <= CROSS_MAX_M; d += CROSS_STEP_M) steps.push(d);
  for (const bearing of bearings) {
    const metas = await Promise.all(
      steps.map((d) => {
        const p = movePoint(anchor.lat, anchor.lng, bearing, d);
        return streetViewMetadata(env, log, `${p.lat},${p.lng}`, "", CROSS_PROBE_RADIUS_M);
      }),
    );
    /** @type {PanoPoint | null} */
    let before = null;
    let inGap = false;
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const lat = Number(meta?.location?.lat);
      const lng = Number(meta?.location?.lng);
      if (meta?.status !== "OK" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        if (before) inGap = true;
        continue;
      }
      const pano = {
        lat,
        lng,
        panoId: typeof meta.pano_id === "string" ? meta.pano_id : "",
        distance: steps[i],
      };
      if (inGap && pano.panoId && pano.panoId !== before?.panoId) {
        log.info("googlemaps.barrier_crossing", { bearing, distance: pano.distance });
        // `inGap` is only ever set with `before` present — the cast is safe.
        return { bearing, before: /** @type {PanoPoint} */ (before), after: pano };
      }
      before = pano;
    }
  }
  log.info("googlemaps.barrier_crossing", { found: false });
  return null;
}

// Captures the map area the user currently sees in the inline interactive
// map (validated view from body.map_view): one billed Static Maps fetch at
// their center/zoom. Cached like the POV capture (the view is rounded
// client-side, so re-asking about the same area is a free hit). Returns
// { image } or null on any failure — fail-soft, the caller degrades.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {MapView} view
 * @returns {Promise<{ image: string } | null>}
 */
export async function runMapViewCapture(env, log, view) {
  if (!googleMapsAvailable(env)) return null;

  const params = new URLSearchParams({
    ll: `${view.lat},${view.lng}`,
    z: String(view.zoom),
  });
  const cacheKey = `https://googlemaps-mapview-cache.internal/frame?${params.toString()}`;
  const cached = await cacheGet(log, "googlemaps.cache", cacheKey);
  if (cached && typeof cached === "object" && cached.image) {
    log.info("googlemaps.mapview_cache_hit", {});
    return cached;
  }

  const image = await fetchImageDataUrl(env, log, staticMapViewUrl(env, view), "googlemaps.mapview_error");
  if (!image) return null;

  const result = { image };
  await cachePut(log, "googlemaps.cache", cacheKey, result, LOOKUP_CACHE_TTL_S);
  return result;
}

/**
 * @param {Env} env
 * @param {string} location
 */
function staticMapUrl(env, location) {
  const qs = new URLSearchParams({
    center: location,
    zoom: "18",
    size: STATICMAP_SIZE,
    scale: "1",
    format: "jpg",
    maptype: "roadmap",
    markers: `color:red|${location}`,
    key: mapsApiKey(env),
  });
  return `${STATICMAP_URL}?${qs}`;
}

// A Static Maps image of the JOURNEY: numbered markers at every stop and a
// straight-line path between them. No center/zoom — Static Maps auto-fits
// to the path and markers. Billed like the other Static fetches (~$2/1k).
// `pathPoints` (optional) draws the path along a REAL route polyline (the
// Routes API's road path, downsampled to keep the URL within limits) while
// the numbered markers stay on the logical stops; without it the path
// connects the stops straight-line.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {LatLng[]} points the logical stops (numbered markers)
 * @param {LatLng[] | null} [pathPoints] a real route polyline for the path line
 * @returns {Promise<string | null>}
 */
export async function routeMapImage(env, log, points, pathPoints = null) {
  const path = Array.isArray(pathPoints) && pathPoints.length >= 2 ? downsamplePath(pathPoints, 60) : points;
  const qs = new URLSearchParams({
    size: STATICMAP_SIZE,
    scale: "1",
    format: "jpg",
    maptype: "roadmap",
    path: "color:0x2563ebff|weight:4|" + path.map((p) => `${p.lat},${p.lng}`).join("|"),
    key: mapsApiKey(env),
  });
  points.forEach((p, i) => qs.append("markers", `label:${(i + 1) % 10}|${p.lat},${p.lng}`));
  return fetchImageDataUrl(env, log, `${STATICMAP_URL}?${qs}`, "googlemaps.routemap_error");
}

// Keep every Nth point (endpoints always) so a long polyline fits the
// Static Maps URL limit.
/**
 * @param {LatLng[]} points
 * @param {number} max
 */
function downsamplePath(points, max) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// Along-road walking distance + duration over the journey's stops — Routes
// API v2 computeRoutes, WALK mode, minimal field mask. This API must be
// enabled on the key (routes.googleapis.com); when it isn't (or errors/
// times out) this returns null and the journey block honestly reports the
// straight-line numbers only — never a made-up walking time.
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROUTES_MAX_INTERMEDIATES = 8;
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {LatLng[]} points
 * @returns {Promise<WalkingRoute | null>}
 */
export async function computeWalkingRoute(env, log, points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  try {
    const wp = (/** @type {LatLng} */ p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const resp = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": mapsApiKey(env),
        // The encoded polyline is the actual ROAD PATH — the travel mode
        // samples its Street View waypoints along it and the route map
        // draws it, so "go to X" follows roads instead of a straight line.
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: wp(points[0]),
        destination: wp(points[points.length - 1]),
        intermediates: points.slice(1, -1).slice(0, ROUTES_MAX_INTERMEDIATES).map(wp),
        travelMode: "WALK",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("googlemaps.routes_error", { status: resp.status });
      return null;
    }
    const data = await resp.json().catch(() => null);
    const route = data?.routes?.[0];
    const dist = Number(route?.distanceMeters);
    const dur = typeof route?.duration === "string" ? Number(route.duration.replace(/s$/, "")) : NaN;
    if (!Number.isFinite(dist) || dist <= 0) return null;
    const polyline = decodePolyline(route?.polyline?.encodedPolyline || "");
    log.info("googlemaps.routes", { distance_m: dist, polyline_points: polyline.length });
    return { distanceMeters: dist, durationS: Number.isFinite(dur) ? dur : null, polyline };
  } catch (/** @type {any} */ err) {
    log.warn("googlemaps.routes_error", { error: err?.message || String(err) });
    return null;
  }
}

// The address lookup's edge-cache key (Workers Cache API, caches.default:
// durable across requests in a colo, no binding needed, fail-soft in every
// branch — see LOOKUP_CACHE_TTL_S above for the caching rationale).
/**
 * @param {string | undefined} target
 * @param {boolean} fetchImages
 */
function lookupCacheKey(target, fetchImages) {
  const params = new URLSearchParams({
    t: (target || "").trim().toLowerCase().replace(/\s+/g, " "),
    img: fetchImages ? "1" : "0", // an imageless hit must not starve an imagery request
  });
  return `https://googlemaps-lookup-cache.internal/lookup?${params.toString()}`;
}

// Orchestrates one Maps lookup. Exactly one of `coords` ("lat,lng" of an
// attached photo) or `address` (a parsed street address) drives it; `coords`
// wins when both are present. `fetchImages` gates the (billed) imagery fetches
// — set when the caller will either attach them to a vision answer model or
// run them through the vision-describe helper. Returns the resolved data
// ({ displayQuery, place, lat, lng, streetView, streetViewFrames,
// staticMapImage, embed, details, count }) or null when nothing resolved (or
// any failure) — the caller stays silent / builds the block itself.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {{ coords?: string, address?: string, fetchImages?: boolean }} target
 * @returns {Promise<MapsLookupResult | null>}
 */
export async function runGoogleMapsLookup(env, log, { coords, address, fetchImages }) {
  if (!googleMapsAvailable(env)) return null;

  // Serve an identical earlier lookup (typically: a follow-up about the same
  // place) from the edge cache. Fail-soft: any miss/error falls through to
  // live API calls.
  const cacheKey = lookupCacheKey(coords || address, !!fetchImages);
  const cached = await cacheGet(log, "googlemaps.cache", cacheKey);
  if (cached && typeof cached === "object") {
    log.info("googlemaps.cache_hit", { frames: cached.streetViewFrames?.length || 0 });
    return cached;
  }

  // Resolve a place + coordinates. A photo's coords are used directly; an
  // address is first sent to Places to canonicalise it and get precise coords
  // (falling back to letting the imagery APIs geocode the raw string).
  /** @type {Place | null} */
  let place = null;
  /** @type {number | null} */
  let lat = null;
  /** @type {number | null} */
  let lng = null;
  let displayQuery = coords || address || "";
  if (coords) {
    const [clat, clng] = coords.split(",").map(Number);
    if (Number.isFinite(clat) && Number.isFinite(clng)) {
      lat = clat;
      lng = clng;
    }
  } else if (address) {
    place = await placesTextSearch(env, log, address);
    if (place) {
      // Prefer the formatted address — it carries the CITY, so the frames
      // title and the context block make a wrong-city resolution visible
      // (a bare place name like "Lidbecksgatan 10" hides which one).
      displayQuery = place.address || place.name || address;
      if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
        lat = place.lat;
        lng = place.lng;
      }
    }
  }

  // The location string the imagery APIs use: precise coords when we have
  // them, else the raw address (Google geocodes it).
  const imageryLocation =
    Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : address || "";
  if (!imageryLocation) return null;

  const svMeta = await streetViewMetadata(env, log, imageryLocation, "", STREETVIEW_SEARCH_RADIUS_M);
  const svOk = svMeta?.status === "OK";
  // The found panorama's own id and position: the id pins the imagery
  // fetches to that exact pano, and the position (which can sit up to the
  // search radius from the resolved coordinates) is what the interactive
  // embed and the keyless Street View link must center on — the client's
  // StreetViewPanorama searches only Google's default 50m radius, so
  // centering it on the resolved address would re-miss the pano.
  const svPano = svOk && typeof svMeta.pano_id === "string" ? svMeta.pano_id : "";
  const svMetaLat = svOk ? Number(svMeta.location?.lat) : NaN;
  const svMetaLng = svOk ? Number(svMeta.location?.lng) : NaN;
  const svPoint =
    Number.isFinite(svMetaLat) && Number.isFinite(svMetaLng) ? { lat: svMetaLat, lng: svMetaLng } : null;

  // Nothing to show: an address Places couldn't resolve and with no Street
  // View coverage is a false-positive address — stay silent. A photo's coords
  // are always a valid map point, so they always produce at least a map.
  if (!coords && !place && !svOk) return null;

  // Capture imagery when asked: one Street View frame per cardinal heading (a
  // full look around the spot) plus a road map. Fetched concurrently; each is
  // independently fail-soft (a missing frame just drops). Frames keep their
  // heading label so the client can caption them and the vision prompt can
  // name directions. The CALLER decides whether to attach these to a vision
  // answer model or run them through the vision-describe helper — this just
  // fetches them.
  /** @type {Array<{ dir: string, url: string }>} */
  let streetViewFrames = [];
  /** @type {string | null} */
  let staticMapImage = null;
  if (fetchImages) {
    const svJobs = svOk
      ? STREETVIEW_HEADINGS.map((h) =>
          fetchImageDataUrl(env, log, streetViewImageUrl(env, imageryLocation, h.deg, svPano), "googlemaps.streetview_image_error"),
        )
      : [];
    const [svResults, mapResult] = await Promise.all([
      Promise.all(svJobs),
      fetchImageDataUrl(env, log, staticMapUrl(env, imageryLocation), "googlemaps.staticmap_error"),
    ]);
    streetViewFrames = /** @type {Array<{ dir: string, url: string }>} */ (
      svResults.map((url, i) => ({ dir: STREETVIEW_HEADINGS[i].dir, url })).filter((f) => f.url)
    );
    staticMapImage = mapResult;
  }

  // Coordinates for the client's interactive Street View embed (only when
  // there's coverage and a real point to center on) — the panorama's own
  // position when the metadata reported one, so the embed can't re-miss it.
  const embedPoint =
    svPoint ||
    (Number.isFinite(lat) && Number.isFinite(lng)
      ? { lat: /** @type {number} */ (lat), lng: /** @type {number} */ (lng) }
      : null);
  const embed = svOk && embedPoint ? embedPoint : null;

  // Prefer the formatted address (includes the city) so the activity detail
  // reveals WHICH "Maskinistvägen 11" Google resolved — makes a wrong-city hit
  // visible instead of showing a bare, ambiguous street name.
  const bits = [];
  if (place) bits.push(place.address || place.name || "place found");
  if (svOk) bits.push(`Street View${svMeta.date ? ` (${svMeta.date})` : ""}`);
  bits.push("road map");
  const details = [`${displayQuery} → ${bits.join(", ")}`];

  const result = {
    displayQuery,
    place,
    lat,
    lng,
    streetView: svOk ? { date: svMeta.date || "", lat: svPoint?.lat ?? null, lng: svPoint?.lng ?? null } : null,
    streetViewFrames,
    staticMapImage,
    embed,
    details,
    count: 1,
  };

  // Cache only successful lookups (the null early-returns above stay uncached
  // so a retry can still find something). A write failure never affects the
  // response.
  await cachePut(log, "googlemaps.cache", cacheKey, result, LOOKUP_CACHE_TTL_S);

  return result;
}

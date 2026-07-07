// Google Maps Platform client — the keyed tier of photo-location support
// (the keyless tier — Street View deep links, Nominatim, Overpass — lives in
// src/geocode.js and keeps working with no GOOGLE_MAPS_API_KEY set).
//
// Three APIs, each behind its own per-user settings knob (src/settings.js)
// AND the GOOGLE_MAPS_API_KEY secret; with the key missing this module is
// invisible (mapsAvailable() false, knobs read as off):
//   - Street View Static API: a free metadata call checks imagery coverage,
//     then 4 panorama JPEGs (compass headings N/E/S/W) are fetched so a
//     vision model can literally look around the photo's location.
//     $7/1k images, 10k free/month (Essentials SKU).
//   - Maps Static API: one labeled road-map image of the photo location(s)
//     for spatial context alongside the street-level views. $2/1k, 10k
//     free/month (Essentials SKU).
//   - Places API (New) Nearby Search: named establishments with rating,
//     review count, open-now and business status — richer and fresher than
//     the free Overpass baseline (which stays as the fallback). NOTE the
//     field mask below includes rating/userRatingCount/currentOpeningHours,
//     which bill the call as the ENTERPRISE Nearby Search SKU (1k free
//     calls/month, ~$40/1k after) — trimming the mask to
//     displayName/types/businessStatus would drop it to Pro ($32/1k, 5k
//     free). One call per photo location; deliberate choice, revisit if
//     volume ever approaches the cap.
//
// Same outbound-privacy posture as geocode.js: only coordinates (and the
// API key) cross the wire — never the filename, the user's question, or any
// account identifier. Everything fails soft: a Google error/timeout means
// less context, never a blocked chat.

const SV_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const SV_METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const PLACES_NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";
const TIMEOUT_MS = 8000;

// 640x400 is Street View Static's and Maps Static's free-tier max width at a
// bandwidth-friendly aspect; JPEG keeps each image's base64 form well under
// ~100K chars so four headings + a map fit comfortably inside Berget's ~1MB
// request ceiling alongside the user's own downscaled photos.
const IMG_SIZE = "640x400";
export const SV_HEADINGS = [
  { deg: 0, label: "facing north" },
  { deg: 90, label: "facing east" },
  { deg: 180, label: "facing south" },
  { deg: 270, label: "facing west" },
];

const PLACES_RADIUS_M = 250;
const PLACES_MAX = 20;
// Field mask = billing SKU — see the module header before touching this.
export const PLACES_FIELD_MASK = [
  "places.displayName",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.currentOpeningHours.openNow",
].join(",");

export function mapsAvailable(env) {
  return !!env.GOOGLE_MAPS_API_KEY;
}

// ---- pure builders/formatters (unit-tested in maps.test.js) ----------------

// Query string for one Street View frame. `source=outdoor` skips indoor/
// business panoramas (a photo's surroundings are the street); pano is the
// metadata-confirmed panorama id so all four headings render the SAME
// panorama instead of re-snapping per request.
export function streetViewParams(panoId, headingDeg) {
  return `size=${IMG_SIZE}&pano=${encodeURIComponent(panoId)}&heading=${headingDeg}&fov=90&return_error_code=true`;
}

export function streetViewMetadataParams(lat, lon) {
  return `location=${lat}%2C${lon}&source=outdoor`;
}

// Static map query: one labeled marker per photo (A, B, …). A single
// location gets an explicit zoom (auto-fit around one marker is too tight);
// multiple locations let the API fit them all.
export function staticMapParams(locations) {
  const markers = locations
    .slice(0, 4)
    .map(({ lat, lon }, i) => `markers=${encodeURIComponent(`color:red|label:${String.fromCharCode(65 + i)}|${lat},${lon}`)}`)
    .join("&");
  const zoom = locations.length === 1 ? `&center=${locations[0].lat}%2C${locations[0].lon}&zoom=16` : "";
  return `size=${IMG_SIZE}&scale=1&maptype=roadmap&format=jpg&${markers}${zoom}`;
}

export function placesNearbyBody(lat, lon) {
  return {
    maxResultCount: PLACES_MAX,
    rankPreference: "POPULARITY",
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lon }, radius: PLACES_RADIUS_M },
    },
  };
}

// Places (New) results → display lines: "Name (Coffee Shop) — 4.5★ (321
// reviews), open now". businessStatus only surfaces when it's NOT the
// normal OPERATIONAL — "permanently closed" is exactly the freshness signal
// the free OSM data can't give.
export function formatPlaces(places) {
  if (!Array.isArray(places)) return [];
  const out = [];
  for (const p of places) {
    if (out.length >= PLACES_MAX) break;
    const name = typeof p?.displayName?.text === "string" ? p.displayName.text.trim() : "";
    if (!name) continue;
    const kind = typeof p?.primaryTypeDisplayName?.text === "string" ? p.primaryTypeDisplayName.text : null;
    const bits = [];
    if (typeof p?.rating === "number") {
      bits.push(`${p.rating}★${typeof p?.userRatingCount === "number" ? ` (${p.userRatingCount} reviews)` : ""}`);
    }
    if (p?.currentOpeningHours?.openNow === true) bits.push("open now");
    else if (p?.currentOpeningHours?.openNow === false) bits.push("closed right now");
    if (p?.businessStatus === "CLOSED_PERMANENTLY") bits.push("PERMANENTLY CLOSED");
    else if (p?.businessStatus === "CLOSED_TEMPORARILY") bits.push("temporarily closed");
    out.push(`${name}${kind ? ` (${kind})` : ""}${bits.length ? ` — ${bits.join(", ")}` : ""}`);
  }
  return out;
}

// ---- fetchers (all fail-soft, live-verified per project convention) --------

async function timedFetch(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// Free coverage check. Returns {panoId, date} when Google has street-level
// imagery near the coordinates, null otherwise (including on any error) —
// callers skip the paid image fetches entirely on null.
export async function streetViewCoverage(env, log, lat, lon) {
  try {
    const url = `${SV_METADATA_URL}?${streetViewMetadataParams(lat, lon)}&key=${env.GOOGLE_MAPS_API_KEY}`;
    const resp = await timedFetch(url);
    if (!resp.ok) {
      log.warn("maps.sv_metadata_error", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    if (data?.status !== "OK" || !data?.pano_id) {
      if (data?.status !== "ZERO_RESULTS") log.warn("maps.sv_metadata_status", { status: data?.status });
      return null;
    }
    return { panoId: data.pano_id, date: typeof data.date === "string" ? data.date : null };
  } catch (err) {
    log.warn("maps.sv_metadata_error", { error: err?.message || String(err) });
    return null;
  }
}

async function fetchImageAsDataUrl(url, log, event) {
  try {
    const resp = await timedFetch(url);
    if (!resp.ok) {
      log.warn(event, { status: resp.status });
      return null;
    }
    const mime = resp.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  } catch (err) {
    log.warn(event, { error: err?.message || String(err) });
    return null;
  }
}

// btoa needs a binary string; build it in chunks (String.fromCharCode has an
// argument-count ceiling, and per-byte concatenation is quadratic).
export function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// The four compass frames of one confirmed panorama, fetched concurrently.
// Returns [{label, dataUrl}] — a failed heading just drops out.
export async function streetViewImages(env, log, panoId) {
  const frames = await Promise.all(
    SV_HEADINGS.map(async ({ deg, label }) => {
      const url = `${SV_IMAGE_URL}?${streetViewParams(panoId, deg)}&key=${env.GOOGLE_MAPS_API_KEY}`;
      const dataUrl = await fetchImageAsDataUrl(url, log, "maps.sv_image_error");
      return dataUrl ? { label: `Street View ${label} (${deg}°)`, dataUrl } : null;
    }),
  );
  return frames.filter(Boolean);
}

// One road-map image with a labeled marker per photo location, or null.
export async function staticMapImage(env, log, locations) {
  const url = `${STATIC_MAP_URL}?${staticMapParams(locations)}&key=${env.GOOGLE_MAPS_API_KEY}`;
  const dataUrl = await fetchImageAsDataUrl(url, log, "maps.static_map_error");
  return dataUrl ? { label: mapLabel(locations), dataUrl } : null;
}

export function mapLabel(locations) {
  return locations.length === 1
    ? "Map of the photo's location (red marker)"
    : `Map of the photos' locations (markers A–${String.fromCharCode(64 + Math.min(locations.length, 4))})`;
}

// Nearby establishments via Places (New). Returns display lines, [] when
// Google has nothing there, or null on any failure — callers treat null/[]
// as "fall back to Overpass".
export async function placesNearby(env, log, lat, lon) {
  try {
    const resp = await timedFetch(PLACES_NEARBY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": PLACES_FIELD_MASK,
      },
      body: JSON.stringify(placesNearbyBody(lat, lon)),
    });
    if (!resp.ok) {
      log.warn("maps.places_error", { status: resp.status });
      return null;
    }
    const data = await resp.json();
    return formatPlaces(data?.places);
  } catch (err) {
    log.warn("maps.places_error", { error: err?.message || String(err) });
    return null;
  }
}

// Orchestrates the imagery for one request: Street View frames for the FIRST
// photo location that has coverage (four frames of one spot beats one frame
// each of several) plus one map covering every location. Both knob-gated by
// the caller; returns {images: [{label, dataUrl}], notes: [..]} for the SSE
// step details.
export async function collectMapImagery(env, log, locations, { streetView, mapImage }) {
  const [svFrames, map] = await Promise.all([
    (async () => {
      if (!streetView) return { frames: [], date: null };
      for (const { lat, lon } of locations) {
        const coverage = await streetViewCoverage(env, log, lat, lon);
        if (coverage) {
          return { frames: await streetViewImages(env, log, coverage.panoId), date: coverage.date };
        }
      }
      return { frames: [], date: null };
    })(),
    mapImage ? staticMapImage(env, log, locations) : Promise.resolve(null),
  ]);

  const images = [...svFrames.frames, ...(map ? [map] : [])];
  const notes = [];
  if (svFrames.frames.length) {
    notes.push(
      `Street View: ${svFrames.frames.length} view(s)${svFrames.date ? ` (imagery dated ${svFrames.date})` : ""}`,
    );
  }
  if (map) notes.push("Area map with marker(s)");
  return { images, notes };
}

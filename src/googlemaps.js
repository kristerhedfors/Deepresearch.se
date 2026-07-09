// Google Maps Platform integration ("Google Maps & Street View" in the UI) —
// an opt-in per-user knob (src/settings.js's `google_maps`, default OFF).
// When the knob is on and the GOOGLE_MAPS_API_KEY secret is set, the Worker
// resolves a location the research question is about — either a street address
// named in the message, or an attached photo's GPS EXIF coordinates — into
// Google Maps data across three Maps Platform APIs that share the one key:
//
//   • Places API (places.googleapis.com) — resolve a named address into a
//     canonical place: display name, formatted address, precise coordinates,
//     place type, rating and business status. This both enriches the answer
//     and yields the exact coordinates the two imagery APIs below key off.
//   • Street View Static API (street-view-image-backend.googleapis.com) —
//     confirm panorama coverage, its capture date, and fetch the actual
//     street-level photo for a vision model to describe.
//   • Maps Static API (static-maps-backend.googleapis.com) — a road-map image
//     of the spot for spatial context.
//
// Wired the same deterministic, no-function-calling way as the reverse-
// geocoder (src/geocode.js) and Shodan (src/shodan.js): the location is
// extracted deterministically (a photo's coordinates, or an address parsed
// from the message — the pure text analysis lives in src/googlemaps-text.js),
// the lookups run server-side, and the result is appended as one labeled
// context block every downstream phase can reason and search with — never
// silently blended into the user's text.
//
// This module owns the REST side: the Maps Platform clients, the edge-cached
// lookup orchestration, and the labeled context-block builders.
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
// Four cardinal headings give the vision model a full look around the spot
// (what's across the street, the façade, neighbours) — the "multi-angle
// capture" that makes Street View actually queryable, not one fixed frame.
const STREETVIEW_HEADINGS = [
  { deg: 0, dir: "north" },
  { deg: 90, dir: "east" },
  { deg: 180, dir: "south" },
  { deg: 270, dir: "west" },
];

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
export function googleMapsEmbedKey(env) {
  const embed = typeof env.GOOGLE_MAPS_EMBED_KEY === "string" ? env.GOOGLE_MAPS_EMBED_KEY : "";
  if (embed) return embed;
  return typeof env.GOOGLE_MAPS_API_KEY === "string" ? env.GOOGLE_MAPS_API_KEY : "";
}

// The honest note for an explicit street-view ask that resolved to NOTHING:
// the knob is on (this code only runs then), so the model must ask which
// place is meant — never hand out "enable it in Settings" steps.
export function unresolvedMapsBlock() {
  return (
    "\n\n--- Google Maps ---\n" +
    "The user asked for Street View, and Google Maps & Street View is ENABLED, but no address or place name could be identified in the message. " +
    "Ask the user which address or place they mean (one short question). " +
    "Do NOT instruct the user to enable Google Maps — it is already on.\n" +
    "--- End of Google Maps ---"
  );
}

// ---- pure link/block builders (exported for unit tests) --------------------

// Appended to every Maps context block. Without it a model that wanted to
// "show" imagery invented a Street View Static API markdown image with
// key=YOUR_API_KEY — a broken image in the reply (reported 2026-07-09,
// "Street view basaltvägen 1 enköping"). Any real imagery is rendered
// beside the reply by the client, never by the model.
const NO_FABRICATED_IMAGE_URLS =
  "NEVER construct or output Google Maps API image URLs or markdown images (e.g. maps.googleapis.com/maps/api/streetview?...) — you have no API key, so such URLs render as broken images. Any available imagery is already shown to the user beside this reply; when linking, use only the keyless links given above.";

// Keyless Google Maps Street View link (built from the pano's own
// coordinates) the model can cite and the user can open. NEVER embeds the API
// key — the keyed image URL is used only for the internal fetch.
export function panoLink(lat, lng) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
}

// Keyless Google Maps link that drops a pin at the coordinates.
export function mapLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

// A heading in degrees as a compass point ("143°" → "southeast"), so the
// context block reads naturally for the model and the user.
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
export function compassDir(heading) {
  const h = ((Number(heading) % 360) + 360) % 360;
  return COMPASS[Math.round(h / 45) % 8];
}

// The labeled context block for a captured CURRENT-view frame (the POV path):
// the user panned/moved the inline panorama and asked a follow-up, and the
// exact frame on their screen was captured and (when possible) described.
// Same plain-text convention as buildMapsBlock. Pure — exported for tests.
export function buildPovBlock(pov, parts) {
  const lines = [
    "The user is viewing an interactive Street View panorama beside this chat and may have panned or moved it.",
    `Their CURRENTLY VISIBLE view was captured for this question: at coordinates ${pov.lat}, ${pov.lng}, facing ${pov.heading}° (${compassDir(pov.heading)}), pitch ${pov.pitch}°.`,
  ];
  if (parts.date) lines.push(`Street View imagery captured: ${parts.date}`);
  lines.push(`Map link: ${mapLink(pov.lat, pov.lng)}`);
  lines.push(`Street View link: ${panoLink(pov.lat, pov.lng)}`);
  if (parts.panoramaShown) {
    lines.push(
      "An interactive Street View panorama positioned at exactly this view is displayed to the user directly beside this reply — they can keep looking around from there, so refer to the view as shared context.",
    );
  } else if (parts.framesShown) {
    lines.push("The captured frame is displayed to the user directly beside this reply, so you can refer to it as shared context.");
  }
  // The user navigated here from wherever the conversation started — the
  // coordinates above are where they are NOW, so the answer must hand them
  // a link to this position, not rely on links given for the original place.
  lines.push(
    `The user has moved within Street View, so ALWAYS include the Map link above in your answer as a markdown link (e.g. [View on Google Maps](${mapLink(pov.lat, pov.lng)})) so they can open their current position.`,
  );
  if (parts.description) {
    lines.push(`Visual description of the user's current view (auto-generated): ${parts.description}`);
  } else {
    lines.push("The frame could not be examined by a vision model this time — answer from the location data above and say plainly that the view itself couldn't be inspected.");
  }
  // Conditional on purpose: the capture fires generously for panorama
  // conversations, so the question may or may not be about the view —
  // steer without misdirecting the unrelated case.
  lines.push(
    "If the question refers to something visible (a person, vehicle, sign, building — anything in the scene), answer it directly from the visual description above and never ask them to clarify who or what they mean: they mean what is in their view. If the question is unrelated to the view, answer it normally and ignore this block.",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// The labeled context block appended to the conversation, same plain-text
// convention as geocode.js's resolved-location block and shodan.js's host
// block. `parts` is the assembled lookup result (place / streetView / map).
export function buildMapsBlock(query, parts) {
  const lines = [`Location looked up: ${query}`];
  const p = parts.place;
  if (p) {
    if (p.name) lines.push(`Place: ${p.name}`);
    if (p.address) lines.push(`Address: ${p.address}`);
    if (p.type) lines.push(`Type: ${p.type}`);
    if (Number.isFinite(p.rating)) {
      lines.push(`Rating: ${p.rating}${p.ratingCount ? ` (${p.ratingCount} reviews)` : ""}`);
    }
    if (p.status) lines.push(`Business status: ${p.status}`);
  }
  const lat = parts.lat;
  const lng = parts.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    lines.push(`Coordinates: ${lat}, ${lng}`);
    lines.push(`Map link: ${mapLink(lat, lng)}`);
  }
  if (parts.streetView) {
    // Link the panorama's own position when the lookup reported one (it can
    // sit up to the search radius from the resolved address), else the
    // resolved coordinates.
    const svLat = Number.isFinite(parts.streetView.lat) ? parts.streetView.lat : lat;
    const svLng = Number.isFinite(parts.streetView.lng) ? parts.streetView.lng : lng;
    if (Number.isFinite(svLat) && Number.isFinite(svLng)) lines.push(`Street View link: ${panoLink(svLat, svLng)}`);
    if (parts.streetView.date) lines.push(`Street View imagery captured: ${parts.streetView.date}`);
  } else {
    // The location resolved but Google has no panorama near it. Said
    // explicitly, because omitting it made the model present a road-map
    // description as "Street View imagery" (reported 2026-07-09).
    lines.push(
      "No Street View imagery is available for this location (Google has no panorama near these coordinates). If the user asked for Street View, say that plainly — never present anything else (a map, a guess) as Street View imagery.",
    );
  }
  const svCount = parts.streetViewCount || 0;
  if (parts.followUp) {
    // pickLookup walked back to an address an EARLIER turn named: tell the
    // model this is fresh imagery of the location already under discussion,
    // so it reasons about THE image instead of denying knowledge of it.
    lines.push(
      "This is a follow-up question about the location already being discussed — the CURRENT Street View imagery of it was re-fetched and re-examined for this question.",
    );
  }
  if (parts.framesShown) {
    lines.push(
      `${parts.framesShown} Street View photo(s) of this location are displayed to the user directly beside this reply, so you can refer to them ("in the photos", "the north-facing frame") as shared context.`,
    );
  }
  if (parts.mapShown) {
    lines.push(
      "A road-map image of the area is displayed to the user directly beside this reply, so you can refer to it as shared context.",
    );
  }
  if (parts.description) {
    // A vision model already looked at the imagery for a non-vision answer
    // model — hand over its description so the answer can relay it. Label
    // WHAT was described honestly: when only the road map could be examined
    // (no Street View coverage, or every frame fetch failed), saying
    // "Street View imagery" here made the model claim Street View it never
    // had (reported 2026-07-09).
    const describedWhat = parts.describedMapOnly
      ? "Visual description of the road map of the area (auto-generated — this is a MAP image, NOT Street View)"
      : "Visual description of the Street View imagery (auto-generated)";
    lines.push(`${describedWhat}: ${parts.description}`);
  } else {
    const imgs = [];
    if (svCount) {
      imgs.push(
        svCount === 1
          ? "one Street View photo"
          : `${svCount} Street View photos looking ${STREETVIEW_HEADINGS.slice(0, svCount).map((h) => h.dir).join(", ")} from the spot`,
      );
    }
    if (parts.hasMap) imgs.push("a road map");
    if (imgs.length) {
      lines.push(`Attached to this message for you to describe: ${imgs.join(" and ")}.`);
    } else if (parts.streetView) {
      lines.push("Street View imagery exists here; to see it the user can open the Street View link above (the answering model can't view images).");
    }
  }
  // A resolved location must never be re-asked (reported: the user wrote
  // "lidbecksgatan 10 hallstahammar" and still got "did you mean Lidköping
  // or Hallstahammar?" — a wasted turn beside already-fetched imagery).
  lines.push(
    "The location was already resolved as shown above — do NOT ask the user to confirm or disambiguate the location or city. Answer about the resolved location directly; if the user's message names a locality that differs from the resolved address, say so plainly instead of asking.",
  );
  // The knob is on (this block only exists when it is). Stop the model from
  // wrongly telling the user to enable an already-enabled feature.
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
  lines.push(NO_FABRICATED_IMAGE_URLS);
  return "\n\n--- Google Maps ---\n" + lines.join("\n") + "\n--- End of Google Maps ---";
}

// ---- REST calls ------------------------------------------------------------

// Base64-encode bytes in chunks so a large image doesn't blow the argument
// limit of String.fromCharCode (Workers have btoa but not Buffer).
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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
  } catch (err) {
    log.warn(event, { error: err?.message || String(err) });
    return null;
  }
}

// Places API (New) Text Search: resolve an address/place string into a single
// canonical place. Field mask keeps the response — and the billing tier —
// minimal. Returns { name, address, lat, lng, type, rating, ratingCount,
// status } or null.
export async function placesTextSearch(env, log, query) {
  try {
    const resp = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.location,places.primaryType,places.rating,places.userRatingCount,places.businessStatus",
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn("googlemaps.places_error", { status: resp.status });
      return null;
    }
    const data = await resp.json().catch(() => null);
    const place = data?.places?.[0];
    if (!place) {
      log.info("googlemaps.places", { found: false });
      return null;
    }
    const lat = Number(place.location?.latitude);
    const lng = Number(place.location?.longitude);
    log.info("googlemaps.places", { found: true });
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
  } catch (err) {
    log.warn("googlemaps.places_error", { error: err?.message || String(err) });
    return null;
  }
}

// Street View metadata is FREE (Google does not bill metadata requests) and
// tells us whether a panorama exists at `location` before we spend on an
// image. A pano id (from the client's live panorama) takes precedence over
// the location string when given. Returns the parsed metadata (status "OK"
// means imagery exists) or null.
export async function streetViewMetadata(env, log, location, pano = "", radius = 0) {
  try {
    const qs = new URLSearchParams({ key: env.GOOGLE_MAPS_API_KEY });
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
  } catch (err) {
    log.warn("googlemaps.streetview_meta_error", { error: err?.message || String(err) });
    return null;
  }
}

function streetViewImageUrl(env, location, heading, pano = "") {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    heading: String(heading),
    fov: "90",
    key: env.GOOGLE_MAPS_API_KEY,
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
function streetViewPovImageUrl(env, pov) {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    heading: String(pov.heading),
    pitch: String(pov.pitch),
    fov: String(pov.fov),
    key: env.GOOGLE_MAPS_API_KEY,
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

function staticMapUrl(env, location) {
  const qs = new URLSearchParams({
    center: location,
    zoom: "18",
    size: STATICMAP_SIZE,
    scale: "1",
    format: "jpg",
    maptype: "roadmap",
    markers: `color:red|${location}`,
    key: env.GOOGLE_MAPS_API_KEY,
  });
  return `${STATICMAP_URL}?${qs}`;
}

// Cross-request lookup cache, the exact pattern src/exa.js uses for searches:
// a follow-up turn is a SEPARATE /api/chat request, and the follow-up flow
// above (pickLookup's walk-back) re-looks-up the SAME location on every
// gated follow-up — without a cache each one re-bills Places + five imagery
// fetches at Google. Workers Cache API (caches.default): durable across
// requests in a colo, no binding needed, fail-soft in every branch. Short TTL
// only — enough to absorb a whole session of follow-ups about one address
// (raised from 10 to 30 min after a user asking repeatedly about the same
// address in one sitting), still comfortably inside Google's
// performance-caching allowance (Street View imagery itself changes on a
// timescale of years).
const LOOKUP_CACHE_TTL_S = 1800;

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
  let place = null;
  let lat = null;
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
  let streetViewFrames = [];
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
    streetViewFrames = svResults
      .map((url, i) => ({ dir: STREETVIEW_HEADINGS[i].dir, url }))
      .filter((f) => f.url);
    staticMapImage = mapResult;
  }

  // Coordinates for the client's interactive Street View embed (only when
  // there's coverage and a real point to center on) — the panorama's own
  // position when the metadata reported one, so the embed can't re-miss it.
  const embedPoint = svPoint || (Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);
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

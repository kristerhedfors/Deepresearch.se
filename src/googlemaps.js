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
// from the message by extractPlace below), the lookups run server-side, and
// the result is appended as one labeled context block every downstream phase
// can reason and search with — never silently blended into the user's text.
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

import { textOf, lastUserMessage } from "./conversation.js";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const STREETVIEW_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const STATICMAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const TIMEOUT_MS = 6000;
const STREETVIEW_SIZE = "640x640";
const STATICMAP_SIZE = "600x400"; // JPEG below — small enough to attach alongside Street View
const MAX_LOCATION_CHARS = 200;

export function googleMapsAvailable(env) {
  return !!env.GOOGLE_MAPS_API_KEY;
}

// ---- deterministic address extraction (pure — exported for unit tests) -----

// What marks the word before a house number as a STREET name (so
// "Maskinistvägen 11" is an address but "iPhone 15" / "on August 5" are not).
// Two safe tests, deliberately kept apart:
//  - Swedish street words are compounds ending in a street morpheme
//    (…vägen, …gatan, …gränd); testing that morpheme as a word-ENDING is safe
//    because ordinary words practically never end that way.
//  - English street words are short and some (st, rd) are substrings of common
//    words ("August", "record"), so they must match the word EXACTLY, never as
//    a mere ending.
const SWEDISH_STREET_SUFFIX_RE =
  /(vägen|väg|gatan|gata|gränden|gränd|stigen|stig|allén|allé|backen|backe|liden|torget|torg)$/u;
const ENGLISH_STREET_WORDS = new Set([
  "street", "st", "road", "rd", "avenue", "ave", "lane", "ln", "drive", "dr",
  "boulevard", "blvd", "highway", "hwy", "court", "ct", "place", "pl",
  "square", "sq", "way", "terrace", "parkway", "pkwy",
]);

// A word is address-like text: unicode letters plus the marks/apostrophes/
// hyphens that appear inside street names. \p{L} covers å/ä/ö and accents.
const WORD = "[\\p{L}][\\p{L}\\p{M}'’.-]*";
// One or more words followed by a 1-4 digit house number (optionally with a
// letter suffix like "11B"). The leading words let a preceding locality ride
// along ("Kallhäll Maskinistvägen 11").
const ADDRESS_RE = new RegExp(`(?:${WORD}\\s+){1,4}\\d{1,4}[a-zA-Z]?\\b`, "gu");

// A STANDALONE Swedish street name — a single word ending in a street morpheme
// (Maskinistvägen, Storgatan, Björkstigen). No house number needed: a word
// ending "…vägen"/"…gatan"/etc. is an unambiguous street signal, and people
// routinely ask about a street without a number ("street view of X in Y").
const SWEDISH_STREET_TOKEN_RE =
  /[\p{L}][\p{L}\p{M}-]*(?:vägen|väg|gatan|gata|gränden|gränd|stigen|stig|allén|allé|backen|backe|liden|torget|torg)\b/giu;
// A STANDALONE English street phrase — 1-3 Capitalized words then a Capitalized
// street type ("Abbey Road", "Main Street"). Requiring the type word to be
// capitalized keeps ordinary prose ("down the road") from matching, and the
// type list is limited to the unambiguous ones (dropping Drive/Place/Way/
// Court/Square, which double as common capitalized words — "Please Drive",
// "the Square" — since here no house number anchors them).
const ENGLISH_STREET_PHRASE_RE =
  /\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*){0,2}\s+(?:Street|Road|Avenue|Lane|Boulevard|Highway|Terrace|Parkway)\b/gu;
// A trailing locality after a bare street name: "…, Kallhäll", "… in Kallhäll",
// "… i Kallhäll". Up to two Capitalized words are captured as the place.
const LOCALITY_RE =
  /^[\s,]*(?:,|\bin\b|\bi\b|\bpå\b|\bvid\b|\bnear\b)?\s*(\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)?)/u;

// Given a matched street span and the text right after it, append a trailing
// locality when one is present, so "Maskinistvägen in Kallhäll" resolves as
// "Maskinistvägen, Kallhäll" rather than a bare, ambiguous street name.
function withTrailingLocality(street, rest) {
  const m = rest.match(LOCALITY_RE);
  if (!m || !m[1]) return street;
  const locality = m[1].trim();
  // Don't repeat a word the street span already ends with.
  if (street.toLowerCase().endsWith(locality.toLowerCase())) return street;
  return `${street}, ${locality}`;
}

// Pulls a single geocodable street-address / street-name candidate out of free
// text, or returns "" when the message names no street. Three shapes, most
// specific first:
//   1. a numbered address ("Kallhäll Maskinistvägen 11", "Main Street 5"),
//   2. a standalone Swedish street name ("Maskinistvägen", optionally "… in
//      Kallhäll"),
//   3. a standalone English street phrase ("Abbey Road", optionally "… London").
// Deliberately conservative so ordinary "<noun> <number>" phrases ("iPhone 15",
// "Article 5", "on May 5") and plain prose don't get mistaken for addresses.
// Only this candidate ever crosses the wire, never the whole message — the same
// minimal-request privacy posture shodan.js/geocode.js keep.
export function extractPlace(text) {
  const raw = typeof text === "string" ? text : "";

  // 1) Numbered street address (most specific).
  for (const m of raw.matchAll(ADDRESS_RE)) {
    const words = m[0].trim().replace(/\s+/g, " ").split(" ");
    if (words.length < 2) continue;
    const streetIdx = words.length - 2;
    const streetWord = (words[streetIdx] || "").toLowerCase().replace(/[^\p{L}]/gu, "");
    if (!SWEDISH_STREET_SUFFIX_RE.test(streetWord) && !ENGLISH_STREET_WORDS.has(streetWord)) continue;
    // The regex may have swept up filler words before the street name ("what's
    // at Maskinistvägen 11"). Keep only Capitalized preceding words — a
    // locality like "Kallhäll" or "Main" — and drop lowercase filler.
    let start = streetIdx;
    while (start > 0 && /^\p{Lu}/u.test(words[start - 1])) start--;
    const street = words.slice(start).join(" ");
    const rest = raw.slice(m.index + m[0].length);
    return withTrailingLocality(street, rest).slice(0, MAX_LOCATION_CHARS);
  }

  // 2) & 3) Standalone street name — pick whichever (Swedish token / English
  // phrase) appears earliest in the message.
  const sv = firstMatch(raw, SWEDISH_STREET_TOKEN_RE);
  const en = firstMatch(raw, ENGLISH_STREET_PHRASE_RE);
  const hit = sv && en ? (sv.index <= en.index ? sv : en) : sv || en;
  if (hit) {
    const street = hit[0].trim();
    const rest = raw.slice(hit.index + hit[0].length);
    return withTrailingLocality(street, rest).slice(0, MAX_LOCATION_CHARS);
  }
  return "";
}

function firstMatch(raw, re) {
  re.lastIndex = 0;
  return re.exec(raw);
}

// ---- pure link/block builders (exported for unit tests) --------------------

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
    if (Number.isFinite(lat) && Number.isFinite(lng)) lines.push(`Street View link: ${panoLink(lat, lng)}`);
    if (parts.streetView.date) lines.push(`Street View imagery captured: ${parts.streetView.date}`);
  }
  const imgs = [];
  if (parts.streetViewImage) imgs.push("a Street View photo");
  if (parts.staticMapImage) imgs.push("a road map");
  if (imgs.length) {
    lines.push(`Attached to this message for you to describe: ${imgs.join(" and ")}.`);
  } else if (parts.streetView) {
    lines.push("Street View imagery exists here (image not attached — the answering model has no vision).");
  }
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
// image. Returns the parsed metadata (status "OK" means imagery exists) or
// null.
export async function streetViewMetadata(env, log, location) {
  try {
    const qs = new URLSearchParams({ location, key: env.GOOGLE_MAPS_API_KEY });
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

function streetViewImageUrl(env, location) {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    location,
    key: env.GOOGLE_MAPS_API_KEY,
    return_error_code: "true",
  });
  return `${STREETVIEW_IMAGE_URL}?${qs}`;
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

// Orchestrates one Maps lookup. Exactly one of `coords` ("lat,lng" of an
// attached photo) or `address` (a parsed street address) drives it; `coords`
// wins when both are present. `wantImages` gates the (billed) imagery fetches
// — true only when the answer model can use them (vision) and the message
// isn't already carrying user images. Returns:
//   { block, details, images, count } when something resolved,
//   null when nothing did (or any failure) — the caller stays silent.
export async function runGoogleMapsLookup(env, log, { coords, address, wantImages }) {
  if (!googleMapsAvailable(env)) return null;

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
      displayQuery = place.name || place.address || address;
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

  const svMeta = await streetViewMetadata(env, log, imageryLocation);
  const svOk = svMeta?.status === "OK";

  // Nothing to show: an address Places couldn't resolve and with no Street
  // View coverage is a false-positive address — stay silent. A photo's coords
  // are always a valid map point, so they always produce at least a map.
  if (!coords && !place && !svOk) return null;

  const [streetViewImage, staticMapImage] = wantImages
    ? await Promise.all([
        svOk ? fetchImageDataUrl(env, log, streetViewImageUrl(env, imageryLocation), "googlemaps.streetview_image_error") : null,
        fetchImageDataUrl(env, log, staticMapUrl(env, imageryLocation), "googlemaps.staticmap_error"),
      ])
    : [null, null];

  const parts = {
    place,
    lat,
    lng,
    streetView: svOk ? { date: svMeta.date || "" } : null,
    streetViewImage,
    staticMapImage,
  };
  const block = buildMapsBlock(displayQuery, parts);
  const images = [streetViewImage, staticMapImage].filter(Boolean);

  const bits = [];
  if (place) bits.push(place.name || place.address || "place found");
  if (svOk) bits.push(`Street View${svMeta.date ? ` (${svMeta.date})` : ""}`);
  bits.push("road map");
  const details = [`${displayQuery} — ${bits.join(", ")}`];

  return { block, details, images, count: 1 };
}

// Convenience used by the pipeline: derive the lookup inputs from a
// conversation + any attached-photo coordinates. Prefers a precise photo
// coordinate over a parsed address; returns null when the message names no
// address and there is no photo location.
export function pickLookup(conversation, imageLocations) {
  const c = Array.isArray(imageLocations) ? imageLocations[0] : null;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { coords: `${c.lat},${c.lon}`, address: "" };
  }
  const address = extractPlace(textOf(lastUserMessage(conversation)?.content));
  return address ? { coords: "", address } : null;
}

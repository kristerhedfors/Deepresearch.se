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

import { textOf } from "./conversation.js";

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const STREETVIEW_META_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const STREETVIEW_IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const STATICMAP_URL = "https://maps.googleapis.com/maps/api/staticmap";
const TIMEOUT_MS = 6000;
const STREETVIEW_SIZE = "512x512"; // per frame; 4 frames + a map must fit Berget's ~1MB body
const STATICMAP_SIZE = "600x400"; // JPEG below — small enough to attach alongside Street View
const MAX_LOCATION_CHARS = 200;
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
// Filler / intent words that are never part of an address. Used to trim
// leading noise ("show street view of …") and to reject a bad trailing capture.
// Lowercase, accents included; localities like "kallhäll"/"järfälla" are NOT
// here, so a lowercase locality survives (the bug that sent bare
// "Maskinistvägen 11" to Google and resolved to the wrong city).
const STOPWORDS = new Set([
  // English intent/filler
  "show", "street", "streets", "view", "streetview", "google", "maps", "map", "of", "the", "a",
  "an", "at", "on", "for", "me", "my", "please", "pls", "can", "could", "would", "you", "we", "i",
  "what", "whats", "where", "which", "is", "are", "was", "were", "do", "does", "get", "give", "see",
  "look", "looks", "around", "find", "near", "in", "to", "from", "with", "and", "this", "that",
  "here", "there", "no", "not", "yes",
  // Swedish intent/filler
  "visa", "mig", "se", "titta", "vad", "finns", "det", "den", "här", "där", "ligger", "är", "och",
  "på", "pa", "vid", "gatuvy", "kan", "du", "jag", "vi", "var", "hur", "nej", "ja", "en", "ett",
]);

const normWord = (w) => (w || "").toLowerCase().replace(/[^\p{L}]/gu, "");

// A trailing locality after the street span. Case-INSENSITIVE (users type
// "in järfälla", "i kallhäll" lowercase): a connector (comma / in / i / på /
// vid / near) followed by up to two place words, OR a bare Capitalized proper
// noun ("… Kallhäll"). A trailing stopword the capture grabbed ("Alnö is") is
// trimmed off.
const CONNECTOR_LOCALITY_RE =
  /^\s*(?:,|\b(?:in|i|på|pa|vid|near|kommun)\b)\s*([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)/iu;
const BARE_CAP_LOCALITY_RE =
  /^\s+(\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)?)/u;

// Given a matched street span and the text right after it, append a trailing
// locality when one is present, so "Maskinistvägen 11 in järfälla" resolves as
// "Maskinistvägen 11, järfälla" rather than a bare, ambiguous street name.
function withTrailingLocality(street, rest) {
  const m = rest.match(CONNECTOR_LOCALITY_RE) || rest.match(BARE_CAP_LOCALITY_RE);
  if (!m || !m[1]) return street;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  while (words.length && STOPWORDS.has(normWord(words[words.length - 1]))) words.pop();
  const locality = words.join(" ");
  if (!locality || street.toLowerCase().includes(locality.toLowerCase())) return street;
  return `${street}, ${locality}`;
}

// Preceding place-name words right before a street token ("kallhäll
// maskinistvägen"), walking back over non-stopwords (case-insensitive) up to
// two words. Returns "" when the words before the street are all filler.
function leadingLocality(before) {
  const words = before.trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = words.length - 1; i >= 0 && kept.length < 2; i--) {
    const nw = normWord(words[i]);
    // Stop at filler or a token with no letters (a bare house number "5").
    if (!nw || STOPWORDS.has(nw)) break;
    kept.unshift(words[i]);
  }
  return kept.join(" ");
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
    const streetWord = normWord(words[streetIdx]);
    if (!SWEDISH_STREET_SUFFIX_RE.test(streetWord) && !ENGLISH_STREET_WORDS.has(streetWord)) continue;
    // The regex may have swept up filler words before the street name ("show
    // street view of kallhäll maskinistvägen 11"). Walk back over preceding
    // words that are NOT filler — a locality like "kallhäll" or "Main" is kept
    // (even lowercase), and filler ("of", "view") stops the walk.
    let start = streetIdx;
    while (start > 0 && !STOPWORDS.has(normWord(words[start - 1]))) start--;
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
    const lead = leadingLocality(raw.slice(0, hit.index));
    const street = (lead ? lead + " " : "") + hit[0].trim();
    const rest = raw.slice(hit.index + hit[0].length);
    return withTrailingLocality(street, rest).slice(0, MAX_LOCATION_CHARS);
  }
  return "";
}

function firstMatch(raw, re) {
  re.lastIndex = 0;
  return re.exec(raw);
}

// ---- follow-up reference gate (pure — exported for unit tests) --------------

// Does a message that names NO address refer back to previously discussed
// Street View imagery / the place being looked at? This is the deterministic
// gate for follow-up turns ("what color is the roof?", "vad är det för färg på
// taket?") — without it, a follow-up carries no address, no enrichment runs,
// and the model truthfully claims it has no knowledge of the image (the
// reported bug). Vocabulary: imagery words, building parts, and visual
// attributes in English and Swedish. Deliberately excludes generics like
// "see"/"there"/"look" alone (they'd re-trigger a billed lookup on ordinary
// follow-ups); "look like" is specific enough to keep. A false positive only
// costs one cached-able Maps lookup and a harmless context block; a false
// negative degrades to today's behavior — both fail-soft.
const FOLLOWUP_REFERENCE_RE = new RegExp(
  "\\b(?:" +
    // imagery / the view itself
    "street ?view|gatuvy|imager?y|images?|pictures?|photos?|panoramas?|" +
    "bild(?:en|er|erna)?|foto(?:t|n|na)?|" +
    // the building and its parts
    "buildings?|house[s]?|roof(?:s|top)?|fa[cç]ades?|windows?|doors?|garages?|" +
    "gardens?|yards?|fences?|balcon(?:y|ies)|entrances?|floors?|stor(?:ey|ies|eys)|chimneys?|" +
    "hus(?:et|en)?|byggnad(?:en|er|erna)?|tak(?:et|en)?|fasad(?:en|er|erna)?|" +
    "fönst(?:er|ret|ren|erna)|dörr(?:en|ar|arna)?|trädgård(?:en|ar|arna)?|" +
    "staket(?:et|en)?|balkong(?:en|er|erna)?|entré(?:n|er|erna)?|våning(?:en|ar|arna)?|skorsten(?:en|ar)?|" +
    // visual attributes / surroundings
    "colou?rs?|visible|surroundings?|neighbou?rhoods?|parked|" +
    "look(?:s|ed|ing)? like|across the street|opposite|" +
    "färg(?:en|er|erna)?|syns|omgivning(?:en|ar|arna)?|grann(?:e|en|ar|arna)|parkerad(?:e|a)?|" +
    "ser (?:det|den|huset|byggnaden|platsen) ut|mittemot|tvärs över gatan" +
    ")\\b",
  "iu",
);

export function referencesStreetView(text) {
  return FOLLOWUP_REFERENCE_RE.test(typeof text === "string" ? text : "");
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
  if (parts.description) {
    // A vision model already looked at the imagery for a non-vision answer
    // model — hand over its description so the answer can relay it.
    lines.push(`Visual description of the Street View imagery (auto-generated): ${parts.description}`);
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
  // The knob is on (this block only exists when it is). Stop the model from
  // wrongly telling the user to enable an already-enabled feature.
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
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

function streetViewImageUrl(env, location, heading) {
  const qs = new URLSearchParams({
    size: STREETVIEW_SIZE,
    location,
    heading: String(heading),
    fov: "90",
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

// Cross-request lookup cache, the exact pattern src/exa.js uses for searches:
// a follow-up turn is a SEPARATE /api/chat request, and the follow-up flow
// above (pickLookup's walk-back) re-looks-up the SAME location on every
// gated follow-up — without a cache each one re-bills Places + five imagery
// fetches at Google. Workers Cache API (caches.default): durable across
// requests in a colo, no binding needed, fail-soft in every branch. Short TTL
// only — enough to absorb a follow-up exchange, well inside Google's
// performance-caching allowance (Street View imagery itself changes on a
// timescale of years).
const LOOKUP_CACHE_TTL_S = 600;

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
  const cache = globalThis.caches?.default;
  const cacheKey = lookupCacheKey(coords || address, !!fetchImages);
  if (cache) {
    try {
      const hit = await cache.match(new Request(cacheKey));
      if (hit) {
        const payload = await hit.json();
        if (payload && typeof payload === "object") {
          log.info("googlemaps.cache_hit", { frames: payload.streetViewFrames?.length || 0 });
          return payload;
        }
      }
    } catch (err) {
      log.warn("googlemaps.cache_read_failed", { error: err?.message || String(err) });
    }
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
          fetchImageDataUrl(env, log, streetViewImageUrl(env, imageryLocation, h.deg), "googlemaps.streetview_image_error"),
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
  // there's coverage and a real point to center on).
  const embed = svOk && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

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
    streetView: svOk ? { date: svMeta.date || "" } : null,
    streetViewFrames,
    staticMapImage,
    embed,
    details,
    count: 1,
  };

  // Cache only successful lookups (the null early-returns above stay uncached
  // so a retry can still find something). A write failure never affects the
  // response.
  if (cache) {
    try {
      await cache.put(
        new Request(cacheKey),
        new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${LOOKUP_CACHE_TTL_S}`,
          },
        }),
      );
    } catch (err) {
      log.warn("googlemaps.cache_write_failed", { error: err?.message || String(err) });
    }
  }

  return result;
}

// Convenience used by the pipeline: derive the lookup inputs from a
// conversation + any attached-photo coordinates. Prefers a precise photo
// coordinate over an address parsed from the latest message. When the latest
// message names NOTHING but clearly refers back to the imagery/place
// (referencesStreetView above), the walk-back finds the most recent address an
// EARLIER user turn named — that's what lets a follow-up ("what color is the
// roof?") re-snap the current Street View imagery instead of the model
// claiming it has no knowledge of any image. The server is stateless and the
// prior turn's Maps block was appended server-side only, so the conversation
// text the client resends is the ONLY durable record — and the address in it
// is exactly that. Returns null when nothing names (or refers back to) a
// location; `followUp: true` marks a walked-back hit so the enrichment can
// label the block accordingly.
export function pickLookup(conversation, imageLocations) {
  const c = Array.isArray(imageLocations) ? imageLocations[0] : null;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { coords: `${c.lat},${c.lon}`, address: "" };
  }
  const users = Array.isArray(conversation) ? conversation.filter((m) => m?.role === "user") : [];
  const latest = textOf(users[users.length - 1]?.content);
  const address = extractPlace(latest);
  if (address) return { coords: "", address };
  if (!referencesStreetView(latest)) return null;
  for (let i = users.length - 2; i >= 0; i--) {
    const prior = extractPlace(textOf(users[i]?.content));
    if (prior) return { coords: "", address: prior, followUp: true };
  }
  return null;
}

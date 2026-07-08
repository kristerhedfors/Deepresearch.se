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
  "here", "there", "no", "not", "yes", "now", "today", "tomorrow", "thanks",
  // Swedish intent/filler
  "visa", "mig", "se", "titta", "vad", "finns", "det", "den", "här", "där", "ligger", "är", "och",
  "på", "pa", "vid", "gatuvy", "kan", "du", "jag", "vi", "var", "hur", "nej", "ja", "en", "ett",
  "nu", "idag", "imorgon", "tack",
]);

const normWord = (w) => (w || "").toLowerCase().replace(/[^\p{L}]/gu, "");

// A trailing locality after the street span. Case-INSENSITIVE (users type
// "in järfälla", "i kallhäll" lowercase): a connector (comma / in / i / på /
// vid / near) followed by up to two place words, OR a bare word pair with NO
// connector at all ("Streetview lidbecksgatan 10 hallstahammar" — the
// reported wrong-city bug: only a CAPITALIZED bare locality used to count, so
// a lowercase one was dropped, the bare street went to Google, and it
// resolved the wrong city while the user had named the right one explicitly).
// Bare words are kept only up to the first intent/filler stopword, so "look
// like", "ligger i centrum" etc. never read as localities.
const CONNECTOR_LOCALITY_RE =
  /^\s*(?:,|\b(?:in|i|på|pa|vid|near|kommun)\b)\s*([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)/iu;
const BARE_LOCALITY_RE =
  /^\s+([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)/u;

// Given a matched street span and the text right after it, append a trailing
// locality when one is present, so "Maskinistvägen 11 in järfälla" resolves as
// "Maskinistvägen 11, järfälla" rather than a bare, ambiguous street name.
function withTrailingLocality(street, rest) {
  const m = rest.match(CONNECTOR_LOCALITY_RE) || rest.match(BARE_LOCALITY_RE);
  if (!m || !m[1]) return street;
  const words = [];
  for (const w of m[1].trim().split(/\s+/)) {
    if (!w || STOPWORDS.has(normWord(w))) break;
    words.push(w);
  }
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
// NOTE: \b is ASCII-only in JS — it never fires next to å/ä/ö/é ("på?" has no
// \b after "å") — so the word boundaries are Unicode-aware lookarounds.
const FOLLOWUP_REFERENCE_RE = new RegExp(
  "(?<![\\p{L}\\p{M}])(?:" +
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
    "look(?:s|ed|ing)? (?:like|at)|across the street|opposite|" +
    "färg(?:en|er|erna)?|syns|omgivning(?:en|ar|arna)?|grann(?:e|en|ar|arna)|parkerad(?:e|a)?|" +
    "ser (?:det|den|huset|byggnaden|platsen) ut|mittemot|tvärs över gatan|" +
    // panorama-referring phrases ("what am I looking at?", after panning)
    "am i (?:seeing|looking)|in front of|this view|the view|" +
    "vy(?:n|er|erna)?|tittar (?:jag|vi|man) på|ser jag|framför (?:mig|oss)" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);

export function referencesStreetView(text) {
  return FOLLOWUP_REFERENCE_RE.test(typeof text === "string" ? text : "");
}

// The LOOSE gate for the live-panorama (POV) path: things a user pointing at
// a street scene asks about — people, vehicles, signage, shops, greenery —
// none of which the strict building-vocabulary gate above can cover
// (reported: "Describe the person" → the gate missed it → no capture → the
// model asked "what person?", while the person stood in the panorama on
// screen). Kept SEPARATE from the strict gate on purpose: a POV capture is
// one cheap, cached Static frame and the user demonstrably has the panorama
// open, so false positives cost little — the walk-back path (no POV) keeps
// the strict gate because it re-runs a full billed lookup.
const SCENE_REFERENCE_RE = new RegExp(
  "(?<![\\p{L}\\p{M}])(?:" +
    // people & animals
    "person|people|man|men|woman|women|child(?:ren)?|kids?|guys?|pedestrians?|someone|anyone|crowd|dogs?|cats?|" +
    "person(?:en|er|erna)?|människ(?:a|an|or|orna)|man(?:nen)?|män(?:nen)?|kvinn(?:a|an|or|orna)|barn(?:et|en)?|någon|folk|hund(?:en|ar)?|katt(?:en|er)?|" +
    // vehicles
    "vehicles?|vans?|trucks?|bus(?:es)?|bikes?|bicycles?|motorcycles?|scooters?|" +
    "fordon(?:et|en)?|bil(?:en|ar|arna)?|lastbil(?:en|ar)?|buss(?:en|ar|arna)?|cykel(?:n)?|cyklar(?:na)?|moped(?:en)?|" +
    // signage, businesses, street furniture, greenery
    "signs?|signage|shops?|stores?|storefronts?|business(?:es)?|restaurants?|caf[ée]s?|" +
    "trees?|statues?|graffiti|posters?|flags?|logos?|bench(?:es)?|" +
    "skylt(?:en|ar|arna)?|affär(?:en|er|erna)?|butik(?:en|er|erna)?|restaurang(?:en|er|erna)?|" +
    "träd(?:et|en)?|staty(?:n|er)?|flagg(?:a|an|or)|bänk(?:en|ar)?|" +
    // deictic questions about the scene
    "who is (?:that|this|he|she|there)|who's (?:that|this)|what does (?:it|the sign|that) say|" +
    "vem är (?:det|den|han|hon|där)|vad står det" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);

export function referencesStreetViewScene(text) {
  const t = typeof text === "string" ? text : "";
  return referencesStreetView(t) || SCENE_REFERENCE_RE.test(t);
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
  if (parts.framesShown) {
    lines.push("The captured frame is displayed to the user directly beside this reply, so you can refer to it as shared context.");
  }
  if (parts.description) {
    lines.push(`Visual description of the user's current view (auto-generated): ${parts.description}`);
  } else {
    lines.push("The frame could not be examined by a vision model this time — answer from the location data above and say plainly that the view itself couldn't be inspected.");
  }
  lines.push(
    "The user's question refers to what is visible in their current view — answer it directly from the visual description above; do NOT ask them to clarify who or what they mean (e.g. never ask which person/car/building — it is the one in their view).",
  );
  lines.push("Google Maps & Street View is already enabled — do NOT suggest the user enable it.");
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
  // A resolved location must never be re-asked (reported: the user wrote
  // "lidbecksgatan 10 hallstahammar" and still got "did you mean Lidköping
  // or Hallstahammar?" — a wasted turn beside already-fetched imagery).
  lines.push(
    "The location was already resolved as shown above — do NOT ask the user to confirm or disambiguate the location or city. Answer about the resolved location directly; if the user's message names a locality that differs from the resolved address, say so plainly instead of asking.",
  );
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
// image. A pano id (from the client's live panorama) takes precedence over
// the location string when given. Returns the parsed metadata (status "OK"
// means imagery exists) or null.
export async function streetViewMetadata(env, log, location, pano = "") {
  try {
    const qs = new URLSearchParams({ key: env.GOOGLE_MAPS_API_KEY });
    if (pano) qs.set("pano", pano);
    else qs.set("location", location);
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

  const cache = globalThis.caches?.default;
  const params = new URLSearchParams({
    p: pov.panoId || "",
    ll: `${pov.lat},${pov.lng}`,
    h: String(pov.heading),
    pt: String(pov.pitch),
    f: String(pov.fov),
  });
  const cacheKey = `https://googlemaps-pov-cache.internal/frame?${params.toString()}`;
  if (cache) {
    try {
      const hit = await cache.match(new Request(cacheKey));
      if (hit) {
        const payload = await hit.json();
        if (payload && typeof payload === "object" && payload.image) {
          log.info("googlemaps.pov_cache_hit", {});
          return payload;
        }
      }
    } catch (err) {
      log.warn("googlemaps.cache_read_failed", { error: err?.message || String(err) });
    }
  }

  const [meta, image] = await Promise.all([
    streetViewMetadata(env, log, `${pov.lat},${pov.lng}`, pov.panoId),
    fetchImageDataUrl(env, log, streetViewPovImageUrl(env, pov), "googlemaps.streetview_pov_error"),
  ]);
  if (!image) return null;

  const result = { image, date: meta?.status === "OK" ? meta.date || "" : "" };
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
// conversation + any attached-photo coordinates + the client's live panorama
// POV. Precedence, most specific first:
//   1. an attached photo's GPS coordinates,
//   2. an address the LATEST message names (a new location — the client's
//      panorama, if any, still shows the old one),
//   3. the user's CURRENT panorama view (body.street_view_pov) when the
//      message refers back to the imagery/place — capture exactly what they
//      panned/moved to,
//   4. the walk-back: the most recent address an EARLIER user turn named
//      (the panorama-less fallback — embed key missing or the Maps JS SDK
//      failed to load, where only the iframe rendered and no POV exists).
// 3 and 4 share the referencesStreetView gate: without a back-reference in
// the message, an ordinary follow-up must not re-bill Google. The server is
// stateless and the prior turn's Maps block was appended server-side only, so
// the resent conversation text (and the client-held POV) are the only durable
// records. Returns null when nothing names (or refers back to) a location;
// `followUp: true` / `pov` mark the shape so the enrichment labels the block.
export function pickLookup(conversation, imageLocations, pov = null) {
  const c = Array.isArray(imageLocations) ? imageLocations[0] : null;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { coords: `${c.lat},${c.lon}`, address: "" };
  }
  const users = Array.isArray(conversation) ? conversation.filter((m) => m?.role === "user") : [];
  const latest = textOf(users[users.length - 1]?.content);
  const address = extractPlace(latest);
  if (address) return { coords: "", address };
  // The POV path uses the LOOSE gate (people/vehicles/signs — anything one
  // asks pointing at a live street scene); the walk-back keeps the strict
  // imagery/building gate since it re-runs a full billed lookup.
  if (pov && referencesStreetViewScene(latest)) return { coords: "", address: "", pov, followUp: true };
  if (!referencesStreetView(latest)) return null;
  for (let i = users.length - 2; i >= 0; i--) {
    const prior = extractPlace(textOf(users[i]?.content));
    if (prior) return { coords: "", address: prior, followUp: true };
  }
  return null;
}

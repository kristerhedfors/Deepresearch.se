// The pure text side of the Google Maps integration — extracted from
// googlemaps.js so the deterministic language analysis (address/place
// extraction, street-view intent gates, locality corrections, and the
// lookup-input derivation pickLookup) lives apart from the REST clients and
// lookup orchestration it feeds. Everything here is pure and Node-testable
// (googlemaps.test.js), the same pure-core split the client applies
// (message-content.js out of stream.js).
//
// This is the privacy-critical layer: only the candidate these functions
// extract ever crosses the wire to Google, never the whole message — the
// same minimal-request posture shodan.js/geocode.js keep.

import { textOf } from "./conversation.js";

const MAX_LOCATION_CHARS = 200;

// ---- deterministic address extraction ---------------------------------------

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
  "mean", "meant", "instead", "rather",
  // Swedish intent/filler
  "visa", "mig", "se", "titta", "vad", "finns", "det", "den", "här", "där", "ligger", "är", "och",
  "på", "pa", "vid", "gatuvy", "kan", "du", "jag", "vi", "var", "hur", "nej", "ja", "en", "ett",
  "nu", "idag", "imorgon", "tack", "menade", "menar", "istället", "snarare",
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

// Cleans one ADDRESS_RE match into a street span, or "" when it isn't really
// an address: the word right before the house number must be a street word
// (morpheme/exact-word tests above), and the walk-back keeps preceding
// non-filler words — a locality like "kallhäll" or "Main" rides along (even
// lowercase) while intent filler ("of", "view") stops the walk. Shared by
// extractPlace (user messages) and addressesInText (assistant answers).
function streetSpanOf(matchText) {
  const words = matchText.trim().replace(/\s+/g, " ").split(" ");
  if (words.length < 2) return "";
  const streetIdx = words.length - 2;
  const streetWord = normWord(words[streetIdx]);
  if (!SWEDISH_STREET_SUFFIX_RE.test(streetWord) && !ENGLISH_STREET_WORDS.has(streetWord)) return "";
  let start = streetIdx;
  while (start > 0 && !STOPWORDS.has(normWord(words[start - 1]))) start--;
  return words.slice(start).join(" ");
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
// Only this candidate ever crosses the wire, never the whole message.
export function extractPlace(text) {
  const raw = typeof text === "string" ? text : "";

  // 1) Numbered street address (most specific).
  for (const m of raw.matchAll(ADDRESS_RE)) {
    const street = streetSpanOf(m[0]);
    if (!street) continue;
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

// ---- named-place street-view requests ---------------------------------------

// An EXPLICIT street-view ask, the precondition for the free-text place
// query below and for the honest unresolved note. Typo-tolerant: an
// enumerated set of common misspellings, not a loose pattern — reported
// verbatim 2026-07-08: "Streer view" missed the exact-match regex and the
// whole ask fell through to a clarify.
// Swedish gets the same breadth as English: the definite form ("gatuvyn"),
// the gatvy typo, and the synonym "gatubild(en)" (Swedish-language parity
// audit 2026-07-09).
const SV_WORDS =
  "(?:street|streer|stret|streat|steet|sreet|stere)\\s*(?:view|veiw|vew|wiev)|streetview|gatu?vy(?:n)?|gatubild(?:en)?";
const STREETVIEW_INTENT_RE = new RegExp(`\\b(?:${SV_WORDS})\\b`, "iu");
const STREETVIEW_INTENT_ALL_RE = new RegExp(`\\b(?:${SV_WORDS})\\b`, "giu");
export function streetViewIntent(text) {
  return STREETVIEW_INTENT_RE.test(typeof text === "string" ? text : "");
}

// A named-place street-view request ("Street view of LEGO offices in
// Copenhagen", "gatuvy Turning Torso i Malmö") carries no street address for
// extractPlace — but Places Text Search resolves free-text place names fine
// (reported verbatim 2026-07-08: the LEGO ask fired nothing, and the model
// invented "enable Google Maps in Settings" instructions at a user whose
// knob was ON). When the message EXPLICITLY asks for street view, everything
// after the intent/filler words becomes the Places query. Returns "" when
// there's no explicit ask, an actual address is present (extractPlace owns
// it), or nothing usable remains — a bare "street view" follow-up must keep
// walking back instead.
export function extractPlaceQuery(text) {
  const raw = typeof text === "string" ? text : "";
  if (!streetViewIntent(raw) || extractPlace(raw)) return "";
  const words = raw
    .replace(STREETVIEW_INTENT_ALL_RE, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Trim LEADING intent/filler only — interior connectors ("in Copenhagen")
  // belong to the place.
  let start = 0;
  while (start < words.length && STOPWORDS.has(normWord(words[start]))) start++;
  let q = words.slice(start).join(" ").replace(/[?!.]+$/u, "").trim();
  // Cut a trailing lowercase clause ("…Copenhagen, including a description
  // of the building") while keeping comma-joined proper localities
  // ("…1, København").
  q = q.replace(/,\s+\p{Ll}[\s\S]*$/u, "").trim();
  if (!q) return "";
  // Don't query bare filler ("street view of the area"): a single word must
  // at least look like a proper name.
  if (q.split(/\s+/).length < 2 && !/\p{Lu}/u.test(q)) return "";
  return q.slice(0, MAX_LOCATION_CHARS);
}

// ---- named-place visual questions (no street-view keyword, no address) -------

// A visual question about a NAMED PLACE — "There is a fast food restaurant in
// Uppsala, Sweden called ”Rosa Pantern”. What's the color of the building
// across the road from it?" (reported verbatim 2026-07-09, chat_logs #47) —
// carries no street address for extractPlace and no street-view keyword for
// extractPlaceQuery, so the whole ask fired nothing: no lookup, no honest
// unresolved note, and the model invented "enable Google Maps in Settings"
// instructions — the LEGO-offices failure class one layer further out.
// The extraction is deterministic and privacy-minimal (only the assembled
// place candidate crosses the wire, never the message): a NAME — quoted
// (”Rosa Pantern”, "rosapantern"), introduced by a naming cue ("called X",
// "som heter X"), or right after a place-type word ("restaurangen Rosa
// Pantern") — anchored by a place-type word or a capitalized locality
// ("in Uppsala", "i Malmö"). pickLookup fires it only when the message ALSO
// carries street-view/visual flavor (streetViewIntent or the strict
// referencesStreetView gate), so ordinary quoted titles ("the book called
// ”The Road”") never bill a lookup.

// Double-quote pairs only (typographic included — Swedish uses ”…”); single
// quotes/apostrophes live inside ordinary words ("I'm") and stay out.
const QUOTED_NAME_RE = /["“”„«»]([^"“”„«»]{2,60})["“”„«»]/gu;
const NAME_CUE_RE = /(?<![\p{L}\p{M}])(?:called|named|heter|kallas|kallad|kallat|vid namn)(?![\p{L}\p{M}])\s*/giu;
// Place-type words that mark the neighboring name as a PLACE name. Swedish
// gets the same breadth as English, definite forms included (parity rule).
const PLACE_TYPE_RE = new RegExp(
  "(?<![\\p{L}\\p{M}])(?:" +
    "restaurants?|diners?|caf[ée]s?|coffee ?shops?|bars?|pubs?|hotels?|hostels?|shops?|stores?|" +
    "supermarkets?|malls?|museums?|galler(?:y|ies)|schools?|universit(?:y|ies)|church(?:es)?|stations?|" +
    "kiosks?|pizzerias?|baker(?:y|ies)|gyms?|cinemas?|theatres?|theaters?|" +
    // Roadside/errand amenities (added with the nearby-place search,
    // 2026-07-09 — "Gas station near e18 there"): fuel, pharmacy, cash,
    // parking, care, groceries.
    "gas ?stations?|petrol ?stations?|fuel ?stations?|service ?stations?|pharmac(?:y|ies)|drugstores?|" +
    "atms?|banks?|grocer(?:y|ies)|grocery ?stores?|parking|hospitals?|clinics?|police ?stations?|" +
    "librar(?:y|ies)|bibliotek(?:et|en)?|" +
    "restaurang(?:en|er|erna)?|gatukök(?:et|en)?|kaf[ée](?:et|er)?|krog(?:en|ar|arna)?|hotell(?:et|en)?|" +
    "butik(?:en|er|erna)?|affär(?:en|er|erna)?|köpcentr(?:um|et)|museet|skol(?:a|an|or|orna)|" +
    "universitet(?:et)?|kyrk(?:a|an|or|orna)|kiosk(?:en|er)?|pizzeri(?:a|an|or)|" +
    "bageri(?:et|er)?|biograf(?:en|er)?|teater(?:n|rar)?|" +
    // The Swedish amenity parity set, definite/plural forms included; "mack"
    // is the everyday word for a gas station.
    "bensinstation(?:en|er|erna)?|bensinmack(?:en|ar)?|mack(?:en|ar|arna)?|tankställe(?:t|n)?|" +
    "apotek(?:et|en)?|bankomat(?:en|er|erna)?|uttagsautomat(?:en|er)?|parkering(?:en|ar|arna)?|" +
    "sjukhus(?:et|en)?|vårdcentral(?:en|er|erna)?|polisstation(?:en|er)?|" +
    "mataffär(?:en|er|erna)?|matbutik(?:en|er|erna)?|livsmedelsbutik(?:en|er|erna)?" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);
// A capitalized locality after a place connector ("in Uppsala", "i Malmö",
// "near Odenplan"). Deliberately NOT case-insensitive: with the i flag \p{Lu}
// would match lowercase too, and a lowercase capture would turn ordinary
// prose after "i"/"in" into a "locality". Bare "i" is lowercase-only — the
// English pronoun is always capital, the Swedish preposition practically
// always lowercase.
const PLACE_LOCALITY_RE =
  /(?<![\p{L}\p{M}])(?:[Ii]n|[Aa]t|[Pp]å|[Pp]a|[Vv]id|[Nn]ear|[Nn]ära|[Uu]tanför|[Oo]utside|i)\s+(\p{Lu}[\p{L}\p{M}'’.-]*(?:\s+\p{Lu}[\p{L}\p{M}'’.-]*)?)/gu;

// Walk forward over the words after a cue/type match, collecting the name:
// stops at intent/filler stopwords and at terminal punctuation (which ends a
// name like `”Rosa Pantern”.` cleanly), strips surrounding quotes/punctuation
// per word, keeps at most 4 words.
function walkNameWords(rest) {
  const out = [];
  for (const w of rest.trim().split(/\s+/)) {
    const core = w.replace(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, "");
    if (!core || STOPWORDS.has(normWord(core))) break;
    out.push(core);
    if (/[.,!?;:"”“»]$/u.test(w) || out.length >= 4) break;
  }
  const name = out.join(" ");
  return /\p{L}/u.test(name) && name.length >= 2 ? name : "";
}

function quotedNameOf(raw) {
  for (const m of raw.matchAll(QUOTED_NAME_RE)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 6) continue;
    const name = words.join(" ");
    if (!/\p{L}/u.test(name)) continue;
    if (words.every((w) => STOPWORDS.has(normWord(w)))) continue;
    return name;
  }
  return "";
}

function nameAfterMatch(raw, re) {
  re.lastIndex = 0;
  const m = re.exec(raw);
  if (!m) return "";
  return walkNameWords(raw.slice(m.index + m[0].length));
}

function placeLocalityOf(raw, name) {
  const n = (name || "").toLowerCase();
  for (const m of raw.matchAll(PLACE_LOCALITY_RE)) {
    const loc = (m[1] || "").trim();
    if (!loc) continue;
    const l = loc.toLowerCase();
    // "near Rosa Pantern" captures the name itself — that's not a locality.
    if (n.includes(l) || l.includes(n)) continue;
    if (STOPWORDS.has(normWord(loc.split(/\s+/)[0]))) continue;
    return loc;
  }
  return "";
}

// The Places query for a named-place mention, or "" when the message names no
// place. Requires an anchor (place-type word or locality) alongside the name
// so a quoted book/film title never reads as a place. The street-view/visual
// gate is applied by the caller (pickLookup), not here.
export function extractNamedPlaceQuery(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw || extractPlace(raw)) return "";
  const name = quotedNameOf(raw) || nameAfterMatch(raw, NAME_CUE_RE) || nameAfterMatch(raw, PLACE_TYPE_RE);
  if (!name) return "";
  const locality = placeLocalityOf(raw, name);
  if (!locality && !PLACE_TYPE_RE.test(raw)) return "";
  return (locality ? `${name}, ${locality}` : name).slice(0, MAX_LOCATION_CHARS);
}

// ---- nearby-place asks (Google Places search around the current position) ----

// Reported verbatim 2026-07-09: mid-panorama, "Gas station near e18 there"
// routed to the POV scene capture ("there" is a deictic in the loose gate),
// so the model LOOKED at the current frame instead of SEARCHING — the gas
// station wasn't in view and the answer denied. A place-TYPE word plus a
// NEARBY word is a search ask, not a look ask: with a live anchor it goes
// to Places Text Search biased around the current position (pickLookup's
// `nearby` shape → enrichment.js runNearbyPlaceEnrichment).
//
// "here"/"there" count as nearby words ONLY because the type word is also
// required — "street view here" (no type) keeps its here-jump, while "is
// there a pharmacy?" resolves the idiomatic "there" into the search it is.
const NEARBY_WORD_RE =
  /(?<![\p{L}\p{M}])(?:near(?:by|est)?|closest|close by|around here|here|there|närmaste|närmsta|nära|i närheten|häromkring|i området|runt här|här|där)(?![\p{L}\p{M}])/iu;
// Leading question filler stripped off the Places query ("is there a",
// "find me", "finns det någon", "var finns") — the remainder is what gets
// searched, and Places' text search handles natural phrasing fine.
const NEARBY_LEAD_RE =
  /^(?:(?:is|are)\s+there\s+(?:a|an|any)?|find(?:\s+me)?(?:\s+(?:a|an|any))?|show(?:\s+me)?(?:\s+(?:a|an|any))?|any|hitta|visa(?:\s+mig)?|finns\s+det\s+(?:någon|nagon|något|nagot|några|nagra)?|var\s+finns)\s*/iu;
// A trailing bare deictic ("… there", "… här") adds nothing to the query —
// the location bias carries the position.
const NEARBY_TRAIL_RE =
  /[\s,]*(?:right\s+)?(?:around\s+here|close\s+by|nearby|i\s+närheten|häromkring|härifrån|here|there|här|där)?[\s?!.]*$/iu;

// A SUPERLATIVE opener ("nearest coop", "närmaste willys") makes a short
// NAME a nearby search even without a place-TYPE word — reported verbatim
// 2026-07-09: "nearest coop"-shaped asks got clarifies because Coop is a
// brand, not a type. Typo forms included, matching the move/street-view
// convention.
const NEAREST_LEAD_RE = /^(?:the\s+)?(?:near[e]?st|neares|neardst|closest|närmaste|närmsta|narmaste|narmsta)(?![\p{L}\p{M}])/iu;

export function extractNearbyPlaceQuery(text) {
  const raw = (typeof text === "string" ? text : "").trim();
  if (!raw || raw.length > 120) return "";
  if (extractPlace(raw)) return ""; // a real address owns the message
  const asksNearby = NEARBY_WORD_RE.test(raw) || TELEPORT_VERB_RE.test(raw) || TRAVEL_TO_RE.test(raw) || NEAREST_LEAD_RE.test(raw);
  if (!asksNearby) return "";
  const q = raw.replace(TELEPORT_LEAD_RE, "").replace(NEARBY_LEAD_RE, "").replace(NEARBY_TRAIL_RE, "").trim();
  if (!q) return "";
  if (PLACE_TYPE_RE.test(raw)) {
    if (!PLACE_TYPE_RE.test(q)) return "";
    return q.slice(0, MAX_LOCATION_CHARS);
  }
  // No place-TYPE word: only the superlative + a short NAME qualifies
  // ("nearest coop") — the name must carry a non-stopword.
  const words = q.split(/\s+/).filter(Boolean);
  if (!NEAREST_LEAD_RE.test(q) || words.length < 2 || words.length > 4) return "";
  if (words.slice(1).every((w) => STOPWORDS.has(normWord(w)))) return "";
  return q.slice(0, MAX_LOCATION_CHARS);
}

// How the nearby ask wants to be ANSWERED — the user's explicitly refined
// semantics (2026-07-09): "teleport should just drop you there. If I say
// 'go to nearest …' then we do the actual travel with waypoints and map
// views."
//   "instant" — teleport/jump verbs: DROP at the destination, no travel
//               narrative, no route map, no series.
//   "travel"  — go/get/take-me/walk-to verbs: the actual travel — start
//               narrative, photo waypoints along the way, the route map.
//   "search"  — no relocation verb ("gas station near e18"): informational
//               — results + destination view + route map.
export function nearbyAskMode(text) {
  const t = typeof text === "string" ? text : "";
  if (TELEPORT_VERB_RE.test(t)) return "instant";
  if (TRAVEL_TO_RE.test(t)) return "travel";
  return "search";
}

// Initial bearing (degrees clockwise from north) from point 1 toward point
// 2 — equirectangular like movePoint/distanceMeters, exact enough for the
// ≤ a-few-km travel captures. Pure and exported for tests.
export function bearingDeg(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = lat2 - lat1;
  return Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360);
}

// ---- teleport & cross-barrier asks -------------------------------------------

// "jump"/"teleport" mean INSTANT relocation — the user's explicitly stated
// semantics (2026-07-09): "if I say 'jump' or 'teleport' I mean just
// relocate there, no path finding". Travel verbs ("get to", "ta mig till")
// carry the same relocation intent. Everything here is VIRTUAL panorama
// navigation — the blocks say so, because the reported failure was the
// model lecturing a panorama user to "never cross the tracks directly".
const TELEPORT_VERB_RE =
  /(?<![\p{L}\p{M}])(?:jump|teleport|beam(?:\s+(?:me|us))?|hoppa|teleportera)(?![\p{L}\p{M}])/iu;
const TRAVEL_TO_RE =
  /(?<![\p{L}\p{M}])(?:get|go|move|travel|walk|head|take\s+(?:me|us)|ta\s+(?:mig|oss)|gå|ga|åk|förflytta|forflytta)(?:\s+(?:me|us|mig|oss))?\s+(?:to|till|över|over|across)(?![\p{L}\p{M}])/iu;
// Strips the relocation verb phrase off a nearby-place query, so "teleport
// to the nearest gas station" searches for "nearest gas station". The
// word-boundary lookaheads matter: without them the diacritic-less Swedish
// verb "ga" ate the start of "Gas station…".
// The optional openers include "let's/lets" (and the reported adjacent-key
// typo "legs" — verbatim 2026-07-09: "Legs go to coop" got a clarify) and a
// bare "ok" ("Ok nearest gas station").
const TELEPORT_LEAD_RE =
  /^(?:(?:please|ok|okay|let'?s|lets|legs)\s+)?(?:jump|teleport|beam|hoppa|teleportera|get|go|move|travel|walk|head|take|ta|gå|ga|åk|förflytta|forflytta)(?![\p{L}\p{M}])(?:\s+(?:me|us|mig|oss)(?![\p{L}\p{M}]))?(?:\s+(?:to|till|över|over|across)(?![\p{L}\p{M}]))?\s*(?:(?:the|a|an|den|det|en|ett)\s+)?/iu;

// "The other side of the railway" — a barrier the user wants the panorama
// relocated across (reported verbatim 2026-07-09: "Get to the other side
// of the railway", twice, got a real-world safety lecture instead of a
// relocation). Diacritic-less Swedish rides along; the bare diacritic-less
// "spar"/"an" forms are excluded (ordinary words) — they need their
// definite suffix.
const BARRIER_WORDS =
  "railway|railroad|rail\\s*way|train\\s*tracks?|tracks?|rails|river|stream|canal|road|street|highway|motorway|freeway|bridge|" +
  "järnväg(?:en)?|jarnvag(?:en)?|(?:tåg)?spår(?:et|en)?|(?:tag)?spar(?:et|en)|älven|alven|ån|floden|kanalen|vägen|vagen|gatan|motorvägen|motorvagen|bron";
const OTHER_SIDE_RE = new RegExp(
  `(?:(?:other|far)\\s+side\\s+of|andra\\s+sidan(?:\\s+av)?)\\s+(?:the\\s+)?(${BARRIER_WORDS})(?![\\p{L}\\p{M}])`,
  "iu",
);
const ACROSS_BARRIER_RE = new RegExp(
  `(?:across|över|over)\\s+(?:the\\s+)?(${BARRIER_WORDS})(?![\\p{L}\\p{M}])`,
  "iu",
);

// ---- journey view ("show how we traveled") ------------------------------------

// Requested 2026-07-09: after a session of relocations, "Show how we
// traveled on maps" should draw the visited positions as a route — the
// model instead listed coordinates with a disclaimer that no travel trail
// exists. It does exist: every relocation answer carries the MANDATED
// keyless coordinate links, so the journey is recoverable from the
// conversation deterministically.
const JOURNEY_ASK_RE =
  /(?<![\p{L}\p{M}])(?:(?:show|draw|display|map|trace|plot|visa|rita|kartlägg|kartlagg)(?![\p{L}\p{M}])[\s\S]{0,40}?(?:how\s+(?:we|i)\s+(?:traveled|travelled|moved|went|got\s+here)|(?:our|my|the)\s+(?:route|path|journey|trail|trip|travels?|way\s+here)|hur\s+(?:vi|jag)\s+(?:åkte|akte|reste|rörde\s+(?:oss|mig)|rorde\s+(?:oss|mig)|tog\s+(?:oss|mig)|kom\s+hit|färdades|fardades)|(?:vår|var|min|hela)\s+(?:rutt(?:en)?|resa(?:n)?|färd(?:en)?|fard(?:en)?)|rutt(?:en)?|resan|färden|farden)|how\s+did\s+(?:we|i)\s+(?:travel|get\s+here)|hur\s+(?:åkte|akte|reste)\s+(?:vi|jag)|hur\s+kom\s+(?:vi|jag)\s+hit)(?![\p{L}\p{M}])/iu;
export function journeyAsk(text) {
  return JOURNEY_ASK_RE.test(typeof text === "string" ? text : "");
}

// The coordinates every Maps block MANDATES into the answers: the keyless
// Google links (query=LAT,LNG / viewpoint=LAT,LNG) and the embed reference
// lines ("panorama at LAT, LNG"). Assistant turns only — user text quoting
// a coordinate must not fabricate a stop.
const JOURNEY_COORD_RE =
  /(?:[?&]query=|viewpoint=|panorama at )(-?\d{1,2}\.\d{3,}),\s?(-?\d{1,3}\.\d{3,})/g;
// Consecutive stops closer than this are the same position (an answer's
// query= and viewpoint= links repeat the same point).
const JOURNEY_DEDUP_M = 20;
const JOURNEY_MAX_POINTS = 12;

// Walks the ASSISTANT turns in order and returns the journey's waypoints
// ([{lat,lng}...], oldest first, consecutive duplicates collapsed, capped
// to the most recent JOURNEY_MAX_POINTS). Pure and exported for tests.
export function extractJourneyPoints(conversation) {
  const points = [];
  for (const m of Array.isArray(conversation) ? conversation : []) {
    if (m?.role !== "assistant") continue;
    const text = textOf(m.content);
    for (const hit of text.matchAll(JOURNEY_COORD_RE)) {
      const lat = Number(hit[1]);
      const lng = Number(hit[2]);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) continue;
      const prev = points[points.length - 1];
      if (prev && distanceMeters(prev.lat, prev.lng, lat, lng) < JOURNEY_DEDUP_M) continue;
      points.push({ lat, lng });
    }
  }
  return points.slice(-JOURNEY_MAX_POINTS);
}

// Returns { barrier } for a cross-barrier relocation ask, else null. A
// relocation/travel verb makes any phrasing count; verb-less phrasings
// must be short commands ("other side of the tracks"), so prose that
// merely mentions a river's far side never fires.
export function extractCrossBarrierAsk(text) {
  const raw = (typeof text === "string" ? text : "").trim();
  if (!raw || raw.length > 120) return null;
  const m = raw.match(OTHER_SIDE_RE) || raw.match(ACROSS_BARRIER_RE);
  if (!m) return null;
  const hasVerb = TELEPORT_VERB_RE.test(raw) || TRAVEL_TO_RE.test(raw);
  if (!hasVerb && raw.split(/\s+/).length > 8) return null;
  return { barrier: m[1].toLowerCase().replace(/\s+/g, " ") };
}

// Meters between two coordinates — equirectangular, exact enough for the
// "≈X m away" labels in the nearby-places block (same approximation as
// movePoint). Pure and exported for tests + googlemaps.js.
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.round(Math.sqrt(x * x + y * y) * 6371000);
}

// ---- fragment answers to "which office?" ------------------------------------

// NUMBERED addresses anywhere in a text — used on ASSISTANT messages, whose
// research answers surface the addresses the user then refers back to
// ("Accenture has offices at Alströmergatan 12, Rådmansgatan 42, …" →
// user: "Alstromer"). Numbered-only on purpose: assistant prose mentions
// many bare street names; a street + house number is a high-precision
// candidate.
function addressesInText(text) {
  const raw = typeof text === "string" ? text : "";
  const out = [];
  for (const m of raw.matchAll(ADDRESS_RE)) {
    const street = streetSpanOf(m[0]);
    if (street) out.push(street);
  }
  return out;
}

// Diacritics-insensitive normalization so a user's quick "Alstromer" matches
// "Alströmergatan" (fragments are typed fast, without ö/ä/å).
const normForMatch = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

// Matches a short fragment the user typed (usually answering the model's own
// "which office?" clarify) against every address the CONVERSATION has
// surfaced — assistant research answers included, which the user-only
// walk-back can never see (reported verbatim 2026-07-08: assistant listed
// three Accenture offices, user answered "Alstromer", and the model just
// asked again). Returns the address only on a UNIQUE match; ambiguous or
// unknown fragments return "" so the clarify loop can continue honestly.
export function matchAddressFragment(conversation, fragment) {
  const frag = normForMatch((fragment || "").trim());
  if (frag.length < 4) return "";
  const msgs = Array.isArray(conversation) ? conversation : [];
  const candidates = [];
  const seen = new Set();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = textOf(msgs[i]?.content);
    const found = msgs[i]?.role === "assistant" ? addressesInText(t) : [extractPlace(t)].filter(Boolean);
    for (const a of found) {
      const key = normForMatch(a);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(a);
      }
    }
  }
  const hits = candidates.filter((a) => {
    const n = normForMatch(a);
    return n.startsWith(frag) || n.includes(" " + frag) || n.includes(frag);
  });
  return hits.length === 1 ? hits[0] : "";
}

// True when this conversation is street-view flavored: some earlier USER
// turn explicitly asked for it (typo-tolerant), so a bare fragment answer
// like "Alstromer" can be read as picking a location.
function conversationAsksStreetView(users) {
  return users.some((m) => streetViewIntent(textOf(m?.content)));
}

// ---- locality-correction extraction ------------------------------------------

// A correction turn names a CITY but no street ("I meant in hallstahammar!",
// "jag menade i hallstahammar", or just "i hallstahammar") — reported
// verbatim 2026-07-08: "lidbecksgatan 10" resolved to the wrong city, the
// user corrected with a city-only message, and every later lookup STILL
// walked back to the bare street and picked the wrong city again, because
// no single message carried street + corrected city together. pickLookup
// merges this fix onto the walked-back street. Cues are the STRONG
// correction words only (meant/instead/rather + Swedish) — weak cues like
// "not"/"actually" appear in ordinary questions and would turn arbitrary
// words into "localities".
const FIX_CUE_RE = /\b(?:meant|instead|rather|menade|menar|istället|snarare)\b/iu;
const FIX_AFTER_CUE_RE =
  /\b(?:meant|instead|rather|menade|menar|istället|snarare)\b[,!.]?\s*(?:\b(?:in|i|på|pa)\s+)?([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)/iu;
const FIX_AFTER_CONNECTOR_RE =
  /\b(?:in|i|på|pa)\s+([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)/iu;
// The WHOLE message is "in X" / "i X" (a bare one-line correction).
const FIX_BARE_MESSAGE_RE =
  /^\s*(?:in|i|på|pa)\s+([\p{L}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}][\p{L}\p{M}'’.-]*)?)[\s!.?]*$/iu;

export function extractLocalityFix(text) {
  const raw = typeof text === "string" ? text : "";
  // A message that names a full address needs no fix-merging — extractPlace
  // handles it outright.
  if (!raw || extractPlace(raw)) return "";
  let m = null;
  if (FIX_CUE_RE.test(raw)) {
    m = raw.match(FIX_AFTER_CUE_RE) || raw.match(FIX_AFTER_CONNECTOR_RE);
  } else {
    m = raw.match(FIX_BARE_MESSAGE_RE);
  }
  if (!m || !m[1]) return "";
  const words = [];
  for (const w of m[1].trim().split(/\s+/)) {
    if (!w || STOPWORDS.has(normWord(w))) break;
    words.push(w);
  }
  return words.join(" ");
}

// Merges a locality correction onto a walked-back street: the fix REPLACES
// any comma-appended locality the address already carried (it's a
// correction), and is a no-op when the address already names it.
function withLocalityFix(address, fix) {
  if (!fix) return address;
  if (address.toLowerCase().includes(fix.toLowerCase())) return address;
  return `${address.split(",")[0].trim()}, ${fix}`;
}

// ---- follow-up reference gate -------------------------------------------------

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
    "street ?view|gatuvy(?:n)?|gatubild(?:en)?|imager?y|images?|pictures?|photos?|panoramas?|" +
    "bild(?:en|er|erna)?|foto(?:t|n|na)?|" +
    // the building and its parts
    "buildings?|house[s]?|roof(?:s|top)?|fa[cç]ades?|windows?|doors?|garages?|" +
    "gardens?|yards?|fences?|balcon(?:y|ies)|entrances?|floors?|stor(?:ey|ies|eys)|chimneys?|" +
    "hus(?:et|en)?|byggnad(?:en|er|erna)?|tak(?:et|en)?|fasad(?:en|er|erna)?|" +
    "fönst(?:er|ret|ren|erna)|dörr(?:en|ar|arna)?|trädgård(?:en|ar|arna)?|" +
    "staket(?:et|en)?|balkong(?:en|er|erna)?|entré(?:n|er|erna)?|våning(?:en|ar|arna)?|skorsten(?:en|ar)?|" +
    // visual attributes / surroundings
    "colou?rs?|visible|surroundings?|neighbou?rhoods?|parked|" +
    "look(?:s|ed|ing)? (?:like|at)|across the (?:street|road)|opposite|" +
    "färg(?:en|er|erna)?|syns|omgivning(?:en|ar|arna)?|grann(?:e|en|ar|arna)|parkerad(?:e|a)?|" +
    "ser (?:det|den|huset|byggnaden|platsen) ut|mittemot|tvärs över gatan|" +
    // panorama-referring phrases ("what am I looking at?", after panning)
    "am i (?:seeing|looking)|in front of|this view|the view|" +
    "vy(?:n|er|erna)?|tittar (?:jag|vi|man) på|ser jag|framför (?:mig|oss)|" +
    // asking the ASSISTANT what it sees ("What do you see", "vad ser du" —
    // reported verbatim 2026-07-09: both got a no-image denial mid-panorama)
    "what (?:do|can|could) you see|vad ser (?:du|ni)|vad kan (?:du|ni) se" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);

export function referencesStreetView(text) {
  return FOLLOWUP_REFERENCE_RE.test(typeof text === "string" ? text : "");
}

// The LOOSE gate for the live-panorama (POV) path: anything a user says
// while pointing at a live street scene. Grown in two reported rounds —
// first scene CONTENTS the strict building gate can't cover ("Describe the
// person" → no capture → the model asked "what person?"), then, when the
// noun vocabulary kept leaking (Workers Logs 2026-07-08 ~13:22Z: 4 of 5
// panorama follow-ups fired nothing), the structural classes below: bare
// DEICTIC references ("what is that?", "is it open?", "vad är det där?"),
// POSITIONAL phrasing ("the building to the left", "across from me"), and
// VISUAL-ACT verbs ("describe", "read", "zoom", "beskriv", "läs"). Kept
// SEPARATE from the strict gate on purpose: a POV capture is one cheap,
// cached Static frame and the user demonstrably has the panorama open, so
// false positives cost little — the walk-back path (no POV) keeps the
// strict gate because it re-runs a full billed lookup.
const SCENE_REFERENCE_RE = new RegExp(
  "(?<![\\p{L}\\p{M}])(?:" +
    // people & animals
    "person|people|man|men|woman|women|child(?:ren)?|kids?|guys?|dudes?|folks?|gentleman|lady|pedestrians?|someone|anyone|crowd|dogs?|cats?|" +
    "person(?:en|er|erna)?|människ(?:a|an|or|orna)|man(?:nen)?|män(?:nen)?|kvinn(?:a|an|or|orna)|barn(?:et|en)?|någon|folk|hund(?:en|ar)?|katt(?:en|er)?|" +
    // person-deictic pronouns ("what is he wearing?", "vem är hon?")
    "he|she|him|her|han|hon|honom|henne|" +
    // vehicles
    "vehicles?|vans?|trucks?|bus(?:es)?|bikes?|bicycles?|motorcycles?|scooters?|" +
    "fordon(?:et|en)?|bil(?:en|ar|arna)?|lastbil(?:en|ar)?|buss(?:en|ar|arna)?|cykel(?:n)?|cyklar(?:na)?|moped(?:en)?|" +
    // signage, businesses, street furniture, greenery
    "signs?|signage|shops?|stores?|storefronts?|business(?:es)?|restaurants?|caf[ée]s?|" +
    "trees?|statues?|graffiti|posters?|flags?|logos?|bench(?:es)?|" +
    "skylt(?:en|ar|arna)?|affär(?:en|er|erna)?|butik(?:en|er|erna)?|restaurang(?:en|er|erna)?|" +
    "träd(?:et|en)?|staty(?:n|er)?|flagg(?:a|an|or)|bänk(?:en|ar)?|" +
    // bare deictic references — the user is pointing at the scene
    // ("The one in view" — reported verbatim — carries ONLY these signals)
    "that|this|it|these|those|there|views?|(?:the|that|this) ones?|" +
    "det|den|där|här|denna|detta|dessa|dom|vyn?|(?:den|det) här|" +
    // temporal continuations — the user moved the panorama and re-asks
    // ("And now" — reported verbatim 2026-07-09: it fired nothing, no
    // capture ran, and the model invented a scene; "what about now?",
    // "again?", "och nu?", "nu då?")
    "now|again|nu|igen|" +
    // positional phrasing within the view
    "left|right|behind|ahead|front|corner|opposite|across|next to|" +
    "vänster|höger|bakom|framför|hörn(?:et)?|mittemot|bredvid|" +
    // visual-act verbs
    "describe|read|zoom|identify|" +
    "beskriv(?:a)?|läs(?:a)?|zooma|identifiera|" +
    // asking the assistant what it sees, loose forms ("do you see the shop?",
    // "kan du se…?") — the full "what do you see"/"vad ser du" phrasings sit
    // in the strict gate so they work even without a live POV
    "(?:do|can|could) you see|are you seeing|ser (?:du|ni)|kan (?:du|ni) se|" +
    // question phrases about the scene
    "who is|who's|what does .{0,20} say|" +
    "vem är|vad står" +
    ")(?![\\p{L}\\p{M}])",
  "iu",
);

export function referencesStreetViewScene(text) {
  const t = typeof text === "string" ? text : "";
  return referencesStreetView(t) || SCENE_REFERENCE_RE.test(t);
}

// ---- street-view jumps: "street view here" & relative moves ------------------
// (requested 2026-07-09) With a live view on screen (interactive map or
// panorama), the user can pop open Street View at the position they're
// looking at ("street view here", "gatuvy här") or a computed one ("100
// meters along this road", "200 m norrut") — deterministic phrase parsing +
// flat-earth-at-this-scale destination math, no model in the loop.

// Compass words → bearing degrees (EN + SV incl. the "-ut" adverb forms).
// 8-point names FIRST: "northeast" must not read as "north" + junk.
// Diacritic-less Swedish variants (soderut, vasterut) ride along — users on
// non-Swedish keyboards type them routinely, the same reality the
// diacritics-insensitive address-fragment matching already handles. Bare
// "vast"/"ost" (English words / cheese) are deliberately NOT included —
// only the unambiguous -ut adverb and -er forms.
const COMPASS_WORDS = [
  ["north[- ]?east|nordost(?:ut)?|nordöst(?:ut)?", 45],
  ["south[- ]?east|sydost(?:ut)?|sydöst(?:ut)?", 135],
  ["south[- ]?west|sydväst(?:ut)?|sydvast(?:ut)?", 225],
  ["north[- ]?west|nordväst(?:ut)?|nordvast(?:ut)?", 315],
  ["north|norrut|norr", 0],
  ["south|söderut|söder|soderut|soder|syd", 180],
  ["east|österut|öster|osterut|oster|öst", 90],
  ["west|västerut|väster|vasterut|vaster|väst", 270],
];
const COMPASS_RES = COMPASS_WORDS.map(([words, bearing]) => ({
  re: new RegExp(`(?<![\\p{L}\\p{M}])(?:${words})(?![\\p{L}\\p{M}])`, "iu"),
  bearing,
}));

// A distance: "100 m", "100 meters", "0.5 km", "200 meter". Swedish "meter"
// is both singular and plural, so the EN forms cover it.
const DISTANCE_RE = /(\d+(?:[.,]\d+)?)\s*(km|kilomet(?:er|re)s?|m|met(?:er|re)s?|meter)\b/iu;
// Facing-relative words: "along this road", "down the street", "ahead",
// "framåt", "rakt fram", "längs vägen" — meaningful only from a panorama,
// whose heading says which way "along" IS. The forward word takes an
// enumerated misspelling set like the street-view word does (reported
// verbatim 2026-07-09: "Forwsrd 200m" mid-panorama fired nothing and the
// model asked for GPS coordinates one turn after a successful "Forward
// 100m"), plus diacritic-less Swedish (framat, langre fram, folj vagen).
const FORWARD_RE =
  /(?<![\p{L}\p{M}])(?:along|down|up)\s+(?:this|the|that|samma)?\s*(?:road|street|way)|(?<![\p{L}\p{M}])(?:ahead|ahed|forw[sa]rds?|fowards?|forwads?|forwrds?|further|onwards?|straight on|(?:längs|langs)\s+(?:den här\s+|denna\s+|samma\s+)?(?:vägen|gatan|vagen)|längre fram|langre fram|(?:följ|folj)\s+(?:vägen|gatan|vagen)|(?:uppför|nerför|nedför|uppfor|nerfor|nedfor)\s+(?:gatan|vägen|vagen)|framåt|framat|rakt fram|vidare)(?![\p{L}\p{M}])/iu;
const BACK_RE =
  /(?<![\p{L}\p{M}])(?:back(?:wards?)?|bakwards?|behind (?:me|us)|bakåt|bakat|tillbaka|tilbaka|tillbaks|backa)(?![\p{L}\p{M}])/iu;
// A movement/show verb — the anti-overfire requirement for bare compass
// moves ("the shop is 100 meters north of the station" while a map is open
// must NOT jump; "go 100 meters north" / a short bare "100 m north" must).
// Diacritic-less Swedish forms included (ga, fortsatt, oppna) — safe here
// because the verb only ever fires alongside a matched distance + compass.
const MOVE_VERB_RE =
  /(?<![\p{L}\p{M}])(?:go|move|walk|continue|head|jump|take me|show|open|pop|gå|ga|fortsätt|fortsatt|hoppa|ta mig|visa|öppna|oppna|flytta|förflytta|forflytta|promenera)(?![\p{L}\p{M}])/iu;

const clampMeters = (n) => Math.max(5, Math.min(3000, Math.round(n)));

// Parses a relative move out of the message: distance + direction. Returns
// null, or { meters, mode: "bearing"|"forward"|"back", bearing?, dir } where
// `dir` is the normalized word for block phrasing ("north", "forward"…).
export function extractRelativeMove(text) {
  const t = typeof text === "string" ? text : "";
  if (!t) return null;
  const dm = t.match(DISTANCE_RE);
  if (!dm) return null;
  let meters = Number(dm[1].replace(",", "."));
  if (!Number.isFinite(meters) || meters <= 0) return null;
  if (/^k/i.test(dm[2])) meters *= 1000;
  meters = clampMeters(meters);
  // Facing-relative first: "100 meters along this road" is inherently about
  // the view on screen, no extra verb needed.
  if (FORWARD_RE.test(t)) return { meters, mode: "forward", dir: "forward" };
  if (BACK_RE.test(t)) return { meters, mode: "back", dir: "back" };
  const compass = COMPASS_RES.find((c) => c.re.test(t));
  if (!compass) return null;
  // A bare compass distance fires only as a command (a move verb) or as a
  // short standalone message ("100 m norrut") — prose that merely MENTIONS
  // a distance ("the shop is 100 meters north of the station") stays out.
  if (!MOVE_VERB_RE.test(t) && t.trim().split(/\s+/).length > 6) return null;
  const dirWord = COMPASS_WORDS[COMPASS_RES.indexOf(compass)][0].split("|")[0].replace(/\[- \]\?/g, "");
  return { meters, mode: "bearing", bearing: compass.bearing, dir: dirWord };
}

// "Street view HERE": an explicit street-view ask pointing at the current
// position ("street view here", "popup street view at my current location",
// "gatuvy här", "öppna gatuvy där jag är") — no address, no place name.
const HERE_RE =
  /(?<![\p{L}\p{M}])(?:here|right here|current (?:location|position|spot|view)|this (?:location|position|spot|point)|my (?:actual |real |physical |current |own )?(?:location|position)|där jag (?:faktiskt |egentligen )?är|var jag är|min (?:nuvarande |faktiska |riktiga |verkliga |fysiska )?(?:position|plats)|nuvarande (?:plats|läge)|denna plats|den här platsen|härifrån|här)(?![\p{L}\p{M}])/iu;
export function streetViewHereIntent(text) {
  const t = typeof text === "string" ? text : "";
  return streetViewIntent(t) && HERE_RE.test(t);
}

// "WHERE AM I" — a plain ask about the user's own position, no street-view
// word at all (reported verbatim 2026-07-09: "Where am i now" → "Street
// view" → "My location" got three denials — every gate wanted street-view
// word + here-word in ONE message, and a bare where-am-I ask had no gate at
// all). It IS a here-ask: anchor to the device location (or live view) and
// open the view/map that answers it. Enumerated forms with an EN typo set
// and Swedish at the same breadth (invariant 6). The lookahead requires the
// phrase to end the clause (allowing a short decoration word — "now", "nu",
// "exactly" — then punctuation/end), so prose like "where are we going with
// this" or "var är vi på väg" never fires.
const WHERE_AM_I_RE =
  /(?<![\p{L}\p{M}])(?:(?:where|wher|were|whree?)\s+(?:exactly\s+)?(?:am\s+i|are\s+we)|va(?:r|rt)\s+(?:exakt\s+)?(?:är|e)\s+(?:jag|vi)|var\s+n[åa]gonstans\s+(?:är|e)\s+(?:jag|vi)|var\s+befinner\s+(?:jag\s+mig|vi\s+oss))(?=\s*(?:right\s+now|just\s+nu|now|exactly|currently|located|somewhere|nu|egentligen|n[åa]gonstans)?\s*(?:[?!.,]|$))/iu;
export function whereAmIIntent(text) {
  return WHERE_AM_I_RE.test(typeof text === "string" ? text : "");
}

// A short HERE-answer to the assistant's own "which address or place?"
// clarify ("My location", "här", "min plats") — the street-view word lives
// in an EARLIER user turn, so streetViewHereIntent can't see it (same
// 2026-07-09 report: "Street view" → clarify → "My location" fired nothing
// and the model invented enable-in-Settings steps at a knob-ON user).
// Deliberately tight — the fragment must be essentially nothing BUT a
// here-phrase, so a longer sentence merely containing "here" can't
// re-anchor the conversation to the device.
export function hereFragmentAnswer(text) {
  const t = (typeof text === "string" ? text : "").trim();
  if (!t || t.length > 48 || t.split(/\s+/).length > 4) return false;
  return HERE_RE.test(t);
}

// An EXPLICIT reference to the user's PHYSICAL location ("my actual
// location", "where I actually am", "min faktiska plats", "där jag
// faktiskt är"). Requested 2026-07-09: once a live panorama/map exists,
// follow-ups anchor to IT — moving around the map must not snap back to
// the device — so the device location only wins the anchor again when the
// user says they mean their real position, not the view they've navigated
// to. This gate is that say-so; it also makes the client re-request the
// device location even while a live view exists (message-content.js
// mirrors it).
const PHYSICAL_LOCATION_RE =
  /(?<![\p{L}\p{M}])(?:my (?:actual|real|physical|true|own) (?:location|position)|where i (?:actually|really) am|min (?:faktiska|riktiga|verkliga|fysiska|egna) (?:plats|position)|där jag (?:faktiskt|egentligen) är|var jag faktiskt är)(?![\p{L}\p{M}])/iu;
export function physicalLocationAsk(text) {
  return PHYSICAL_LOCATION_RE.test(typeof text === "string" ? text : "");
}

// The full here-ask decision for the latest turn: an explicit street-view-
// here ask, a plain where-am-I ask, an explicit physical-location ask, or
// a here-fragment answering an earlier street-view turn. Shared by
// pickLookup's jump gate and — via the exported conversation-level wrapper
// below — enrichment.js, which phrases the unresolved note as "allow
// location access" instead of "which address?" when the device location
// never arrived.
function isHereAsk(latest, users) {
  return (
    streetViewHereIntent(latest) ||
    whereAmIIntent(latest) ||
    physicalLocationAsk(latest) ||
    (conversationAsksStreetView(users) && hereFragmentAnswer(latest))
  );
}

/** True when the conversation's latest user turn is a here-ask (see above). */
export function hereAskIntent(conversation) {
  const users = Array.isArray(conversation) ? conversation.filter((m) => m?.role === "user") : [];
  return isHereAsk(textOf(users[users.length - 1]?.content), users);
}

// Destination of a move from (lat, lng) `meters` toward `bearingDeg`.
// Equirectangular approximation — exact enough for the ≤3km moves the
// parser allows (centimeter error at this scale), rounded to ~10cm so
// repeated identical asks hit the server's capture cache.
export function movePoint(lat, lng, bearingDeg, meters) {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / 111320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const dLng = (meters * Math.sin(rad)) / (111320 * (Math.abs(cosLat) > 1e-9 ? cosLat : 1e-9));
  return {
    lat: Math.round((lat + dLat) * 1e6) / 1e6,
    lng: Math.round((lng + dLng) * 1e6) / 1e6,
  };
}

// ---- lookup-input derivation --------------------------------------------------

// Used by the pipeline's Maps enrichment: derive the lookup inputs from a
// conversation + any attached-photo coordinates + the client's live panorama
// POV. Precedence, most specific first:
//   1. an attached photo's GPS coordinates,
//   2. an address the LATEST message names (a new location — the client's
//      panorama, if any, still shows the old one),
//   3. the user's CURRENT panorama view (body.street_view_pov) when the
//      message refers back to the imagery/place — capture exactly what they
//      panned/moved to,
//   4. the user's CURRENT interactive-map view (body.map_view) under the
//      same gate — the road-map sibling of 3, live when a location resolved
//      WITHOUT Street View coverage and a map embed rendered instead (the
//      client keeps exactly one of POV/map view live at a time, so 3 and 4
//      never really compete),
//   5. the walk-back: the most recent address an EARLIER user turn named
//      (the embed-less fallback — embed key missing or the Maps JS SDK
//      failed to load, where only the iframe rendered and no view exists).
// 3-5 share the referencesStreetView gate: without a back-reference in
// the message, an ordinary follow-up must not re-bill Google. The server is
// stateless and the prior turn's Maps block was appended server-side only, so
// the resent conversation text (and the client-held view) are the only durable
// records. Returns null when nothing names (or refers back to) a location;
// `followUp: true` / `pov` / `mapView` / `jump` / `nearby` / `crossBarrier`
// mark the shape so the enrichment labels the block.
// Between 2 and 3 sit the JUMPS (requested 2026-07-09): "street view here"
// and relative moves ("100 meters along this road", "gå 200 m norrut"),
// anchored to the live panorama (position + heading), else the live map
// (center), else the device's reported location (`body.user_location`,
// sent by the client only for here-asks — "street view here", a plain
// "where am I?", or a short here-fragment answering an earlier street-view
// turn; the client prefilter in message-content.js mirrors isHereAsk) —
// checked BEFORE the free-text place query so "street view at my current
// location" is never sent to Places as a literal place name.
// ---- relocation-to-a-NAME asks + the pending-relocation memory ---------------

// "Go to hemköp" / "teleport to willys": a relocation verb aimed at an
// arbitrary NAME (a brand, a shop — no place-TYPE word, no address).
// Reported verbatim 2026-07-09: "Go to hemköp" mid-journey fell straight
// into the web-research pipeline (sources, comparison tables, and another
// "I cannot physically move you"). The message must BEGIN with the
// relocation verb phrase (TELEPORT_LEAD_RE is ^-anchored — prose like
// "when I go to the shop…" never fires) and the remainder must be a short
// plausible name; a small idiom set ("go to sleep", "gå till jobbet")
// stays out. Returns { query, mode } or null. Place-TYPE asks ("go to
// nearest gas station") are matched earlier by the nearby gate.
const RELOCATION_JUNK = new Set([
  "sleep", "bed", "work", "hell", "heaven", "home", "town", "toilet", "bathroom",
  "sängs", "sangs", "jobbet", "hem", "helvetet", "stan", "toaletten", "badrummet",
]);
export function extractRelocationQuery(text) {
  const raw = (typeof text === "string" ? text : "").trim();
  if (!raw || raw.length > 80) return null;
  if (extractPlace(raw)) return null; // a real address owns the message
  if (!TELEPORT_VERB_RE.test(raw) && !TRAVEL_TO_RE.test(raw)) return null;
  const stripped = raw.replace(TELEPORT_LEAD_RE, "");
  if (stripped === raw) return null; // the message must START with the verb phrase
  const q = stripped.replace(NEARBY_TRAIL_RE, "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!q || words.length > 4) return null;
  if (HERE_RE.test(q) || WHERE_AM_I_RE.test(q)) return null; // here-asks own these
  if (words.some((w) => RELOCATION_JUNK.has(normWord(w)))) return null;
  if (words.every((w) => STOPWORDS.has(normWord(w)))) return null;
  return { query: q.slice(0, MAX_LOCATION_CHARS), mode: nearbyAskMode(raw) };
}

// The conversation's UNFINISHED relocation — "remember we were going
// there, in the process of figuring it out" (same report: after "Go to
// hemköp" listed two stores, the pick "Stäket" fell into web research).
// Deterministically recovered from the transcript, newest first, within
// the last few user turns: a relocation-to-name ask or a nearby-place ask.
// Pure and exported for tests.
const PENDING_RELOCATION_WINDOW = 6;
export function pendingRelocation(users) {
  const list = Array.isArray(users) ? users : [];
  const stop = Math.max(0, list.length - 1 - PENDING_RELOCATION_WINDOW);
  for (let i = list.length - 2; i >= stop; i--) {
    const t = textOf(list[i]?.content);
    const reloc = extractRelocationQuery(t);
    if (reloc) return reloc;
    const nearbyQuery = extractNearbyPlaceQuery(t);
    if (nearbyQuery) return { query: nearbyQuery, mode: nearbyAskMode(t) };
  }
  return null;
}

// ---- route polylines ------------------------------------------------------------

// Google's encoded-polyline algorithm (5-decimal precision) → [{lat,lng}].
// The Routes API returns the actual road path this way; the travel mode
// samples its Street View waypoints along it, so "go to X" really walks the
// route instead of cutting straight across terrain (reported 2026-07-09:
// travel answers looked "just like teleport" — no waypoints in between).
// Malformed input degrades to the points decoded so far. Pure — tested
// against Google's reference example.
export function decodePolyline(encoded) {
  const s = typeof encoded === "string" ? encoded : "";
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < s.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = s.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = s.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

// Intermediate sample points along a polyline, one every ~everyM meters
// (endpoints excluded — the caller owns start and destination), capped.
// The travel mode's step-by-step Street View waypoints come from this. Pure.
export function samplePolyline(points, everyM = 400, maxSamples = 4) {
  const pts = Array.isArray(points) ? points : [];
  const out = [];
  let acc = 0;
  for (let i = 1; i < pts.length - 1 && out.length < maxSamples; i++) {
    acc += distanceMeters(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    if (acc >= everyM) {
      out.push({ lat: pts[i].lat, lng: pts[i].lng });
      acc = 0;
    }
  }
  return out;
}

// ---- the lookup-intent registry -----------------------------------------------
// pickLookup used to be one long if-chain; every reported miss this far has
// been "a new ask shape fell through it". It is now an ORDERED REGISTRY of
// small named matchers over one shared context — adding an ask shape is one
// matcher function + one line in the list, and the precedence is readable
// top to bottom. Each matcher returns a target (the shapes documented on
// pickLookup) or null; the first match wins.
//
// The shared context:
//   latest / trimmed — the newest user turn's text
//   users / conversation — for cross-turn matchers
//   pov / mapView / userLocation — the raw live-view inputs
//   anchor — the resolved current position (see matchers using it):
//            physical-location asks flip to the device; else panorama
//            (has heading) → map center → device location
//   latestFix — a locality correction in the latest turn, shared by the
//            fragment/scene/walk-back matchers

function buildLookupCtx(conversation, imageLocations, pov, mapView, userLocation) {
  const users = Array.isArray(conversation) ? conversation.filter((m) => m?.role === "user") : [];
  const latest = textOf(users[users.length - 1]?.content);
  const anchor =
    physicalLocationAsk(latest) && userLocation
      ? { lat: userLocation.lat, lng: userLocation.lng, heading: 0, hasHeading: false }
      : pov
        ? { lat: pov.lat, lng: pov.lng, heading: pov.heading, hasHeading: true }
        : mapView
          ? { lat: mapView.lat, lng: mapView.lng, heading: 0, hasHeading: false }
          : userLocation
            ? { lat: userLocation.lat, lng: userLocation.lng, heading: 0, hasHeading: false }
            : null;
  return {
    conversation,
    users,
    latest,
    trimmed: latest.trim(),
    imageLocations,
    pov,
    mapView,
    userLocation,
    anchor,
    latestFix: extractLocalityFix(latest),
  };
}

// An attached photo's GPS coordinates are the most specific input of all.
function matchPhotoCoords(ctx) {
  const c = Array.isArray(ctx.imageLocations) ? ctx.imageLocations[0] : null;
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
    return { coords: `${c.lat},${c.lon}`, address: "" };
  }
  return null;
}

// An address the LATEST message names — a new location beats everything
// the conversation was doing before.
function matchNewAddress(ctx) {
  const address = extractPlace(ctx.latest);
  return address ? { coords: "", address } : null;
}

// "Show how we traveled" — the journey view. Needs no anchor: the
// waypoints come from the mandated coordinate links in the ASSISTANT
// turns, so this works even after the live view was closed. Fewer than
// two distinct stops → nothing to draw, fall through.
function matchJourney(ctx) {
  if (!journeyAsk(ctx.latest)) return null;
  const points = extractJourneyPoints(ctx.conversation);
  if (points.length < 2) return null;
  return { coords: "", address: "", journey: { points }, followUp: true };
}

// A relative move ("100 meters along this road", "gå 200 m norrut").
// Facing-relative moves ("along this road", "back") need a heading — only
// the panorama has one; a map/device anchor takes compass moves.
function matchRelativeMove(ctx) {
  if (!ctx.anchor) return null;
  const move = extractRelativeMove(ctx.latest);
  if (!move || (move.mode !== "bearing" && !ctx.anchor.hasHeading)) return null;
  const bearing =
    move.mode === "bearing" ? move.bearing : move.mode === "back" ? (ctx.anchor.heading + 180) % 360 : ctx.anchor.heading;
  const dest = movePoint(ctx.anchor.lat, ctx.anchor.lng, bearing, move.meters);
  return {
    coords: "",
    address: "",
    jump: { lat: dest.lat, lng: dest.lng, heading: bearing, meters: move.meters, dir: move.dir },
    followUp: true,
  };
}

// A CROSS-BARRIER relocation ("Get to the other side of the railway",
// "hoppa över spåret"): the enrichment probes free Street View metadata
// along the travel bearing for a coverage GAP (the barrier corridor)
// followed by renewed coverage (the other side) and relocates there, with
// a photo series of the virtual crossing.
function matchCrossBarrier(ctx) {
  if (!ctx.anchor) return null;
  const ask = extractCrossBarrierAsk(ctx.latest);
  if (!ask) return null;
  return {
    coords: "",
    address: "",
    crossBarrier: {
      barrier: ask.barrier,
      lat: ctx.anchor.lat,
      lng: ctx.anchor.lng,
      heading: ctx.anchor.heading,
      hasHeading: ctx.anchor.hasHeading,
    },
    followUp: true,
  };
}

// A NEARBY-place ask (place-TYPE word + nearby/relocation word) searches
// Places around the anchor — BEFORE the here-ask so "gas station here"
// searches rather than jumping, and before the POV scene gate so the
// deictic "there" can't demote a search ask into a frame capture.
function matchNearbyPlace(ctx) {
  if (!ctx.anchor) return null;
  const query = extractNearbyPlaceQuery(ctx.latest);
  if (!query) return null;
  return {
    coords: "",
    address: "",
    nearby: { query, lat: ctx.anchor.lat, lng: ctx.anchor.lng, mode: nearbyAskMode(ctx.latest) },
    followUp: true,
  };
}

// A relocation verb aimed at an arbitrary NAME ("Go to hemköp") — same
// nearby target shape, so the whole Places/travel machinery serves it.
function matchRelocationToName(ctx) {
  if (!ctx.anchor) return null;
  const ask = extractRelocationQuery(ctx.latest);
  if (!ask) return null;
  return {
    coords: "",
    address: "",
    nearby: { query: ask.query, lat: ctx.anchor.lat, lng: ctx.anchor.lng, mode: ask.mode },
    followUp: true,
  };
}

// "Go there" (and the reported adjacent-key typo "Co there") resumes the
// conversation's PENDING relocation — verbatim 2026-07-09: "Go there"
// after failed "go to coop" asks got "What specific information are you
// seeking about 'Go there'?". Always travel mode: the user said go.
const GO_THERE_RE =
  /^(?:(?:please|ok|okay|let'?s|lets|legs)\s+)?(?:go|co|gå|ga|take\s+(?:me|us)|ta\s+(?:mig|oss))\s+(?:there|dit)\s*[?!.]*$/iu;
function matchGoThereResume(ctx) {
  if (!ctx.anchor || !GO_THERE_RE.test(ctx.trimmed)) return null;
  const pending = pendingRelocation(ctx.users);
  if (!pending) return null;
  return {
    coords: "",
    address: "",
    nearby: { query: pending.query, lat: ctx.anchor.lat, lng: ctx.anchor.lng, mode: "travel" },
    followUp: true,
  };
}

// A here-ask ("street view here", "where am I?", a here-fragment after a
// street-view turn): pop the view at the anchor.
function matchHereAsk(ctx) {
  if (!ctx.anchor || !isHereAsk(ctx.latest, ctx.users)) return null;
  return {
    coords: "",
    address: "",
    jump: { lat: ctx.anchor.lat, lng: ctx.anchor.lng, heading: ctx.anchor.heading, meters: 0, dir: "here" },
    followUp: true,
  };
}

// An explicit street-view ask naming a PLACE rather than an address
// ("Street view of LEGO offices in Copenhagen") — Places resolves the
// free-text name. A new named place outranks corrections/POV/walk-back,
// exactly like a new address does.
function matchPlaceQuery(ctx) {
  const placeQuery = extractPlaceQuery(ctx.latest);
  return placeQuery ? { coords: "", address: placeQuery } : null;
}

// A VISUAL question about a NAMED place with no address and no street-view
// keyword ("what's the color of the building across the road from ”Rosa
// Pantern” in Uppsala?" — chat_logs #47): the name+anchor extraction is
// deterministic; the street-view flavor comes from the same strict gate the
// walk-back uses (plus the explicit-intent one), so an ordinary research
// question mentioning a restaurant never bills a lookup.
function matchNamedPlace(ctx) {
  const namedPlace = extractNamedPlaceQuery(ctx.latest);
  if (!namedPlace || !(streetViewIntent(ctx.latest) || referencesStreetView(ctx.latest))) return null;
  return { coords: "", address: namedPlace };
}

// A short fragment answering the model's own "which office?" clarify
// ("Alstromer" after the assistant listed three Accenture addresses):
// matched — diacritics-insensitively — against addresses the whole
// conversation has surfaced, assistant research answers included.
function matchAddressFragmentAnswer(ctx) {
  if (!conversationAsksStreetView(ctx.users)) return null;
  const t = ctx.trimmed;
  if (!t || t.length > 40 || t.split(/\s+/).length > 3) return null;
  const picked = matchAddressFragment(ctx.conversation, t);
  return picked ? { coords: "", address: picked, followUp: true } : null;
}

// A short fragment resolving the conversation's UNFINISHED relocation
// ("Go to hemköp" → two stores listed → "Stäket"): the pending ask's query
// and the fragment combine into one Places search ("hemköp Stäket"),
// inheriting the pending mode — so the travel the user started two turns
// ago completes instead of falling into web research.
function matchRelocationFragmentAnswer(ctx) {
  if (!ctx.anchor) return null;
  const t = ctx.trimmed;
  if (!t || t.length > 40 || t.split(/\s+/).length > 3) return null;
  const words = t.split(/\s+/);
  if (words.every((w) => STOPWORDS.has(normWord(w)))) return null;
  const pending = pendingRelocation(ctx.users);
  if (!pending) return null;
  return {
    coords: "",
    address: "",
    nearby: { query: `${pending.query} ${t}`.slice(0, MAX_LOCATION_CHARS), lat: ctx.anchor.lat, lng: ctx.anchor.lng, mode: pending.mode },
    followUp: true,
  };
}

// The POV path uses the LOOSE gate (people/vehicles/signs — anything one
// asks pointing at a live street scene); the walk-back keeps the strict
// imagery/building gate since it re-runs a full billed lookup. A locality
// correction outranks the POV — the on-screen panorama shows the WRONG
// place by definition.
function matchPovScene(ctx) {
  if (!ctx.pov || ctx.latestFix || !referencesStreetViewScene(ctx.latest)) return null;
  return { coords: "", address: "", pov: ctx.pov, followUp: true };
}

// The live interactive MAP gets the same loose gate: "what's that big
// building?", "vad är det där?", "and now" while panning the map must
// capture the area on screen, not walk back to a stale address.
function matchMapScene(ctx) {
  if (!ctx.mapView || ctx.latestFix || !referencesStreetViewScene(ctx.latest)) return null;
  return { coords: "", address: "", mapView: ctx.mapView, followUp: true };
}

// The walk-back: the most recent address an EARLIER user turn named, with
// locality corrections encountered on the way riding along — and, when the
// user's own turns name nothing, the assistant's research answers, but
// ONLY when they surfaced exactly one distinct address (several stay
// silent so the model can honestly ask which one).
function matchWalkBack(ctx) {
  if (!ctx.latestFix && !referencesStreetView(ctx.latest)) return null;
  let fix = ctx.latestFix;
  for (let i = ctx.users.length - 2; i >= 0; i--) {
    const t = textOf(ctx.users[i]?.content);
    const prior = extractPlace(t);
    if (prior) return { coords: "", address: withLocalityFix(prior, fix), followUp: true };
    if (!fix) fix = extractLocalityFix(t);
  }
  const fromAssistant = new Map();
  for (const m of Array.isArray(ctx.conversation) ? ctx.conversation : []) {
    if (m?.role !== "assistant") continue;
    for (const a of addressesInText(textOf(m.content))) {
      fromAssistant.set(normForMatch(a), a);
    }
  }
  if (fromAssistant.size === 1) {
    const only = fromAssistant.values().next().value;
    return { coords: "", address: withLocalityFix(only, fix), followUp: true };
  }
  return null;
}

// Precedence, top to bottom — the ORDER IS THE SPEC. Most-specific inputs
// first (a photo's GPS, a typed address), then the anchored relocations
// (moves, barriers, nearby/named destinations, here-asks), then the
// named/fragment resolutions, then the scene captures, and the walk-back
// last (it re-bills a full lookup, so everything cheaper gets a chance
// first).
const LOOKUP_MATCHERS = [
  matchPhotoCoords,
  matchNewAddress,
  matchJourney,
  matchRelativeMove,
  matchCrossBarrier,
  matchNearbyPlace,
  matchRelocationToName,
  matchGoThereResume,
  matchHereAsk,
  matchPlaceQuery,
  matchNamedPlace,
  matchAddressFragmentAnswer,
  matchRelocationFragmentAnswer,
  matchPovScene,
  matchMapScene,
  matchWalkBack,
];

export function pickLookup(conversation, imageLocations, pov = null, mapView = null, userLocation = null) {
  const ctx = buildLookupCtx(conversation, imageLocations, pov, mapView, userLocation);
  for (const matcher of LOOKUP_MATCHERS) {
    const target = matcher(ctx);
    if (target) {
      // Which matcher decided rides on the target as DIAGNOSTICS — the
      // enrichment logs it (maps.intent) and it lands in the chat_logs
      // meta, so "how did routing go?" is answerable from the logs
      // (requested 2026-07-09 after a run of silent intent misses).
      // Non-enumerable on purpose: it is not part of the target-shape
      // contract the runners and tests consume.
      Object.defineProperty(target, "intent", { value: matcher.name.replace(/^match/, ""), enumerable: false });
      return target;
    }
  }
  return null;
}

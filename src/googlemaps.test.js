// Unit suite for the Google Maps integration's pure logic: the deterministic
// text side (src/googlemaps-text.js — address/place extraction, every intent
// gate, the pickLookup matcher registry) and googlemaps.js's pure exports
// (link/block builders, compassDir, jumpSearchRadius, key gating). The REST
// clients and the enrichment runners need live Google/Berget and are covered
// by live verification instead (see the live-verify skill).
//
// Layout: per-function describes first (extraction, gates, block builders),
// then the scenario suites replaying verbatim reported conversations
// (Accenture fragments, "Gas station near e18 there", the railway crossing,
// the journey view, "Where am i now"), and the "Swedish language parity"
// suite enforcing CLAUDE.md invariant 6 — every deterministic gate must take
// Swedish forms with the same breadth as English. When adding or extending a
// gate, add its Swedish parity case there in the same change.
//
// Deliberately NOT `// @ts-check`: these tests exercise fail-soft behavior
// by feeding malformed and partial shapes (empty envs, truncated targets,
// bare object literals) that strict types would reject by design.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildCrossBarrierBlock,
  buildJourneyBlock,
  buildJumpBlock,
  buildMapsBlock,
  buildMapViewBlock,
  buildNearbyPlacesBlock,
  buildPovBlock,
  compassDir,
  googleMapsAvailable,
  googleMapsEmbedKey,
  jumpSearchRadius,
  mapLink,
  panoLink,
  unresolvedMapsBlock,
} from "./googlemaps.js";
import {
  bearingDeg,
  decodePolyline,
  distanceMeters,
  extractCrossBarrierAsk,
  extractLocalityFix,
  extractNamedPlaceQuery,
  extractJourneyPoints,
  extractNearbyPlaceQuery,
  extractPlace,
  extractPlaceQuery,
  extractRelativeMove,
  extractRelocationQuery,
  hereAskIntent,
  hereFragmentAnswer,
  journeyAsk,
  matchAddressFragment,
  movePoint,
  nearbyAskMode,
  needsAnchorAsk,
  pendingRelocation,
  physicalLocationAsk,
  samplePolyline,
  pickLookup,
  referencesStreetView,
  referencesStreetViewScene,
  streetViewHereIntent,
  streetViewIntent,
  whereAmIIntent,
} from "./googlemaps-text.js";

test("googleMapsAvailable reflects the GOOGLE_MAPS_API_KEY secret", () => {
  assert.equal(googleMapsAvailable({}), false);
  assert.equal(googleMapsAvailable({ GOOGLE_MAPS_API_KEY: "" }), false);
  assert.equal(googleMapsAvailable({ GOOGLE_MAPS_API_KEY: "k" }), true);
});

test("googleMapsEmbedKey prefers the dedicated key, else falls back to the main key", () => {
  assert.equal(googleMapsEmbedKey({}), ""); // neither set
  assert.equal(googleMapsEmbedKey({ GOOGLE_MAPS_API_KEY: "main" }), "main"); // fallback
  assert.equal(googleMapsEmbedKey({ GOOGLE_MAPS_EMBED_KEY: "embed" }), "embed"); // dedicated
  assert.equal(
    googleMapsEmbedKey({ GOOGLE_MAPS_API_KEY: "main", GOOGLE_MAPS_EMBED_KEY: "embed" }),
    "embed", // dedicated wins
  );
});

describe("extractPlace", () => {
  test("pulls a numbered Swedish street address", () => {
    assert.equal(extractPlace("Kallhäll Maskinistvägen 11"), "Kallhäll Maskinistvägen 11");
    assert.equal(extractPlace("Vad finns på Maskinistvägen 11?"), "Maskinistvägen 11");
    assert.equal(extractPlace("Storgatan 4B ligger i centrum"), "Storgatan 4B");
  });

  test("pulls a numbered English street address (exact street word before the number)", () => {
    assert.equal(extractPlace("The office is at Main Street 5"), "Main Street 5");
  });

  test("keeps a LOWERCASE locality so Google resolves the right city", () => {
    // Users type localities lowercase; dropping them sent bare "Maskinistvägen
    // 11" to Google and resolved to the wrong city (reported bug).
    assert.equal(extractPlace("Show street view of kallhäll maskinistvägen 11"), "kallhäll maskinistvägen 11");
    assert.equal(extractPlace("No maskinistvägen 11 in järfälla"), "maskinistvägen 11, järfälla");
    assert.equal(extractPlace("maskinistvägen 11 i kallhäll"), "maskinistvägen 11, kallhäll");
  });

  test("keeps a BARE lowercase trailing locality (no connector) — the wrong-city clarify bug", () => {
    // Reported 2026-07-08 verbatim: the lowercase "hallstahammar" was dropped
    // (only Capitalized bare localities counted), Google resolved the OTHER
    // Lidbecksgatan 10, and the model asked which city the user meant —
    // one they had explicitly named.
    assert.equal(extractPlace("Streetview lidbecksgatan 10 hallstahammar"), "lidbecksgatan 10, hallstahammar");
    assert.equal(extractPlace("gatuvy storgatan 4 katrineholm"), "storgatan 4, katrineholm");
    // Trailing filler still never reads as a locality.
    assert.equal(extractPlace("Storgatan 4B ligger i centrum"), "Storgatan 4B");
    assert.equal(extractPlace("what does the building at Main Street 5 look like"), "Main Street 5");
  });

  test("pulls a STANDALONE Swedish street name (no house number)", () => {
    assert.equal(extractPlace("street view of Maskinistvägen in Kallhäll"), "Maskinistvägen, Kallhäll");
    assert.equal(extractPlace("Maskinistvägen, Kallhäll"), "Maskinistvägen, Kallhäll");
    assert.equal(extractPlace("what does Storgatan look like?"), "Storgatan");
  });

  test("pulls a STANDALONE English street phrase (no house number)", () => {
    assert.equal(extractPlace("show me Abbey Road in London"), "Abbey Road, London");
    assert.equal(extractPlace("the office on Main Street"), "Main Street");
  });

  test("a number-first street name still resolves via the standalone path", () => {
    assert.equal(extractPlace("5 Maskinistvägen"), "Maskinistvägen");
  });

  test("does NOT mistake ordinary '<noun> <number>' phrases for addresses", () => {
    assert.equal(extractPlace("the new iPhone 15 is out"), "");
    assert.equal(extractPlace("see Article 5 of the treaty"), "");
    assert.equal(extractPlace("we met on August 5"), "");
    assert.equal(extractPlace("this record 12 times"), "");
    assert.equal(extractPlace("top 10 list"), "");
  });

  test("does NOT match ordinary prose that merely capitalizes a street-ish word", () => {
    assert.equal(extractPlace("Please Drive carefully"), "");
    assert.equal(extractPlace("we walked down the road"), "");
    assert.equal(extractPlace("give me the Square footage"), "");
  });

  test("returns empty string for non-string / no-address input", () => {
    assert.equal(extractPlace(null), "");
    assert.equal(extractPlace(undefined), "");
    assert.equal(extractPlace(42), "");
    assert.equal(extractPlace("just a normal question with no address"), "");
  });
});

describe("extractPlaceQuery / streetViewIntent / unresolvedMapsBlock", () => {
  test("an explicit street-view ask naming a PLACE becomes a Places query — the verbatim LEGO report", () => {
    // Reported 2026-07-08: this fired nothing (no street address to parse)
    // and the model told a knob-ON user to enable Google Maps in Settings.
    assert.equal(extractPlaceQuery("Street view of LEGO offices in Copenhagen"), "LEGO offices in Copenhagen");
    assert.equal(extractPlaceQuery("gatuvy Turning Torso i Malmö"), "Turning Torso i Malmö");
    assert.equal(extractPlaceQuery("show me the street view of the Eiffel Tower"), "Eiffel Tower");
    assert.equal(extractPlaceQuery("Street view Copenhagen"), "Copenhagen");
  });

  test("cuts a trailing lowercase clause but keeps comma-joined localities", () => {
    assert.equal(
      extractPlaceQuery("Street View of the LEGO Group offices in Copenhagen, including a description of the building"),
      "LEGO Group offices in Copenhagen",
    );
    assert.equal(extractPlaceQuery("street view of Rådhuspladsen, København"), "Rådhuspladsen, København");
  });

  test("yields nothing without explicit street-view intent, for bare filler, or when an address exists", () => {
    assert.equal(extractPlaceQuery("LEGO offices in Copenhagen"), ""); // no explicit ask — ordinary research question
    assert.equal(extractPlaceQuery("street view"), ""); // bare follow-up — must walk back instead
    assert.equal(extractPlaceQuery("show street view of the area"), ""); // filler only
    assert.equal(extractPlaceQuery("street view of Maskinistvägen 11"), ""); // extractPlace owns real addresses
    assert.equal(extractPlaceQuery(null), "");
  });

  test("streetViewIntent detects the explicit ask in both languages", () => {
    assert.equal(streetViewIntent("Street view of LEGO offices"), true);
    assert.equal(streetViewIntent("gatuvy tack"), true);
    assert.equal(streetViewIntent("what does the building look like?"), false);
  });

  test("unresolvedMapsBlock says the feature is ON and asks for the place — never enable instructions", () => {
    const block = unresolvedMapsBlock();
    assert.match(block, /ENABLED/);
    assert.match(block, /Ask the user which address or place/);
    assert.match(block, /Do NOT instruct the user to enable/);
  });
});

// The verbatim chat_logs #47 report (2026-07-09): a visual question about a
// NAMED place — no street address, no street-view keyword — fired nothing.
const ROSA_PANTERN_Q =
  "There is a fast food restaurant in Uppsala, Sweden called ”Rosa Pantern”. " +
  "I’m curious, what’s the color of the building across the road from it?";

describe("extractNamedPlaceQuery — visual questions about a named place (chat_logs #47)", () => {
  test("the verbatim Rosa Pantern report resolves to a Places query and fires the lookup", () => {
    assert.equal(extractNamedPlaceQuery(ROSA_PANTERN_Q), "Rosa Pantern, Uppsala");
    assert.deepEqual(pickLookup([{ role: "user", content: ROSA_PANTERN_Q }], []), {
      coords: "",
      address: "Rosa Pantern, Uppsala",
    });
  });

  test("the unquoted lowercase variant works via the place-type word", () => {
    assert.equal(
      extractNamedPlaceQuery("What does the building across the road from the restaurant rosapantern look like?"),
      "rosapantern",
    );
  });

  test("a naming cue without quotes works too", () => {
    assert.equal(
      extractNamedPlaceQuery("What color is the roof of the burger place called Rosa Pantern in Uppsala?"),
      "Rosa Pantern, Uppsala",
    );
  });

  test("a quoted title with NO place anchor is not a place — no billed lookup for a book question", () => {
    assert.equal(extractNamedPlaceQuery('What color is the cover of the book called "The Road"?'), "");
  });

  test("a NON-visual question about the same place never fires a lookup", () => {
    const q = "What are the opening hours of the restaurant ”Rosa Pantern” in Uppsala?";
    assert.equal(extractNamedPlaceQuery(q), "Rosa Pantern, Uppsala"); // extraction works…
    assert.equal(pickLookup([{ role: "user", content: q }], []), null); // …but no visual flavor, no lookup
  });

  test("a real street address stays owned by extractPlace", () => {
    assert.equal(extractNamedPlaceQuery("the restaurant ”Rosa Pantern” at Storgatan 12 in Uppsala"), "");
  });

  test("null/empty are safe", () => {
    assert.equal(extractNamedPlaceQuery(null), "");
    assert.equal(extractNamedPlaceQuery(""), "");
  });
});

describe("fragment answers & typo-tolerant intent — the verbatim Accenture conversation", () => {
  const research = { role: "assistant", content:
    "Accenture has offices at Alströmergatan 12, 112 47 Stockholm; Rådmansgatan 42, 113 57 Stockholm; and Kungstensgatan 23A, 113 57 Stockholm." };

  test("streetViewIntent tolerates common misspellings", () => {
    assert.equal(streetViewIntent("Streer view"), true); // reported verbatim
    assert.equal(streetViewIntent("stret view"), true);
    assert.equal(streetViewIntent("street veiw"), true);
    assert.equal(streetViewIntent("gatvy"), true);
    assert.equal(streetViewIntent("a street with a view"), false);
  });

  test("a bare fragment answering the clarify picks the matching assistant-surfaced address", () => {
    // "Alstromer" (no diacritics, no suffix) → Alströmergatan 12, uniquely.
    const convo = [
      { role: "user", content: "Show me Accenture offices in Stockholm" },
      research,
      { role: "user", content: "Streer view" },
      { role: "assistant", content: "Which office do you want street view images of?" },
      { role: "user", content: "Alstromer" },
    ];
    assert.deepEqual(pickLookup(convo, []), { coords: "", address: "Alströmergatan 12", followUp: true });
  });

  test("matchAddressFragment is diacritics-insensitive and demands a UNIQUE hit", () => {
    const convo = [research];
    assert.equal(matchAddressFragment(convo, "Alstromer"), "Alströmergatan 12");
    assert.equal(matchAddressFragment(convo, "radmansgatan"), "Rådmansgatan 42");
    assert.equal(matchAddressFragment(convo, "gatan"), ""); // matches all three — ambiguous
    assert.equal(matchAddressFragment(convo, "abc"), ""); // too short / unknown
    assert.equal(matchAddressFragment([], "Alstromer"), "");
  });

  test("bare 'street view' with SEVERAL assistant addresses stays null — the clarify is honest", () => {
    const convo = [
      { role: "user", content: "Show me Accenture offices in Stockholm" },
      research,
      { role: "user", content: "Streer view" },
    ];
    assert.equal(pickLookup(convo, []), null);
  });

  test("bare 'street view' with exactly ONE assistant-surfaced address uses it", () => {
    const convo = [
      { role: "user", content: "Where is the Accenture Liquid Studio?" },
      { role: "assistant", content: "It is located at Alströmergatan 12, 112 47 Stockholm." },
      { role: "user", content: "street view" },
    ];
    assert.deepEqual(pickLookup(convo, []), { coords: "", address: "Alströmergatan 12", followUp: true });
  });
});

describe("panoLink / mapLink", () => {
  test("build keyless Google Maps URLs from coordinates (never leaking a key)", () => {
    const pano = panoLink(59.4, 17.9);
    const map = mapLink(59.4, 17.9);
    assert.match(pano, /map_action=pano/);
    assert.match(pano, /viewpoint=59\.4,17\.9/);
    assert.match(map, /query=59\.4,17\.9/);
    assert.ok(!pano.includes("key="), "pano link must not carry an API key");
    assert.ok(!map.includes("key="), "map link must not carry an API key");
  });
});

describe("buildMapsBlock", () => {
  test("renders place details, coordinates, links and a multi-frame imagery note", () => {
    const block = buildMapsBlock("Maskinistvägen 11", {
      place: { name: "Some Place", address: "Maskinistvägen 11, Kallhäll", type: "point of interest", rating: 4.3, ratingCount: 88, status: "OPERATIONAL" },
      lat: 59.4,
      lng: 17.9,
      streetView: { date: "2022-06" },
      streetViewCount: 4,
      hasMap: true,
    });
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /Place: Some Place/);
    assert.match(block, /Address: Maskinistvägen 11, Kallhäll/);
    assert.match(block, /Rating: 4\.3 \(88 reviews\)/);
    assert.match(block, /Business status: OPERATIONAL/);
    assert.match(block, /Map link: /);
    assert.match(block, /Street View link: /);
    assert.match(block, /captured: 2022-06/);
    assert.match(block, /4 Street View photos looking north, east, south, west/);
    assert.match(block, /a road map/);
    assert.match(block, /--- End of Google Maps ---/);
  });

  test("every block forbids re-asking the already-resolved location", () => {
    const block = buildMapsBlock("x", { place: null, lat: 1, lng: 2, streetView: null, streetViewCount: 0, hasMap: false });
    assert.match(block, /do NOT ask the user to confirm or disambiguate/);
  });

  test("every block tells the model Maps is already enabled", () => {
    const block = buildMapsBlock("x", { place: null, lat: 1, lng: 2, streetView: null, streetViewCount: 0, hasMap: false });
    assert.match(block, /already enabled — do NOT suggest the user enable it/);
  });

  test("singular wording for a single frame", () => {
    const block = buildMapsBlock("x", { place: null, lat: 59.4, lng: 17.9, streetView: { date: "" }, streetViewCount: 1, hasMap: false });
    assert.match(block, /one Street View photo/);
    assert.ok(!/Street View photos/.test(block));
  });

  test("renders a vision-generated description when provided (non-vision answer model)", () => {
    const block = buildMapsBlock("Lidbecksgatan 10", {
      place: { name: "", address: "Lidbecksgatan 10, Hallstahammar" },
      lat: 59.6,
      lng: 16.2,
      streetView: { date: "2021-12" },
      streetViewCount: 0,
      hasMap: false,
      description: "A three-storey yellow-brick apartment block on a quiet residential street.",
    });
    assert.match(block, /Visual description of the Street View imagery \(auto-generated\): A three-storey yellow-brick/);
    assert.ok(!block.includes("Attached to this message"));
    assert.ok(!/open the Street View link/.test(block));
  });

  test("marks a follow-up block and the frames shown beside the reply", () => {
    const block = buildMapsBlock("Maskinistvägen 11", {
      place: null,
      lat: 59.4,
      lng: 17.9,
      streetView: { date: "2022-06" },
      streetViewCount: 0,
      hasMap: false,
      description: "The roof is dark grey concrete tile.",
      followUp: true,
      framesShown: 4,
    });
    assert.match(block, /follow-up question about the location already being discussed/);
    assert.match(block, /re-fetched and re-examined for this question/);
    assert.match(block, /4 Street View photo\(s\) of this location are displayed to the user/);
  });

  test("a first-turn block carries neither follow-up nor frames-shown lines", () => {
    const block = buildMapsBlock("x", { place: null, lat: 1, lng: 2, streetView: null, streetViewCount: 0, hasMap: false });
    assert.ok(!/follow-up question/.test(block));
    assert.ok(!/displayed to the user/.test(block));
  });

  test("notes when Street View exists but nothing could be shown (no vision at all)", () => {
    const block = buildMapsBlock("59.4,17.9", {
      place: null,
      lat: 59.4,
      lng: 17.9,
      streetView: { date: "" },
      streetViewCount: 0,
      hasMap: false,
    });
    assert.match(block, /open the Street View link/);
    assert.ok(!block.includes("Attached to this message"));
  });

  // The basaltvägen regression (2026-07-09): Places resolved a business but
  // Street View metadata was ZERO_RESULTS — the block must say so plainly
  // instead of letting the model pass a road map off as Street View.
  test("says explicitly when the resolved location has NO Street View coverage", () => {
    const block = buildMapsBlock("Basaltgatan 3, Enköping", {
      place: { name: "Basalt AB", address: "Basaltgatan 3, 749 40 Enköping" },
      lat: 59.65,
      lng: 17.12,
      streetView: null,
      streetViewCount: 0,
      hasMap: false,
    });
    assert.match(block, /No Street View imagery is available for this location/);
    assert.match(block, /never present anything else \(a map, a guess\) as Street View imagery/);
    assert.ok(!/Street View link: /.test(block));
    // Without a panorama the map link is the user's only way in — the answer
    // must carry it as a markdown link (requested 2026-07-09).
    assert.match(block, /ALWAYS include the Map link above in your answer as a markdown link/);
    assert.match(block, /\[View on Google Maps\]\(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=59\.65,17\.12\)/);
  });

  test("a block with coverage does not demand the markdown map link", () => {
    const block = buildMapsBlock("x", { place: null, lat: 1, lng: 2, streetView: { date: "" }, streetViewCount: 0, hasMap: false });
    assert.ok(!/ALWAYS include the Map link/.test(block));
  });

  test("mentions the interactive map shown beside the reply (mapEmbedShown)", () => {
    const block = buildMapsBlock("Basaltgatan 3, Enköping", {
      place: null,
      lat: 59.65,
      lng: 17.12,
      streetView: null,
      streetViewCount: 0,
      hasMap: false,
      mapEmbedShown: true,
    });
    assert.match(block, /interactive Google Map of the area .* is displayed to the user directly beside this reply/);
  });

  test("a block with coverage carries no no-coverage note", () => {
    const block = buildMapsBlock("x", { place: null, lat: 1, lng: 2, streetView: { date: "" }, streetViewCount: 0, hasMap: false });
    assert.ok(!/No Street View imagery is available/.test(block));
  });

  test("the Street View link centers on the panorama's own position when the lookup reported one", () => {
    const block = buildMapsBlock("x", {
      place: null,
      lat: 59.65,
      lng: 17.12,
      streetView: { date: "", lat: 59.6512, lng: 17.1187 },
      streetViewCount: 0,
      hasMap: false,
    });
    assert.match(block, /Street View link: .*viewpoint=59\.6512,17\.1187/);
    // The resolved address still owns the coordinates + map link.
    assert.match(block, /Coordinates: 59\.65, 17\.12/);
  });

  test("labels a map-only description as a MAP, never as Street View imagery", () => {
    const block = buildMapsBlock("Basaltgatan 3, Enköping", {
      place: null,
      lat: 59.65,
      lng: 17.12,
      streetView: null,
      streetViewCount: 0,
      hasMap: false,
      description: "The map shows an industrial street with several labeled businesses.",
      describedMapOnly: true,
      mapShown: true,
    });
    assert.match(block, /Visual description of the road map of the area \(auto-generated — this is a MAP image, NOT Street View\): The map shows/);
    assert.ok(!/Visual description of the Street View imagery/.test(block));
    assert.match(block, /road-map image of the area is displayed to the user/);
  });

  test("every block forbids fabricating Google Maps image URLs (the key=YOUR_API_KEY hallucination)", () => {
    for (const parts of [
      { place: null, lat: 1, lng: 2, streetView: null, streetViewCount: 0, hasMap: false },
      { place: null, lat: 1, lng: 2, streetView: { date: "" }, streetViewCount: 4, hasMap: true, description: "x" },
    ]) {
      const block = buildMapsBlock("x", parts);
      assert.match(block, /NEVER construct or output Google Maps API image URLs/);
      assert.match(block, /use only the keyless links given above/);
      assert.ok(!block.includes("key="), "the block must never leak or exemplify a keyed URL");
    }
  });
});

describe("referencesStreetView", () => {
  test("matches follow-up questions about the imagery / building (English)", () => {
    assert.equal(referencesStreetView("what color is the roof?"), true);
    assert.equal(referencesStreetView("how many floors does the building have?"), true);
    assert.equal(referencesStreetView("is there a garage visible?"), true);
    assert.equal(referencesStreetView("what does it look like across the street?"), true);
    assert.equal(referencesStreetView("describe the picture again"), true);
    assert.equal(referencesStreetView("any cars parked outside?"), true);
  });

  test("matches follow-up questions about the imagery / building (Swedish)", () => {
    assert.equal(referencesStreetView("vad är det för färg på taket?"), true);
    assert.equal(referencesStreetView("hur många våningar har huset?"), true);
    assert.equal(referencesStreetView("vad syns på bilden?"), true);
    assert.equal(referencesStreetView("hur ser det ut mittemot?"), true);
    assert.equal(referencesStreetView("finns det ett staket runt trädgården?"), true);
  });

  test("matches panorama-referring phrases (after the user pans the live view)", () => {
    assert.equal(referencesStreetView("what am I looking at?"), true);
    assert.equal(referencesStreetView("what is in front of me here?"), true);
    assert.equal(referencesStreetView("describe this view"), true);
    assert.equal(referencesStreetView("vad tittar jag på?"), true);
    assert.equal(referencesStreetView("vad ser jag framför mig?"), true);
    assert.equal(referencesStreetView("beskriv vyn"), true);
  });

  test("matches asking the assistant what IT sees — 'What do you see' / 'vad ser du' (reported 2026-07-09)", () => {
    // Both got a "since I don't have access to images…" denial while the
    // panorama stood open beside the chat.
    assert.equal(referencesStreetView("What do you see"), true);
    assert.equal(referencesStreetView("what can you see?"), true);
    assert.equal(referencesStreetView("vad ser du"), true);
    assert.equal(referencesStreetView("Vad ser ni?"), true);
    assert.equal(referencesStreetView("vad kan du se?"), true);
  });

  test("does NOT match ordinary research follow-ups", () => {
    assert.equal(referencesStreetView("summarize the sources"), false);
    assert.equal(referencesStreetView("tell me more about the company"), false);
    assert.equal(referencesStreetView("who owns it?"), false);
    assert.equal(referencesStreetView("vad kostar det?"), false);
    assert.equal(referencesStreetView(""), false);
    assert.equal(referencesStreetView(null), false);
  });
});

describe("referencesStreetViewScene (the loose POV-path gate)", () => {
  test("'What do we have here' fires — English 'here' has parity with Swedish 'här' (verbatim 2026-07-09)", () => {
    assert.equal(referencesStreetViewScene("What do we have here"), true);
    assert.equal(referencesStreetViewScene("vad har vi här"), true);
  });

  test("matches scene contents the strict gate can't enumerate", () => {
    // Reported 2026-07-08 verbatim: "Describe the person" missed the strict
    // gate, no capture fired, and the model asked "what person?" while the
    // person stood in the on-screen panorama.
    assert.equal(referencesStreetViewScene("Describe the person"), true);
    assert.equal(referencesStreetViewScene("who is that?"), true);
    assert.equal(referencesStreetViewScene("what does the sign say?"), true);
    assert.equal(referencesStreetViewScene("is that a restaurant?"), true);
    assert.equal(referencesStreetViewScene("vem är det där?"), true);
    assert.equal(referencesStreetViewScene("vad står det på skylten?"), true);
    assert.equal(referencesStreetViewScene("beskriv människorna"), true);
  });

  test("includes everything the strict gate matches", () => {
    assert.equal(referencesStreetViewScene("what color is the roof?"), true);
    assert.equal(referencesStreetViewScene("what am I looking at?"), true);
  });

  test("matches bare deictic / positional / visual-act phrasings (second reported leak)", () => {
    // Workers Logs 2026-07-08 ~13:22Z: 4 of 5 panorama follow-ups fired
    // nothing — noun vocabulary alone keeps leaking, so the structural
    // classes carry the load.
    assert.equal(referencesStreetViewScene("what is that?"), true);
    assert.equal(referencesStreetViewScene("is it open?"), true);
    assert.equal(referencesStreetViewScene("zoom in on the left"), true);
    assert.equal(referencesStreetViewScene("read the text on the wall"), true);
    assert.equal(referencesStreetViewScene("what's behind me?"), true);
    assert.equal(referencesStreetViewScene("vad är det där?"), true);
    assert.equal(referencesStreetViewScene("vad kostar det?"), true); // deictic "det" — in a panorama convo this points at the view
    assert.equal(referencesStreetViewScene("beskriv"), true);
    assert.equal(referencesStreetViewScene("vad finns till vänster?"), true);
  });

  test("matches loose what-do-you-see forms (fourth reported round, 2026-07-09)", () => {
    assert.equal(referencesStreetViewScene("What do you see"), true);
    assert.equal(referencesStreetViewScene("vad ser du"), true);
    assert.equal(referencesStreetViewScene("do you see anything interesting?"), true);
    assert.equal(referencesStreetViewScene("kan du se skylten?"), true);
    assert.equal(referencesStreetViewScene("ser du något?"), true);
  });

  test("matches temporal continuations after a capture — 'And now' (fifth reported round, 2026-07-09)", () => {
    // The user panned to a new spot and re-asked with just "And now" — the
    // gate fired nothing, no capture ran, and the model invented a scene.
    assert.equal(referencesStreetViewScene("And now"), true);
    assert.equal(referencesStreetViewScene("what about now?"), true);
    assert.equal(referencesStreetViewScene("again?"), true);
    assert.equal(referencesStreetViewScene("och nu?"), true);
    assert.equal(referencesStreetViewScene("nu då?"), true);
    assert.equal(referencesStreetViewScene("igen"), true);
  });

  test("matches the third reported round verbatim — 'Describe the dude' / 'The one in view'", () => {
    // Screenshot 2026-07-08 15:23 (pre-deploy of the deictic round): both
    // turns got "Need to narrow the scope first" clarifies while the person
    // stood in the panorama.
    assert.equal(referencesStreetViewScene("Describe the dude"), true);
    assert.equal(referencesStreetViewScene("The one in view"), true);
    assert.equal(referencesStreetViewScene("what is he wearing?"), true);
    assert.equal(referencesStreetViewScene("vem är hon?"), true);
  });

  test("still ignores follow-ups with no reference to the scene at all", () => {
    assert.equal(referencesStreetViewScene("summarize the sources"), false);
    assert.equal(referencesStreetViewScene("what does the company do?"), false);
    assert.equal(referencesStreetViewScene("who owns the property according to public records?"), false);
    assert.equal(referencesStreetViewScene(null), false);
  });
});

describe("compassDir", () => {
  test("maps headings to compass points, wrapping negatives and >360", () => {
    assert.equal(compassDir(0), "north");
    assert.equal(compassDir(90), "east");
    assert.equal(compassDir(143), "southeast");
    assert.equal(compassDir(270), "west");
    assert.equal(compassDir(359), "north");
    assert.equal(compassDir(-90), "west");
    assert.equal(compassDir(450), "east");
  });
});

describe("pickLookup", () => {
  test("prefers a photo's GPS coordinates over a parsed address", () => {
    const convo = [{ role: "user", content: "photo from Maskinistvägen 11" }];
    const out = pickLookup(convo, [{ name: "photo.jpg", lat: 59.4, lon: 17.9 }]);
    assert.deepEqual(out, { coords: "59.4,17.9", address: "" });
  });

  test("falls back to a parsed street address when there's no photo location", () => {
    const convo = [{ role: "user", content: "what's at Maskinistvägen 11?" }];
    assert.deepEqual(pickLookup(convo, []), { coords: "", address: "Maskinistvägen 11" });
  });

  test("returns null when nothing names a location", () => {
    const convo = [{ role: "user", content: "a plain research question" }];
    assert.equal(pickLookup(convo, []), null);
    assert.equal(pickLookup(convo, undefined), null);
  });

  test("a follow-up about the imagery walks back to the address an earlier turn named", () => {
    // The reported bug: the follow-up carries no address, so no enrichment ran
    // and the model claimed it had no knowledge of the Street View image.
    const convo = [
      { role: "user", content: "show street view of Maskinistvägen 11 in Kallhäll" },
      { role: "assistant", content: "Here is the location…" },
      { role: "user", content: "what color is the roof?" },
    ];
    assert.deepEqual(pickLookup(convo, []), {
      coords: "",
      address: "Maskinistvägen 11, Kallhäll",
      followUp: true,
    });
  });

  test("walk-back picks the MOST RECENT earlier address, not the first", () => {
    const convo = [
      { role: "user", content: "street view of Storgatan 4" },
      { role: "assistant", content: "…" },
      { role: "user", content: "now show Abbey Road in London" },
      { role: "assistant", content: "…" },
      { role: "user", content: "how many floors does the building have?" },
    ];
    assert.deepEqual(pickLookup(convo, []), { coords: "", address: "Abbey Road, London", followUp: true });
  });

  test("a follow-up that does NOT reference the imagery stays null (no re-billed lookup)", () => {
    const convo = [
      { role: "user", content: "show street view of Maskinistvägen 11" },
      { role: "assistant", content: "…" },
      { role: "user", content: "who owns the property according to public records?" },
    ];
    assert.equal(pickLookup(convo, []), null);
  });

  test("an address in the LATEST message wins over history and carries no followUp flag", () => {
    const convo = [
      { role: "user", content: "street view of Storgatan 4" },
      { role: "assistant", content: "…" },
      { role: "user", content: "and what does the building at Main Street 5 look like?" },
    ];
    assert.deepEqual(pickLookup(convo, []), { coords: "", address: "Main Street 5" });
  });

  test("the user's current panorama view beats the walk-back on an imagery follow-up", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const convo = [
      { role: "user", content: "street view of Maskinistvägen 11" },
      { role: "assistant", content: "…" },
      { role: "user", content: "what am I looking at now?" },
    ];
    assert.deepEqual(pickLookup(convo, [], pov), { coords: "", address: "", pov, followUp: true });
  });

  test("a scene question ('Describe the person') fires the POV path — but NOT the billed walk-back", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const convo = [
      { role: "user", content: "street view of Maskinistvägen 11" },
      { role: "assistant", content: "…" },
      { role: "user", content: "Describe the person" },
    ];
    assert.deepEqual(pickLookup(convo, [], pov), { coords: "", address: "", pov, followUp: true });
    // Without a live panorama the loose vocabulary must NOT trigger the
    // full billed address re-lookup.
    assert.equal(pickLookup(convo, []), null);
  });

  test("the user's current MAP view fires the capture path on a scene follow-up (no-coverage parity)", () => {
    const mapView = { lat: 59.65, lng: 17.12, zoom: 17 };
    const convo = [
      { role: "user", content: "street view of Basaltgatan 3 in Enköping" },
      { role: "assistant", content: "No Street View is available; here is a map…" },
      { role: "user", content: "what's there on the left?" },
    ];
    assert.deepEqual(pickLookup(convo, [], null, mapView), { coords: "", address: "", mapView, followUp: true });
    // Without a live map the loose vocabulary must NOT trigger the billed
    // address walk-back (same rule as the POV).
    assert.equal(pickLookup(convo, []), null);
  });

  test("a NEW address in the latest message beats the live map view", () => {
    const mapView = { lat: 59.65, lng: 17.12, zoom: 17 };
    const convo = [
      { role: "user", content: "street view of Basaltgatan 3" },
      { role: "assistant", content: "…" },
      { role: "user", content: "ok, now Storgatan 4 instead" },
    ];
    assert.deepEqual(pickLookup(convo, [], null, mapView), { coords: "", address: "Storgatan 4" });
  });

  test("a live PANORAMA outranks a map view (the client keeps one live, but defensively)", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const mapView = { lat: 59.65, lng: 17.12, zoom: 17 };
    const convo = [{ role: "user", content: "what do you see?" }];
    assert.deepEqual(pickLookup(convo, [], pov, mapView), { coords: "", address: "", pov, followUp: true });
  });

  test("a map view rides only on scene/imagery follow-ups — an ordinary question ignores it", () => {
    const mapView = { lat: 59.65, lng: 17.12, zoom: 17 };
    const convo = [
      { role: "user", content: "street view of Basaltgatan 3" },
      { role: "assistant", content: "…" },
      { role: "user", content: "summarize the company's finances" },
    ];
    assert.equal(pickLookup(convo, [], null, mapView), null);
  });

  test("a POV rides only on imagery follow-ups — an ordinary question ignores it", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const convo = [
      { role: "user", content: "street view of Maskinistvägen 11" },
      { role: "assistant", content: "…" },
      { role: "user", content: "who owns the property according to public records?" },
    ];
    assert.equal(pickLookup(convo, [], pov), null);
  });

  test("a named-place street-view ask fires a lookup and outranks the POV", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const convo = [{ role: "user", content: "Street view of LEGO offices in Copenhagen" }];
    assert.deepEqual(pickLookup(convo, [], pov), { coords: "", address: "LEGO offices in Copenhagen" });
  });

  test("a locality CORRECTION merges with the walked-back street — the verbatim wrong-city conversation", () => {
    // Reported 2026-07-08 verbatim: "Street view lidbecksgatan 10" resolved
    // Lidköping; "I meant in hallstahammar!" only got a clarify; a later
    // "Street view" walked back to the bare street and showed Lidköping
    // AGAIN. No single message carries street + corrected city.
    const t1 = { role: "user", content: "Street view lidbecksgatan 10" };
    const a = { role: "assistant", content: "…" };
    const t2 = { role: "user", content: "I meant in hallstahammar!" };

    // The correction turn itself re-runs the lookup in the corrected city.
    assert.deepEqual(pickLookup([t1, a, t2], []), {
      coords: "", address: "lidbecksgatan 10, hallstahammar", followUp: true,
    });

    // …and outranks a live POV — the on-screen panorama shows the WRONG city.
    const pov = { panoId: "abc", lat: 58.5, lng: 13.16, heading: 0, pitch: 0, fov: 90 };
    assert.deepEqual(pickLookup([t1, a, t2], [], pov), {
      coords: "", address: "lidbecksgatan 10, hallstahammar", followUp: true,
    });

    // A later "Street view" follow-up (no POV) still lands in the corrected
    // city: the fix from turn 2 rides along the walk-back past it.
    const t3 = { role: "user", content: "Street view" };
    assert.deepEqual(pickLookup([t1, a, t2, a, t3], []), {
      coords: "", address: "lidbecksgatan 10, hallstahammar", followUp: true,
    });
  });

  test("extractLocalityFix finds strong corrections and bare 'in X' messages, nothing else", () => {
    assert.equal(extractLocalityFix("I meant in hallstahammar!"), "hallstahammar");
    assert.equal(extractLocalityFix("jag menade i hallstahammar"), "hallstahammar");
    assert.equal(extractLocalityFix("in hallstahammar"), "hallstahammar");
    assert.equal(extractLocalityFix("i västerås"), "västerås");
    assert.equal(extractLocalityFix("hallstahammar instead"), ""); // cue with nothing after — connectorless bare word before a cue is too ambiguous
    // Weak/no cues never invent a locality.
    assert.equal(extractLocalityFix("why is it not open?"), "");
    assert.equal(extractLocalityFix("is it actually a shop?"), "");
    assert.equal(extractLocalityFix("The one in view"), "");
    assert.equal(extractLocalityFix("summarize the sources"), "");
    // A full address supersedes fix-extraction (extractPlace owns it).
    assert.equal(extractLocalityFix("I meant Storgatan 4 in Katrineholm"), "");
    assert.equal(extractLocalityFix(null), "");
  });

  test("a NEW address in the latest message wins over the panorama POV", () => {
    const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const convo = [
      { role: "user", content: "street view of Storgatan 4" },
      { role: "assistant", content: "…" },
      { role: "user", content: "what does the building at Main Street 5 look like?" },
    ];
    assert.deepEqual(pickLookup(convo, [], pov), { coords: "", address: "Main Street 5" });
  });
});

describe("buildPovBlock", () => {
  const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };

  test("describes the captured current view with position, heading and links", () => {
    const block = buildPovBlock(pov, {
      date: "2023-05",
      description: "A red-brick three-storey building with a bakery at street level.",
      framesShown: 1,
    });
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /CURRENTLY VISIBLE view was captured/);
    assert.match(block, /59\.41, 17\.91, facing 143° \(southeast\), pitch -5°/);
    assert.match(block, /imagery captured: 2023-05/);
    assert.match(block, /Map link: /);
    assert.match(block, /Street View link: /);
    assert.match(block, /displayed to the user directly beside this reply/);
    assert.match(block, /Visual description of the user's current view \(auto-generated\): A red-brick/);
    assert.match(block, /already enabled — do NOT suggest the user enable it/);
    assert.ok(!block.includes("key="), "the block must never leak an API key");
  });

  test("tells the model to answer view questions from the description — never ask which person/car", () => {
    const block = buildPovBlock(pov, { date: "", description: "A man in a black jacket crosses the street.", framesShown: 1 });
    assert.match(block, /never ask them to clarify who or what they mean/);
    // Conditional wording: the capture over-fires by design, so an
    // unrelated question must not be misdirected.
    assert.match(block, /unrelated to the view, answer it normally/);
  });

  test("says plainly when the frame couldn't be examined (no vision model)", () => {
    const block = buildPovBlock(pov, { date: "", description: "", framesShown: 1 });
    assert.match(block, /could not be examined by a vision model/);
    assert.ok(!/Visual description/.test(block));
    assert.ok(!/imagery captured/.test(block));
  });

  test("describes the live continue-from-here panorama when one is shown instead of the frame", () => {
    const block = buildPovBlock(pov, { date: "", description: "A shop front.", framesShown: 0, panoramaShown: true });
    assert.match(block, /interactive Street View panorama positioned at exactly this view/);
    assert.match(block, /keep looking around from there/);
    assert.ok(!/captured frame is displayed/.test(block));
  });

  test("always instructs the answer to include a markdown Map link at the CURRENT position (the user moved)", () => {
    for (const parts of [
      { date: "", description: "", framesShown: 1 },
      { date: "", description: "x", framesShown: 0, panoramaShown: true },
    ]) {
      const block = buildPovBlock(pov, parts);
      assert.match(block, /ALWAYS include the Map link above in your answer as a markdown link/);
      assert.match(block, /\[View on Google Maps\]\(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=59\.41,17\.91\)/);
    }
  });

  test("forbids fabricating Google Maps image URLs, same as the lookup block", () => {
    const block = buildPovBlock(pov, { date: "", description: "x", framesShown: 0, panoramaShown: true });
    assert.match(block, /NEVER construct or output Google Maps API image URLs/);
    assert.ok(!block.includes("key="));
  });
});

describe("buildMapViewBlock", () => {
  const view = { lat: 59.65123, lng: 17.11987, zoom: 16 };

  test("describes the captured current map view with center, zoom, link and the fresh map", () => {
    const block = buildMapViewBlock(view, {
      description: "An industrial street grid with several labeled businesses.",
      mapShown: true,
    });
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /CURRENTLY VISIBLE map area was captured/);
    assert.match(block, /centered at coordinates 59\.65123, 17\.11987, zoom level 16/);
    assert.match(block, /Map link: /);
    assert.match(block, /fresh interactive Google Map positioned at exactly this view is displayed to the user/);
    assert.match(block, /ALWAYS include the Map link above in your answer as a markdown link/);
    assert.match(block, /\[View on Google Maps\]\(https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=59\.65123,17\.11987\)/);
    assert.match(block, /Visual description of the user's current map view \(auto-generated — this is a MAP image, NOT Street View\): An industrial/);
    assert.match(block, /already enabled — do NOT suggest the user enable it/);
    assert.match(block, /NEVER construct or output Google Maps API image URLs/);
    assert.ok(!block.includes("key="), "the block must never leak an API key");
  });

  test("says plainly when the view couldn't be examined, and misdirection stays conditional", () => {
    const block = buildMapViewBlock(view, { description: "", mapShown: false });
    assert.match(block, /could not be examined by a vision model/);
    assert.ok(!/Visual description/.test(block));
    assert.ok(!/fresh interactive Google Map/.test(block));
    assert.match(block, /unrelated to the map, answer it normally/);
    assert.match(block, /never ask them to clarify where they mean/);
  });
});

describe("extractRelativeMove", () => {
  test("parses facing-relative moves — no verb needed, the phrasing is deictic", () => {
    assert.deepEqual(extractRelativeMove("100 meters along this road"), { meters: 100, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("continue 250 m ahead"), { meters: 250, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("50 meter längs vägen"), { meters: 50, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("gå 100 m framåt"), { meters: 100, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("go 100 metres back"), { meters: 100, mode: "back", dir: "back" });
    assert.deepEqual(extractRelativeMove("backa 75 m tillbaka"), { meters: 75, mode: "back", dir: "back" });
  });

  test("parses compass moves — as a command or a short standalone message", () => {
    assert.deepEqual(extractRelativeMove("go 200 meters north"), { meters: 200, mode: "bearing", bearing: 0, dir: "north" });
    assert.deepEqual(extractRelativeMove("100 m norrut"), { meters: 100, mode: "bearing", bearing: 0, dir: "north" });
    assert.deepEqual(extractRelativeMove("fortsätt 300 meter söderut"), { meters: 300, mode: "bearing", bearing: 180, dir: "south" });
    assert.deepEqual(extractRelativeMove("150 m northeast"), { meters: 150, mode: "bearing", bearing: 45, dir: "northeast" });
    assert.deepEqual(extractRelativeMove("0.5 km west"), { meters: 500, mode: "bearing", bearing: 270, dir: "west" });
  });

  test("prose that merely MENTIONS a compass distance does not fire", () => {
    assert.equal(extractRelativeMove("the shop is located about 100 meters north of the train station"), null);
    assert.equal(extractRelativeMove("what is 100 meters in feet?"), null);
    assert.equal(extractRelativeMove("the building is 20 m tall"), null);
    assert.equal(extractRelativeMove(""), null);
    assert.equal(extractRelativeMove(undefined), null);
  });

  test("clamps distances to a sane range", () => {
    assert.equal(extractRelativeMove("go 1 m north").meters, 5);
    assert.equal(extractRelativeMove("go 99 km north").meters, 3000);
  });
});

describe("streetViewHereIntent", () => {
  test("matches explicit street-view-at-current-location asks (EN + SV)", () => {
    assert.equal(streetViewHereIntent("street view here"), true);
    assert.equal(streetViewHereIntent("popup street view at my current location"), true);
    assert.equal(streetViewHereIntent("show streetview at this spot"), true);
    assert.equal(streetViewHereIntent("gatuvy här"), true);
    assert.equal(streetViewHereIntent("öppna gatuvy där jag är"), true);
  });

  test("needs BOTH the street-view word and a here-word", () => {
    assert.equal(streetViewHereIntent("street view of Storgatan 4"), false);
    assert.equal(streetViewHereIntent("what is here?"), false);
    assert.equal(streetViewHereIntent(""), false);
  });
});

describe("movePoint", () => {
  test("100 m north ≈ +0.0009° latitude, longitude unchanged", () => {
    const p = movePoint(59.65, 17.12, 0, 100);
    assert.ok(Math.abs(p.lat - 59.650898) < 0.000005, String(p.lat));
    assert.equal(p.lng, 17.12);
  });

  test("east moves scale longitude by the latitude's cosine", () => {
    const p = movePoint(59.65, 17.12, 90, 100);
    assert.equal(p.lat, 59.65);
    // 100 / (111320 * cos(59.65°)) ≈ 0.001778
    assert.ok(Math.abs(p.lng - 17.121778) < 0.00001, String(p.lng));
  });

  test("south-west combines both components", () => {
    const p = movePoint(59.65, 17.12, 225, 100);
    assert.ok(p.lat < 59.65 && p.lng < 17.12);
  });
});

describe("pickLookup — street-view jumps", () => {
  const pov = { panoId: "abc", lat: 59.41, lng: 17.91, heading: 90, pitch: 0, fov: 90 };
  const mapView = { lat: 59.65, lng: 17.12, zoom: 17 };

  test("'100 meters along this road' from a live panorama moves along its heading", () => {
    const convo = [{ role: "user", content: "100 meters along this road" }];
    const out = pickLookup(convo, [], pov);
    assert.ok(out?.jump, "expected a jump target");
    assert.equal(out.jump.heading, 90);
    assert.equal(out.jump.meters, 100);
    assert.equal(out.jump.lat, 59.41); // due-east move: latitude unchanged
    assert.ok(out.jump.lng > 17.91);
    assert.equal(out.followUp, true);
  });

  test("a compass move works from the interactive map (no heading needed)", () => {
    const convo = [{ role: "user", content: "go 200 meters north" }];
    const out = pickLookup(convo, [], null, mapView);
    assert.ok(out?.jump);
    assert.equal(out.jump.heading, 0);
    assert.ok(out.jump.lat > 59.65);
    assert.equal(out.jump.lng, 17.12);
  });

  test("'along this road' from a MAP degrades to the map-view describe — a map has no facing to move along", () => {
    const convo = [{ role: "user", content: "100 meters along this road" }];
    const out = pickLookup(convo, [], null, mapView);
    assert.ok(!out?.jump, "must not jump without a heading");
    assert.deepEqual(out, { coords: "", address: "", mapView, followUp: true });
  });

  test("'street view here' pops at the map center / panorama position / device location", () => {
    const convo = [{ role: "user", content: "street view here" }];
    const fromMap = pickLookup(convo, [], null, mapView);
    assert.deepEqual(fromMap.jump, { lat: 59.65, lng: 17.12, heading: 0, meters: 0, dir: "here" });
    const fromPov = pickLookup(convo, [], pov);
    assert.deepEqual(fromPov.jump, { lat: 59.41, lng: 17.91, heading: 90, meters: 0, dir: "here" });
    const userLocation = { lat: 59.33, lng: 18.06, zoom: 17 };
    const fromDevice = pickLookup(convo, [], null, null, userLocation);
    assert.deepEqual(fromDevice.jump, { lat: 59.33, lng: 18.06, heading: 0, meters: 0, dir: "here" });
  });

  test("'street view at my current location' never leaks to Places as a place query", () => {
    const convo = [{ role: "user", content: "popup street view at my current location" }];
    const out = pickLookup(convo, [], null, mapView);
    assert.ok(out?.jump, "must resolve as a jump, not an address/place lookup");
    assert.equal(out.address, "");
  });

  test("a NEW address still beats a jump phrase", () => {
    const convo = [{ role: "user", content: "show street view of Storgatan 4 here" }];
    const out = pickLookup(convo, [], null, mapView);
    assert.equal(out.address, "Storgatan 4");
    assert.ok(!out.jump);
  });

  test("without any anchor, jump phrases resolve nothing", () => {
    const convo = [{ role: "user", content: "go 200 meters north" }];
    assert.equal(pickLookup(convo, []), null);
  });

  test("'Forwsrd 200m' — the verbatim typo report (2026-07-09) still moves from the live panorama", () => {
    // Reported: "Forward 100m" worked, then "Forwsrd 200m" fired nothing
    // and the model asked for GPS coordinates mid-panorama.
    assert.deepEqual(extractRelativeMove("Forwsrd 200m"), { meters: 200, mode: "forward", dir: "forward" });
    const convo = [
      { role: "user", content: "Where am i" },
      { role: "user", content: "Forward 100m" },
      { role: "user", content: "Forwsrd 200m" },
    ];
    const out = pickLookup(convo, [], pov);
    assert.ok(out?.jump, "expected a jump from the live panorama");
    assert.equal(out.jump.meters, 200);
    assert.equal(out.jump.heading, pov.heading); // continues the view's facing
  });

  test("forward/back typo set: foward / forwad / ahed / bakat / tilbaka", () => {
    assert.equal(extractRelativeMove("foward 100 m")?.mode, "forward");
    assert.equal(extractRelativeMove("forwad 100m")?.mode, "forward");
    assert.equal(extractRelativeMove("100 m ahed")?.mode, "forward");
    assert.equal(extractRelativeMove("50 m bakat")?.mode, "back");
    assert.equal(extractRelativeMove("tilbaka 50 meter")?.mode, "back");
  });

  test("an explicit PHYSICAL-location ask flips the anchor back to the device", () => {
    // Requested 2026-07-09: follow-ups continue from the live view; the
    // device location only wins again when the user says they mean their
    // real position.
    const userLocation = { lat: 59.45, lng: 17.8, zoom: 17 };
    const physical = [{ role: "user", content: "street view at my actual location" }];
    const out = pickLookup(physical, [], pov, null, userLocation);
    assert.deepEqual(out.jump, { lat: 59.45, lng: 17.8, heading: 0, meters: 0, dir: "here" });
    // Without the physical wording, the live panorama still wins.
    const plain = [{ role: "user", content: "street view here" }];
    const fromPov = pickLookup(plain, [], pov, null, userLocation);
    assert.deepEqual(fromPov.jump, { lat: pov.lat, lng: pov.lng, heading: pov.heading, meters: 0, dir: "here" });
    // Physical wording without a device location degrades to the live view
    // (the client will have requested it, but it can still be denied).
    const noDevice = pickLookup(physical, [], pov);
    assert.deepEqual(noDevice.jump, { lat: pov.lat, lng: pov.lng, heading: pov.heading, meters: 0, dir: "here" });
  });

  test("needsAnchorAsk: relocation-family asks with no anchor get the allow-location note", () => {
    // Verbatim 2026-07-09: three anchor-less relocation asks (all logged
    // maps_intent "none") drew a hallucinated clarify instead of the
    // allow-location-access note.
    assert.equal(needsAnchorAsk([{ role: "user", content: "Lets go to hemköp stäket" }]), true);
    assert.equal(needsAnchorAsk([{ role: "user", content: "Lets go to hemlöp stäket" }]), true); // even with the typo
    assert.equal(needsAnchorAsk([{ role: "user", content: "nearest gas station" }]), true);
    assert.equal(needsAnchorAsk([{ role: "user", content: "get to the other side of the railway" }]), true);
    // A fragment continuing a pending relocation counts too.
    assert.equal(
      needsAnchorAsk([
        { role: "user", content: "Lets go to hemlöp stäket" },
        { role: "user", content: "Hemköp" },
      ]),
      true,
    );
    // Ordinary questions never trigger the note.
    assert.equal(needsAnchorAsk([{ role: "user", content: "what is the capital of France" }]), false);
    assert.equal(needsAnchorAsk([{ role: "user", content: "Hemköp" }]), false); // fragment with nothing pending
    assert.equal(needsAnchorAsk([]), false);
  });

  test("physicalLocationAsk is a here-ask on its own (unresolved-note path)", () => {
    assert.equal(physicalLocationAsk("show me my actual location"), true);
    assert.equal(physicalLocationAsk("where i actually am"), true);
    assert.equal(physicalLocationAsk("my location"), false); // plain here-word, not physical
    assert.equal(hereAskIntent([{ role: "user", content: "show me my actual location" }]), true);
  });
});

describe("nearby-place asks — the verbatim 'Gas station near e18 there' report (2026-07-09)", () => {
  const pov = { panoId: "abc", lat: 59.455, lng: 17.8027, heading: 156, pitch: 0, fov: 90 };

  test("extractNearbyPlaceQuery: type word + nearby word → the Places query", () => {
    assert.equal(extractNearbyPlaceQuery("Gas station near e18 there"), "Gas station near e18");
    assert.equal(extractNearbyPlaceQuery("is there a pharmacy nearby?"), "pharmacy");
    assert.equal(extractNearbyPlaceQuery("nearest gas station"), "nearest gas station");
    assert.equal(extractNearbyPlaceQuery("find me a restaurant around here"), "restaurant");
  });

  test("extractNearbyPlaceQuery negatives: no nearby word / no type word / a real address / junk", () => {
    assert.equal(extractNearbyPlaceQuery("restaurants in Oslo"), ""); // ordinary research question
    assert.equal(extractNearbyPlaceQuery("what is that there?"), ""); // deictic without a type — POV path owns it
    assert.equal(extractNearbyPlaceQuery("street view here"), "");
    assert.equal(extractNearbyPlaceQuery("gas station near Storgatan 4"), ""); // address owns the message
    assert.equal(extractNearbyPlaceQuery(""), "");
    assert.equal(extractNearbyPlaceQuery(undefined), "");
  });

  test("with a live panorama, the verbatim ask becomes a nearby search at the view's position — NOT a POV capture", () => {
    const convo = [{ role: "user", content: "Gas station near e18 there" }];
    const out = pickLookup(convo, [], pov);
    assert.deepEqual(out, {
      coords: "",
      address: "",
      nearby: { query: "Gas station near e18", lat: 59.455, lng: 17.8027, mode: "search" },
      followUp: true,
    });
  });

  test("'gas station here' searches nearby instead of here-jumping; 'street view here' still jumps", () => {
    const svConvo = [{ role: "user", content: "street view" }, { role: "user", content: "gas station here" }];
    const out = pickLookup(svConvo, [], pov);
    assert.equal(out?.nearby?.query, "gas station");
    const jump = pickLookup([{ role: "user", content: "street view here" }], [], pov);
    assert.ok(jump?.jump, "street view here must stay a here-jump");
  });

  test("anchors follow the usual precedence: device location works; no anchor resolves nothing", () => {
    const convo = [{ role: "user", content: "nearest gas station" }];
    const fromDevice = pickLookup(convo, [], null, null, { lat: 59.44, lng: 17.8, zoom: 17 });
    assert.deepEqual(fromDevice.nearby, { query: "nearest gas station", lat: 59.44, lng: 17.8, mode: "search" });
    assert.equal(pickLookup(convo, []), null); // ordinary pipeline handles it
  });

  test("nearbyAskMode: teleport = instant drop, travel verbs = the actual travel, else search", () => {
    // The user's refined semantics (2026-07-09): "teleport should just
    // drop you there. If I say 'go to nearest …' then we do the actual
    // travel with waypoints and map views."
    assert.equal(nearbyAskMode("Teleport to nearest gas station"), "instant");
    assert.equal(nearbyAskMode("jump to the pharmacy"), "instant");
    assert.equal(nearbyAskMode("hoppa till närmaste mack"), "instant");
    assert.equal(nearbyAskMode("go to nearest gas station"), "travel");
    assert.equal(nearbyAskMode("take me to a pharmacy"), "travel");
    assert.equal(nearbyAskMode("ta mig till närmaste bensinstation"), "travel");
    assert.equal(nearbyAskMode("gas station near e18 there"), "search");
    assert.equal(nearbyAskMode("nearest pharmacy"), "search");
    // The mode rides through pickLookup.
    const pov2 = { panoId: "p", lat: 59.455, lng: 17.8027, heading: 90, pitch: 0, fov: 90 };
    assert.equal(pickLookup([{ role: "user", content: "go to nearest gas station" }], [], pov2).nearby.mode, "travel");
    assert.equal(pickLookup([{ role: "user", content: "teleport to nearest gas station" }], [], pov2).nearby.mode, "instant");
  });

  test("bearingDeg points the travel captures at the destination", () => {
    assert.equal(bearingDeg(59.0, 17.0, 60.0, 17.0), 0); // due north
    assert.equal(bearingDeg(59.0, 17.0, 58.0, 17.0), 180); // due south
    assert.equal(bearingDeg(59.0, 17.0, 59.0, 18.0), 90); // due east
    const ne = bearingDeg(59.45, 17.8, 59.46, 17.83); // northeast-ish
    assert.ok(ne > 30 && ne < 80, `expected NE-ish, got ${ne}`);
  });

  test("'Go to hemköp' — a relocation to a NAME, no place-type word (the verbatim report)", () => {
    // Reported 2026-07-09: this fell into the web-research pipeline
    // (sources, comparison tables, "I cannot physically move you").
    assert.deepEqual(extractRelocationQuery("Go to hemköp"), { query: "hemköp", mode: "travel" });
    assert.deepEqual(extractRelocationQuery("Teleport to willys"), { query: "willys", mode: "instant" });
    assert.deepEqual(extractRelocationQuery("ta mig till ica maxi"), { query: "ica maxi", mode: "travel" });
    // Idioms and prose never fire.
    assert.equal(extractRelocationQuery("go to sleep"), null);
    assert.equal(extractRelocationQuery("gå till jobbet"), null);
    assert.equal(extractRelocationQuery("when I go to the shop each week I take the bus"), null);
    assert.equal(extractRelocationQuery("go to the other side of the railway"), null); // barrier matcher owns it? — no: barrier word IS the remainder
    const pov2 = { panoId: "p", lat: 59.455, lng: 17.8027, heading: 90, pitch: 0, fov: 90 };
    const out = pickLookup([{ role: "user", content: "Go to hemköp" }], [], pov2);
    assert.deepEqual(out.nearby, { query: "hemköp", lat: 59.455, lng: 17.8027, mode: "travel" });
  });

  test("a fragment resolves the conversation's pending relocation — 'Go to hemköp' → 'Stäket'", () => {
    // The verbatim conversation: the travel was in progress, the pick fell
    // into web research. The pending ask and the fragment combine into one
    // Places query, inheriting the travel mode.
    const pov2 = { panoId: "p", lat: 59.462, lng: 17.8229, heading: 0, pitch: 0, fov: 90 };
    const convo = [
      { role: "user", content: "Teleport to nearest gas station" },
      { role: "assistant", content: "The nearest gas station is Qstar…" },
      { role: "user", content: "Go to hemköp" },
      { role: "assistant", content: "There are two Hemköp stores near your location…" },
      { role: "user", content: "Stäket" },
    ];
    const out = pickLookup(convo, [], pov2);
    assert.deepEqual(out.nearby, { query: "hemköp Stäket", lat: 59.462, lng: 17.8229, mode: "travel" });
    // pendingRelocation looks back through user turns, newest first.
    const users = convo.filter((m) => m.role === "user");
    assert.deepEqual(pendingRelocation(users), { query: "hemköp", mode: "travel" });
    // No pending relocation → a bare fragment resolves nothing.
    assert.equal(pickLookup([{ role: "user", content: "Stäket" }], [], pov2), null);
    // Without an anchor the fragment also resolves nothing (no position to search near).
    assert.equal(pickLookup(convo, []), null);
  });

  test("the verbatim 'Legs go to coop' session (2026-07-09): lets/typo openers, nearest-NAME, go-there resume", () => {
    const pov2 = { panoId: "p", lat: 59.4566, lng: 17.801, heading: 0, pitch: 0, fov: 90 };
    // "Lets go to coop" (and the adjacent-key typo "Legs go to coop") — a
    // relocation to a brand name behind a let's-opener.
    assert.deepEqual(extractRelocationQuery("Lets go to coop"), { query: "coop", mode: "travel" });
    assert.deepEqual(extractRelocationQuery("Legs go to coop"), { query: "coop", mode: "travel" });
    assert.deepEqual(extractRelocationQuery("Let's go to coop"), { query: "coop", mode: "travel" });
    // "nearest coop" — a superlative + NAME, no place-type word.
    assert.equal(extractNearbyPlaceQuery("nearest coop"), "nearest coop");
    assert.equal(extractNearbyPlaceQuery("närmaste coop"), "närmaste coop");
    assert.equal(extractNearbyPlaceQuery("nearest"), ""); // no name — nothing to search
    // "Lets go to the nearest library" — library is a place type now.
    const lib = pickLookup([{ role: "user", content: "Lets go to the nearest library" }], [], pov2);
    assert.equal(lib?.nearby?.query, "nearest library");
    assert.equal(lib?.nearby?.mode, "travel");
    assert.equal(pickLookup([{ role: "user", content: "gå till närmaste bibliotek" }], [], pov2)?.nearby?.mode, "travel");
    // "Go there" / typo "Co there" resume the pending relocation as travel.
    const convo = [
      { role: "user", content: "Lets go to coop" },
      { role: "assistant", content: "Which Coop do you mean?" },
      { role: "user", content: "Go there" },
    ];
    assert.deepEqual(pickLookup(convo, [], pov2).nearby, { query: "coop", lat: 59.4566, lng: 17.801, mode: "travel" });
    const typo = [...convo.slice(0, 2), { role: "user", content: "Co there" }];
    assert.deepEqual(pickLookup(typo, [], pov2).nearby, { query: "coop", lat: 59.4566, lng: 17.801, mode: "travel" });
    // No pending relocation → "go there" falls through to the POV scene
    // gate (the deictic "there" while a panorama is live captures the
    // current view — there is no destination to resume).
    const bare = pickLookup([{ role: "user", content: "Go there" }], [], pov2);
    assert.ok(bare?.pov, "expected the POV scene capture");
    assert.equal(bare.intent, "PovScene");
  });

  test("pickLookup tags the winning matcher (non-enumerable) — the routing trace the logs surface", () => {
    const pov2 = { panoId: "p", lat: 59.4566, lng: 17.801, heading: 0, pitch: 0, fov: 90 };
    assert.equal(pickLookup([{ role: "user", content: "nearest gas station" }], [], pov2).intent, "NearbyPlace");
    assert.equal(pickLookup([{ role: "user", content: "Lets go to coop" }], [], pov2).intent, "RelocationToName");
    assert.equal(pickLookup([{ role: "user", content: "street view here" }], [], pov2).intent, "HereAsk");
    // Non-enumerable: not part of the target-shape contract.
    assert.equal(Object.keys(pickLookup([{ role: "user", content: "street view here" }], [], pov2)).includes("intent"), false);
  });

  test("decodePolyline: Google's reference example; samplePolyline spaces the waypoints", () => {
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    assert.deepEqual(pts, [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
    assert.deepEqual(decodePolyline(""), []);
    assert.deepEqual(decodePolyline(undefined), []);
    // A straight north line of 11 points, ~111m apart: sampling every 300m
    // takes roughly every third point and never the endpoints.
    const line = Array.from({ length: 11 }, (_, i) => ({ lat: 59 + i * 0.001, lng: 17.8 }));
    const samples = samplePolyline(line, 300, 4);
    assert.ok(samples.length >= 2 && samples.length <= 4, `got ${samples.length}`);
    assert.ok(samples.every((p) => p.lat > 59 && p.lat < 59.01));
    assert.deepEqual(samplePolyline([], 300), []);
  });

  test("buildNearbyPlacesBlock mode framing: instant drops, travel narrates the way", () => {
    const places = [{ name: "Qstar", address: "Enköpingsvägen 199", lat: 59.4618, lng: 17.8232, type: "gas station", rating: null, ratingCount: 0, status: "" }];
    const instant = buildNearbyPlacesBlock("nearest gas station", { lat: 59.45, lng: 17.8 }, places, { mode: "instant", panoramaShown: true });
    assert.match(instant, /asked to TELEPORT — they have been dropped straight at the first result/);
    assert.match(instant, /no travel narrative/);
    assert.ok(!instant.includes("Open the answer by saying where the user currently is"));
    const travel = buildNearbyPlacesBlock("nearest gas station", { lat: 59.45, lng: 17.8 }, places, {
      mode: "travel",
      panoramaShown: true,
      anchorPlace: "Nyboda, Stäket",
      routeMapShown: true,
      seriesShown: 3,
    });
    assert.match(travel, /asked to GO there — present it as the actual travel/);
    assert.match(travel, /photo waypoints and route map beside this reply/);
    assert.match(travel, /Open the answer by saying where the user currently is/);
  });

  test("distanceMeters: zero at the same point, ~1.1 km per 0.01° latitude", () => {
    assert.equal(distanceMeters(59.45, 17.8, 59.45, 17.8), 0);
    const d = distanceMeters(59.45, 17.8, 59.46, 17.8);
    assert.ok(d > 1080 && d < 1140, `expected ≈1112 m, got ${d}`);
  });

  test("buildNearbyPlacesBlock lists hits with distance and links, and mandates the top link", () => {
    const anchor = { lat: 59.455, lng: 17.8027 };
    const places = [
      { name: "Circle K Stäket", address: "Enköpingsvägen 1, Järfälla", lat: 59.4462, lng: 17.8031, type: "gas station", rating: 4.2, ratingCount: 310, status: "OPERATIONAL" },
      { name: "OKQ8 Kallhäll", address: "Skarprättarvägen 2, Järfälla", lat: 59.44, lng: 17.81, type: "gas station", rating: 4.0, ratingCount: 120, status: "OPERATIONAL" },
    ];
    const block = buildNearbyPlacesBlock("Gas station near e18", anchor, places, { panoramaShown: true, description: "A forecourt with pumps." });
    assert.match(block, /Google Places was searched around their CURRENT position \(59\.455, 17\.8027\)/);
    assert.match(block, /Circle K Stäket — Enköpingsvägen 1, Järfälla \(gas station, ≈979 m away, rated 4\.2 \(310\)\)/);
    assert.match(block, /2 results, best match first/);
    assert.match(block, /panorama at the first result \(Circle K Stäket\)/);
    assert.match(block, /Visual description of the first result's Street View \(auto-generated\): A forecourt/);
    assert.match(block, /ALWAYS include the first result's Map link/);
    assert.match(block, /do NOT ask them to confirm it/);
    assert.match(block, /NEVER construct or output Google Maps API image URLs/);
    assert.ok(!block.includes("key="));
  });

  test("buildNearbyPlacesBlock with zero hits stays honest — no invented places, no enable steps", () => {
    const block = buildNearbyPlacesBlock("gas station", { lat: 1, lng: 2 }, []);
    assert.match(block, /NO results for this search near the current position/);
    assert.match(block, /never invent a place/);
    assert.match(block, /already enabled — do NOT suggest/);
  });

  test("teleport asks get the say-where-you-are opener, the waypoint route map, and the never-disclaim note", () => {
    // The verbatim 2026-07-09 report: "Teleport to nearest gas station"
    // answered without the user's own location, without a waypoint map, and
    // with "Note: I can't actually 'teleport' you".
    const places = [
      { name: "Qstar", address: "Enköpingsvägen 199, Järfälla", lat: 59.4618, lng: 17.8232, type: "gas station", rating: 4.3, ratingCount: 57, status: "OPERATIONAL" },
    ];
    const block = buildNearbyPlacesBlock("nearest gas station", { lat: 59.4566, lng: 17.801 }, places, {
      panoramaShown: true,
      anchorPlace: "Nyboda, Stäket, Järfälla kommun",
      routeMapShown: true,
    });
    assert.match(block, /current position reverse-geocodes to \(OpenStreetMap Nominatim\): Nyboda, Stäket/);
    assert.match(block, /Open the answer by saying where the user currently is/);
    assert.match(block, /route map with numbered waypoints \(1 = the user's position, last = Qstar\)/);
    assert.match(block, /If the user asked to "jump" or "teleport", that relocation HAS happened/);
    assert.match(block, /NEVER say you cannot teleport/);
  });

  test("teleport/travel verbs count as the nearby trigger and strip out of the query", () => {
    // "if I say 'jump' or 'teleport' I mean just relocate there" — and the
    // instruction works for a place target too (the user's explicit ask).
    assert.equal(extractNearbyPlaceQuery("teleport to the gas station"), "gas station");
    assert.equal(extractNearbyPlaceQuery("jump to the nearest gas station"), "nearest gas station");
    assert.equal(extractNearbyPlaceQuery("get me to a pharmacy"), "pharmacy");
    assert.equal(extractNearbyPlaceQuery("ta mig till närmaste mack"), "närmaste mack");
    assert.equal(extractNearbyPlaceQuery("hoppa till apoteket"), "apoteket");
  });
});

describe("cross-barrier relocations — the verbatim 'Get to the other side of the railway' report (2026-07-09)", () => {
  const pov = { panoId: "abc", lat: 59.455, lng: 17.8027, heading: 156, pitch: 0, fov: 90 };

  test("extractCrossBarrierAsk: the verbatim ask, teleport verbs, and Swedish parity", () => {
    assert.deepEqual(extractCrossBarrierAsk("Get to the other side of the railway"), { barrier: "railway" });
    assert.deepEqual(extractCrossBarrierAsk("jump across the river"), { barrier: "river" });
    assert.deepEqual(extractCrossBarrierAsk("teleport to the other side of the tracks"), { barrier: "tracks" });
    assert.deepEqual(extractCrossBarrierAsk("hoppa över spåret"), { barrier: "spåret" });
    assert.deepEqual(extractCrossBarrierAsk("ta mig till andra sidan järnvägen"), { barrier: "järnvägen" });
    assert.deepEqual(extractCrossBarrierAsk("andra sidan av bron"), { barrier: "bron" }); // short verb-less command
  });

  test("extractCrossBarrierAsk negatives: prose mentions and no barrier word", () => {
    // A long verb-less sentence merely mentioning a far side never fires.
    assert.equal(extractCrossBarrierAsk("the houses on the other side of the river are much older than these ones"), null);
    assert.equal(extractCrossBarrierAsk("get to the other side of the argument"), null);
    assert.equal(extractCrossBarrierAsk(""), null);
    assert.equal(extractCrossBarrierAsk(undefined), null);
  });

  test("with a live panorama the ask becomes a crossBarrier target carrying position + heading", () => {
    const convo = [{ role: "user", content: "Get to the other side of the railway" }];
    const out = pickLookup(convo, [], pov);
    assert.deepEqual(out, {
      coords: "",
      address: "",
      crossBarrier: { barrier: "railway", lat: 59.455, lng: 17.8027, heading: 156, hasHeading: true },
      followUp: true,
    });
  });

  test("device location anchors a fresh-chat crossing; no anchor resolves nothing", () => {
    const convo = [{ role: "user", content: "get to the other side of the railway" }];
    const fromDevice = pickLookup(convo, [], null, null, { lat: 59.45, lng: 17.8, zoom: 17 });
    assert.equal(fromDevice.crossBarrier.barrier, "railway");
    assert.equal(fromDevice.crossBarrier.hasHeading, false);
    assert.equal(pickLookup(convo, []), null);
  });

  test("buildCrossBarrierBlock (found): virtual-navigation note, landing facts, series and mandates", () => {
    const block = buildCrossBarrierBlock("railway", { lat: 59.455, lng: 17.8027 }, {
      found: true,
      bearing: 156,
      distance: 240,
      lat: 59.4531,
      lng: 17.8039,
      place: "Nyboda, Järfälla kommun",
      framesShown: 3,
      panoramaShown: true,
      description: "A quiet residential street.",
    });
    // The load-bearing line — the reported failure was a real-world safety
    // lecture at a panorama user.
    assert.match(block, /VIRTUAL Street View panorama navigation — the user is NOT physically moving/);
    assert.match(block, /Do NOT give real-world safety or route guidance/);
    assert.match(block, /heading 156° \(southeast\), landing ≈240 m/);
    assert.match(block, /reverse-geocodes to \(OpenStreetMap Nominatim\): Nyboda, Järfälla kommun/);
    assert.match(block, /photo series of the virtual crossing \(start → just before the railway → the other side\)/);
    assert.match(block, /ALWAYS include the Map link/);
    assert.ok(!block.includes("key="));
  });

  test("buildCrossBarrierBlock (not found) stays honest — no invented destination", () => {
    const block = buildCrossBarrierBlock("river", { lat: 1, lng: 2 }, { found: false, mapShown: true });
    assert.match(block, /No renewed Street View coverage was found beyond the river/);
    assert.match(block, /never invent a view or a destination/);
    assert.match(block, /interactive Google Map of the current area/);
    assert.match(block, /VIRTUAL Street View panorama navigation/);
  });
});

describe("journey view — the verbatim 'Show how we traveled on maps' request (2026-07-09)", () => {
  // Assistant turns shaped like the real transcript: every relocation
  // answer carries the mandated keyless links.
  const convo = [
    { role: "user", content: "Where am i" },
    {
      role: "assistant",
      content:
        "You appear to be in Nyboda, Stäket.\n" +
        "[View on Google Maps](https://www.google.com/maps/search/?api=1&query=59.45656464541731,17.80098981082323) · " +
        "[Open Street View](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=59.45656464541731,17.80098981082323)",
    },
    { role: "user", content: "Forward 100m" },
    {
      role: "assistant",
      content:
        "You're now about 100 m southeast.\n" +
        "[View on Google Maps](https://www.google.com/maps/search/?api=1&query=59.45500465830343,17.80271919031539)\n" +
        "[Embedded element #2: interactive Google Street View panorama at 59.45500465830343, 17.80271919031539]",
    },
    { role: "user", content: "Jump to other side of railway" },
    {
      role: "assistant",
      content:
        "You've been virtually relocated near Bolinder strand.\n" +
        "[View on Google Maps](https://www.google.com/maps/search/?api=1&query=59.45343107809868,17.79708567685437)",
    },
    { role: "user", content: "Show how we traveled on maps" },
  ];

  test("journeyAsk: EN + SV forms, interrogatives, and negatives", () => {
    assert.equal(journeyAsk("Show how we traveled on maps"), true);
    assert.equal(journeyAsk("show our route"), true);
    assert.equal(journeyAsk("draw the path we took on the map"), true);
    assert.equal(journeyAsk("show the route"), true);
    assert.equal(journeyAsk("how did we get here?"), true);
    assert.equal(journeyAsk("visa rutten"), true);
    assert.equal(journeyAsk("visa hur vi åkte"), true);
    assert.equal(journeyAsk("rita vår färd på kartan"), true);
    assert.equal(journeyAsk("hur kom vi hit?"), true);
    assert.equal(journeyAsk("show me the gas station"), false);
    assert.equal(journeyAsk("what is the best route between Stockholm and Oslo"), false);
    assert.equal(journeyAsk(""), false);
  });

  test("extractJourneyPoints walks assistant turns, dedupes same-position links, ignores user text", () => {
    const points = extractJourneyPoints(convo);
    assert.deepEqual(points, [
      { lat: 59.45656464541731, lng: 17.80098981082323 }, // query= and viewpoint= collapse to one stop
      { lat: 59.45500465830343, lng: 17.80271919031539 }, // link + embed-ref line collapse too
      { lat: 59.45343107809868, lng: 17.79708567685437 },
    ]);
    // User-quoted coordinates never fabricate a stop.
    assert.deepEqual(extractJourneyPoints([{ role: "user", content: "query=59.1,17.1 viewpoint=59.2,17.2" }]), []);
  });

  test("pickLookup routes the verbatim ask to the journey view; a single stop falls through", () => {
    const out = pickLookup(convo, []);
    assert.equal(out.followUp, true);
    assert.equal(out.journey.points.length, 3);
    const oneStop = [convo[1], { role: "user", content: "Show how we traveled on maps" }];
    assert.equal(pickLookup(oneStop, []), null);
  });

  test("buildJourneyBlock: confident journey framing, legs, totals, walking time, directions link", () => {
    const points = extractJourneyPoints(convo);
    const block = buildJourneyBlock(points, {
      route: { distanceMeters: 1500, durationS: 1080 },
      startPlace: "Nyboda, Stäket",
      endPlace: "Bolinder strand, Järfälla",
      mapShown: true,
      embedShown: true,
    });
    // The reported failure: the model disclaimed "no verified route".
    assert.match(block, /Present it AS the journey/);
    assert.match(block, /do not disclaim it as unverified/);
    assert.match(block, /1\. start: 59\.45656464541731, 17\.80098981082323 \(Nyboda, Stäket\)/);
    assert.match(block, /3\. current position: .*\(Bolinder strand, Järfälla\).*from the previous stop \(straight line\)/);
    assert.match(block, /Total straight-line distance along the stops: ≈/);
    assert.match(block, /Along roads\/paths \(Google Routes, walking\): ≈1\.5 km, about 18 min on foot/);
    assert.match(block, /Directions link through all stops: https:\/\/www\.google\.com\/maps\/dir\/59\.45656464541731,17\.80098981082323\//);
    assert.match(block, /route map with the numbered stops/);
    assert.match(block, /ALWAYS include the directions link/);
    assert.ok(!block.includes("key="));
  });

  test("buildJourneyBlock without a Routes result stays honest about walking time", () => {
    const points = [{ lat: 59.1, lng: 17.1 }, { lat: 59.2, lng: 17.2 }];
    const block = buildJourneyBlock(points, {});
    assert.match(block, /could not be computed this time/);
    assert.match(block, /do NOT invent a walking time/);
  });
});

describe("here-asks across turns — the verbatim 'Where am i now' conversation (2026-07-09)", () => {
  const userLocation = { lat: 59.33, lng: 18.06, zoom: 17 };

  test("whereAmIIntent: EN forms + typo set; end-of-clause guard against prose", () => {
    assert.equal(whereAmIIntent("Where am i now"), true);
    assert.equal(whereAmIIntent("where am I?"), true);
    assert.equal(whereAmIIntent("wher am i"), true);
    assert.equal(whereAmIIntent("where are we right now?"), true);
    assert.equal(whereAmIIntent("Where am I? Can you show a map"), true);
    assert.equal(whereAmIIntent("where are we going with this"), false);
    assert.equal(whereAmIIntent("where am i going wrong here"), false);
    assert.equal(whereAmIIntent(""), false);
    assert.equal(whereAmIIntent(undefined), false);
  });

  test("hereFragmentAnswer: short here-phrases only", () => {
    assert.equal(hereFragmentAnswer("My location"), true);
    assert.equal(hereFragmentAnswer("use my location"), true);
    assert.equal(hereFragmentAnswer("här"), true);
    assert.equal(hereFragmentAnswer("what restaurants are here in the town center"), false);
    assert.equal(hereFragmentAnswer("over there"), false);
    assert.equal(hereFragmentAnswer(""), false);
  });

  test("'Where am i now' as the FIRST message jumps to the device location", () => {
    const convo = [{ role: "user", content: "Where am i now" }];
    const out = pickLookup(convo, [], null, null, userLocation);
    assert.deepEqual(out.jump, { lat: 59.33, lng: 18.06, heading: 0, meters: 0, dir: "here" });
  });

  test("'My location' answering an earlier 'Street view' turn jumps to the device location", () => {
    // The reported conversation, verbatim: the street-view word and the
    // here-word arrive in SEPARATE turns.
    const convo = [
      { role: "user", content: "Where am i now" },
      { role: "assistant", content: "I can’t determine your location from this chat alone." },
      { role: "user", content: "Street view" },
      { role: "assistant", content: "Which address or place would you like to view in Street View?" },
      { role: "user", content: "My location" },
    ];
    const out = pickLookup(convo, [], null, null, userLocation);
    assert.deepEqual(out.jump, { lat: 59.33, lng: 18.06, heading: 0, meters: 0, dir: "here" });
  });

  test("a bare here-fragment with NO earlier street-view turn resolves nothing", () => {
    const convo = [{ role: "user", content: "My location" }];
    assert.equal(pickLookup(convo, [], null, null, userLocation), null);
  });

  test("hereAskIntent mirrors the gate for the no-location unresolved note", () => {
    // Same conversations WITHOUT a device location: pickLookup finds no
    // anchor, and enrichment.js asks hereAskIntent to phrase the note as
    // "allow location access" instead of "which address?".
    assert.equal(hereAskIntent([{ role: "user", content: "Where am i now" }]), true);
    assert.equal(
      hereAskIntent([
        { role: "user", content: "Street view" },
        { role: "user", content: "My location" },
      ]),
      true,
    );
    assert.equal(hereAskIntent([{ role: "user", content: "street view here" }]), true);
    assert.equal(hereAskIntent([{ role: "user", content: "My location" }]), false);
    assert.equal(hereAskIntent([{ role: "user", content: "summarize the sources" }]), false);
    assert.equal(hereAskIntent([]), false);
  });
});

describe("buildJumpBlock", () => {
  const jump = { lat: 59.411, lng: 17.9125, heading: 90, meters: 100, dir: "forward" };

  test("a found destination carries links, the fresh panorama, and the description", () => {
    const block = buildJumpBlock(jump, {
      found: true,
      date: "2023-07",
      panoramaShown: true,
      description: "A tree-lined residential street with parked cars.",
    });
    assert.match(block, /asked to open Street View about 100 meters along the road\/direction they are viewing/);
    assert.match(block, /59\.411, 17\.9125, facing 90° \(east\)/);
    assert.match(block, /imagery captured: 2023-07/);
    assert.match(block, /Street View link: /);
    assert.match(block, /interactive Street View panorama positioned at this destination/);
    assert.match(block, /Visual description of the destination's Street View \(auto-generated\): A tree-lined/);
    assert.match(block, /ALWAYS include the Map link above in your answer as a markdown link/);
    assert.match(block, /do NOT ask them to confirm coordinates/);
    assert.match(block, /NEVER construct or output Google Maps API image URLs/);
    assert.ok(!block.includes("key="));
  });

  test("no coverage at the destination says so plainly and shows the map instead", () => {
    const block = buildJumpBlock({ ...jump, dir: "north" }, { found: false, mapShown: true });
    assert.match(block, /about 100 meters to the north of their current position/);
    assert.match(block, /NO Street View panorama near that destination/);
    assert.match(block, /interactive Google Map of the destination is displayed/);
    assert.ok(!/Street View link: /.test(block));
  });

  test("a here-jump reads as the current position", () => {
    const block = buildJumpBlock({ lat: 1, lng: 2, heading: 0, meters: 0, dir: "here" }, { found: true, panoramaShown: true, description: "x" });
    assert.match(block, /open Street View at their current position/);
  });

  test("a reverse-geocoded place names the destination — the actual 'where am I?' answer", () => {
    const block = buildJumpBlock(
      { lat: 1, lng: 2, heading: 0, meters: 0, dir: "here" },
      { found: true, panoramaShown: true, description: "x", place: "Södermalm, Stockholm, Sverige" },
    );
    assert.match(block, /reverse-geocodes to \(OpenStreetMap Nominatim\): Södermalm, Stockholm, Sverige/);
    // The no-coverage branch keeps the place line too — the map still answers.
    const noPano = buildJumpBlock({ lat: 1, lng: 2, heading: 0, meters: 0, dir: "here" }, { found: false, mapShown: true, place: "Södermalm" });
    assert.match(noPano, /reverse-geocodes to .*: Södermalm/);
    // And without one, no empty line appears.
    const bare = buildJumpBlock({ lat: 1, lng: 2, heading: 0, meters: 0, dir: "here" }, { found: false, mapShown: true });
    assert.ok(!bare.includes("reverse-geocodes"));
  });
});

describe("Swedish language parity (audit 2026-07-09) — every gate takes Swedish forms", () => {
  test("street-view intent: definite form, typo, and the gatubild synonym", () => {
    assert.equal(streetViewIntent("visa gatuvyn tack"), true);
    assert.equal(streetViewIntent("gatvy storgatan"), true);
    assert.equal(streetViewIntent("gatubild av Storgatan"), true);
    assert.equal(streetViewIntent("gatubilden här"), true);
  });

  test("follow-up reference gate takes gatuvyn/gatubilden", () => {
    assert.equal(referencesStreetView("kan du visa gatuvyn igen?"), true);
    assert.equal(referencesStreetView("vad syns på gatubilden?"), true);
  });

  test("relative moves: Swedish forward/back/verb forms", () => {
    assert.deepEqual(extractRelativeMove("fortsätt 100 meter längre fram"), { meters: 100, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("följ vägen 200 meter"), { meters: 200, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("gå 150 m uppför gatan"), { meters: 150, mode: "forward", dir: "forward" });
    assert.deepEqual(extractRelativeMove("backa 50 meter"), { meters: 50, mode: "back", dir: "back" });
    assert.deepEqual(extractRelativeMove("flytta 100 m österut"), { meters: 100, mode: "bearing", bearing: 90, dir: "east" });
  });

  test("English 'further' gets the same treatment as 'ahead'", () => {
    assert.deepEqual(extractRelativeMove("continue 100 meters further"), { meters: 100, mode: "forward", dir: "forward" });
  });

  test("named-place visual questions: Swedish quotes, cues, place types, and localities", () => {
    // The Swedish sibling of the verbatim Rosa Pantern report (chat_logs #47).
    const q = "Vad är det för färg på huset mittemot restaurangen ”Rosa Pantern” i Uppsala?";
    assert.equal(extractNamedPlaceQuery(q), "Rosa Pantern, Uppsala");
    assert.deepEqual(pickLookup([{ role: "user", content: q }], []), {
      coords: "",
      address: "Rosa Pantern, Uppsala",
    });
    // The "som heter" naming cue and a Swedish place-type word (gatukök).
    assert.equal(
      extractNamedPlaceQuery("Hur ser huset bredvid gatuköket som heter Rosa Pantern i Uppsala ut?"),
      "Rosa Pantern, Uppsala",
    );
    // A Swedish non-visual question never fires a lookup.
    assert.equal(
      pickLookup([{ role: "user", content: "Vilka öppettider har restaurangen ”Rosa Pantern” i Uppsala?" }], []),
      null,
    );
  });

  test("here-intent: min plats / var jag är / härifrån / den här platsen", () => {
    assert.equal(streetViewHereIntent("gatuvy min plats"), true);
    assert.equal(streetViewHereIntent("visa gatuvyn var jag är"), true);
    assert.equal(streetViewHereIntent("gatubild härifrån"), true);
    assert.equal(streetViewHereIntent("street view på den här platsen"), true);
    // Still needs the street-view word — a bare Swedish here-phrase is not an ask.
    assert.equal(streetViewHereIntent("vad finns på min plats?"), false);
  });

  test("where-am-I intent: var är jag / vart är vi / var befinner jag mig / var någonstans", () => {
    assert.equal(whereAmIIntent("var är jag nu"), true);
    assert.equal(whereAmIIntent("vart är vi?"), true);
    assert.equal(whereAmIIntent("var e jag"), true);
    assert.equal(whereAmIIntent("var befinner jag mig just nu?"), true);
    assert.equal(whereAmIIntent("var någonstans är jag"), true);
    // Prose guard, same as English.
    assert.equal(whereAmIIntent("var är vi på väg"), false);
  });

  test("here-fragment answers: min plats / här / min position", () => {
    const convo = [{ role: "user", content: "gatuvy" }, { role: "user", content: "min plats" }];
    const out = pickLookup(convo, [], null, null, { lat: 59.33, lng: 18.06, zoom: 17 });
    assert.equal(out?.jump?.dir, "here");
    assert.equal(hereFragmentAnswer("här"), true);
    assert.equal(hereFragmentAnswer("min position"), true);
  });

  test("diacritic-less Swedish moves: soderut / vasterut / framat / fortsatt / ga", () => {
    assert.deepEqual(extractRelativeMove("flytta 100 m soderut"), { meters: 100, mode: "bearing", bearing: 180, dir: "south" });
    assert.deepEqual(extractRelativeMove("ga 100 m vasterut"), { meters: 100, mode: "bearing", bearing: 270, dir: "west" });
    assert.equal(extractRelativeMove("100 m framat")?.mode, "forward");
    assert.equal(extractRelativeMove("fortsatt 200 meter langre fram")?.mode, "forward");
  });

  test("physical-location ask: min faktiska plats / där jag faktiskt är", () => {
    assert.equal(physicalLocationAsk("gatuvy min faktiska plats"), true);
    assert.equal(physicalLocationAsk("visa där jag faktiskt är"), true);
    assert.equal(physicalLocationAsk("min plats"), false);
  });

  test("nearby-place asks: närmaste bensinstation / mack i närheten / apotek nära", () => {
    assert.equal(extractNearbyPlaceQuery("närmaste bensinstation"), "närmaste bensinstation");
    assert.equal(extractNearbyPlaceQuery("finns det någon mack i närheten?"), "mack");
    assert.equal(extractNearbyPlaceQuery("bensinstation nära e18 där"), "bensinstation nära e18");
    assert.equal(extractNearbyPlaceQuery("apotek häromkring"), "apotek");
    // Type word without a nearby word stays an ordinary question.
    assert.equal(extractNearbyPlaceQuery("berätta om apoteket i Uppsala"), "");
  });
});

describe("jump landing improvements (live report 2026-07-09)", () => {
  test("jumpSearchRadius scales with the jump distance, floored and capped", () => {
    assert.equal(jumpSearchRadius(0), 150); // "street view here"
    assert.equal(jumpSearchRadius(100), 150); // short jumps keep the floor
    assert.equal(jumpSearchRadius(300), 150);
    assert.equal(jumpSearchRadius(500), 250);
    assert.equal(jumpSearchRadius(1000), 500); // the 'Ol north 1km' case
    assert.equal(jumpSearchRadius(3000), 1000); // capped
    assert.equal(jumpSearchRadius(undefined), 150);
  });

  test("a here-ask with no device location asks for location ACCESS, not an address", () => {
    const block = unresolvedMapsBlock(true);
    assert.match(block, /CURRENT LOCATION/);
    assert.match(block, /allow location access/);
    assert.match(block, /name an address or place instead/);
    assert.match(block, /Do NOT instruct the user to enable/);
    assert.ok(!/Ask the user which address or place they mean/.test(block));
  });

  test("the generic unresolved note is unchanged without the here flag", () => {
    const block = unresolvedMapsBlock();
    assert.match(block, /Ask the user which address or place they mean/);
    assert.ok(!/location access/.test(block));
  });
});

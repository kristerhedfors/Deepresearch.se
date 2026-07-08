import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildMapsBlock,
  buildPovBlock,
  compassDir,
  extractPlace,
  googleMapsAvailable,
  googleMapsEmbedKey,
  mapLink,
  panoLink,
  pickLookup,
  extractLocalityFix,
  extractPlaceQuery,
  referencesStreetView,
  streetViewIntent,
  unresolvedMapsBlock,
  referencesStreetViewScene,
} from "./googlemaps.js";

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
});

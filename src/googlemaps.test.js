import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildMapsBlock,
  extractPlace,
  googleMapsAvailable,
  googleMapsEmbedKey,
  mapLink,
  panoLink,
  pickLookup,
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
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildMapsBlock,
  extractPlace,
  googleMapsAvailable,
  mapLink,
  panoLink,
  pickLookup,
} from "./googlemaps.js";

test("googleMapsAvailable reflects the GOOGLE_MAPS_API_KEY secret", () => {
  assert.equal(googleMapsAvailable({}), false);
  assert.equal(googleMapsAvailable({ GOOGLE_MAPS_API_KEY: "" }), false);
  assert.equal(googleMapsAvailable({ GOOGLE_MAPS_API_KEY: "k" }), true);
});

describe("extractPlace", () => {
  test("pulls a Swedish street address (street word ends in a street morpheme)", () => {
    assert.equal(extractPlace("Kallhäll Maskinistvägen 11"), "Kallhäll Maskinistvägen 11");
    assert.equal(extractPlace("Vad finns på Maskinistvägen 11?"), "Maskinistvägen 11");
    assert.equal(extractPlace("Storgatan 4B ligger i centrum"), "Storgatan 4B");
  });

  test("pulls an English street address (exact street word before the number)", () => {
    assert.equal(extractPlace("The office is at Main Street 5"), "Main Street 5");
  });

  test("does NOT mistake ordinary '<noun> <number>' phrases for addresses", () => {
    assert.equal(extractPlace("the new iPhone 15 is out"), "");
    assert.equal(extractPlace("see Article 5 of the treaty"), "");
    assert.equal(extractPlace("we met on August 5"), "");
    assert.equal(extractPlace("this record 12 times"), "");
    assert.equal(extractPlace("top 10 list"), "");
  });

  test("no false positive when the number comes first (US house-number style unsupported)", () => {
    assert.equal(extractPlace("5 Maskinistvägen"), "");
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
  test("renders place details, coordinates, links and imagery note", () => {
    const block = buildMapsBlock("Maskinistvägen 11", {
      place: { name: "Some Place", address: "Maskinistvägen 11, Kallhäll", type: "point of interest", rating: 4.3, ratingCount: 88, status: "OPERATIONAL" },
      lat: 59.4,
      lng: 17.9,
      streetView: { date: "2022-06" },
      streetViewImage: "data:image/jpeg;base64,aaa",
      staticMapImage: "data:image/jpeg;base64,bbb",
    });
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /Place: Some Place/);
    assert.match(block, /Address: Maskinistvägen 11, Kallhäll/);
    assert.match(block, /Rating: 4\.3 \(88 reviews\)/);
    assert.match(block, /Business status: OPERATIONAL/);
    assert.match(block, /Map link: /);
    assert.match(block, /Street View link: /);
    assert.match(block, /captured: 2022-06/);
    assert.match(block, /Attached to this message/);
    assert.match(block, /--- End of Google Maps ---/);
  });

  test("notes when Street View exists but no image was attached (text-only model)", () => {
    const block = buildMapsBlock("59.4,17.9", {
      place: null,
      lat: 59.4,
      lng: 17.9,
      streetView: { date: "" },
      streetViewImage: null,
      staticMapImage: null,
    });
    assert.match(block, /image not attached/);
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

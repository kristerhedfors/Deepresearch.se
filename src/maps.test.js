import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SV_HEADINGS,
  PLACES_FIELD_MASK,
  bytesToBase64,
  formatPlaces,
  mapLabel,
  mapsAvailable,
  placesNearbyBody,
  staticMapParams,
  streetViewMetadataParams,
  streetViewParams,
} from "./maps.js";

describe("mapsAvailable", () => {
  test("true only with a GOOGLE_MAPS_API_KEY", () => {
    assert.equal(mapsAvailable({ GOOGLE_MAPS_API_KEY: "k" }), true);
    assert.equal(mapsAvailable({}), false);
    assert.equal(mapsAvailable({ GOOGLE_MAPS_API_KEY: "" }), false);
  });
});

describe("streetViewParams", () => {
  test("renders a specific panorama at the requested heading, error-coded", () => {
    const q = streetViewParams("abc/123", 90);
    assert.ok(q.includes("pano=abc%2F123"));
    assert.ok(q.includes("heading=90"));
    assert.ok(q.includes("size=640x400"));
    assert.ok(q.includes("fov=90"));
    assert.ok(q.includes("return_error_code=true"));
  });

  test("four compass headings cover the full circle", () => {
    assert.deepEqual(SV_HEADINGS.map((h) => h.deg), [0, 90, 180, 270]);
  });
});

describe("streetViewMetadataParams", () => {
  test("outdoor imagery near the coordinates", () => {
    assert.equal(streetViewMetadataParams(59.3251, 18.0711), "location=59.3251%2C18.0711&source=outdoor");
  });
});

describe("staticMapParams", () => {
  test("single location: red marker A plus explicit center/zoom", () => {
    const q = staticMapParams([{ lat: 59.3251, lon: 18.0711 }]);
    assert.ok(q.includes(`markers=${encodeURIComponent("color:red|label:A|59.3251,18.0711")}`));
    assert.ok(q.includes("center=59.3251%2C18.0711&zoom=16"));
    assert.ok(q.includes("format=jpg"));
  });

  test("multiple locations: sequential labels, no explicit zoom (auto-fit)", () => {
    const q = staticMapParams([
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
    ]);
    assert.ok(q.includes(encodeURIComponent("label:A|1,2")));
    assert.ok(q.includes(encodeURIComponent("label:B|3,4")));
    assert.ok(!q.includes("zoom="));
  });

  test("caps markers at 4 locations", () => {
    const q = staticMapParams(Array.from({ length: 6 }, (_, i) => ({ lat: i, lon: i })));
    assert.equal((q.match(/markers=/g) || []).length, 4);
  });
});

describe("placesNearbyBody", () => {
  test("250 m circle, popularity-ranked, capped result count", () => {
    const b = placesNearbyBody(59.3251, 18.0711);
    assert.equal(b.locationRestriction.circle.center.latitude, 59.3251);
    assert.equal(b.locationRestriction.circle.center.longitude, 18.0711);
    assert.equal(b.locationRestriction.circle.radius, 250);
    assert.equal(b.rankPreference, "POPULARITY");
    assert.ok(b.maxResultCount >= 1 && b.maxResultCount <= 20);
  });

  test("the field mask stays in sync with what formatPlaces reads", () => {
    for (const field of ["displayName", "primaryTypeDisplayName", "businessStatus", "rating", "userRatingCount", "currentOpeningHours.openNow"]) {
      assert.ok(PLACES_FIELD_MASK.includes(`places.${field}`), `field mask missing ${field}`);
    }
  });
});

describe("formatPlaces", () => {
  test("non-array gives []", () => {
    assert.deepEqual(formatPlaces(null), []);
    assert.deepEqual(formatPlaces(undefined), []);
    assert.deepEqual(formatPlaces({}), []);
  });

  test("full entry: name, kind, rating, reviews, open state", () => {
    const out = formatPlaces([
      {
        displayName: { text: "Café Nero" },
        primaryTypeDisplayName: { text: "Coffee Shop" },
        rating: 4.5,
        userRatingCount: 321,
        currentOpeningHours: { openNow: true },
        businessStatus: "OPERATIONAL",
      },
    ]);
    assert.deepEqual(out, ["Café Nero (Coffee Shop) — 4.5★ (321 reviews), open now"]);
  });

  test("permanently closed is surfaced loudly; OPERATIONAL stays silent", () => {
    const out = formatPlaces([
      { displayName: { text: "Old Bar" }, businessStatus: "CLOSED_PERMANENTLY" },
      { displayName: { text: "Pop-up" }, businessStatus: "CLOSED_TEMPORARILY" },
    ]);
    assert.deepEqual(out, ["Old Bar — PERMANENTLY CLOSED", "Pop-up — temporarily closed"]);
  });

  test("closed-right-now differs from unknown hours; nameless entries drop", () => {
    const out = formatPlaces([
      { displayName: { text: "Night Club" }, currentOpeningHours: { openNow: false } },
      { displayName: { text: "  " } },
      { rating: 5 },
      { displayName: { text: "No Extras" } },
    ]);
    assert.deepEqual(out, ["Night Club — closed right now", "No Extras"]);
  });

  test("caps at 20 entries", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ displayName: { text: `Place ${i}` } }));
    assert.equal(formatPlaces(many).length, 20);
  });
});

describe("bytesToBase64", () => {
  test("matches Node's own encoder, including across chunk boundaries", () => {
    for (const len of [0, 1, 3, 8192, 8193, 20000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7 + len) % 256);
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `length ${len}`);
    }
  });
});

describe("mapLabel", () => {
  test("singular and plural marker descriptions", () => {
    assert.match(mapLabel([{ lat: 1, lon: 2 }]), /red marker/);
    assert.match(mapLabel([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]), /markers A–B/);
  });
});

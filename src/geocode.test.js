import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { streetViewUrl, overpassQuery, formatNearby } from "./geocode.js";

describe("streetViewUrl", () => {
  test("builds a keyless Maps URLs API pano link from the coordinates", () => {
    const url = streetViewUrl(59.3251, 18.0711);
    assert.equal(url, "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=59.3251%2C18.0711");
  });

  test("carries negative coordinates through unchanged", () => {
    assert.match(streetViewUrl(-33.8568, -70.6483), /viewpoint=-33\.8568%2C-70\.6483$/);
  });
});

describe("overpassQuery", () => {
  test("queries every establishment tag family around the coordinates, named only", () => {
    const q = overpassQuery(59.3251, 18.0711);
    assert.match(q, /^\[out:json\]\[timeout:\d+\];/);
    for (const tag of ["amenity", "shop", "tourism", "leisure"]) {
      assert.ok(q.includes(`nwr(around:250,59.3251,18.0711)[name][${tag}];`), `missing ${tag} clause`);
    }
    assert.match(q, /out center \d+;$/);
  });
});

describe("formatNearby", () => {
  test("non-array and empty inputs give []", () => {
    assert.deepEqual(formatNearby(null), []);
    assert.deepEqual(formatNearby(undefined), []);
    assert.deepEqual(formatNearby("nope"), []);
    assert.deepEqual(formatNearby([]), []);
  });

  test("labels each entry with its tag kind, underscores spaced", () => {
    const out = formatNearby([
      { tags: { name: "Café Nero", amenity: "cafe" } },
      { tags: { name: "City Gym", leisure: "fitness_centre" } },
    ]);
    assert.deepEqual(out, ["Café Nero (cafe)", "City Gym (fitness centre)"]);
  });

  test("skips unnamed elements and dedupes case-insensitively across node/way copies", () => {
    const out = formatNearby([
      { tags: { amenity: "bench" } }, // no name
      { tags: { name: "  " } }, // blank name
      { tags: { name: "Grand Hotel", tourism: "hotel" } },
      { tags: { name: "GRAND HOTEL", amenity: "restaurant" } }, // same place, other family
      null,
      { notags: true },
    ]);
    assert.deepEqual(out, ["Grand Hotel (hotel)"]);
  });

  test("caps the list at 20 entries", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ tags: { name: `Shop ${i}`, shop: "bakery" } }));
    assert.equal(formatNearby(many).length, 20);
  });

  test("an element with a name but no known tag family keeps the bare name", () => {
    assert.deepEqual(formatNearby([{ tags: { name: "Mystery Spot" } }]), ["Mystery Spot"]);
  });
});

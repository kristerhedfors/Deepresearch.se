import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { addDeckEntries, deckEntries, nearestDeckIndex, resetDeck } from "./imagedeck.js";

// The deck's pure core (registry order, validation, nearest-waypoint
// lookup) runs in Node unmodified — the lightbox DOM only exists once
// openDeck is called in a browser.

const IMG = "data:image/jpeg;base64,AAAA";

beforeEach(() => resetDeck());

test("addDeckEntries keeps conversation order and returns the strip's start index", () => {
  assert.equal(addDeckEntries([{ url: IMG, caption: "first" }]), 0);
  const start = addDeckEntries([
    { url: IMG, caption: "second", lat: 59.45, lng: 17.8 },
    { url: IMG, caption: "third", kind: "map", lat: 59.46, lng: 17.81 },
  ]);
  assert.equal(start, 1);
  const entries = deckEntries();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.caption), ["first", "second", "third"]);
  assert.equal(entries[0].lat, null); // coordinates optional — mini-map just hides
  assert.equal(entries[1].kind, "photo");
  assert.equal(entries[2].kind, "map");
});

test("addDeckEntries drops non-data-URL frames and coerces junk coordinates", () => {
  addDeckEntries([
    { url: "https://example.com/x.jpg", caption: "remote — rejected" },
    { url: IMG, caption: "kept", lat: "not-a-number", lng: 17.8 },
    null,
  ]);
  const entries = deckEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lat, null); // one bad coordinate → no position at all
});

test("nearestDeckIndex finds the LATEST image within the radius — the deck opens where the user last was", () => {
  addDeckEntries([
    { url: IMG, caption: "start", lat: 59.45656, lng: 17.80099 },
    { url: IMG, caption: "no position" },
    { url: IMG, caption: "junction", lat: 59.455, lng: 17.80272 },
    { url: IMG, caption: "junction revisited", lat: 59.45501, lng: 17.80272 }, // ~1m away — later visit wins
  ]);
  assert.equal(nearestDeckIndex(59.455, 17.80272), 3);
  assert.equal(nearestDeckIndex(59.45656, 17.80099), 0);
  // Nothing within 30m of a point far from every stop.
  assert.equal(nearestDeckIndex(59.5, 17.9), -1);
  // A widened radius reaches the nearest stop.
  assert.ok(nearestDeckIndex(59.4551, 17.80272, 200) >= 2);
});

test("resetDeck empties the registry (conversation-scoped, like the POV/map view)", () => {
  addDeckEntries([{ url: IMG, caption: "x" }]);
  resetDeck();
  assert.deepEqual(deckEntries(), []);
  assert.equal(nearestDeckIndex(59.45, 17.8), -1);
});

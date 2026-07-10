// Node tests for imagedeck.js's pure core: entry validation/order, keyless embed URLs, latest-within-radius lookup.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  addDeckEntries,
  deckEntries,
  keylessMapEmbedUrl,
  keylessStreetViewEmbedUrl,
  nearestDeckIndex,
  resetDeck,
} from "./imagedeck.js";

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

test("entries keep the frame's heading so an ask reproduces exactly that view", () => {
  addDeckEntries([
    { url: IMG, caption: "faced SE", lat: 59.45, lng: 17.8, heading: 156 },
    { url: IMG, caption: "no heading", lat: 59.46, lng: 17.81 },
  ]);
  const entries = deckEntries();
  assert.equal(entries[0].heading, 156);
  assert.equal(entries[1].heading, 0); // defaults straight north
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

// The keyless embed URLs — the fix for chat_logs #170/#171 (2026-07-09,
// "mini image in maps view is just white"): the key-based embed/v1 renders
// a white rejection page when the key lacks the Maps Embed API service, so
// the mini-map and the SDK-failure fallbacks use Google's keyless
// output=embed / output=svembed surfaces, which need no key at all.
test("keylessMapEmbedUrl: keyless output=embed with the position and zoom", () => {
  const u = new URL(keylessMapEmbedUrl(59.4693, 17.8119, 16));
  assert.equal(u.origin + u.pathname, "https://maps.google.com/maps");
  assert.equal(u.searchParams.get("q"), "59.4693,17.8119");
  assert.equal(u.searchParams.get("z"), "16");
  assert.equal(u.searchParams.get("output"), "embed");
  assert.equal(u.searchParams.get("key"), null); // keyless is the point
  // Junk zoom falls back to 16 instead of emitting "NaN".
  assert.equal(new URL(keylessMapEmbedUrl(1, 2, "junk")).searchParams.get("z"), "16");
});

test("keylessStreetViewEmbedUrl: keyless output=svembed; cbp pitch is inverted vs the SDK's", () => {
  const u = new URL(keylessStreetViewEmbedUrl(59.4693, 17.8119, 120, 10));
  assert.equal(u.origin + u.pathname, "https://maps.google.com/maps");
  assert.equal(u.searchParams.get("layer"), "c");
  assert.equal(u.searchParams.get("cbll"), "59.4693,17.8119");
  // SDK pitch +10 (up) must arrive as cbp -10 (verified against the
  // embed?pb redirect: cbp …,-10 → pb 4f10).
  assert.equal(u.searchParams.get("cbp"), "11,120,0,0,-10");
  assert.equal(u.searchParams.get("output"), "svembed");
  assert.equal(u.searchParams.get("key"), null);
  // Defaults: no heading/pitch → 0s, junk coerces instead of "NaN".
  assert.equal(new URL(keylessStreetViewEmbedUrl(1, 2)).searchParams.get("cbp"), "11,0,0,0,0");
  assert.equal(new URL(keylessStreetViewEmbedUrl(1, 2, "x", "y")).searchParams.get("cbp"), "11,0,0,0,0");
});

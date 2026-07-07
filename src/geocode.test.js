// Unit tests for the reverse-geocoding enrichment (src/geocode.js): the
// fetch-level fail-soft contract of reverseGeocode and the conversation/
// SSE-step contract of augmentWithLocations, with the network mocked.
// Deliberately loose on service-name wording (the maps provider is an
// implementation detail that has changed once already) — assertions target
// the step ids, the fail-soft outcomes, and the appended context block.

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { augmentWithLocations, reverseGeocode } from "./geocode.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };
const realFetch = globalThis.fetch;

function mockFetch(impl) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return impl(String(url), opts);
  };
  return calls;
}

const okResponse = (body) => ({ ok: true, json: async () => body });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("reverseGeocode", () => {
  it("returns the display name and sends only coordinates, with a generic UA", async () => {
    const calls = mockFetch(() => okResponse({ display_name: "Tribeca, Manhattan, New York" }));
    const place = await reverseGeocode({}, noopLog, 40.7128, -74.006);
    assert.equal(place, "Tribeca, Manhattan, New York");
    assert.equal(calls.length, 1);
    const { url, opts } = calls[0];
    assert.match(url, /lat=40.7128/);
    assert.match(url, /lon=-74.006/);
    // Minimal-request promise: nothing identifying crosses the wire.
    const ua = opts.headers["User-Agent"] || "";
    assert.ok(ua, "a non-default User-Agent is required by the usage policy");
    assert.ok(!/deepresearch/i.test(ua), "UA must not name the site");
    assert.ok(!url.includes("photo"), "no filename in the request");
  });

  it("returns null on a non-ok response instead of throwing", async () => {
    mockFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
    assert.equal(await reverseGeocode({}, noopLog, 1, 2), null);
  });

  it("returns null when fetch itself fails (timeout, network)", async () => {
    mockFetch(() => {
      throw new Error("The operation was aborted due to timeout");
    });
    assert.equal(await reverseGeocode({}, noopLog, 1, 2), null);
  });

  it("returns null when the response carries no usable place name", async () => {
    mockFetch(() => okResponse({ error: "Unable to geocode" }));
    assert.equal(await reverseGeocode({}, noopLog, 1, 2), null);
    mockFetch(() => okResponse({ display_name: "" }));
    assert.equal(await reverseGeocode({}, noopLog, 1, 2), null);
  });
});

describe("augmentWithLocations", () => {
  const conversation = [{ role: "user", content: "Where was this taken?" }];

  it("returns the conversation untouched, with no step events, when nothing valid to resolve", async () => {
    const calls = mockFetch(() => okResponse({ display_name: "x" }));
    const events = [];
    for (const raw of [undefined, null, [], "junk", [{ name: "a", lat: 999, lon: 0 }]]) {
      const out = await augmentWithLocations({}, noopLog, (e) => events.push(e), conversation, raw);
      assert.equal(out, conversation);
    }
    assert.equal(events.length, 0, "no spurious activity step for ordinary questions");
    assert.equal(calls.length, 0);
  });

  it("appends a labeled resolved-location block and emits start/done steps", async () => {
    mockFetch(() => okResponse({ display_name: "Kungsträdgården, Stockholm" }));
    const events = [];
    const out = await augmentWithLocations(
      {}, noopLog, (e) => events.push(e), conversation,
      [{ name: "photo.jpg", lat: 59.3293, lon: 18.0686 }],
    );

    // Step contract: one start + one done, both id "geocode", done carries
    // the per-photo detail lines.
    assert.equal(events.length, 2);
    assert.equal(events[0].status.type, "step_start");
    assert.equal(events[0].status.id, "geocode");
    assert.match(events[0].status.label, /photo location/i);
    assert.equal(events[1].status.type, "step_done");
    assert.equal(events[1].status.id, "geocode");
    assert.deepEqual(events[1].status.details, ["photo.jpg: near Kungsträdgården, Stockholm"]);

    // Conversation contract: the block is appended to the LAST message's
    // text as its own labeled section; the input array is not mutated.
    assert.notEqual(out, conversation);
    assert.equal(conversation[0].content, "Where was this taken?");
    assert.match(out[0].content, /^Where was this taken\?/);
    assert.match(out[0].content, /Resolved location/i);
    assert.match(out[0].content, /photo\.jpg: near Kungsträdgården, Stockholm/);
  });

  it("fails soft when no lookup resolves: done step, conversation unchanged", async () => {
    mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const events = [];
    const out = await augmentWithLocations(
      {}, noopLog, (e) => events.push(e), conversation,
      [{ name: "photo.jpg", lat: 1, lon: 2 }],
    );
    assert.equal(out, conversation);
    assert.equal(events[1].status.type, "step_done");
    assert.deepEqual(events[1].status.details, []);
  });

  it("keeps the resolvable photos when others fail", async () => {
    mockFetch((url) =>
      url.includes("lat=1") ? okResponse({ display_name: "Somewhere" }) : okResponse({}),
    );
    const events = [];
    const out = await augmentWithLocations(
      {}, noopLog, (e) => events.push(e), conversation,
      [
        { name: "a.jpg", lat: 1, lon: 2 },
        { name: "b.jpg", lat: 3, lon: 4 },
      ],
    );
    assert.deepEqual(events[1].status.details, ["a.jpg: near Somewhere"]);
    assert.match(out[0].content, /a\.jpg: near Somewhere/);
    assert.ok(!/b\.jpg/.test(out[0].content));
  });

  it("caps lookups at the validation limit and works without an emit callback", async () => {
    const calls = mockFetch(() => okResponse({ display_name: "x" }));
    const raw = Array.from({ length: 9 }, (_, i) => ({ name: `p${i}.jpg`, lat: i, lon: i }));
    const out = await augmentWithLocations({}, noopLog, undefined, conversation, raw);
    assert.equal(calls.length, 4, "validateImageLocations caps at 4 locations");
    assert.match(out[0].content, /p0\.jpg/);
  });
});

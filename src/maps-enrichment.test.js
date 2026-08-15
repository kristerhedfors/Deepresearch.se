// Unit suite for the Google Maps enrichment RUNNER (src/maps-enrichment.js)
// and the REST layer underneath it (src/googlemaps.js) — the two pieces the
// existing 1850-line src/googlemaps.test.js deliberately leaves out ("The REST
// clients and the enrichment runners need live Google/Berget and are covered
// by live verification instead"). Nothing here re-tests a pure text gate or a
// pure block builder; that file owns those exhaustively.
//
// Written after chat_logs #1670 (2026-08-06) showed an enrichment silently
// producing nothing with the knob on, the secret set, and a matching message —
// the trigger path itself was untested. So what is pinned here is the TRIGGER
// PATH end to end, with `globalThis.fetch` faked over Google's four Maps
// Platform APIs (Places / Street View metadata / Street View + Static Maps
// imagery / Routes), Nominatim, and Berget's vision describe-helper:
//
//   • it FIRES — a step, a Places lookup, an appended block, and both
//     `state.ext.maps` write-backs (`count` → the `google_maps` chat_logs
//     meta key, `intent` → the `maps_intent` routing trace);
//   • it STAYS SILENT — the same conversation array reference back, no step,
//     no outbound request, `maps_intent: "none"`;
//   • it is WIRED IN — with the knob off, `extensionEnrichments()` never
//     reaches the runner at all (no fetch, no step, no `intent` written);
//   • it FAILS SOFT in every branch (CLAUDE.md invariant 2) — an API error, a
//     ZERO_RESULTS coverage miss, a dead vision helper, a Routes outage, a
//     `fetch` that throws outright, and a null lookup all degrade, never throw;
//   • untrusted CLIENT INPUT (`street_view_pov` / `map_view` / `user_location`)
//     is sanitised at the `resolveState` seam before it can reach an outbound
//     Google URL, and is read at all only when the knob is on;
//   • PRIVACY (invariant 4) — outbound Google requests carry the address or a
//     coordinate and the key, never the user's question, an attached filename,
//     or an account/session id; and the keyless links the RUNNER's block
//     builds never carry an API key;
//   • ENV GATING — no GOOGLE_MAPS_API_KEY means no outbound request at all.
//
// Swedish parity (invariant 6) is pinned at the runner level only: the pure
// gates' EN⇄SV breadth lives in googlemaps.test.js's "Swedish language
// parity" suite. Here a Swedish address ask and a Swedish relocation ask must
// reach the SAME runner branches as their English twins.
//
// Deliberately NOT `// @ts-check`: the client-input suite feeds deliberately
// malformed shapes (prototype-pollution payloads, strings where numbers go,
// Infinity, nested objects) that strict types would reject by design.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { extensionEnrichments, getExtension, resolveExtensionState } from "./extensions.js";
import { enrichmentApplies } from "./enrichment.js";
import { runGoogleMapsEnrichment } from "./maps-enrichment.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

// ---- fixtures ---------------------------------------------------------------

const SERVER_KEY = "AIza-SERVER-KEY-DO-NOT-LEAK";
const EMBED_KEY = "AIza-EMBED-KEY-DO-NOT-LEAK";
const BERGET_TOKEN = "berget-token-do-not-leak";

const envWithKeys = () => ({
  GOOGLE_MAPS_API_KEY: SERVER_KEY,
  GOOGLE_MAPS_EMBED_KEY: EMBED_KEY,
  BERGET_API_TOKEN: BERGET_TOKEN,
});

// The firing message. The sensitive material sits AFTER the client's block
// separator ("\n\n---"), which is exactly where the runner cuts the question
// it hands the vision helper — so the filename must never leave the isolate.
const ADDRESS_QUESTION = "What does the building at Main Street 5 look like?";
const SECRET_FILENAME = "acme-payroll-CONFIDENTIAL.xlsx";
const ADDRESS_MESSAGE =
  `${ADDRESS_QUESTION}\n\n--- Attached document: ${SECRET_FILENAME} ---\nrow one\nrow two\n--- End of document ---`;

// An ordinary research question naming no location at all.
const QUIET_QUESTION = "Summarize recent research on solid-state battery chemistry";

const SESSION_ID = "sess-9f3a-DO-NOT-LEAK";
const ACCOUNT_ID = "user-42-DO-NOT-LEAK";

/** A tiny JPEG-shaped body — the image fetchers only need bytes. */
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]), { status: 200 });

/** One OpenAI-style SSE completion, as Berget's streaming endpoint returns it. */
function sseCompletion(text) {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 31, completion_tokens: 17 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const DESCRIPTION = "A four-storey brick building faces the street.";

const OK_META = {
  status: "OK",
  date: "2023-05",
  pano_id: "PANO_TEST_1",
  location: { lat: 42.100011, lng: -71.200022 },
};
const OK_PLACES = {
  places: [
    {
      displayName: { text: "Acme HQ" },
      formattedAddress: "Main Street 5, Springfield",
      location: { latitude: 42.1, longitude: -71.2 },
      primaryType: "corporate_office",
      rating: 4.2,
      userRatingCount: 33,
      businessStatus: "OPERATIONAL",
    },
  ],
};

/**
 * The happy-path route table. Order matters: the Street View METADATA URL is a
 * prefix-extension of the Street View IMAGE URL, so it must be matched first.
 * Every entry may be overridden per test.
 */
function googleRoutes(over = {}) {
  const pick = (k, fallback) => (k in over ? over[k] : fallback);
  return [
    [/maps\/api\/streetview\/metadata/, pick("meta", () => OK_META)],
    [/places\.googleapis\.com/, pick("places", () => OK_PLACES)],
    [/maps\/api\/streetview/, pick("svImage", () => jpeg())],
    [/maps\/api\/staticmap/, pick("staticMap", () => jpeg())],
    [/routes\.googleapis\.com/, pick("routes", () => ({
      routes: [{ distanceMeters: 812, duration: "610s", polyline: { encodedPolyline: "" } }],
    }))],
    [/nominatim\.openstreetmap\.org/, pick("nominatim", () => ({ display_name: "Test Place, Test City" }))],
    [/api\.berget\.ai/, pick("berget", () => sseCompletion(DESCRIPTION))],
  ];
}

/** The per-request state the runner reads — core fields plus its own slice. */
function makeState(over = {}) {
  const { maps: mapsOver = {}, ...rest } = over;
  return {
    // The answering agent's resolved capability. Since 2026-08-13 an extension
    // needs BOTH its per-account knob and the agent's declaration of its
    // context block (src/extensions.js seam 6, the Cyber agent's
    // `street-imagery`), so a state built without this reaches the registry
    // seam and stops there. The runner itself never reads it — these tests call
    // it directly — but the wiring suite below goes through the registry.
    capability: { context: ["street-imagery"] },
    imageLocations: [],
    visionModel: null,
    visionModels: [],
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    // Core identity fields the runner has no business forwarding anywhere.
    sessionId: SESSION_ID,
    uid: ACCOUNT_ID,
    ext: {
      maps: { on: true, count: 0, intent: undefined, pov: null, view: null, userLocation: null, ...mapsOver },
      shodan: { on: false, count: 0 },
    },
    ...rest,
  };
}

/** A conversation from a string, or passed through when already an array. */
const convoOf = (c) => (Array.isArray(c) ? c : [{ role: "user", content: c }]);

/**
 * Drives runGoogleMapsEnrichment with its POSITIONAL signature
 * (env, log, emit, step, stepDone, conversation, state) over a faked fetch.
 */
async function run(input, opts = {}) {
  const steps = [];
  const logs = [];
  const events = [];
  const state = opts.state || makeState(opts.stateOver);
  const env = "env" in opts ? opts.env : envWithKeys();
  const conversation = convoOf(input);
  const log = {
    info: (e, m) => logs.push([e, m]),
    warn: (e, m) => logs.push([e, m]),
    error: (e, m) => logs.push([e, m]),
    debug: () => {},
  };
  let out;
  let stub;
  await withFakeFetch(opts.routes || googleRoutes(), async (s) => {
    stub = s;
    out = await runGoogleMapsEnrichment(
      env,
      log,
      (ev) => events.push(ev),
      (id, label) => steps.push(["start", id, label]),
      (id, label, details) => steps.push(["done", id, label, details]),
      conversation,
      state,
    );
  });
  return { out, steps, logs, events, state, conversation, stub };
}

/** The text of the last message, however its content is shaped. */
const lastText = (convo) => {
  const c = convo[convo.length - 1].content;
  return typeof c === "string"
    ? c
    : (c || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
};

/** The appended Maps block only (everything after the original message). */
const blockOf = (res) => lastText(res.out).slice(lastText(res.conversation).length);

const logEvents = (res) => res.logs.map(([e]) => e);
const statuses = (res) => res.events.map((e) => e.status?.type);

// ============================================================================
// 1. It fires end to end
// ============================================================================

describe("fires end to end on a street address", () => {
  test("a step, a Places lookup, and an appended Google Maps block", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });

    // A visible step naming the service, opened and closed.
    assert.deepEqual(res.steps[0], ["start", "maps", "Checking Google Maps…"]);
    const done = res.steps.find((s) => s[0] === "done");
    assert.ok(done, "the step must be closed");
    assert.equal(done[1], "maps");

    // Places was actually called, with the parsed address and nothing else.
    const places = res.stub.matching(/places\.googleapis\.com/);
    assert.equal(places.length, 1);
    assert.equal(places[0].method, "POST");
    assert.deepEqual(JSON.parse(places[0].body), { textQuery: "Main Street 5", maxResultCount: 1 });
    assert.equal(places[0].headers["x-goog-api-key"], SERVER_KEY);

    // The block is APPENDED — a new array, the original untouched.
    assert.notEqual(res.out, res.conversation);
    const block = blockOf(res);
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /--- End of Google Maps ---/);
    assert.match(block, /Main Street 5, Springfield/);
    // The vision describe-helper's text is what reaches the answer model.
    assert.ok(block.includes(DESCRIPTION), "the describe-helper's text must land in the block");
    assert.equal(done[2], "Google Maps data + Street View described");
  });

  test("the four cardinal frames + the road map are fetched and the frames are emitted", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    assert.equal(res.stub.matching(/maps\/api\/streetview\?/).length, 4);
    assert.equal(res.stub.matching(/maps\/api\/staticmap/).length, 1);
    assert.ok(statuses(res).includes("streetview_frames"));
    assert.ok(statuses(res).includes("streetview_embed"));
    const frames = res.events.find((e) => e.status.type === "streetview_frames").status.frames;
    assert.deepEqual(frames.map((f) => f.dir), ["north", "east", "south", "west"]);
    assert.deepEqual(frames.map((f) => f.heading), [0, 90, 180, 270]);
  });

  test("with no vision helper the imagery is never billed and the block still lands", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: null } });
    assert.equal(res.stub.matching(/maps\/api\/streetview\?/).length, 0);
    assert.equal(res.stub.matching(/maps\/api\/staticmap/).length, 0);
    assert.equal(res.stub.matching(/api\.berget\.ai/).length, 0);
    assert.match(blockOf(res), /--- Google Maps ---/);
    assert.equal(res.steps.find((s) => s[0] === "done")[2], "Google Maps data found");
  });

  test("the vision helper's tokens are billed to state.visionTotals, not the answer model's", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    assert.deepEqual(res.state.visionTotals, { prompt_tokens: 31, completion_tokens: 17 });
  });
});

describe("the state.ext.maps write-backs (the chat_logs meta)", () => {
  test("count lands and becomes the google_maps meta key", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    assert.equal(res.state.ext.maps.count, 1);
    assert.equal(getExtension("maps").logMeta(res.state.ext.maps).google_maps, 1);
  });

  test("intent lands as the MATCHER NAME on a firing case (maps_intent)", async () => {
    const res = await run(ADDRESS_MESSAGE);
    assert.equal(res.state.ext.maps.intent, "NewAddress");
    assert.equal(getExtension("maps").logMeta(res.state.ext.maps).maps_intent, "NewAddress");
    // …and it is logged, which is where Workers Logs shows the routing.
    const intentLine = res.logs.find(([e]) => e === "maps.intent");
    assert.ok(intentLine, "maps.intent must be logged on every run");
    assert.equal(intentLine[1].intent, "NewAddress");
  });

  test("intent is 'none' on a NON-firing case", async () => {
    const res = await run(QUIET_QUESTION);
    assert.equal(res.state.ext.maps.intent, "none");
    assert.equal(getExtension("maps").logMeta(res.state.ext.maps).maps_intent, "none");
  });

  test("a POV capture and a nearby search report their own matcher names", async () => {
    const pov = { panoId: "PANO_LIVE", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 };
    const povRes = await run(
      [
        { role: "user", content: "street view of Maskinistvägen 11" },
        { role: "assistant", content: "…" },
        { role: "user", content: "Describe the person" },
      ],
      { stateOver: { maps: { pov } } },
    );
    assert.equal(povRes.state.ext.maps.intent, "PovScene");

    const nearbyRes = await run("gas station near me", {
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
    });
    assert.equal(nearbyRes.state.ext.maps.intent, "NearbyPlace");
  });
});

// ============================================================================
// 2. It does not fire
// ============================================================================

describe("silent on a question that names no location", () => {
  test("the SAME array reference back, no step, no outbound request", async () => {
    const res = await run(QUIET_QUESTION);
    assert.equal(res.out, res.conversation, "the conversation must come back unchanged");
    assert.deepEqual(res.steps, []);
    assert.deepEqual(res.events, []);
    assert.deepEqual(res.stub.requests, [], "an ordinary question must cost nothing at Google");
    assert.equal(res.state.ext.maps.count, 0);
  });

  test("a research follow-up after a Street View turn does not re-bill a lookup", async () => {
    const res = await run([
      { role: "user", content: "show street view of Maskinistvägen 11" },
      { role: "assistant", content: "…" },
      { role: "user", content: "who owns the property according to public records?" },
    ]);
    assert.equal(res.out, res.conversation);
    assert.deepEqual(res.stub.requests, []);
    assert.equal(res.state.ext.maps.intent, "none");
  });
});

describe("the knob gates the runner at the registry seam", () => {
  /** The core loop src/enrichment.js runs, over the EXTENSION entries only. */
  async function runViaRegistry(body, on, message) {
    const state = makeState();
    state.ext = resolveExtensionState(body, { maps: on });
    const steps = [];
    const conversation = convoOf(message);
    let convo = conversation;
    let stub;
    await withFakeFetch(googleRoutes(), async (s) => {
      stub = s;
      for (const e of extensionEnrichments()) {
        // The gate as runEnrichments applies it — the knob AND the agent's
        // declared context block, composed in the one place that may compose them.
        if (!enrichmentApplies(e, state)) continue;
        convo = await e.run({
          env: envWithKeys(),
          log: { info() {}, warn() {}, error() {}, debug() {} },
          emit() {},
          step: (id, label) => steps.push(["start", id, label]),
          stepDone: (id, label) => steps.push(["done", id, label]),
          conversation: convo,
          state,
        });
      }
    });
    return { convo, conversation, steps, stub, state };
  }

  test("knob OFF: the runner is never reached — no fetch, no step, no intent written", async () => {
    const r = await runViaRegistry({}, false, ADDRESS_MESSAGE);
    assert.equal(r.convo, r.conversation);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.stub.requests, []);
    assert.equal(r.state.ext.maps.intent, undefined, "maps_intent must stay absent when the knob is off");
    // …which is exactly how the meta key disappears from chat_logs.
    assert.equal("maps_intent" in JSON.parse(JSON.stringify(getExtension("maps").logMeta(r.state.ext.maps))), false);
  });

  test("knob ON through the same seam: the runner fires", async () => {
    const r = await runViaRegistry({}, true, ADDRESS_MESSAGE);
    assert.notEqual(r.convo, r.conversation);
    assert.equal(r.steps[0][1], "maps");
    assert.equal(r.state.ext.maps.intent, "NewAddress");
    assert.ok(r.stub.matching(/places\.googleapis\.com/).length > 0);
  });

  test("knob ON but the AGENT does not declare street imagery: still never reached", async () => {
    // The second gate, added 2026-08-13. The knob is the account's consent to
    // send an address to Google; the context block is which agent may use it.
    // A Deep Science turn on an account that switched Maps on must resolve no
    // place and bill no imagery.
    const state = makeState({ capability: { context: ["scholar-metrics"] } });
    state.ext = resolveExtensionState({}, { maps: true });
    const conversation = convoOf(ADDRESS_MESSAGE);
    await withFakeFetch(googleRoutes(), async (stub) => {
      for (const e of extensionEnrichments()) {
        assert.equal(enrichmentApplies(e, state), false, e.id);
      }
      assert.deepEqual(stub.requests, []);
    });
    assert.equal(state.ext.maps.intent, undefined);
    assert.equal(conversation.length, 1);
  });
});

// ============================================================================
// 3. The anchor-missing branch
// ============================================================================

describe("the anchor-missing branch (a relocation ask with no device location)", () => {
  test("appends the allow-location-access note and sets intent 'anchor-missing'", async () => {
    const res = await run("Lets go to hemköp stäket");
    assert.equal(res.state.ext.maps.intent, "anchor-missing");
    assert.notEqual(res.out, res.conversation);
    const block = blockOf(res);
    assert.match(block, /--- Google Maps ---/);
    assert.match(block, /allow location access/);
    assert.match(block, /Do NOT instruct the user to enable Google Maps/);
    // No target resolved, so nothing is looked up and no step opens.
    assert.deepEqual(res.steps, []);
    assert.deepEqual(res.stub.requests, []);
    assert.equal(res.state.ext.maps.count, 0);
  });

  test("an explicit street-view ask with NO place asks which address — intent stays 'none'", async () => {
    const res = await run("show me street view");
    assert.equal(res.state.ext.maps.intent, "none");
    const block = blockOf(res);
    assert.match(block, /no address or place name could be identified/);
    assert.match(block, /Ask the user which address or place they mean/);
    assert.deepEqual(res.stub.requests, []);
  });

  test("with the device location present the SAME ask resolves instead of degrading", async () => {
    const res = await run("Lets go to hemköp stäket", {
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
    });
    assert.equal(res.state.ext.maps.intent, "RelocationToName");
    assert.ok(res.stub.matching(/places\.googleapis\.com/).length > 0);
  });
});

// ============================================================================
// 4. Fails soft in every branch (invariant 2)
// ============================================================================

describe("fails soft — a degraded result, never a throw", () => {
  const cases = [
    {
      name: "Places returns 403 and Street View has no coverage → the honest no-data note",
      message: ADDRESS_MESSAGE,
      routes: googleRoutes({
        places: () => new Response("denied", { status: 403 }),
        meta: () => ({ status: "ZERO_RESULTS" }),
      }),
      expect(res) {
        assert.notEqual(res.out, res.conversation);
        assert.match(blockOf(res), /Google returned no usable data for this location/);
        assert.equal(res.steps.find((s) => s[0] === "done")[2], "No Google Maps data for that location");
        assert.ok(logEvents(res).includes("googlemaps.places_error"));
      },
    },
    {
      name: "Places returns an API error STATUS body (200 with no places) → degrades",
      message: ADDRESS_MESSAGE,
      routes: googleRoutes({
        places: () => ({ error: { code: 400, status: "INVALID_ARGUMENT" } }),
        meta: () => ({ status: "ZERO_RESULTS" }),
      }),
      expect(res) {
        assert.match(blockOf(res), /Google returned no usable data/);
        assert.ok(logEvents(res).includes("googlemaps.places"));
      },
    },
    {
      name: "Places resolves but Street View says ZERO_RESULTS → the no-coverage block",
      message: ADDRESS_MESSAGE,
      stateOver: { visionModel: "vision-helper-test" },
      routes: googleRoutes({ meta: () => ({ status: "ZERO_RESULTS" }) }),
      expect(res) {
        const block = blockOf(res);
        assert.match(block, /No Street View imagery is available for this location/);
        assert.match(block, /never present anything else \(a map, a guess\) as Street View imagery/);
        // The road map stands in, honestly labeled, and no panorama is embedded.
        assert.ok(statuses(res).includes("map_embed"));
        assert.equal(statuses(res).includes("streetview_embed"), false);
        assert.equal(res.state.ext.maps.count, 1);
      },
    },
    {
      name: "the vision describe-helper 500s → the block lands WITHOUT a description",
      message: ADDRESS_MESSAGE,
      stateOver: { visionModel: "vision-helper-test" },
      routes: googleRoutes({ berget: () => new Response("upstream boom", { status: 500 }) }),
      expect(res) {
        const block = blockOf(res);
        assert.match(block, /--- Google Maps ---/);
        assert.equal(block.includes(DESCRIPTION), false);
        assert.equal(res.steps.find((s) => s[0] === "done")[2], "Google Maps data found");
        assert.ok(logEvents(res).includes("googlemaps.describe_failed"));
      },
    },
    {
      name: "the vision describe-helper THROWS → the block still lands",
      message: ADDRESS_MESSAGE,
      stateOver: { visionModel: "vision-helper-test" },
      routes: googleRoutes({
        berget: () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
      expect(res) {
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.equal(blockOf(res).includes(DESCRIPTION), false);
        assert.ok(logEvents(res).includes("googlemaps.describe_failed"));
      },
    },
    {
      name: "every Street View image fetch fails → the block degrades to the map only",
      message: ADDRESS_MESSAGE,
      stateOver: { visionModel: "vision-helper-test" },
      routes: googleRoutes({ svImage: () => new Response("", { status: 500 }) }),
      expect(res) {
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.ok(logEvents(res).includes("googlemaps.streetview_image_error"));
      },
    },
    {
      name: "the POV capture fails → the honest 'couldn't capture' note",
      message: [
        { role: "user", content: "street view of Maskinistvägen 11" },
        { role: "assistant", content: "…" },
        { role: "user", content: "Describe the person" },
      ],
      stateOver: { maps: { pov: { panoId: "PANO_LIVE", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 } } },
      routes: googleRoutes({ svImage: () => new Response("", { status: 500 }) }),
      expect(res) {
        assert.match(blockOf(res), /no image could be fetched/);
        assert.equal(res.steps.find((s) => s[0] === "done")[2], "Couldn't capture the current Street View view");
        assert.equal(res.state.ext.maps.count, 0);
      },
    },
    {
      name: "the MAP-VIEW capture fails → the honest 'couldn't capture the map view' note",
      message: [
        { role: "user", content: "street view of Maskinistvägen 11" },
        { role: "assistant", content: "…" },
        { role: "user", content: "What do we have here?" },
      ],
      stateOver: { maps: { view: { lat: 59.4, lng: 17.9, zoom: 17 } } },
      routes: googleRoutes({ staticMap: () => new Response("", { status: 500 }) }),
      expect(res) {
        assert.match(blockOf(res), /current map view.*could be fetched|no image could be fetched/s);
        assert.equal(res.steps.find((s) => s[0] === "done")[2], "Couldn't capture the current map view");
      },
    },
    {
      name: "the Routes API fails on a JOURNEY ask → straight-line figures only, no throw",
      message: [
        { role: "user", content: "street view here" },
        {
          role: "assistant",
          content:
            "panorama at 59.4000, 17.9000 — https://www.google.com/maps/search/?api=1&query=59.5000,17.9500",
        },
        { role: "user", content: "show how we traveled" },
      ],
      routes: googleRoutes({ routes: () => new Response("routes api not enabled", { status: 403 }) }),
      expect(res) {
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.match(res.steps.find((s) => s[0] === "done")[2], /Journey mapped — 2 stops/);
        // The honest degrade: straight-line only, never an invented walking time.
        assert.match(res.steps.find((s) => s[0] === "done")[3][0], /straight-line/);
        assert.equal(res.steps.find((s) => s[0] === "done")[3][0].includes("on foot"), false);
        assert.ok(logEvents(res).includes("googlemaps.routes_error"));
      },
    },
    {
      name: "the Routes API fails on a TRAVEL ask → the nearby block still lands",
      message: "go to the nearest pharmacy",
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
      routes: googleRoutes({ routes: () => new Response("nope", { status: 500 }) }),
      expect(res) {
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.equal(res.state.ext.maps.intent, "NearbyPlace");
        assert.ok(logEvents(res).includes("googlemaps.routes_error"));
      },
    },
    {
      name: "a nearby search finding nothing degrades to an honest empty block",
      message: "gas station near me",
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
      routes: googleRoutes({ places: () => ({ places: [] }) }),
      expect(res) {
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.match(res.steps.find((s) => s[0] === "done")[2], /nothing found for "gas station near me" nearby/);
        assert.equal(res.state.ext.maps.count, 0);
      },
    },
    {
      name: "a cross-barrier probe finding no crossing degrades to a map + honest block",
      message: "get to the other side of the railway",
      stateOver: { maps: { pov: { panoId: "PANO_LIVE", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 } } },
      routes: googleRoutes({ meta: () => ({ status: "ZERO_RESULTS" }) }),
      expect(res) {
        assert.equal(res.state.ext.maps.intent, "CrossBarrier");
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.match(res.steps.find((s) => s[0] === "done")[2], /No Street View found beyond the railway/);
      },
    },
    {
      name: "fetch THROWS on every outbound call → nothing escapes",
      message: ADDRESS_MESSAGE,
      stateOver: { visionModel: "vision-helper-test" },
      routes: [
        [
          () => true,
          () => {
            throw new Error("network is down");
          },
        ],
      ],
      expect(res) {
        assert.match(blockOf(res), /Google returned no usable data for this location/);
        assert.equal(res.steps.find((s) => s[0] === "done")[2], "No Google Maps data for that location");
      },
    },
    {
      name: "the null-lookup degrade path (no key ⇒ runGoogleMapsLookup returns null)",
      message: ADDRESS_MESSAGE,
      env: {},
      expect(res) {
        assert.deepEqual(res.stub.requests, [], "a missing key must cost nothing at Google");
        assert.match(blockOf(res), /Google Maps & Street View is ENABLED and was checked for "Main Street 5"/);
        assert.match(blockOf(res), /Do NOT instruct the user to enable Google Maps — it is already on/);
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const res = await run(c.message, {
        routes: c.routes,
        stateOver: c.stateOver,
        ...("env" in c ? { env: c.env } : {}),
      });
      c.expect(res);
    });
  }

  /** Calls the runner directly with a hostile conversation and every fetch dead. */
  const runRaw = (conversation) =>
    withFakeFetch(
      [[() => true, () => { throw new Error("everything is broken"); }]],
      () =>
        runGoogleMapsEnrichment(
          envWithKeys(),
          { info() {}, warn() {}, error() {}, debug() {} },
          () => {},
          () => {},
          () => {},
          conversation,
          makeState({ visionModel: "vision-helper-test" }),
        ),
    );

  test("no branch ever rejects for a well-formed conversation, however empty or partial", async () => {
    const junk = [
      [],
      [{ role: "user" }],
      [{ role: "user", content: null }],
      [{ role: "user", content: [] }],
      [{ role: "assistant", content: "no user turn at all" }],
      [{ role: "user", content: ADDRESS_MESSAGE }],
      [{ role: "user", content: "Lets go to hemköp stäket" }],
      [{ role: "user", content: "show me street view" }],
      [{ role: "user", content: [{ type: "text", text: ADDRESS_MESSAGE }, { type: "image_url", image_url: { url: "data:," } }] }],
    ];
    for (const conversation of junk) {
      const out = await runRaw(conversation);
      assert.ok(out === conversation || Array.isArray(out), `bad return for ${JSON.stringify(conversation)}`);
    }
  });

  // KNOWN GAP, pinned so a fix is a deliberate change rather than a surprise:
  // pickLookup / needsAnchorAsk / hereAskIntent all guard `Array.isArray`, but
  // the `!target` branch then calls lastUserMessage(conversation) — which
  // spreads the argument — so a conversation that is not an array (or holds a
  // null message) throws out of the runner instead of degrading. Today it is
  // contained one layer up: src/enrichment.js's runEnrichments wraps every
  // `run` in try/catch and logs `maps.enrichment_failed`, and src/validation.js
  // rejects such bodies before the pipeline. Reported, not fixed here.
  // Was a KNOWN GAP until 2026-08-07: pickLookup/needsAnchorAsk/hereAskIntent
  // all guarded `Array.isArray(conversation)`, but the `!target` branch then
  // called lastUserMessage, which spread the value blind and threw
  // "conversation is not iterable" out of a runner whose contract is that it
  // degrades. Guarded in conversation.js; this is the regression pin.
  test("a non-array conversation (or a null message) degrades instead of throwing", async () => {
    for (const bad of [null, undefined, {}, "a conversation", [null], [undefined, null]]) {
      const out = await runRaw(bad);
      assert.equal(out, bad, `${JSON.stringify(bad)} comes back untouched`);
    }
  });
});

// ============================================================================
// 5. Untrusted client input — the resolveState seam
// ============================================================================
// validateStreetViewPov / validateMapView's PURE semantics are pinned in
// src/validation.test.js. What is pinned here is the SEAM: a hostile request
// body cannot get an unsanitised value into an outbound Google URL, and the
// three fields are read at all only when the knob is on.

describe("hostile client input is sanitised at the resolveState seam", () => {
  const resolve = (body, on = true) => getExtension("maps").resolveState(body, on);

  /** Every POV the seam yields must be a plain numeric record with a safe pano id. */
  function assertSafePov(pov) {
    if (pov === null) return;
    assert.equal(typeof pov, "object");
    assert.deepEqual(Object.keys(pov).sort(), ["fov", "heading", "lat", "lng", "panoId", "pitch"]);
    for (const k of ["lat", "lng", "heading", "pitch", "fov"]) {
      assert.equal(typeof pov[k], "number", `${k} must be a number`);
      assert.ok(Number.isFinite(pov[k]), `${k} must be finite`);
    }
    assert.ok(pov.lat >= -90 && pov.lat <= 90);
    assert.ok(pov.lng >= -180 && pov.lng <= 180);
    assert.ok(pov.heading >= 0 && pov.heading < 360, `heading ${pov.heading} out of range`);
    assert.ok(pov.pitch >= -90 && pov.pitch <= 90);
    assert.ok(pov.fov >= 10 && pov.fov <= 120);
    assert.equal(typeof pov.panoId, "string");
    assert.match(pov.panoId, /^[\w-]{0,64}$/, "a pano id must never carry URL metacharacters");
  }

  /** Every map view the seam yields must be a plain numeric record. */
  function assertSafeView(view) {
    if (view === null) return;
    assert.deepEqual(Object.keys(view).sort(), ["lat", "lng", "zoom"]);
    for (const k of ["lat", "lng", "zoom"]) {
      assert.equal(typeof view[k], "number");
      assert.ok(Number.isFinite(view[k]));
    }
    assert.ok(view.zoom >= 0 && view.zoom <= 21);
  }

  const hostile = [
    ["a prototype-pollution payload", JSON.parse('{"street_view_pov":{"__proto__":{"polluted":1},"lat":10,"lng":20},"map_view":{"__proto__":{"polluted":1},"lat":10,"lng":20},"user_location":{"__proto__":{"polluted":1},"lat":10,"lng":20}}')],
    ["constructor/prototype keys", JSON.parse('{"street_view_pov":{"constructor":{"prototype":{"x":1}},"lat":1,"lng":2},"map_view":{"prototype":1,"lat":1,"lng":2}}')],
    ["strings everywhere", { street_view_pov: "59.4,17.9", map_view: "zoom", user_location: "here" }],
    ["arrays instead of records", { street_view_pov: [59.4, 17.9], map_view: [1, 2], user_location: [] }],
    ["null / undefined / booleans", { street_view_pov: null, map_view: true, user_location: undefined }],
    ["numbers instead of records", { street_view_pov: 42, map_view: -0, user_location: 1e308 }],
    ["huge and infinite coordinates", {
      street_view_pov: { lat: 1e308, lng: -1e308, heading: Infinity, pitch: -Infinity, fov: NaN },
      map_view: { lat: "1e999", lng: "-1e999", zoom: Infinity },
      user_location: { lat: 91, lng: 181 },
    }],
    ["out-of-range but finite numbers get clamped or rejected", {
      street_view_pov: { lat: 59.4, lng: 17.9, heading: -7200.6, pitch: 99999, fov: -5 },
      map_view: { lat: 59.4, lng: 17.9, zoom: 9999 },
      user_location: { lat: 59.4, lng: 17.9, zoom: -9999 },
    }],
    ["URL injection through the pano id", {
      street_view_pov: { panoId: "x&key=ATTACKER_KEY&pano", lat: 59.4, lng: 17.9, heading: 10, pitch: 0, fov: 90 },
    }],
    ["a newline/CRLF injection through the pano id", {
      street_view_pov: { panoId: "abc\r\nX-Injected: 1", lat: 59.4, lng: 17.9, heading: 10, pitch: 0, fov: 90 },
    }],
    ["nested objects with valueOf", {
      street_view_pov: { lat: { valueOf: () => 45 }, lng: { valueOf: () => 9 }, heading: {}, pitch: {}, fov: {} },
      map_view: { lat: { valueOf: () => 45 }, lng: { valueOf: () => 9 }, zoom: {} },
    }],
    ["deeply nested junk", { street_view_pov: { lat: { a: { b: { c: 1 } } }, lng: [[[1]]] }, map_view: { lat: [], lng: {} } }],
    ["NaN-producing strings", { street_view_pov: { lat: "abc", lng: "def" }, map_view: { lat: "", lng: "  " } }],
    ["a body that is not an object at all", "not-a-body"],
    ["a null body", null],
  ];

  for (const [name, body] of hostile) {
    test(`${name} yields only sanitised values or null`, () => {
      const slice = resolve(body, true);
      assert.equal(slice.on, true);
      assert.equal(slice.count, 0);
      assertSafePov(slice.pov);
      assertSafeView(slice.view);
      assertSafeView(slice.userLocation);
      // No prototype pollution reached Object.prototype.
      assert.equal({}.polluted, undefined);
      assert.equal({}.x, undefined);
    });
  }

  test("the specific clamps a hostile body must produce", () => {
    const slice = resolve({
      street_view_pov: { panoId: "x&key=ATTACKER_KEY", lat: 59.4, lng: 17.9, heading: "180&fov=999", pitch: "-9999", fov: "1e9" },
      map_view: { lat: 59.4, lng: 17.9, zoom: 9999 },
      user_location: { lat: 59.4, lng: 17.9, zoom: -9999 },
    }, true);
    assert.deepEqual(slice.pov, { panoId: "", lat: 59.4, lng: 17.9, heading: 0, pitch: -90, fov: 120 });
    assert.deepEqual(slice.view, { lat: 59.4, lng: 17.9, zoom: 21 });
    assert.deepEqual(slice.userLocation, { lat: 59.4, lng: 17.9, zoom: 0 });
  });

  test("a well-formed pano id survives — the sanitiser is not simply blanking everything", () => {
    const slice = resolve({ street_view_pov: { panoId: "abc-123_XYZ", lat: 1, lng: 2, heading: 370.4, pitch: 3.6, fov: 45 } }, true);
    assert.equal(slice.pov.panoId, "abc-123_XYZ");
    assert.equal(slice.pov.heading, 10);
    assert.equal(slice.pov.pitch, 4);
    assert.equal(slice.pov.fov, 45);
  });

  test("the three fields are read ONLY when the knob is on", () => {
    const fullyPopulated = {
      street_view_pov: { panoId: "abc-123", lat: 59.4, lng: 17.9, heading: 90, pitch: 10, fov: 60 },
      map_view: { lat: 59.4, lng: 17.9, zoom: 15 },
      user_location: { lat: 59.4, lng: 17.9 },
    };
    const off = resolve(fullyPopulated, false);
    assert.deepEqual(off, { on: false, count: 0, intent: undefined, pov: null, view: null, userLocation: null });
    // …and the same body with the knob on does read them, so the assertion above
    // is about the GATE and not about an unparseable body.
    const on = resolve(fullyPopulated, true);
    assert.ok(on.pov && on.view && on.userLocation);
  });

  test("a hostile POV cannot reach the outbound Street View URL unsanitised", async () => {
    const slice = getExtension("maps").resolveState(
      {
        street_view_pov: {
          panoId: "x&key=ATTACKER_KEY&pano=evil",
          lat: 59.41,
          lng: 17.91,
          heading: "180&fov=99999",
          pitch: "-9999",
          fov: "1e9",
        },
      },
      true,
    );
    const state = makeState({ visionModel: null, maps: slice });
    const res = await run(
      [
        { role: "user", content: "street view of Maskinistvägen 11" },
        { role: "assistant", content: "…" },
        { role: "user", content: "Describe the person" },
      ],
      { state },
    );
    assert.equal(res.state.ext.maps.intent, "PovScene");
    const imageReqs = res.stub.matching(/maps\/api\/streetview\?/);
    assert.ok(imageReqs.length > 0, "the POV path must have captured a frame");
    for (const r of imageReqs) {
      const qs = new URL(r.url).searchParams;
      assert.equal(qs.get("heading"), "0");
      assert.equal(qs.get("pitch"), "-90");
      assert.equal(qs.get("fov"), "120");
      assert.equal(qs.get("pano"), null, "the rejected pano id must not appear at all");
      assert.equal(qs.get("location"), "59.41,17.91");
      assert.equal(qs.get("key"), SERVER_KEY);
    }
    res.stub.assertNoneCarry(["ATTACKER_KEY", "evil", "99999", "-9999"], assert.fail);
  });
});

// ============================================================================
// 6. Privacy (invariant 4)
// ============================================================================

describe("outbound requests carry the minimum (invariant 4)", () => {
  test("no request carries the attached filename, the session id or the account id", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    assert.ok(res.stub.requests.length > 0, "the firing path must actually have called out");
    res.stub.assertNoneCarry([SECRET_FILENAME, SESSION_ID, ACCOUNT_ID, "row one", "row two"], assert.fail);
  });

  test("GOOGLE requests carry only the address/coordinates and the key — never the question", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    const google = res.stub.requests.filter((r) => r.host.endsWith("googleapis.com"));
    assert.ok(google.length > 0);
    for (const r of google) {
      const haystack = `${r.url}\n${JSON.stringify(r.headers)}\n${r.body}`;
      assert.equal(haystack.includes(ADDRESS_QUESTION), false, `Google request leaked the question: ${r.url}`);
      assert.equal(haystack.includes("What does the building"), false);
      assert.equal(haystack.includes(SECRET_FILENAME), false);
      assert.equal(haystack.includes(BERGET_TOKEN), false, "one provider's secret must not reach another");
    }
    // What Google DOES get: the parsed address, and coordinates for the imagery.
    assert.ok(res.stub.matching(/places\.googleapis\.com/)[0].body.includes("Main Street 5"));
  });

  test("the vision helper never receives the account id, the session id or the filename", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    const berget = res.stub.matching(/api\.berget\.ai/);
    assert.equal(berget.length, 1);
    const body = berget[0].body;
    assert.equal(body.includes(SECRET_FILENAME), false);
    assert.equal(body.includes(SESSION_ID), false);
    assert.equal(body.includes(ACCOUNT_ID), false);
    // The user's question DOES ride along — that is the point of the helper —
    // but only the part before the client's first labeled block.
    assert.ok(body.includes(ADDRESS_QUESTION));
    assert.equal(body.includes("--- Attached document"), false);
  });

  test("Nominatim gets a coordinate and nothing else", async () => {
    const res = await run("gas station near me", {
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
    });
    for (const r of res.stub.matching(/nominatim/)) {
      const qs = new URL(r.url).searchParams;
      assert.deepEqual([...qs.keys()].sort(), ["addressdetails", "format", "lat", "lon", "zoom"]);
      assert.equal(r.body, "");
    }
  });

  test("the block the RUNNER produces carries only keyless links — never an API key", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    const block = blockOf(res);
    assert.match(block, /https:\/\/www\.google\.com\/maps\//);
    assert.equal(block.includes(SERVER_KEY), false, "the server key must never reach the model");
    assert.equal(block.includes(EMBED_KEY), false, "the embed key must never reach the model");
    assert.equal(/[?&]key=/.test(block), false, "no keyed Google URL may appear in a context block");
    assert.match(block, /NEVER construct or output Google Maps API image URLs/);
  });

  test("the SSE events the runner emits never carry a key either", async () => {
    const res = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    const wire = JSON.stringify(res.events);
    assert.equal(wire.includes(SERVER_KEY), false);
    assert.equal(wire.includes(EMBED_KEY), false);
    const embed = res.events.find((e) => e.status.type === "streetview_embed").status;
    assert.deepEqual(Object.keys(embed).sort(), ["lat", "lng", "type"]);
  });
});

// ============================================================================
// 7. Env gating
// ============================================================================

describe("env gating", () => {
  test("no GOOGLE_MAPS_API_KEY ⇒ not one outbound request", async () => {
    for (const env of [{}, { GOOGLE_MAPS_API_KEY: "" }]) {
      const res = await run(ADDRESS_MESSAGE, { env, stateOver: { visionModel: "vision-helper-test" } });
      assert.deepEqual(res.stub.requests, [], "a keyless deployment must never call Google");
      // …and the user still gets the honest note rather than "enable Maps".
      assert.match(blockOf(res), /Do NOT instruct the user to enable Google Maps/);
      assert.deepEqual(res.events, [], "no embed can be rendered without a key");
    }
  });

  test("with no embed key at all the runner emits no embed event and says so in the block", async () => {
    // Both keys absent ⇒ googleMapsEmbedKey is "" ⇒ the keyless link stands alone.
    const res = await run(
      [
        { role: "user", content: "street view of Maskinistvägen 11" },
        { role: "assistant", content: "…" },
        { role: "user", content: "Describe the person" },
      ],
      {
        env: { BERGET_API_TOKEN: BERGET_TOKEN },
        stateOver: { maps: { pov: { panoId: "PANO_LIVE", lat: 59.41, lng: 17.91, heading: 143, pitch: -5, fov: 90 } } },
      },
    );
    // No key ⇒ runStreetViewPovCapture returns null before any fetch.
    assert.deepEqual(res.stub.requests, []);
    assert.equal(statuses(res).includes("streetview_embed"), false);
    assert.match(blockOf(res), /no image could be fetched/);
  });

  test("the dedicated embed key is what the RUNNER gates its embed events on", async () => {
    const withEmbed = await run(ADDRESS_MESSAGE, { stateOver: { visionModel: "vision-helper-test" } });
    assert.ok(statuses(withEmbed).includes("streetview_embed"));
    // Falling back to the main key keeps the embed (googlemaps.test.js pins the
    // fallback itself; this pins that the runner honours it).
    const fallback = await run(ADDRESS_MESSAGE, {
      env: { GOOGLE_MAPS_API_KEY: SERVER_KEY, BERGET_API_TOKEN: BERGET_TOKEN },
      stateOver: { visionModel: "vision-helper-test" },
    });
    assert.ok(statuses(fallback).includes("streetview_embed"));
  });
});

// ============================================================================
// 8. Swedish parity at the RUNNER level (invariant 6)
// ============================================================================

describe("Swedish parity — the same runner branches, both languages", () => {
  const pairs = [
    {
      what: "an address ask reaches the place-lookup branch",
      en: "what does the building at Main Street 5 look like?",
      sv: "hur ser byggnaden på Maskinistvägen 11 ut?",
      intent: "NewAddress",
      stateOver: { visionModel: "vision-helper-test" },
      check(res) {
        assert.equal(res.steps[0][2], "Checking Google Maps…");
        assert.match(blockOf(res), /--- Google Maps ---/);
        assert.ok(res.stub.matching(/places\.googleapis\.com/).length > 0);
      },
    },
    {
      what: "a relocation ask with no anchor reaches the anchor-missing branch",
      en: "go to the nearest pharmacy",
      sv: "gå till närmaste apotek",
      intent: "anchor-missing",
      check(res) {
        assert.match(blockOf(res), /allow location access/);
        assert.deepEqual(res.stub.requests, []);
      },
    },
    {
      what: "a nearby search with a device location reaches the Places-nearby branch",
      en: "gas station near me",
      sv: "närmaste bensinstation",
      intent: "NearbyPlace",
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
      check(res) {
        assert.ok(res.stub.matching(/places\.googleapis\.com/).length > 0);
        assert.match(blockOf(res), /--- Google Maps ---/);
      },
    },
    {
      what: "a here-ask reaches the jump branch",
      en: "street view here",
      sv: "gatuvy här",
      intent: "HereAsk",
      stateOver: { maps: { userLocation: { lat: 59.4, lng: 17.9, zoom: 17 } } },
      check(res) {
        assert.match(res.steps[0][2], /Opening Street View at the requested position/);
      },
    },
  ];

  for (const p of pairs) {
    test(`${p.what} — EN and SV alike`, async () => {
      for (const [lang, message] of [["EN", p.en], ["SV", p.sv]]) {
        const res = await run(message, { stateOver: p.stateOver });
        assert.equal(res.state.ext.maps.intent, p.intent, `${lang}: "${message}" routed to the wrong branch`);
        p.check(res);
      }
    });
  }

  test("the gate is not English-only: the Swedish forms cost the same outbound calls", async () => {
    const en = await run("what does the building at Main Street 5 look like?", {
      stateOver: { visionModel: "vision-helper-test" },
    });
    const sv = await run("hur ser byggnaden på Maskinistvägen 11 ut?", {
      stateOver: { visionModel: "vision-helper-test" },
    });
    assert.deepEqual(en.stub.hosts().sort(), sv.stub.hosts().sort());
    assert.deepEqual(statuses(en), statuses(sv));
  });
});

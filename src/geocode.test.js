// Unit tests for the reverse-geocoder (src/geocode.js) — the OpenStreetMap
// Nominatim lookup that turns a photo's GPS EXIF into a place name.
//
// Why this file exists: geocode.js makes an UNCONDITIONAL outbound
// third-party call on every chat request that carries `imageLocations`, it is
// deliberately NOT registered in the extension registry (src/extensions.js
// lines 30-34: "no knob or service-specific request state, so neither is
// registered here"), and until now it had zero test coverage. That is the
// worst combination in this repo: a live network hop on the hot path with no
// pinned contract and no wiring guard.
//
// What is pinned here:
//   * FIRES     — a well-formed payload emits the `geocode` step naming
//                 OpenStreetMap Nominatim and appends the labeled block, with
//                 the EXACT strings the source emits (read, not invented).
//   * SILENT    — absent/empty/null/non-array input returns the SAME array
//                 reference, emits no step, and touches the network zero times.
//   * FAILS SOFT— invariant 2: 500 / 429 / timeout / malformed body / missing
//                 display_name / fetch itself throwing all degrade, never throw.
//   * PRIVACY   — invariant 4 and the module header's promise that "only the
//                 coordinates cross the wire to Nominatim, never the filename,
//                 the user's question, or any account/session identifier".
//   * WIRING    — that chat.js still calls augmentWithLocations BEFORE
//                 runPipeline. Nothing else pins this: the call is
//                 unconditional and sits outside the enrichment registry, so
//                 no registry test can see it and a refactor could silently
//                 drop the geocode step without a single test failing. It is
//                 therefore asserted by reading src/chat.js as TEXT, the same
//                 technique src/extensions.test.js (core purity) and
//                 src/facade-contract.test.js already use.
//
// Deliberately NOT `// @ts-check`: most of the silent-path and validation
// cases feed intentionally malformed shapes (string coordinates, nulls,
// hostile extra keys, a non-array payload) that strict types reject by design.
//
// THREE PLACES where the real behaviour differs from what the comments
// promise are pinned below as the REAL behaviour, each with a note, rather
// than as the behaviour one would expect. Search for "DIVERGENCE" (coordinate
// validation coerces instead of type-checking; a throwing coordinate accessor
// escapes the fail-soft contract) and "OBSERVABILITY GAP" (a 200 with no
// usable display_name logs nothing at all).

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { augmentWithLocations, reverseGeocode } from "./geocode.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The literals the source actually uses (src/geocode.js lines 21-23).
const NOMINATIM_HOST = "nominatim.openstreetmap.org";
const NOMINATIM = /nominatim\.openstreetmap\.org/;
const GENERIC_USER_AGENT = "geocode-client/1.0";
const STEP_ID = "geocode";
const STEP_START_LABEL = "Resolving photo location (OpenStreetMap)…";

// Values that must never leave this Worker on the Nominatim hop.
const QUESTION = "What is in this photo of my house at 12 Oak Street?";
const FILENAME = "IMG_secret_vacation.jpg";
const SESSION_ID = "sess_abc123deadbeef";
const ACCOUNT_ID = "user-4711";
const EMAIL = "krister.hedfors@gmail.com";
const NEVER_LEAKS = [QUESTION, FILENAME, SESSION_ID, ACCOUNT_ID, EMAIL, "12 Oak Street"];

const STOCKHOLM = { name: FILENAME, lat: 59.3293, lon: 18.0686 };
const GOTHENBURG = { name: "img_0002.jpg", lat: 57.7089, lon: 11.9746 };

const PLACE_STHLM = "Gamla stan, Stockholm, Sweden";
const PLACE_GBG = "Inom Vallgraven, Göteborg, Sweden";

/** A Nominatim 200 with a resolvable name. */
const okPlace = (display_name) => ({ display_name, place_id: 1, licence: "ODbL" });

/** Routes every Nominatim call to `responder`. */
const route = (responder) => [[NOMINATIM, responder]];

/**
 * Runs augmentWithLocations against a fake fetch, recording every SSE event.
 * `opts.conversation` overrides the default one-user-message conversation;
 * `opts.emit` overrides the emitter (pass `undefined` explicitly to exercise
 * the optional-emitter path via `opts.noEmit`).
 */
async function run(rawLocations, responder = okPlace(PLACE_STHLM), opts = {}) {
  const events = [];
  const log = opts.log || fakeLog();
  const conversation =
    opts.conversation !== undefined ? opts.conversation : [{ role: "user", content: QUESTION }];
  const emit = opts.noEmit ? undefined : (e) => events.push(e);
  return withFakeFetch(route(responder), async (stub) => {
    const out = await augmentWithLocations(opts.env || {}, log, emit, conversation, rawLocations);
    return {
      out,
      events,
      steps: events.map((e) => e.status),
      log,
      stub,
      conversation,
    };
  });
}

/** The text of the last message, however its content is shaped. */
const lastText = (convo) => {
  const c = convo[convo.length - 1].content;
  if (typeof c === "string") return c;
  return c.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
};

// ---------------------------------------------------------------------------
// FIRES — a well-formed payload
// ---------------------------------------------------------------------------

describe("fires: a well-formed imageLocations payload", () => {
  test("emits step_start then step_done on the `geocode` id", async () => {
    const { steps } = await run([STOCKHOLM]);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].type, "step_start");
    assert.equal(steps[0].id, STEP_ID);
    assert.equal(steps[0].label, STEP_START_LABEL);
    assert.equal(steps[1].type, "step_done");
    assert.equal(steps[1].id, STEP_ID);
  });

  test("the visible step NAMES OpenStreetMap Nominatim (the service disclosure)", async () => {
    const { steps } = await run([STOCKHOLM]);
    // step_start names OpenStreetMap; step_done names the full service.
    assert.match(steps[0].label, /OpenStreetMap/);
    assert.equal(steps[1].label, "Resolved 1 photo location via OpenStreetMap Nominatim");
  });

  test("step_done carries the resolved details, verbatim `<name>: near <place>`", async () => {
    const { steps } = await run([STOCKHOLM]);
    assert.deepEqual(steps[1].details, [`${FILENAME}: near ${PLACE_STHLM}`]);
  });

  test("appends the labeled block to the LAST message, exactly as the source builds it", async () => {
    const { out, conversation } = await run([STOCKHOLM]);
    assert.notEqual(out, conversation, "firing path must return a NEW array");
    assert.equal(conversation[0].content, QUESTION, "input conversation must not be mutated");
    const expected =
      QUESTION +
      "\n\n--- Resolved location(s) (via OpenStreetMap Nominatim) ---\n" +
      `${FILENAME}: near ${PLACE_STHLM}` +
      "\n--- End of resolved location(s) ---";
    assert.equal(lastText(out), expected);
  });

  test("the block's open and close labels are the ones the source emits", async () => {
    const { out } = await run([STOCKHOLM]);
    const text = lastText(out);
    assert.ok(text.includes("--- Resolved location(s) (via OpenStreetMap Nominatim) ---"));
    assert.ok(text.includes("--- End of resolved location(s) ---"));
  });

  test("MULTIPLE locations: one request each, one details line each, plural label", async () => {
    const { steps, out, stub } = await run([STOCKHOLM, GOTHENBURG], (rec) =>
      okPlace(rec.url.includes("lat=57.7089") ? PLACE_GBG : PLACE_STHLM),
    );
    assert.equal(stub.requests.length, 2);
    assert.equal(steps[1].label, "Resolved 2 photo locations via OpenStreetMap Nominatim");
    assert.deepEqual(steps[1].details, [
      `${FILENAME}: near ${PLACE_STHLM}`,
      `img_0002.jpg: near ${PLACE_GBG}`,
    ]);
    const text = lastText(out);
    assert.ok(text.includes(`${FILENAME}: near ${PLACE_STHLM}`));
    assert.ok(text.includes(`img_0002.jpg: near ${PLACE_GBG}`));
    // One block, not one per location.
    assert.equal(text.split("--- Resolved location(s)").length - 1, 1);
  });

  test("a location with no `name` is labeled `photo`", async () => {
    const { steps } = await run([{ lat: 59.3293, lon: 18.0686 }]);
    assert.deepEqual(steps[1].details, [`photo: near ${PLACE_STHLM}`]);
  });

  test("an over-long name is capped at 200 chars before it reaches the block", async () => {
    const { steps } = await run([{ name: "n".repeat(500), lat: 59.3293, lon: 18.0686 }]);
    assert.equal(steps[1].details[0], `${"n".repeat(200)}: near ${PLACE_STHLM}`);
  });

  test("image-only last message (array content, no text part) gets a text part prepended", async () => {
    const conversation = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }] },
    ];
    const { out } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { conversation });
    assert.equal(out[0].content[0].type, "text");
    assert.ok(out[0].content[0].text.includes("--- Resolved location(s)"));
    assert.equal(out[0].content[1].type, "image_url");
  });

  test("array content WITH a text part appends to that part", async () => {
    const conversation = [
      {
        role: "user",
        content: [
          { type: "text", text: QUESTION },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } },
        ],
      },
    ];
    const { out } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { conversation });
    assert.equal(out[0].content.length, 2);
    assert.ok(out[0].content[0].text.startsWith(QUESTION));
    assert.ok(out[0].content[0].text.includes(`${FILENAME}: near ${PLACE_STHLM}`));
  });

  test("`emit` omitted entirely (the no-SSE path) still resolves and appends, no throw", async () => {
    const { out } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { noEmit: true });
    assert.ok(lastText(out).includes(`${FILENAME}: near ${PLACE_STHLM}`));
  });

  test("a non-function `emit` is tolerated (the `typeof emit === 'function'` guard)", async () => {
    await withFakeFetch(route(okPlace(PLACE_STHLM)), async () => {
      const convo = [{ role: "user", content: QUESTION }];
      const out = await augmentWithLocations({}, fakeLog(), /** not a fn */ null, convo, [STOCKHOLM]);
      assert.ok(lastText(out).includes(PLACE_STHLM));
    });
  });
});

// ---------------------------------------------------------------------------
// SILENT — nothing valid to resolve
// ---------------------------------------------------------------------------

describe("silent: nothing valid to resolve", () => {
  const SILENT_INPUTS = [
    ["undefined (the field is absent from the body)", undefined],
    ["null", null],
    ["an empty array", []],
    ["a plain object (non-array)", { lat: 59.3293, lon: 18.0686 }],
    ["a string", "59.3293,18.0686"],
    ["a number", 59.3293],
    ["a boolean", true],
    ["an array of nulls", [null, null]],
    ["an array of strings", ["59.3,18.0"]],
    ["an array of numbers", [1, 2, 3]],
  ];

  for (const [label, raw] of SILENT_INPUTS) {
    test(`${label} → same array reference, no step, no network`, async () => {
      const { out, conversation, steps, stub } = await run(raw);
      assert.equal(out, conversation, "must return the SAME array reference");
      assert.deepEqual(steps, []);
      assert.equal(stub.requests.length, 0, "nothing may reach the network");
    });
  }

  test("a Swedish question with no photo location stays just as silent (no EN-only gate)", async () => {
    const conversation = [{ role: "user", content: "Vad föreställer det här fotot från Göteborg?" }];
    const { out, steps, stub } = await run(undefined, okPlace(PLACE_GBG), { conversation });
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
    assert.equal(stub.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// VALIDATION — what validateImageLocations drops before the network
// ---------------------------------------------------------------------------

describe("validation: junk coordinates never reach Nominatim", () => {
  const REJECTED = [
    ["latitude above +90", { lat: 91, lon: 0 }],
    ["latitude below -90", { lat: -90.0001, lon: 0 }],
    ["longitude above +180", { lat: 0, lon: 180.5 }],
    ["longitude below -180", { lat: 0, lon: -181 }],
    ["NaN latitude", { lat: NaN, lon: 0 }],
    ["Infinity latitude", { lat: Infinity, lon: 0 }],
    ["-Infinity longitude", { lat: 0, lon: -Infinity }],
    ["a non-numeric string latitude", { lat: "north", lon: 0 }],
    ["a non-numeric string longitude", { lat: 0, lon: "öster" }],
    ["missing lat", { lon: 18.0686, name: "a.jpg" }],
    ["missing lon", { lat: 59.3293, name: "a.jpg" }],
    ["both fields missing", { name: "a.jpg" }],
    ["undefined lat/lon", { lat: undefined, lon: undefined }],
    ["an object-valued coordinate", { lat: { v: 59 }, lon: { v: 18 } }],
    ["a two-element array coordinate", { lat: [59, 3], lon: [18, 0] }],
    ["a function-valued coordinate", { lat: () => 59, lon: () => 18 }],
    ["a Symbol-free junk shape", { lat: "1,2", lon: "3,4" }],
    ["a null entry", null],
    ["a string entry", "59,18"],
  ];

  for (const [label, item] of REJECTED) {
    test(`${label} → dropped, no request, no step, conversation unchanged`, async () => {
      const { out, conversation, steps, stub } = await run([item]);
      assert.equal(stub.requests.length, 0, "nothing may reach the network");
      assert.deepEqual(steps, []);
      assert.equal(out, conversation);
    });
  }

  test("exactly the boundary values ±90 / ±180 are ACCEPTED (inclusive range)", async () => {
    const { stub } = await run([
      { name: "a", lat: 90, lon: 180 },
      { name: "b", lat: -90, lon: -180 },
    ]);
    assert.equal(stub.requests.length, 2);
  });

  test("hostile extra keys are stripped — only name/lat/lon survive", async () => {
    const hostile = {
      name: "ok.jpg",
      lat: 59.3293,
      lon: 18.0686,
      email: EMAIL,
      session: SESSION_ID,
      user_id: ACCOUNT_ID,
      question: QUESTION,
      __proto__key: "polluted",
      constructor: "nope",
      "?extra=1&x": "y",
    };
    const { stub, steps } = await run([hostile]);
    assert.equal(stub.requests.length, 1);
    stub.assertNoneCarry([EMAIL, SESSION_ID, ACCOUNT_ID, QUESTION, "polluted", "nope"], assert.fail);
    const url = new URL(stub.requests[0].url);
    assert.deepEqual([...url.searchParams.keys()].sort(), [
      "addressdetails",
      "format",
      "lat",
      "lon",
      "zoom",
    ]);
    assert.deepEqual(steps[1].details, [`ok.jpg: near ${PLACE_STHLM}`]);
  });

  test("an over-long array is capped at 4 lookups (MAX_IMAGE_LOCATIONS)", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}.jpg`, lat: 10 + i, lon: 20 + i }));
    const { stub, steps } = await run(many);
    assert.equal(stub.requests.length, 4, "at most four coordinates may leave");
    assert.equal(steps[1].details.length, 4);
    assert.deepEqual(
      steps[1].details.map((d) => d.split(":")[0]),
      ["p0.jpg", "p1.jpg", "p2.jpg", "p3.jpg"],
    );
  });

  test("the cap counts VALID entries, so junk padding cannot smuggle a fifth lookup", async () => {
    const raw = [
      { lat: 999, lon: 0 },
      "junk",
      null,
      ...Array.from({ length: 6 }, (_, i) => ({ name: `q${i}.jpg`, lat: 10 + i, lon: 20 + i })),
    ];
    const { stub } = await run(raw);
    assert.equal(stub.requests.length, 4);
  });

  test("a mixed array keeps the valid entries and drops the junk", async () => {
    const { stub, steps } = await run([{ lat: 500, lon: 500 }, STOCKHOLM, "junk"]);
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(steps[1].details, [`${FILENAME}: near ${PLACE_STHLM}`]);
  });

  // ---- DIVERGENCE #1 -------------------------------------------------------
  // The module header calls these "untrusted client-reported photo GPS
  // coordinates" and validation.js says it "Silently drops/caps" bad input,
  // but the check is `Number(item?.lat)` — a COERCION, not a type test. So
  // numeric strings, `null`, `""`, `[]`, `false` and single-element arrays all
  // pass the finite+range check and produce a REAL outbound Nominatim request.
  // `null`/`""`/`[]`/`false` all coerce to 0, i.e. Null Island (0,0), which
  // Nominatim happily resolves — the model then gets a confident "near …"
  // context block for a photo that carried no usable coordinate at all.
  // Pinned as the CURRENT behaviour, not the desired one. Reported, not fixed.
  const COERCED = [
    ["numeric-string coordinates", { name: "s.jpg", lat: "59.3293", lon: "18.0686" }],
    ["null coordinates → 0,0 (Null Island)", { name: "n.jpg", lat: null, lon: null }],
    ["empty-string coordinates → 0,0", { name: "e.jpg", lat: "", lon: "" }],
    ["empty-array coordinates → 0,0", { name: "a.jpg", lat: [], lon: [] }],
    ["boolean coordinates → 1,0", { name: "b.jpg", lat: true, lon: false }],
    ["single-element array coordinates", { name: "w.jpg", lat: [59.3293], lon: [18.0686] }],
    // `[[59.3293]].toString()` is "59.3293" — nesting does not help.
    ["nested single-element arrays", { name: "d.jpg", lat: [[59.3293]], lon: [[18.0686]] }],
    ["whitespace-padded numeric strings", { name: "p.jpg", lat: " 59.3293 ", lon: "\t18.0686" }],
  ];

  for (const [label, item] of COERCED) {
    test(`DIVERGENCE: ${label} are COERCED and DO reach the network`, async () => {
      const { stub, steps } = await run([item]);
      assert.equal(stub.requests.length, 1, "current behaviour: the coercion lets this through");
      assert.equal(steps.length, 2);
    });
  }
});

// ---------------------------------------------------------------------------
// FAILS SOFT — invariant 2: a helper phase never breaks the request
// ---------------------------------------------------------------------------

describe("fails soft: Nominatim misbehaving never breaks the chat", () => {
  const timeoutError = () => {
    // What AbortSignal.timeout(4000) produces once the 4 s budget is spent.
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };

  // Failures reverseGeocode's catch/!ok branches SEE, and log as geocode.error.
  const LOGGED_FAILURES = [
    ["HTTP 500", () => new Response("upstream boom", { status: 500 })],
    ["HTTP 429 (rate limited)", () => new Response("slow down", { status: 429 })],
    ["HTTP 403 (usage-policy block)", () => new Response("blocked", { status: 403 })],
    ["a 4 s AbortSignal.timeout", timeoutError],
    ["fetch itself throwing (DNS/TLS)", () => {
      throw new TypeError("fetch failed");
    }],
    ["a non-JSON body served as 200", () => new Response("<html>oops</html>", { status: 200 })],
    ["truncated JSON", () => new Response('{"display_name": "Gam', { status: 200 })],
    ["an empty 200 body", () => new Response("", { status: 200 })],
  ];

  // A 200 that parsed fine but carried nothing usable. These take the final
  // `return … : null` on line 47 — which logs NOTHING. See the observability
  // note below.
  const SILENT_DEGRADES = [
    ["200 with no display_name", () => ({ place_id: 1 })],
    ["200 with an empty display_name", () => ({ display_name: "" })],
    ["200 with a non-string display_name", () => ({ display_name: 42 })],
    ["200 with a null body", () => new Response("null", { status: 200 })],
    ["200 with an array body", () => []],
  ];

  const FAILURES = [...LOGGED_FAILURES, ...SILENT_DEGRADES];

  for (const [label, responder] of FAILURES) {
    test(`${label} → no throw, conversation unchanged, honest degrade`, async () => {
      const { out, conversation, steps, stub } = await run([STOCKHOLM], responder);
      assert.equal(stub.requests.length, 1, "the attempt was made");
      assert.equal(out, conversation, "nothing resolved → the conversation comes back unchanged");
      // The step still opens and closes: the user sees the attempt and its
      // honest outcome rather than a step that never finishes.
      assert.equal(steps.length, 2);
      assert.equal(steps[1].type, "step_done");
      assert.equal(steps[1].label, "No place name resolved for the photo location(s)");
      assert.deepEqual(steps[1].details, []);
    });
  }

  test("transport/HTTP/parse failures log exactly one `geocode.error` warning", async () => {
    for (const [label, responder] of LOGGED_FAILURES) {
      const { log } = await run([STOCKHOLM], responder);
      assert.equal(log.lines.length, 1, label);
      assert.equal(log.lines[0].level, "warn", label);
      assert.equal(log.lines[0].args[0], "geocode.error", label);
    }
  });

  test("a non-OK response logs the status, so the reason is diagnosable", async () => {
    const { log } = await run([STOCKHOLM], () => new Response("slow down", { status: 429 }));
    assert.deepEqual(log.lines[0].args[1], { status: 429 });
  });

  test("a thrown/aborted fetch logs the error message", async () => {
    const { log } = await run([STOCKHOLM], timeoutError);
    assert.match(log.lines[0].args[1].error, /aborted due to timeout/);
  });

  // ---- OBSERVABILITY GAP ---------------------------------------------------
  // A 200 whose body simply has no usable `display_name` returns null on
  // geocode.js line 47 WITHOUT logging anything. From the Worker logs that is
  // indistinguishable from "no photo had coordinates" — the exact silent-no-op
  // shape that made chat_logs #1670 (the Shodan miss) undiagnosable. Pinned as
  // current behaviour; reported, not fixed.
  test("GAP: a 200 with nothing usable logs NOTHING at all", async () => {
    for (const [label, responder] of SILENT_DEGRADES) {
      const { log, steps } = await run([STOCKHOLM], responder);
      assert.equal(log.lines.length, 0, `${label}: currently silent in the Worker log`);
      // The user-facing step is the only surviving signal.
      assert.equal(steps[1].label, "No place name resolved for the photo location(s)");
    }
  });

  test("the failure log never carries the question, the filename or an identifier", async () => {
    const { log } = await run([STOCKHOLM], () => new Response("nope", { status: 500 }));
    log.assertNoneLogged(NEVER_LEAKS, assert.fail);
  });

  test("PARTIAL failure: one location resolves, the other 500s — the good one survives", async () => {
    const { out, steps, stub } = await run([STOCKHOLM, GOTHENBURG], (rec) =>
      rec.url.includes("lat=57.7089") ? new Response("boom", { status: 500 }) : okPlace(PLACE_STHLM),
    );
    assert.equal(stub.requests.length, 2);
    assert.equal(steps[1].label, "Resolved 1 photo location via OpenStreetMap Nominatim");
    assert.deepEqual(steps[1].details, [`${FILENAME}: near ${PLACE_STHLM}`]);
    const text = lastText(out);
    assert.ok(text.includes(PLACE_STHLM));
    assert.ok(!text.includes("img_0002.jpg"), "the failed lookup contributes no line");
  });

  test("an empty conversation with a resolvable location does not throw", async () => {
    const { out } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { conversation: [] });
    assert.deepEqual(out, []);
  });

  test("a last message with unusable content (number) does not throw", async () => {
    const conversation = [{ role: "user", content: 42 }];
    const { out } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { conversation });
    assert.equal(out, conversation, "withAppendedText no-ops on content it cannot append to");
  });

  test("reverseGeocode itself returns null (never throws) on every failure mode", async () => {
    for (const [, responder] of FAILURES) {
      await withFakeFetch(route(responder), async () => {
        const got = await reverseGeocode({}, fakeLog(), 59.3293, 18.0686);
        assert.equal(got, null);
      });
    }
  });

  // ---- DIVERGENCE #2 -------------------------------------------------------
  // augmentWithLocations has NO try/catch of its own: reverseGeocode swallows
  // everything, but validateImageLocations does not, so an entry whose `lat`
  // is an accessor that throws propagates straight out. In chat.js that lands
  // in the stream's catch and errors the whole turn — the one shape where the
  // "never blocks the chat" promise in the header comment does not hold.
  // NOT reachable from the wire today (imageLocations comes from JSON.parse,
  // which cannot produce a getter), so it is pinned as a boundary, not a live
  // bug. If augmentWithLocations ever grows a try/catch, flip this test.
  test("DIVERGENCE: a throwing coordinate accessor escapes (theoretical, not wire-reachable)", async () => {
    const hostile = [
      {
        name: "x.jpg",
        get lat() {
          throw new Error("hostile accessor");
        },
        lon: 18.0686,
      },
    ];
    await withFakeFetch(route(okPlace(PLACE_STHLM)), async (stub) => {
      await assert.rejects(
        () => augmentWithLocations({}, fakeLog(), () => {}, [{ role: "user", content: QUESTION }], hostile),
        /hostile accessor/,
      );
      assert.equal(stub.requests.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// PRIVACY — invariant 4 and the module header's explicit promise
// ---------------------------------------------------------------------------

describe("privacy: only the coordinates cross the wire", () => {
  test("the host is exactly nominatim.openstreetmap.org over https", async () => {
    const { stub } = await run([STOCKHOLM]);
    assert.deepEqual(stub.hosts(), [NOMINATIM_HOST]);
    const url = new URL(stub.requests[0].url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, NOMINATIM_HOST);
    assert.equal(url.pathname, "/reverse");
  });

  test("the URL carries the coordinates and the four fixed params — nothing else", async () => {
    const { stub } = await run([STOCKHOLM]);
    const url = new URL(stub.requests[0].url);
    assert.equal(url.searchParams.get("lat"), "59.3293");
    assert.equal(url.searchParams.get("lon"), "18.0686");
    assert.equal(url.searchParams.get("format"), "jsonv2");
    assert.equal(url.searchParams.get("zoom"), "14");
    assert.equal(url.searchParams.get("addressdetails"), "0");
    assert.deepEqual([...url.searchParams.keys()].sort(), [
      "addressdetails",
      "format",
      "lat",
      "lon",
      "zoom",
    ]);
  });

  test("no request carries the filename, the question, a session/account id or an email", async () => {
    const conversation = [{ role: "user", content: `${QUESTION} (session ${SESSION_ID})` }];
    const env = { SESSION_SECRET: "s3cr3t", GOOGLE_CLIENT_SECRET: "g-s3cr3t" };
    const { stub } = await run([STOCKHOLM, GOTHENBURG], okPlace(PLACE_STHLM), { conversation, env });
    assert.equal(stub.requests.length, 2);
    stub.assertNoneCarry([...NEVER_LEAKS, "s3cr3t", "g-s3cr3t"], assert.fail);
  });

  test("the request is a bodyless GET — no conversation can ride along", async () => {
    const { stub } = await run([STOCKHOLM]);
    assert.equal(stub.requests[0].method, "GET");
    assert.equal(stub.requests[0].body, "");
  });

  test("the generic User-Agent Nominatim's usage policy requires is set, and it names nothing", async () => {
    const { stub } = await run([STOCKHOLM]);
    assert.equal(stub.requests[0].headers["user-agent"], GENERIC_USER_AGENT);
    // Deliberately generic: no site name, no URL, no contact (module header).
    assert.ok(!/deepresearch/i.test(GENERIC_USER_AGENT));
    assert.ok(!/https?:\/\//.test(GENERIC_USER_AGENT));
    assert.ok(!GENERIC_USER_AGENT.includes("@"));
  });

  test("no cookie / authorization / api-key header is attached", async () => {
    const { stub } = await run([STOCKHOLM], okPlace(PLACE_STHLM), {
      env: { EXA_API_KEY: "exa-k", SHODAN_API_KEY: "shodan-k", BERGET_API_KEY: "berget-k" },
    });
    const headers = stub.requests[0].headers;
    for (const forbidden of ["cookie", "authorization", "x-api-key", "x-request-id"]) {
      assert.equal(headers[forbidden], undefined, `${forbidden} must not be sent to Nominatim`);
    }
    stub.assertNoneCarry(["exa-k", "shodan-k", "berget-k"], assert.fail);
  });

  test("the filename stays LOCAL: it labels the context block but never leaves", async () => {
    const { out, stub } = await run([STOCKHOLM]);
    assert.ok(lastText(out).includes(FILENAME), "the block labels the line with the filename");
    stub.assertNoneCarry([FILENAME], assert.fail);
  });
});

// ---------------------------------------------------------------------------
// LANGUAGE INDEPENDENCE — invariant 6's negative form
// ---------------------------------------------------------------------------

describe("language independence: the trigger is structural, not linguistic", () => {
  // geocode.js has NO phrase gate — it fires on the presence of valid
  // coordinates alone. This suite pins that, so a future change that adds an
  // English-only wording gate ("photo taken at…") is caught as an invariant 6
  // violation instead of shipping.
  const PAIRS = [
    ["EN", "Where was this photo taken?"],
    ["SV", "Var är det här fotot taget?"],
    ["SV definite", "Vilken plats visar bilden?"],
    ["SV with å/ä/ö near the boundary", "Är fotot från Öland eller Åre?"],
    ["neither language", "🙂"],
    ["empty text", ""],
  ];

  for (const [label, text] of PAIRS) {
    test(`${label}: fires identically for the same coordinates`, async () => {
      const conversation = [{ role: "user", content: text }];
      const { steps, out, stub } = await run([STOCKHOLM], okPlace(PLACE_STHLM), { conversation });
      assert.equal(stub.requests.length, 1);
      assert.equal(steps.length, 2);
      assert.equal(steps[1].label, "Resolved 1 photo location via OpenStreetMap Nominatim");
      assert.ok(lastText(out).includes(`${FILENAME}: near ${PLACE_STHLM}`));
    });
  }

  test("a non-ASCII place name survives into the block unmangled", async () => {
    const { out, steps } = await run([GOTHENBURG], okPlace(PLACE_GBG));
    assert.deepEqual(steps[1].details, [`img_0002.jpg: near ${PLACE_GBG}`]);
    assert.ok(lastText(out).includes("Göteborg"));
  });

  test("the step labels are English-only today — pinned so localizing is deliberate", async () => {
    const { steps } = await run([STOCKHOLM]);
    assert.equal(steps[0].label, STEP_START_LABEL);
    assert.equal(steps[1].label, "Resolved 1 photo location via OpenStreetMap Nominatim");
  });
});

// ---------------------------------------------------------------------------
// WIRING — the unconditional pre-pipeline call in chat.js
// ---------------------------------------------------------------------------

describe("wiring: chat.js still geocodes before the pipeline runs", () => {
  // These are TEXT assertions on purpose. The geocode call is unconditional
  // and lives OUTSIDE the extension registry (src/extensions.js lines 30-34
  // explain why it is not registered), so src/extensions.test.js's registry
  // walk cannot see it and no behavioural test in this repo exercises the
  // chat.js stream path. Reading the source as text is the same technique
  // src/extensions.test.js (core purity) and src/facade-contract.test.js use,
  // and it is the only thing standing between a refactor and silently losing
  // the photo-location step. If this assertion is ever hard to satisfy after a
  // legitimate refactor, update the pattern — do not delete the test.
  const chatSrc = readFileSync(join(ROOT, "src", "chat.js"), "utf8");

  test("chat.js imports augmentWithLocations from ./geocode.js", () => {
    assert.match(chatSrc, /import\s*\{\s*augmentWithLocations\s*\}\s*from\s*["']\.\/geocode\.js["']/);
  });

  test("chat.js calls augmentWithLocations with the wire field body.imageLocations", () => {
    const call = chatSrc.match(/await augmentWithLocations\(([\s\S]*?)\)\s*;/);
    assert.ok(call, "the augmentWithLocations call must still exist in chat.js");
    assert.match(call[1], /\bbody\.imageLocations\b/, "the client's wire field must still be passed");
    assert.match(call[1], /\bemit\b/, "the SSE emitter must still be passed, or the step goes dark");
  });

  test("the call happens BEFORE runPipeline, and feeds it", () => {
    const assign = chatSrc.match(/const\s+(\w+)\s*=\s*await augmentWithLocations\(/);
    assert.ok(assign, "the geocode result must still be captured into a variable");
    const geocodeAt = chatSrc.indexOf("await augmentWithLocations(");
    const pipelineAt = chatSrc.indexOf("await runPipeline(");
    assert.ok(geocodeAt > -1 && pipelineAt > -1);
    assert.ok(geocodeAt < pipelineAt, "geocoding must precede the pipeline, not follow it");
    const pipelineCall = chatSrc.slice(pipelineAt).match(/await runPipeline\(([\s\S]*?)\)\s*;/);
    assert.ok(pipelineCall);
    assert.match(
      pipelineCall[1],
      new RegExp(`\\b${assign[1]}\\b`),
      "runPipeline must receive the geocode-augmented conversation, not the raw one",
    );
  });

  test("geocode stays OUT of the extension registry (src/extensions.js lines 30-34)", () => {
    const extSrc = readFileSync(join(ROOT, "src", "extensions.js"), "utf8");
    assert.ok(
      !/from\s*["']\.\/geocode\.js["']/.test(extSrc),
      "geocode has no knob and no request state — registering it changes the unconditional contract",
    );
  });
});

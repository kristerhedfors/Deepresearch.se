// Tests for the Tokemon game's STREET-VIEW endpoints (src/tokemon-api.js):
// POST …/go (text navigation) and GET …/scene (the AR frame), plus the
// overlay decoration both the map and the street pane read.
//
// The pure rules live in tokemon.js / tokemon-nav.js and are tested there;
// what is exercised here is the handler layer — validation, the Maps knob
// gate, the fail-soft "unavailable" answers, and the bilingual replies.
// D1 is a tiny in-memory fake (one tokemon_saves row) and the two Google
// calls are stubbed at globalThis.fetch, so nothing here touches a network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decorateOverlays, handleTokemon } from "./tokemon-api.js";
import { ENCOUNTER_RADIUS_M, haversineM } from "./tokemon.js";
import { destinationPoint, SCENE_FOV, SCENE_VIEW_DIST_M } from "./tokemon-nav.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const POS = { lat: 59.3326, lng: 18.0649 }; // Stockholm, Odenplan-ish

// ── in-memory D1 fake: the one statement pair tokemon-api runs ───────────────
function fakeDb() {
  /** @type {Map<string, string>} */
  const saves = new Map();
  const stmt = (sql) => ({
    _a: /** @type {any[]} */ ([]),
    bind(...a) { this._a = a; return this; },
    async first() {
      if (sql.startsWith("SELECT save_json")) {
        const json = saves.get(this._a[0]);
        return json ? { save_json: json } : null;
      }
      return null;
    },
    async run() {
      if (sql.startsWith("INSERT INTO tokemon_saves")) saves.set(this._a[0], this._a[1]);
      return { meta: { changes: 1 } };
    },
  });
  return { saves, prepare: (sql) => stmt(sql), batch: async () => [] };
}

/** An identity with the per-user Google Maps knob on or off. */
const identityWith = (mapsOn) => ({
  id: "u1",
  role: "user",
  email: "u@x.se",
  name: "U",
  user: { id: 1, settings_json: JSON.stringify({ google_maps: mapsOn }) },
});

const envWith = (mapsKey) => ({ DB: fakeDb(), ...(mapsKey ? { GOOGLE_MAPS_API_KEY: "test-key" } : {}) });

/**
 * Call one street-view endpoint. `env`/`identity` default to "Maps knob on,
 * key configured" — the interesting cases override them.
 */
async function call(path, { method = "GET", body, env = envWith(true), identity = identityWith(true) } = {}) {
  const url = new URL(`https://x.se/api/games/tokemon/${path}`);
  const request = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
  const res = await handleTokemon(request, env, url, log, identity, path.split("?")[0]);
  return { status: res.status, body: await res.json() };
}

/** Stub globalThis.fetch for the Google calls a scene/goto makes. */
async function withFetch(handler, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input?.url || input), init);
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const jsonRes = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
const imageRes = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });

// ---------------------------------------------------------------------------
// POST …/go — text navigation

test("go: a move walks the parsed distance and reports it in the frame's language", async () => {
  const r = await call("go", { method: "POST", body: { command: "go north 200 m", ...POS, heading: 90 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, true);
  assert.equal(r.body.heading, 0, "walking north also faces north");
  assert.ok(Math.abs(haversineM(POS.lat, POS.lng, r.body.pos.lat, r.body.pos.lng) - 200) < 1);
  assert.ok(r.body.pos.lat > POS.lat);
  assert.equal(r.body.say, "Walked 200 m north.");

  const sv = await call("go", { method: "POST", body: { command: "gå norrut 200 m", ...POS, heading: 0 } });
  assert.equal(sv.body.say, "Gick 200 m norrut.");
});

test("go: a relative move turns off the CURRENT heading before walking", async () => {
  const r = await call("go", { method: "POST", body: { command: "go left", ...POS, heading: 90 } });
  assert.equal(r.body.heading, 0, "left of east is north");
  assert.equal(r.body.say, "Walked 100 m north.");
  assert.ok(r.body.pos.lat > POS.lat);

  // "continue" keeps the heading; a non-cardinal one is reported in degrees.
  const on = await call("go", { method: "POST", body: { command: "fortsätt 50 m", ...POS, heading: 20 } });
  assert.equal(on.body.heading, 20);
  assert.equal(on.body.say, "Gick 50 m 20°.");
  assert.ok(Math.abs(haversineM(POS.lat, POS.lng, on.body.pos.lat, on.body.pos.lng) - 50) < 1);
});

test("go: a look turns the camera without moving the player", async () => {
  const r = await call("go", { method: "POST", body: { command: "turn right", ...POS, heading: 350 } });
  assert.equal(r.body.moved, false);
  assert.equal(r.body.heading, 80, "wraps past north");
  assert.deepEqual(r.body.pos, POS, "position untouched");
  assert.equal(r.body.say, "Facing 80°.");

  const sv = await call("go", { method: "POST", body: { command: "titta västerut", ...POS, heading: 0 } });
  assert.equal(sv.body.heading, 270);
  assert.equal(sv.body.say, "Tittar 270°.");
});

test("go: bad input is refused with the bilingual help line, not a crash", async () => {
  const noPos = await call("go", { method: "POST", body: { command: "go north" } });
  assert.equal(noPos.status, 400);
  assert.match(noPos.body.error, /lat and lng/);

  const nonsense = await call("go", { method: "POST", body: { command: "sing me a song", ...POS } });
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.body.error, /go north 200 m/);
  assert.match(nonsense.body.error, /gå till Kungsgatan 1/);

  const empty = await call("go", { method: "POST", body: { ...POS } });
  assert.equal(empty.status, 400);

  // A malformed body must not throw either.
  const url = new URL("https://x.se/api/games/tokemon/go");
  const res = await handleTokemon(
    new Request(url, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } }),
    envWith(true),
    url,
    log,
    identityWith(true),
    "go",
  );
  assert.equal(res.status, 400);
});

test("go: traveling to a place rides the Maps knob and answers in the command's language", async () => {
  const off = await call("go", {
    method: "POST",
    body: { command: "go to Sergels torg", ...POS },
    identity: identityWith(false),
  });
  assert.equal(off.status, 403);
  assert.match(off.body.error, /Google Maps setting/);

  const offSv = await call("go", {
    method: "POST",
    body: { command: "gå till Sergels torg", ...POS },
    identity: identityWith(false),
  });
  assert.match(offSv.body.error, /Google Maps-inställningen/);

  // Knob on but no server key: the extension reads as unavailable, same 403.
  const noKey = await call("go", { method: "POST", body: { command: "go to Sergels torg", ...POS }, env: { DB: fakeDb() } });
  assert.equal(noKey.status, 403);
});

test("go: a resolved place moves the player there; an unresolved one 404s", async () => {
  const found = await withFetch(
    () => jsonRes({ places: [{ displayName: { text: "Sergels torg" }, location: { latitude: 59.3326, longitude: 18.0649 } }] }),
    () => call("go", { method: "POST", body: { command: "go to Sergels torg", lat: 59.4, lng: 18.1 } }),
  );
  assert.equal(found.status, 200);
  assert.equal(found.body.moved, true);
  assert.deepEqual(found.body.pos, { lat: 59.3326, lng: 18.0649 });
  assert.equal(found.body.say, "Traveled to Sergels torg.");

  const missing = await withFetch(
    () => jsonRes({ places: [] }),
    () => call("go", { method: "POST", body: { command: "åk till ingenstans", ...POS } }),
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Hittade inte "ingenstans".');

  // Google failing is a miss, not a 500.
  const broken = await withFetch(
    () => new Response("nope", { status: 500 }),
    () => call("go", { method: "POST", body: { command: "go to nowhere", ...POS } }),
  );
  assert.equal(broken.status, 404);
});

// ---------------------------------------------------------------------------
// GET …/scene — the AR frame

test("scene: every unavailable path answers 200 with a reason the pane can explain", async () => {
  const noPos = await call("scene");
  assert.equal(noPos.status, 400);
  assert.match(noPos.body.error, /lat and lng/);

  const off = await call(`scene?lat=${POS.lat}&lng=${POS.lng}`, { identity: identityWith(false) });
  assert.equal(off.status, 200, "never an error page");
  assert.equal(off.body.available, false);
  assert.equal(off.body.reason, "disabled");
  assert.match(off.body.message, /Account → Settings/);

  const noCoverage = await withFetch(
    () => jsonRes({ status: "ZERO_RESULTS" }),
    () => call(`scene?lat=${POS.lat}&lng=${POS.lng}`),
  );
  assert.equal(noCoverage.status, 200);
  assert.equal(noCoverage.body.reason, "no_coverage");

  const captureFailed = await withFetch(
    (url) => (url.includes("/metadata") ? jsonRes({ status: "OK", location: POS, pano_id: "p1" }) : new Response("", { status: 502 })),
    () => call(`scene?lat=${POS.lat}&lng=${POS.lng}`),
  );
  assert.equal(captureFailed.status, 200);
  assert.equal(captureFailed.body.reason, "capture_failed");
});

test("scene: a captured frame snaps the camera to the panorama and frames the spawns", async () => {
  const pano = { lat: POS.lat + 0.0002, lng: POS.lng }; // the pano stands up the street
  const r = await withFetch(
    (url) => (url.includes("/metadata") ? jsonRes({ status: "OK", location: pano, pano_id: "p1", date: "2025-06" }) : imageRes()),
    () => call(`scene?lat=${POS.lat}&lng=${POS.lng}&heading=-90`),
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.available, true);
  assert.match(r.body.image, /^data:image\//);
  assert.equal(r.body.date, "2025-06");
  assert.deepEqual(r.body.pano, pano, "camera = the panorama's true position, not the player's");
  assert.equal(r.body.heading, 270, "heading is normalized into 0..360");
  assert.equal(r.body.fov, SCENE_FOV);
  assert.equal(r.body.viewDistM, SCENE_VIEW_DIST_M);
  assert.ok(Array.isArray(r.body.overlays));
  // Spawns are deterministic per cell+time bucket, so how many are in frame
  // depends on when the suite runs — the CONTRACT is what each one carries.
  for (const o of r.body.overlays) {
    for (const k of ["id", "kind", "emoji", "name", "xPct", "yPct", "scale", "distM", "bearing", "near", "lat", "lng"]) {
      assert.ok(o[k] !== undefined, `overlay.${k}`);
    }
    assert.ok(o.xPct >= 0 && o.xPct <= 100 && o.yPct >= 0 && o.yPct <= 100);
    assert.ok(o.distM <= SCENE_VIEW_DIST_M);
  }
});

test("scene/go: without D1 the game degrades instead of erroring", async () => {
  const scene = await call(`scene?lat=${POS.lat}&lng=${POS.lng}`, { env: {} });
  assert.equal(scene.status, 503);
  assert.match(scene.body.error, /database/i);
  const go = await call("go", { method: "POST", body: { command: "go north", ...POS }, env: {} });
  assert.equal(go.status, 503);
  const unknown = await call("nope");
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// decorateOverlays — what the client actually paints

test("decorateOverlays names each spawn kind and measures `near` from the PLAYER", () => {
  const cam = POS;
  // Player stands 100 m south of the camera; all three spawns are ahead.
  const player = destinationPoint(cam.lat, cam.lng, 180, 100);
  const spawns = [
    { id: "c1", kind: "creature", name: "Cindron", emoji: "🔥", level: 12, ...destinationPoint(cam.lat, cam.lng, 0, 30) },
    { id: "i1", kind: "item", item: "tokeball", emoji: "🎒", ...destinationPoint(cam.lat, cam.lng, 5, 60) },
    { id: "v1", kind: "villain", villain: "Rootkit Rex", emoji: "🦹", ...destinationPoint(cam.lat, cam.lng, 350, 90) },
  ];
  const out = decorateOverlays(/** @type {any} */ (spawns), cam, 0, player);
  const byId = Object.fromEntries(out.map((o) => [o.id, o]));

  assert.equal(byId.c1.name, "Cindron");
  assert.equal(byId.c1.level, 12);
  assert.equal(byId.i1.name, "tokeball", "an item is named by what it is");
  assert.equal(byId.i1.level, undefined, "only creatures carry a level");
  assert.equal(byId.v1.name, "Rootkit Rex");
  assert.equal(byId.v1.emoji, "🦹");

  // 30 m ahead of the camera is 130 m from the player — out of catching reach
  // even though it is right there in the frame.
  assert.equal(byId.c1.near, false);
  assert.ok(haversineM(player.lat, player.lng, byId.c1.lat, byId.c1.lng) > ENCOUNTER_RADIUS_M);
  const atPlayer = decorateOverlays(/** @type {any} */ (spawns), cam, 0, cam);
  assert.equal(atPlayer.find((o) => o.id === "c1").near, true, "standing at the camera, it is in reach");

  // Painted far-to-near, and each overlay carries its own position so a tap
  // works even after the spawn drops out of the client's local list.
  assert.deepEqual(out.map((o) => o.id), ["v1", "i1", "c1"]);
  assert.equal(byId.c1.lat, spawns[0].lat);
});

test("decorateOverlays drops what the camera cannot see", () => {
  const behind = { id: "b", kind: "item", item: "x", emoji: "🎒", ...destinationPoint(POS.lat, POS.lng, 180, 20) };
  const tooFar = { id: "f", kind: "item", item: "x", emoji: "🎒", ...destinationPoint(POS.lat, POS.lng, 0, SCENE_VIEW_DIST_M + 20) };
  const out = decorateOverlays(/** @type {any} */ ([behind, tooFar]), POS, 0, POS);
  assert.deepEqual(out, []);
});

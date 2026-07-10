// Tests for the Tokemon navigation module (src/tokemon-nav.js): the
// text-command grammar (incl. the Swedish-parity suite CLAUDE.md invariant 6
// mandates for every deterministic intent gate), the geodesy, and the
// street-view spawn projection.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  angleDiff,
  bearingBetween,
  DEFAULT_MOVE_M,
  destinationPoint,
  MAX_MOVE_M,
  normalizeHeading,
  parseGoCommand,
  projectSpawns,
  SCENE_FOV,
  SCENE_VIEW_DIST_M,
} from "./tokemon-nav.js";
import { haversineM } from "./tokemon.js";

// ---------------------------------------------------------------------------
// Command grammar

test("move commands parse with direction, distance, and defaults", () => {
  assert.deepEqual(parseGoCommand("go north 200 m"), { kind: "move", bearing: 0, distanceM: 200, sv: false });
  assert.deepEqual(parseGoCommand("walk southwest"), { kind: "move", bearing: 225, distanceM: DEFAULT_MOVE_M, sv: false });
  assert.equal(parseGoCommand("head east 0.5 km").distanceM, 500);
  assert.equal(parseGoCommand("move north 99999 m").distanceM, MAX_MOVE_M); // capped
  assert.deepEqual(parseGoCommand("north"), { kind: "move", bearing: 0, distanceM: DEFAULT_MOVE_M, sv: false });
  assert.equal(parseGoCommand("GO NORTH").bearing, 0); // case-insensitive
  assert.equal(parseGoCommand("go north!").bearing, 0); // trailing punctuation
});

test("goto commands capture the free-text place query", () => {
  assert.deepEqual(parseGoCommand("go to Kungsgatan 1"), { kind: "goto", query: "kungsgatan 1", sv: false });
  assert.equal(parseGoCommand("take me to the eiffel tower").query, "the eiffel tower");
  assert.equal(parseGoCommand("goto sergels torg").query, "sergels torg");
  // A compass word after the verb stays a MOVE, not a goto.
  assert.equal(parseGoCommand("go to the north").kind, "move");
});

test("look/turn commands: relative turns, absolute bearings, degrees", () => {
  assert.deepEqual(parseGoCommand("look right"), { kind: "look", turn: 90, sv: false });
  assert.deepEqual(parseGoCommand("turn left"), { kind: "look", turn: -90, sv: false });
  assert.equal(parseGoCommand("turn around").turn, 180);
  assert.deepEqual(parseGoCommand("look west"), { kind: "look", bearing: 270, sv: false });
  assert.equal(parseGoCommand("turn 45").turn, 45);
  assert.equal(parseGoCommand("face north").bearing, 0);
});

test("non-commands return null", () => {
  assert.equal(parseGoCommand("hello there"), null);
  assert.equal(parseGoCommand(""), null);
  assert.equal(parseGoCommand(null), null);
  assert.equal(parseGoCommand("what is the capital of france"), null);
  assert.equal(parseGoCommand("g".repeat(300)), null); // over-length
  assert.equal(parseGoCommand("turn"), null); // bare verb
});

// Swedish language parity — the invariant-6 suite: every English form has a
// Swedish twin with the same breadth (verbs, adverbial directions,
// unaccented typo forms), and results are flagged sv for reply language.
test("Swedish parity: moves", () => {
  assert.deepEqual(parseGoCommand("gå norrut 200 m"), { kind: "move", bearing: 0, distanceM: 200, sv: true });
  assert.equal(parseGoCommand("promenera söderut").bearing, 180);
  assert.equal(parseGoCommand("spring västerut 300 meter").distanceM, 300);
  assert.equal(parseGoCommand("fortsätt österut").bearing, 90);
  assert.deepEqual(parseGoCommand("norrut"), { kind: "move", bearing: 0, distanceM: DEFAULT_MOVE_M, sv: true });
  assert.equal(parseGoCommand("gå nordost").bearing, 45);
  // Unaccented typo forms.
  assert.equal(parseGoCommand("ga soderut").bearing, 180);
  assert.equal(parseGoCommand("ga vasterut 50 m").bearing, 270);
  assert.equal(parseGoCommand("gå sydvast").bearing, 225);
});

test("Swedish parity: goto", () => {
  assert.deepEqual(parseGoCommand("gå till Kungsgatan 1"), { kind: "goto", query: "kungsgatan 1", sv: true });
  assert.equal(parseGoCommand("ta mig till sergels torg").query, "sergels torg");
  assert.equal(parseGoCommand("åk till gamla stan").query, "gamla stan");
  assert.equal(parseGoCommand("res till uppsala").query, "uppsala");
  // A compass word after the verb stays a MOVE (same rule as English).
  assert.equal(parseGoCommand("gå till norr").kind, "move");
});

test("Swedish parity: look/turn", () => {
  assert.deepEqual(parseGoCommand("titta höger"), { kind: "look", turn: 90, sv: true });
  assert.equal(parseGoCommand("vänd vänster").turn, -90);
  assert.equal(parseGoCommand("vänd om").turn, 180);
  assert.equal(parseGoCommand("titta västerut").bearing, 270);
  assert.equal(parseGoCommand("titta hoger").turn, 90); // unaccented
  assert.equal(parseGoCommand("vand bakat").turn, 180); // unaccented
});

// ---------------------------------------------------------------------------
// Geodesy

test("destinationPoint moves the right distance and direction", () => {
  const start = { lat: 59.3326, lng: 18.0649 };
  const north = destinationPoint(start.lat, start.lng, 0, 200);
  assert.ok(north.lat > start.lat);
  assert.ok(Math.abs(haversineM(start.lat, start.lng, north.lat, north.lng) - 200) < 1);
  const east = destinationPoint(start.lat, start.lng, 90, 500);
  assert.ok(east.lng > start.lng);
  assert.ok(Math.abs(east.lat - start.lat) < 0.0005);
  assert.ok(Math.abs(haversineM(start.lat, start.lng, east.lat, east.lng) - 500) < 2);
});

test("bearingBetween and angleDiff behave", () => {
  assert.ok(Math.abs(bearingBetween(59, 18, 60, 18) - 0) < 1); // due north
  assert.ok(Math.abs(bearingBetween(59, 18, 59, 19) - 90) < 1); // due east
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(180, 0), 180);
  assert.equal(normalizeHeading(-90), 270);
  assert.equal(normalizeHeading(725), 5);
});

// ---------------------------------------------------------------------------
// Projection

test("projectSpawns: ahead is centered, off-fov and far spawns are excluded", () => {
  const cam = { lat: 59.3326, lng: 18.0649 };
  const ahead = destinationPoint(cam.lat, cam.lng, 0, 40); // 40 m due north
  const behind = destinationPoint(cam.lat, cam.lng, 180, 40);
  const far = destinationPoint(cam.lat, cam.lng, 0, SCENE_VIEW_DIST_M + 50);
  const spawns = [
    { id: "a", kind: "creature", ...ahead },
    { id: "b", kind: "creature", ...behind },
    { id: "f", kind: "item", ...far },
  ];
  const out = projectSpawns(cam.lat, cam.lng, 0, spawns);
  assert.deepEqual(out.map((o) => o.id), ["a"]);
  assert.ok(Math.abs(out[0].xPct - 50) < 3, "dead ahead ≈ centered");
  assert.ok(out[0].yPct > 50 && out[0].yPct <= 82);
  assert.ok(out[0].distM >= 38 && out[0].distM <= 42);
});

test("projectSpawns: x follows relative bearing, near spawns are larger and lower", () => {
  const cam = { lat: 59.3326, lng: 18.0649 };
  const right = destinationPoint(cam.lat, cam.lng, 40, 60); // 40° right of heading 0
  const near = destinationPoint(cam.lat, cam.lng, 0, 10);
  const farIn = destinationPoint(cam.lat, cam.lng, 0, 120);
  const out = projectSpawns(cam.lat, cam.lng, 0, [
    { id: "r", kind: "creature", ...right },
    { id: "n", kind: "creature", ...near },
    { id: "f", kind: "creature", ...farIn },
  ]);
  const byId = Object.fromEntries(out.map((o) => [o.id, o]));
  assert.ok(byId.r.xPct > 80, "40° right of a 90° fov sits far right");
  assert.ok(byId.n.scale > byId.f.scale, "near is larger");
  assert.ok(byId.n.yPct > byId.f.yPct, "near is lower in frame");
  assert.equal(out[0].id, "f", "far paints first (under)");
  assert.equal(SCENE_FOV, 90);
});

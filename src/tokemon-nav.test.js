// Tests for the Tokemon navigation module (src/tokemon-nav.js): the
// text-command grammar (incl. the Swedish-parity suite CLAUDE.md invariant 6
// mandates for every deterministic intent gate), the geodesy, and the
// street-view spawn projection.
//
// The parity suite is STRUCTURAL as well as example-based: it walks the
// exported vocabulary tables, so a Swedish word added without an English twin
// (or a Swedish form the reply-language flag can't see) fails here rather
// than in a chat log.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  absoluteBearing,
  angleDiff,
  bearingBetween,
  CAMERA_HEIGHT_M,
  DEFAULT_MOVE_M,
  destinationPoint,
  MAX_MOVE_M,
  NAV_VOCAB,
  normalizeHeading,
  parseGoCommand,
  projectSpawns,
  SCALE_REF_M,
  SCENE_FOV,
  SCENE_VIEW_DIST_M,
  SV_ONLY_WORDS,
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
  assert.equal(parseGoCommand("please go north, then").bearing, 0); // filler words
  assert.equal(parseGoCommand("go north 200m").distanceM, 200); // unit glued to the number
});

test("moves may be relative to the current heading, not just absolute", () => {
  assert.deepEqual(parseGoCommand("go left"), { kind: "move", turn: -90, distanceM: DEFAULT_MOVE_M, sv: false });
  assert.equal(parseGoCommand("walk right 40 m").turn, 90);
  assert.equal(parseGoCommand("go back").turn, 180);
  assert.equal(parseGoCommand("go straight ahead 250 m").turn, 0);
  // A bare move verb means "carry on the way you're facing".
  assert.deepEqual(parseGoCommand("continue"), { kind: "move", turn: 0, distanceM: DEFAULT_MOVE_M, sv: false });
  assert.equal(parseGoCommand("keep going 50 m").distanceM, 50);
  assert.equal(parseGoCommand("keep going 50 m").turn, 0);
  // Absolute wins when both a compass word and the heading are in play.
  assert.equal(parseGoCommand("go north").bearing, 0);
  assert.equal(parseGoCommand("go north").turn, undefined);
});

test("a move verb still routes when the phrase carries words the grammar doesn't know", () => {
  // Lenient tier: an explicit verb + a compass word beats unknown vocabulary.
  assert.equal(parseGoCommand("walk northwest past the church").bearing, 315);
  assert.equal(parseGoCommand("spring söderut längs kajen").bearing, 180);
  // …but unknown words alone are never a move.
  assert.equal(parseGoCommand("past the church"), null);
});

test("goto commands capture the free-text place query", () => {
  assert.deepEqual(parseGoCommand("go to Kungsgatan 1"), { kind: "goto", query: "kungsgatan 1", sv: false });
  assert.equal(parseGoCommand("take me to the eiffel tower").query, "the eiffel tower");
  assert.equal(parseGoCommand("goto sergels torg").query, "sergels torg");
  // A query that is NOTHING BUT a direction stays a move…
  assert.equal(parseGoCommand("go to the north").kind, "move");
  assert.equal(parseGoCommand("go to the north").bearing, 0);
  // …but a place that merely CONTAINS a compass word is still a place. (The
  // old rule scanned the whole query for a direction and walked north here.)
  assert.deepEqual(parseGoCommand("go to the north entrance"), {
    kind: "goto",
    query: "the north entrance",
    sv: false,
  });
  assert.equal(parseGoCommand("walk to west street").query, "west street");
});

test("look/turn commands: relative turns, absolute bearings, degrees", () => {
  assert.deepEqual(parseGoCommand("look right"), { kind: "look", turn: 90, sv: false });
  assert.deepEqual(parseGoCommand("turn left"), { kind: "look", turn: -90, sv: false });
  assert.equal(parseGoCommand("turn around").turn, 180);
  assert.deepEqual(parseGoCommand("look west"), { kind: "look", bearing: 270, sv: false });
  assert.equal(parseGoCommand("turn 45").turn, 45);
  assert.equal(parseGoCommand("turn -90").turn, -90);
  assert.equal(parseGoCommand("turn 45 degrees").turn, 45);
  assert.equal(parseGoCommand("turn 999").turn, 180); // clamped
  assert.equal(parseGoCommand("face north").bearing, 0);
  assert.equal(parseGoCommand("look ahead").turn, 0);
});

test("a look-led phrase never falls through to the move rules", () => {
  assert.equal(parseGoCommand("look at the sky"), null);
  assert.equal(parseGoCommand("titta på kartan"), null);
});

test("non-commands return null", () => {
  assert.equal(parseGoCommand("hello there"), null);
  assert.equal(parseGoCommand(""), null);
  assert.equal(parseGoCommand(null), null);
  assert.equal(parseGoCommand(undefined), null);
  assert.equal(parseGoCommand(42), null);
  assert.equal(parseGoCommand({ command: "go north" }), null);
  assert.equal(parseGoCommand("what is the capital of france"), null);
  assert.equal(parseGoCommand("g".repeat(300)), null); // over-length
  assert.equal(parseGoCommand("turn"), null); // bare verb
  assert.equal(parseGoCommand("go to a"), null); // too short to be a query
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

test("Swedish parity: relative moves", () => {
  assert.deepEqual(parseGoCommand("gå vänster"), { kind: "move", turn: -90, distanceM: DEFAULT_MOVE_M, sv: true });
  assert.equal(parseGoCommand("gå höger 40 m").turn, 90);
  assert.equal(parseGoCommand("gå tillbaka").turn, 180);
  assert.equal(parseGoCommand("fortsätt rakt fram 250 m").turn, 0);
  assert.deepEqual(parseGoCommand("fortsätt"), { kind: "move", turn: 0, distanceM: DEFAULT_MOVE_M, sv: true });
  assert.equal(parseGoCommand("gå 100 meter").turn, 0);
  assert.equal(parseGoCommand("rör dig framåt").turn, 0);
  assert.equal(parseGoCommand("ga hoger").turn, 90); // unaccented
});

test("Swedish parity: goto", () => {
  assert.deepEqual(parseGoCommand("gå till Kungsgatan 1"), { kind: "goto", query: "kungsgatan 1", sv: true });
  assert.equal(parseGoCommand("ta mig till sergels torg").query, "sergels torg");
  assert.equal(parseGoCommand("åk till gamla stan").query, "gamla stan");
  assert.equal(parseGoCommand("res till uppsala").query, "uppsala");
  assert.equal(parseGoCommand("navigera till slussen").query, "slussen");
  // A compass word after the verb stays a MOVE (same rule as English)…
  assert.equal(parseGoCommand("gå till norr").kind, "move");
  // …while a place that contains one is still a place.
  assert.equal(parseGoCommand("gå till norra bantorget").query, "norra bantorget");
});

test("Swedish parity: look/turn", () => {
  assert.deepEqual(parseGoCommand("titta höger"), { kind: "look", turn: 90, sv: true });
  assert.equal(parseGoCommand("vänd vänster").turn, -90);
  assert.equal(parseGoCommand("vänd om").turn, 180);
  assert.equal(parseGoCommand("titta västerut").bearing, 270);
  assert.equal(parseGoCommand("vänd 45 grader").turn, 45);
  assert.equal(parseGoCommand("sväng höger").turn, 90, "the everyday Swedish 'turn'");
  assert.equal(parseGoCommand("svang vanster").turn, -90);
  assert.equal(parseGoCommand("titta hoger").turn, 90); // unaccented
  assert.equal(parseGoCommand("vand bakat").turn, 180); // unaccented
});

test("Swedish parity is structural: every table declares both languages", () => {
  const sets = [
    ...NAV_VOCAB.DIRECTIONS,
    ...NAV_VOCAB.RELATIVES,
    ...Object.values(NAV_VOCAB.VERBS),
    NAV_VOCAB.UNITS,
    NAV_VOCAB.DEGREE_WORDS,
    NAV_VOCAB.FILLER,
  ];
  for (const set of sets) {
    assert.ok(set.en.length, `English forms missing from ${JSON.stringify(set)}`);
    assert.ok(set.sv.length, `Swedish forms missing from ${JSON.stringify(set)}`);
  }
  // Directions and relatives route behavior, so their Swedish side must be at
  // least as broad as the English one — that is what invariant 6 asks for.
  for (const set of [...NAV_VOCAB.DIRECTIONS, ...NAV_VOCAB.RELATIVES]) {
    assert.ok(set.sv.length >= set.en.length, `Swedish narrower than English: ${set.en.join("/")}`);
  }
});

test("Swedish parity is structural: every compass and relative word parses in both languages", () => {
  for (const { bearing, en, sv } of NAV_VOCAB.DIRECTIONS) {
    for (const word of en) assert.equal(parseGoCommand(`go ${word}`)?.bearing, bearing, `en: go ${word}`);
    for (const word of sv) {
      const cmd = parseGoCommand(`gå ${word}`);
      assert.equal(cmd?.bearing, bearing, `sv: gå ${word}`);
      assert.equal(cmd?.sv, true, `sv flag: gå ${word}`);
    }
  }
  for (const { turn, en, sv } of NAV_VOCAB.RELATIVES) {
    for (const word of en) assert.equal(parseGoCommand(`look ${word}`)?.turn, turn, `en: look ${word}`);
    for (const word of sv) assert.equal(parseGoCommand(`titta ${word}`)?.turn, turn, `sv: titta ${word}`);
  }
});

test("the reply-language flag is derived, so shared spellings never flip it", () => {
  // "meter", "m" and "km" exist in both languages: they mark nothing.
  for (const shared of ["meter", "m", "km", "kilometer"]) {
    assert.ok(!SV_ONLY_WORDS.has(shared), `${shared} must not count as Swedish`);
  }
  assert.equal(parseGoCommand("go north 200 meter").sv, false);
  assert.equal(parseGoCommand("gå norrut 200 meter").sv, true);
  // Every Swedish-only word really does flip it (the flag can't drift from
  // the vocabulary because both are derived from the same tables).
  for (const word of SV_ONLY_WORDS) {
    assert.ok(SV_ONLY_WORDS.has(word) && !/^\s*$/.test(word), `empty token in the Swedish set`);
  }
  assert.ok(SV_ONLY_WORDS.has("norrut") && SV_ONLY_WORDS.has("höger") && SV_ONLY_WORDS.has("tillbaka"));
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

test("destinationPoint wraps across the antimeridian", () => {
  const to = destinationPoint(0, 179.9, 90, 30000); // 30 km east of 179.9°E
  assert.ok(to.lng < 0, "longitude wrapped into the western hemisphere");
  assert.ok(to.lng >= -180 && to.lng < 180);
  assert.ok(Math.abs(haversineM(0, 179.9, to.lat, to.lng) - 30000) < 10);
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

test("absoluteBearing resolves absolute and relative commands against a heading", () => {
  assert.equal(absoluteBearing({ bearing: 270 }, 90), 270, "absolute ignores the heading");
  assert.equal(absoluteBearing({ turn: 90 }, 350), 80, "relative wraps");
  assert.equal(absoluteBearing({ turn: -90 }, 0), 270);
  assert.equal(absoluteBearing({ turn: 0 }, 123), 123);
  assert.equal(absoluteBearing({}, 45), 45, "nothing to apply → unchanged");
  // A parsed command feeds straight in, whichever shape it has.
  assert.equal(absoluteBearing(parseGoCommand("go left"), 180), 90);
  assert.equal(absoluteBearing(parseGoCommand("go north"), 180), 0);
});

// ---------------------------------------------------------------------------
// Projection
//
// The frames are square rectilinear renders at SCENE_FOV, so the overlays
// follow the same pinhole camera: x is a TANGENT law, y is the ground point
// under the horizon, size falls off as 1/distance.

const CAM = { lat: 59.3326, lng: 18.0649 };
/** @type {(bearing: number, dist: number, id?: string, kind?: string) => object} */
const spawnAt = (bearing, dist, id = "s", kind = "creature") => ({
  id,
  kind,
  ...destinationPoint(CAM.lat, CAM.lng, bearing, dist),
});
const only = (spawn, heading = 0, opts) => projectSpawns(CAM.lat, CAM.lng, heading, [spawn], opts)[0];

test("projectSpawns: ahead is centered, off-fov and far spawns are excluded", () => {
  const spawns = [
    spawnAt(0, 40, "a"),
    spawnAt(180, 40, "b"),
    spawnAt(0, SCENE_VIEW_DIST_M + 50, "f", "item"),
  ];
  const out = projectSpawns(CAM.lat, CAM.lng, 0, spawns);
  assert.deepEqual(out.map((o) => o.id), ["a"]);
  assert.ok(Math.abs(out[0].xPct - 50) < 0.5, "dead ahead ≈ centered");
  assert.ok(out[0].yPct > 50 && out[0].yPct <= 92);
  assert.ok(out[0].distM >= 38 && out[0].distM <= 42);
  assert.equal(out[0].kind, "creature");
});

test("projectSpawns: x follows the tangent law, not a linear sweep", () => {
  // Half the half-FOV in ANGLE is well short of half the half-frame in PIXELS
  // — that gap is exactly what the old linear mapping got wrong.
  const half = only(spawnAt(22.5, 40));
  assert.ok(Math.abs(half.xPct - (50 + 50 * Math.tan(Math.PI / 8))) < 0.5);
  assert.ok(half.xPct < 71 && half.xPct > 70, `expected ~70.7%, got ${half.xPct}`);
  // Straight ahead, the edge of the frame, and beyond it.
  assert.ok(Math.abs(only(spawnAt(0, 40)).xPct - 50) < 0.5);
  assert.equal(Math.round(only(spawnAt(45, 40)).xPct), 97, "fov edge pins to the frame edge");
  assert.equal(Math.round(only(spawnAt(315, 40)).xPct), 3, "…and mirrored on the left");
  // Heading is what x is measured against, not absolute north.
  assert.ok(Math.abs(only(spawnAt(90, 40), 90).xPct - 50) < 0.5);
  assert.ok(only(spawnAt(90, 40), 60).xPct > 50, "spawn to the right of the heading");
});

test("projectSpawns: y is the ground point under the horizon", () => {
  // yPct = 50 + 50·(camera height / distance) / tan(fov/2); fov 90 → tan = 1.
  const expected = (d) => 50 + (50 * CAMERA_HEIGHT_M) / d;
  for (const d of [10, 25, 60, 120]) {
    assert.ok(Math.abs(only(spawnAt(0, d)).yPct - expected(d)) < 0.2, `${d} m`);
  }
  assert.ok(only(spawnAt(0, 10)).yPct > only(spawnAt(0, 120)).yPct, "near is lower in frame");
  assert.ok(only(spawnAt(0, SCENE_VIEW_DIST_M - 1)).yPct < 52, "the far edge converges on the horizon");
  assert.equal(only(spawnAt(0, 1)).yPct, 92, "closer than the camera height clamps into frame");
});

test("projectSpawns: apparent size falls off as 1/distance, clamped for tappability", () => {
  assert.ok(Math.abs(only(spawnAt(0, SCALE_REF_M)).scale - 1) < 0.02, "reference distance = base size");
  const near = only(spawnAt(0, 20)).scale;
  const far = only(spawnAt(0, 40)).scale;
  assert.ok(Math.abs(near / far - 2) < 0.05, "double the distance, half the size");
  assert.equal(only(spawnAt(0, 2)).scale, 2, "clamped at the near end");
  assert.equal(only(spawnAt(0, 125)).scale, 0.5, "clamped at the far end so it stays tappable");
});

test("projectSpawns: near overlays paint on top and every field is client-ready", () => {
  const out = projectSpawns(CAM.lat, CAM.lng, 0, [spawnAt(0, 10, "n"), spawnAt(10, 120, "f", "item")]);
  assert.deepEqual(out.map((o) => o.id), ["f", "n"], "far first (painted under)");
  for (const o of out) {
    assert.ok(o.xPct >= 3 && o.xPct <= 97);
    assert.ok(o.yPct >= 50 && o.yPct <= 92);
    assert.ok(Number.isInteger(o.distM) && Number.isInteger(o.bearing));
    assert.ok(o.bearing >= 0 && o.bearing < 360);
  }
  assert.equal(SCENE_FOV, 90);
  assert.deepEqual(projectSpawns(CAM.lat, CAM.lng, 0, []), []);
});

test("projectSpawns: the fov and view distance are overridable per call", () => {
  const wide = only(spawnAt(70, 40), 0, { fov: 170 });
  assert.ok(wide, "a 70°-off spawn is inside a 170° frame");
  assert.ok(wide.xPct > 50);
  assert.equal(only(spawnAt(0, 200), 0, { maxDist: 300 }).distM, 200);
  assert.equal(projectSpawns(CAM.lat, CAM.lng, 0, [spawnAt(0, 200)], { maxDist: 150 }).length, 0);
});

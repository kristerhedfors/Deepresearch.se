import test from "node:test";
import assert from "node:assert/strict";
import {
  AU_KM,
  LIGHT_YEAR_KM,
  BODIES,
  SPACE_SCENES,
  SPACE_MATCHERS,
  sceneById,
  spaceIntent,
  spaceIntentMatch,
  zoomToDistance,
  distanceToZoom,
  formatKm,
  clamp,
  projectPoint,
  rotY,
  mulberry32,
  sphereMesh,
  orbitMesh,
  cylinderMesh,
  rocketMesh,
  satelliteMesh,
  astronautMesh,
  landerMesh,
  terrainMesh,
  ringMesh,
  validateScene,
  validateSpaceFeedback,
  FEEDBACK_COMMENT_MAX,
} from "./space-core.js";

// ---------------------------------------------------------------------------
// Registry integrity.

test("space scenes: every scene is sound and bilingual", () => {
  assert.ok(SPACE_SCENES.length >= 8, "expected a real archive, not a stub");
  const ids = new Set();
  for (const s of SPACE_SCENES) {
    const errs = validateScene(s);
    assert.deepEqual(errs, [], `${s.id}: ${errs.join(", ")}`);
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
  }
});

test("space scenes: every matcher entry points at a real scene", () => {
  for (const m of SPACE_MATCHERS) {
    assert.ok(sceneById(m.id), `matcher for unknown scene ${m.id}`);
  }
});

test("sceneById: unknown and non-string ids return null", () => {
  assert.equal(sceneById("not-a-scene"), null);
  assert.equal(sceneById(undefined), null);
  assert.equal(sceneById(42), null);
});

test("bodies: radii and orbits are physically ordered", () => {
  assert.ok(BODIES.sun.radiusKm > BODIES.jupiter.radiusKm);
  assert.ok(BODIES.jupiter.radiusKm > BODIES.earth.radiusKm);
  assert.ok(BODIES.earth.radiusKm > BODIES.moon.radiusKm);
  assert.ok(BODIES.neptune.orbitKm > BODIES.earth.orbitKm);
  assert.ok(Math.abs(BODIES.earth.orbitKm - AU_KM) / AU_KM < 0.01, "Earth orbits at ~1 AU");
});

// ---------------------------------------------------------------------------
// The EN+SV question gate — the Swedish language parity suite (invariant 6):
// for every scene, English phrasings and Swedish phrasings (definite forms,
// synonyms, diacritic-dropped typing) must land on the same animation.

const PARITY = [
  {
    id: "sun-vs-planets",
    en: ["How big is the Sun?", "What is the size of the sun compared to the planets?", "how many earths would fit inside the sun"],
    sv: ["Hur stor är solen?", "Hur stor är solen jämfört med jorden?", "hur många jordklot ryms i solen", "hur stor ar solen"],
  },
  {
    id: "earth-moon",
    en: [
      "How far away is the Moon?", "how far is it to the moon", "What is the distance to the moon?",
      // Chat-style visual asks (feedback #18) — the first is the verbatim
      // reported query.
      "show a moonshot from space between earth and moon",
      "visualize the earth and the moon",
      "show me the moon orbiting earth",
    ],
    sv: [
      "Hur långt bort är månen?", "hur långt är det till månen", "avståndet till månen", "hur langt bort ar manen",
      "visa jorden och månen", "mellan jorden och månen", "ett månskott från rymden", "visa manen och jorden",
    ],
  },
  {
    id: "solar-system",
    en: ["What does the solar system look like?", "show me the solar system", "how big is the solar system"],
    sv: ["Hur ser solsystemet ut?", "visa solsystemet", "hur stort är solsystemet"],
  },
  {
    id: "iss-orbit",
    en: ["How high does the ISS fly?", "how fast is the space station moving", "what altitude does the iss orbit at", "show me the iss"],
    sv: ["Hur högt flyger ISS?", "hur snabbt åker rymdstationen", "vilken höjd har iss sin omloppsbana på", "hur hogt flyger rymdstationen", "visa rymdstationen"],
  },
  {
    id: "satellites",
    en: ["How many satellites orbit Earth?", "how many satellites are there", "satellites around the earth"],
    sv: ["Hur många satelliter kretsar runt jorden?", "hur många satelliter finns det", "satelliter runt jorden", "hur manga satelliter"],
  },
  {
    id: "rocket-launch",
    en: [
      "How does a rocket reach orbit?", "how do rockets work", "rocket launch",
      // The second verbatim reported query (feedback #18, chat_logs #615).
      "show a rocket launching into space",
      "show me a rocket lifting off",
    ],
    sv: [
      "Hur når en raket omloppsbana?", "hur fungerar en raket", "raketuppskjutning", "hur kommer raketer ut i rymden", "hur nar en raket rymden",
      "visa en raket som skjuts upp", "uppskjutningen av en raket",
    ],
  },
  {
    id: "moon-surface",
    en: ["What does the surface of the moon look like?", "walking on the moon", "the moon landing", "show me the moon's surface"],
    sv: ["Hur ser månens yta ut?", "hur ser det ut på månen", "månlandningen", "manens yta", "visa månens yta"],
  },
  {
    id: "saturn-rings",
    en: ["What are Saturn's rings made of?", "the rings of saturn", "saturns rings"],
    sv: ["Vad består Saturnus ringar av?", "ringarna kring saturnus", "saturnus ringar"],
  },
  {
    id: "nearest-star",
    en: ["How far away is the nearest star?", "distance to the closest star", "how far is proxima centauri"],
    sv: ["Hur långt bort är den närmaste stjärnan?", "avståndet till närmaste stjärnan", "hur långt bort är proxima centauri", "hur langt bort ar den narmaste stjarnan"],
  },
];

test("spaceIntent: Swedish language parity — every scene matches in both languages", () => {
  for (const row of PARITY) {
    assert.ok(row.en.length >= 3, `${row.id}: too few EN phrasings in the suite`);
    assert.ok(row.sv.length >= 3, `${row.id}: too few SV phrasings in the suite`);
    for (const q of row.en) {
      assert.equal(spaceIntent(q), row.id, `EN "${q}" should hit ${row.id}`);
    }
    for (const q of row.sv) {
      assert.equal(spaceIntent(q), row.id, `SV "${q}" should hit ${row.id}`);
    }
  }
});

test("spaceIntent: parity suite covers every scene in the registry", () => {
  const covered = new Set(PARITY.map((r) => r.id));
  for (const s of SPACE_SCENES) {
    assert.ok(covered.has(s.id), `scene ${s.id} has no parity coverage`);
  }
});

test("spaceIntent: unrelated questions stay unmatched", () => {
  assert.equal(spaceIntent("What is the capital of France?"), null);
  assert.equal(spaceIntent("Vad är huvudstaden i Frankrike?"), null);
  assert.equal(spaceIntent("write me a poem about autumn"), null);
  assert.equal(spaceIntent(""), null);
  assert.equal(spaceIntent(null), null);
  assert.equal(spaceIntent(42), null);
  // "moonshot" the metaphor must NOT fire the earth-moon scene: it needs a
  // space word alongside (feedback #18's broadened matchers keep this out).
  assert.equal(spaceIntent("our ai moonshot project needs funding"), null);
  assert.equal(spaceIntent("moonshot thinking in business strategy"), null);
});

test("spaceIntentMatch: reports which language matched (caption language)", () => {
  assert.deepEqual(spaceIntentMatch("show a moonshot from space between earth and moon"), { id: "earth-moon", lang: "en" });
  assert.deepEqual(spaceIntentMatch("visa jorden och månen"), { id: "earth-moon", lang: "sv" });
  assert.deepEqual(spaceIntentMatch("show a rocket launching into space"), { id: "rocket-launch", lang: "en" });
  assert.deepEqual(spaceIntentMatch("visa en raket som skjuts upp"), { id: "rocket-launch", lang: "sv" });
  assert.equal(spaceIntentMatch("write me a poem about autumn"), null);
});

// ---------------------------------------------------------------------------
// Zoom mathematics.

test("zoom: log interpolation spans the range and round-trips", () => {
  const min = 9000, max = 1300000;
  assert.equal(zoomToDistance(0, min, max), min);
  assert.ok(Math.abs(zoomToDistance(1, min, max) - max) / max < 1e-9);
  // Log midpoint is the geometric mean, not the arithmetic one.
  const mid = zoomToDistance(0.5, min, max);
  assert.ok(Math.abs(mid - Math.sqrt(min * max)) / mid < 1e-9);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const d = zoomToDistance(t, min, max);
    assert.ok(Math.abs(distanceToZoom(d, min, max) - t) < 1e-9, `round-trip at t=${t}`);
  }
});

test("zoom: out-of-range inputs clamp instead of exploding", () => {
  assert.equal(zoomToDistance(-3, 10, 1000), 10);
  assert.ok(Math.abs(zoomToDistance(7, 10, 1000) - 1000) < 1e-9);
  assert.equal(distanceToZoom(1, 10, 1000), 0);
  assert.equal(distanceToZoom(1e9, 10, 1000), 1);
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
});

test("formatKm: unit follows magnitude and stays language-neutral", () => {
  assert.equal(formatKm(384400), "384 400 km");
  assert.equal(formatKm(6371), "6 371 km");
  assert.match(formatKm(57.9e6), /Mkm$/);
  assert.match(formatKm(AU_KM * 5), /AU$/);
  assert.match(formatKm(LIGHT_YEAR_KM * 4.25), /^4\.25 ly$/);
});

// ---------------------------------------------------------------------------
// Projection and meshes.

test("projectPoint: perspective scale and near-plane cull", () => {
  const cam = { dist: 1000, f: 500, cx: 200, cy: 150 };
  const center = projectPoint([0, 0, 0], cam);
  assert.equal(center.x, 200);
  assert.equal(center.y, 150);
  // A point closer to the camera projects larger (bigger px-per-km scale).
  const near = projectPoint([0, 0, 500], cam);
  assert.ok(near.s > center.s);
  // Behind the camera: culled.
  assert.equal(projectPoint([0, 0, 1000.5], cam), null);
  // y up on the scene maps to smaller y on the canvas.
  const up = projectPoint([0, 100, 0], cam);
  assert.ok(up.y < center.y);
});

function assertMeshSound(mesh, label) {
  assert.ok(mesh.verts.length > 0, `${label}: no verts`);
  assert.ok(mesh.edges.length > 0, `${label}: no edges`);
  for (const [a, b] of mesh.edges) {
    assert.ok(Number.isInteger(a) && a >= 0 && a < mesh.verts.length, `${label}: edge start oob`);
    assert.ok(Number.isInteger(b) && b >= 0 && b < mesh.verts.length, `${label}: edge end oob`);
    assert.notEqual(a, b, `${label}: degenerate edge`);
  }
  for (const v of mesh.verts) {
    assert.ok(v.every(Number.isFinite), `${label}: non-finite vertex`);
  }
}

test("meshes: every builder produces a sound wireframe", () => {
  assertMeshSound(sphereMesh(6371), "sphere");
  assertMeshSound(orbitMesh(384400), "orbit");
  assertMeshSound(cylinderMesh(1, 3), "cylinder");
  assertMeshSound(rocketMesh(70), "rocket");
  assertMeshSound(satelliteMesh(700), "satellite");
  assertMeshSound(astronautMesh(0.0018), "astronaut");
  assertMeshSound(landerMesh(0.007), "lander");
  assertMeshSound(terrainMesh(1.6, 24, 7), "terrain");
  assertMeshSound(ringMesh(74500, 140220, 5), "rings");
});

test("sphereMesh: radius honored, meridians land on ring vertices", () => {
  const r = 6371;
  const m = sphereMesh(r, 5, 8, 16);
  for (const v of m.verts) {
    const len = Math.hypot(v[0], v[1], v[2]);
    assert.ok(Math.abs(len - r) / r < 1e-9, "every sphere vertex sits on the radius");
  }
});

test("terrainMesh: deterministic for a seed, different across seeds", () => {
  const a = terrainMesh(1.6, 20, 7);
  const b = terrainMesh(1.6, 20, 7);
  const c = terrainMesh(1.6, 20, 8);
  assert.deepEqual(a.verts, b.verts);
  assert.notDeepEqual(a.verts, c.verts);
});

test("mulberry32: deterministic stream in [0,1)", () => {
  const r1 = mulberry32(42), r2 = mulberry32(42);
  for (let i = 0; i < 20; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test("rotY: rotates around the y axis, preserves length", () => {
  const p = rotY([1, 2, 0], Math.PI / 2);
  assert.ok(Math.abs(p[0] - 0) < 1e-9);
  assert.equal(p[1], 2);
  assert.ok(Math.abs(p[2] - -1) < 1e-9);
});

// ---------------------------------------------------------------------------
// Feedback validation (shared with POST /api/space/feedback).

test("validateSpaceFeedback: accepts a sound body and normalizes the comment", () => {
  const v = validateSpaceFeedback({ scene: "earth-moon", verdict: "up", comment: "  nice \n zoom  " });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, { scene: "earth-moon", verdict: "up", comment: "nice zoom" });
});

test("validateSpaceFeedback: comment is optional and clamped", () => {
  const empty = validateSpaceFeedback({ scene: "iss-orbit", verdict: "down" });
  assert.equal(empty.ok, true);
  assert.equal(empty.value.comment, "");
  const long = validateSpaceFeedback({ scene: "iss-orbit", verdict: "down", comment: "x".repeat(9000) });
  assert.equal(long.ok, true);
  assert.equal(long.value.comment.length, FEEDBACK_COMMENT_MAX);
});

test("validateSpaceFeedback: rejects unknown scenes, bad verdicts, junk bodies", () => {
  assert.equal(validateSpaceFeedback({ scene: "nope", verdict: "up" }).ok, false);
  assert.equal(validateSpaceFeedback({ scene: "earth-moon", verdict: "maybe" }).ok, false);
  assert.equal(validateSpaceFeedback(null).ok, false);
  assert.equal(validateSpaceFeedback([]).ok, false);
  assert.equal(validateSpaceFeedback("up").ok, false);
});

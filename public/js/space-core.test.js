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
  spherePatchGrid,
  sphereSilhouette,
  facesCamera,
  launchAltKm,
  launchCamDistKm,
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
  starshipStackMesh,
  starshipShipMesh,
  superHeavyMesh,
  launchTowerMesh,
  SUPER_HEAVY_FRAC,
  STARSHIP_SHIP_FRAC,
  STARSHIP_STACK_M,
  orbitSpeedKms,
  validateScene,
  validateSpaceFeedback,
  FEEDBACK_COMMENT_MAX,
  rotX,
  worldRot,
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
      // Verbatim from feedback #46 — the scene DID mount for this, so the
      // gate was never the bug there; the planet and the reply were.
      "Show me a rocket launch to space",
    ],
    sv: [
      "Hur når en raket omloppsbana?", "hur fungerar en raket", "raketuppskjutning", "hur kommer raketer ut i rymden", "hur nar en raket rymden",
      "visa en raket som skjuts upp", "uppskjutningen av en raket",
    ],
  },
  {
    id: "starship-launch",
    en: [
      "How does Starship reach orbit?", "starship launch", "show me a starship launch",
      // Verbatim from feedback #53 — this matched NOTHING, so the chat
      // researched SpaceX news instead of animating the launch asked for.
      "Now launch a starship",
      "starship demo", "super heavy booster", "the tower catch",
    ],
    sv: [
      "Hur når Starship omloppsbana?", "starshipuppskjutning", "visa en starship som skjuts upp",
      "skjut upp en starship", "starship-demo", "hur nar starship omloppsbana",
      "hetseparation", "tornfångst", "tornfangst",
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
  assertMeshSound(starshipStackMesh(121), "starship stack");
  assertMeshSound(starshipShipMesh(52), "starship ship");
  assertMeshSound(superHeavyMesh(71), "super heavy");
  assertMeshSound(launchTowerMesh(146), "tower");
  assertMeshSound(launchTowerMesh(146, 0), "tower, arms closed");
});

// ---------------------------------------------------------------------------
// Starship (feedback #53). The scene is a "launch" like the rocket one, so the
// guards here are about the things a shared runner can quietly get wrong: the
// stack's real proportions, and the pieces staying inside the unit height the
// camera dolly assumes.

test("starship meshes: booster and ship keep the real 71 m / 52 m proportions", () => {
  // 71 m of booster and 52 m of ship, of a stack quoted at ~121 m (the
  // interstage overlaps, which is why the two fractions sum above 1).
  assert.equal(STARSHIP_STACK_M, 121);
  assert.ok(Math.abs(SUPER_HEAVY_FRAC - 71 / 121) < 1e-9);
  assert.ok(Math.abs(STARSHIP_SHIP_FRAC - 52 / 121) < 1e-9);
  assert.ok(SUPER_HEAVY_FRAC > STARSHIP_SHIP_FRAC, "the booster is the taller half");
  assert.ok(SUPER_HEAVY_FRAC + STARSHIP_SHIP_FRAC > 1, "the stages overlap at the interstage");
});

test("starshipStackMesh: base at the pad, tip within the unit height", () => {
  const m = starshipStackMesh(1);
  const ys = m.verts.map((v) => v[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  // The engine bells hang a little below y=0 exactly as rocketMesh's do; what
  // matters is that the stack does not overrun the height the camera scales by.
  assert.ok(lo > -0.06, `stack dips too far below the pad (${lo})`);
  assert.ok(hi <= 1 + 1e-9 && hi > 0.9, `stack tip should reach ~1, got ${hi}`);
});

test("starshipShipMesh: 9 m-wide barrel, flaps reaching past it", () => {
  const m = starshipShipMesh(52);
  const halfWidth = Math.max(...m.verts.map((v) => Math.abs(v[2])));
  const barrelR = 52 * 0.086;
  assert.ok(halfWidth > barrelR, "the flaps must stand off the barrel");
  assert.ok(Math.abs(barrelR * 2 - 9) < 0.5, "the barrel is about 9 m across");
});

test("launchTowerMesh: open arms sit wider than closed ones", () => {
  const span = (m) => Math.max(...m.verts.map((v) => Math.abs(v[2])));
  assert.ok(span(launchTowerMesh(1, 1)) > span(launchTowerMesh(1, 0)),
    "the arms must visibly close on the caught booster");
});

test("orbitSpeedKms: real circular speeds, and it falls with altitude", () => {
  // The two launch scenes' insertion altitudes.
  assert.equal(orbitSpeedKms(400).toFixed(1), "7.7");
  assert.equal(orbitSpeedKms(200).toFixed(1), "7.8");
  assert.ok(orbitSpeedKms(200) > orbitSpeedKms(400), "lower orbits are faster");
});

test("starship scene: the flight order is hot-stage, then catch, then insertion", () => {
  const s = sceneById("starship-launch");
  const c = s.config;
  assert.equal(s.kind, "launch");
  assert.ok(c.stageT < c.catchT, "the booster separates before it is caught");
  assert.ok(c.catchT < c.insertT, "the booster is caught before the Ship inserts");
  assert.ok(c.insertT < 1, "there is animation left for the orbit reveal");
  assert.equal(c.craft, "starship");
  assert.ok(c.tower, "the catch tower is what the scene is for");
});

test("spaceIntent: a Starship question beats the generic rocket scene", () => {
  // Both subjects present — the specific one must win, which is why the
  // starship matcher is registered ahead of rocket-launch.
  assert.equal(spaceIntent("starship rocket launch"), "starship-launch");
  assert.equal(spaceIntent("show me the starship launch to orbit"), "starship-launch");
  // …and a plain rocket question is untouched by the new entry.
  assert.equal(spaceIntent("Show me a rocket launch to space"), "rocket-launch");
  assert.equal(spaceIntent("Space launch demo"), "rocket-launch");
});

test("spaceIntent: the sci-fi starships do not mount the launch scene", () => {
  assert.equal(spaceIntent("show me the starship Enterprise"), null);
  assert.equal(spaceIntent("visa mig rymdskeppet i Starship Troopers"), null);
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

test("worldRot: yaw-then-pitch composition matches rotX(rotY(v)) and leaves zero angles alone", () => {
  const v = [1000, 2000, 3000];
  const st = { rotX: 0.35, rotY: 0.5 };
  assert.deepEqual(worldRot(v, st), rotX(rotY(v, st.rotY), st.rotX));
  assert.deepEqual(worldRot(v, { rotX: 0, rotY: 0 }), v);
});

// --- the launch scene's planet + camera (feedback #46) ---------------------
// The scene used to draw Earth as one thin arc that the starfield showed
// straight through, so a viewer asking for "a rocket launch to space" saw no
// planet at all. These cover the geometry that replaced it.

test("spherePatchGrid: every point lies exactly on the sphere, centred on the site", () => {
  const R = 6371;
  const site = Math.PI / 2;
  const grid = spherePatchGrid(R, site, 0.3, 5, 12);
  assert.equal(grid.length, 10); // one line each way per grid line
  for (const line of grid) {
    assert.equal(line.length, 13);
    for (const p of line) {
      assert.ok(Math.abs(Math.hypot(p[0], p[1], p[2]) - R) < 1e-6, "point off the sphere");
    }
  }
  // The patch straddles the launch site: some point is very near it.
  const sitePos = [R * Math.cos(site), R * Math.sin(site), 0];
  const nearest = Math.min(...grid.flat().map((p) => Math.hypot(p[0] - sitePos[0], p[1] - sitePos[1], p[2] - sitePos[2])));
  assert.ok(nearest < 1, `patch is not centred on the site (nearest ${nearest})`);
});

test("sphereSilhouette: tangent circle sits between centre and camera, and is empty from inside", () => {
  const R = 6371;
  const C = [0, -R, 0];       // planet centre, camera-rotated frame
  const camDist = 1000;
  const pts = sphereSilhouette(C, R, camDist, 48);
  assert.equal(pts.length, 49);
  const D = Math.hypot(-C[0], -C[1], camDist - C[2]);
  for (const p of pts) {
    // Every silhouette point is on the sphere...
    const r = Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]);
    assert.ok(Math.abs(r - R) < 1e-6, "silhouette point off the sphere");
    // ...and its line of sight is tangent there (radius ⟂ view ray).
    const dot = (p[0] - C[0]) * -p[0] + (p[1] - C[1]) * -p[1] + (p[2] - C[2]) * (camDist - p[2]);
    assert.ok(Math.abs(dot) < 1e-6, "silhouette point is not a tangent point");
  }
  // Ring radius is the classic R·√(1−R²/D²). The polyline is closed — its
  // last point repeats the first, so the centroid is taken over the unique
  // points only.
  const uniq = pts.slice(0, -1);
  const mid = [
    uniq.reduce((a, p) => a + p[0], 0) / uniq.length,
    uniq.reduce((a, p) => a + p[1], 0) / uniq.length,
    uniq.reduce((a, p) => a + p[2], 0) / uniq.length,
  ];
  const rad = Math.hypot(pts[0][0] - mid[0], pts[0][1] - mid[1], pts[0][2] - mid[2]);
  assert.ok(Math.abs(rad - R * Math.sqrt(1 - (R * R) / (D * D))) < 1e-3);
  // A camera inside the sphere has no horizon.
  assert.deepEqual(sphereSilhouette([0, 0, 0], R, R - 1), []);
});

test("facesCamera: near side visible, far side culled, horizon is the boundary", () => {
  const R = 6371;
  const C = [0, -R, 0];
  const camDist = 1000;
  // Unit vector from the sphere centre towards the camera at [0,0,camDist].
  const ax = [-C[0], -C[1], camDist - C[2]];
  const D = Math.hypot(ax[0], ax[1], ax[2]);
  const n = ax.map((v) => v / D);
  const near = [C[0] + n[0] * R, C[1] + n[1] * R, C[2] + n[2] * R];
  const far = [C[0] - n[0] * R, C[1] - n[1] * R, C[2] - n[2] * R];
  assert.equal(facesCamera(near, C, camDist), true);
  assert.equal(facesCamera(far, C, camDist), false);
  // The origin is where the rocket sits — on the surface with the view ray
  // tangent to it, i.e. exactly on the horizon, so it is not "facing".
  assert.equal(facesCamera([0, 0, 0], C, camDist), false);
});

test("launchAltKm: rises from the pad to the target and holds after insertion", () => {
  const cfg = { orbitAltKm: 400, insertT: 0.72 };
  assert.equal(launchAltKm(0, cfg), 0);
  assert.equal(launchAltKm(cfg.insertT, cfg), 400);
  assert.equal(launchAltKm(1, cfg), 400);
  // Monotonic through the climb.
  let prev = -1;
  for (let u = 0; u <= cfg.insertT; u += 0.04) {
    const a = launchAltKm(u, cfg);
    assert.ok(a >= prev, "altitude went backwards");
    prev = a;
  }
});

test("launchCamDistKm: starts near the pad, widens with altitude, pulls back for the orbit", () => {
  const cfg = { orbitAltKm: 400, insertT: 0.72 };
  const zoomKm = { min: 40, max: 60000, start: 1400 };
  const pad = launchCamDistKm(0, 0, cfg, zoomKm);
  const climbing = launchCamDistKm(0.4, launchAltKm(0.4, cfg), cfg, zoomKm);
  const inserted = launchCamDistKm(cfg.insertT, 400, cfg, zoomKm);
  const wide = launchCamDistKm(1, 400, cfg, zoomKm);
  assert.ok(pad < 120, `pad view too far out (${pad})`);
  assert.ok(climbing > pad && climbing < inserted, "does not widen with altitude");
  assert.ok(Math.abs(inserted - zoomKm.start) < 1, "insertion should sit at the scene's start distance");
  assert.ok(wide > 6371, "orbit reveal must clear the planet's radius");
  // Always inside the scene's own zoom range.
  for (let u = 0; u <= 1; u += 0.05) {
    const d = launchCamDistKm(u, launchAltKm(u, cfg), cfg, zoomKm);
    assert.ok(d >= zoomKm.min && d <= zoomKm.max, `dolly left the zoom range at u=${u}`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEMOS,
  demoById,
  demoIntent,
  demoIntentMatch,
  demoSurfaceTitle,
  isBareShowAsk,
  showVerbLang,
} from "./demo-core.js";

// ---------------------------------------------------------------------------
// Registry integrity.

test("demo registry: every entry is sound and bilingual", () => {
  assert.ok(DEMOS.length >= 1, "expected a real registry, not a stub");
  const ids = new Set();
  for (const d of DEMOS) {
    assert.ok(d.id && !ids.has(d.id), `duplicate or missing id: ${d.id}`);
    ids.add(d.id);
    assert.ok(["space", "page"].includes(d.kind), `unknown kind: ${d.kind}`);
    assert.match(d.path, /^\/[a-z]+\/$/, `${d.id}: path is a real surface`);
    for (const field of ["title", "blurb"]) {
      assert.ok(d[field].en && d[field].sv, `${d.id}: ${field} needs EN and SV`);
      assert.notEqual(d[field].en, d[field].sv, `${d.id}: ${field} not translated`);
    }
    // Invariant 6: Swedish carries the same breadth as English. Every non-space
    // surface matches on its own patterns, so both sets have to be populated
    // (space delegates its subject matching to space-core.js).
    if (d.kind !== "space") {
      assert.ok(d.subject.en.length && d.subject.sv.length, `${d.id}: subject needs both languages`);
      assert.ok(d.always.en.length && d.always.sv.length, `${d.id}: always needs both languages`);
      assert.ok(d.action.en.length && d.action.sv.length, `${d.id}: action needs both languages`);
    }
    // Every entry carries all four pattern families, both languages, even when
    // a family is empty — the matcher indexes them unconditionally.
    for (const family of ["subject", "action", "always", "deny"]) {
      for (const lang of ["en", "sv"]) {
        assert.ok(Array.isArray(d[family][lang]), `${d.id}: ${family}.${lang} missing`);
      }
    }
  }
  assert.equal(demoById("space")?.path, "/space/");
  assert.equal(demoById("nope"), null);
});

// ---------------------------------------------------------------------------
// The reported case, verbatim — feedback #50, 2026-07-29 — so it is the
// regression floor.

test("feedback #50: \"Space launch demo\" resolves to the rocket-launch scene", () => {
  const m = demoIntent("Space launch demo");
  assert.equal(m?.id, "space");
  assert.equal(m?.kind, "space");
  assert.equal(m?.sceneId, "rocket-launch");
});

test("feedback #50: a bare \"Show me visually\" inherits the previous turn", () => {
  // The real sequence: "Space launch demo" → "Show me visually". On its own
  // the follow-up matches nothing; behind its prior turn it is the animation.
  assert.equal(demoIntent("Show me visually"), null);
  const m = demoIntent("Show me visually", "Space launch demo");
  assert.equal(m?.sceneId, "rocket-launch");
});

test("a subject-carrying message is never overridden by its prior turn", () => {
  // A real question after a demo ask wins on its own terms, and an unrelated
  // one matches nothing at all.
  assert.equal(demoIntent("What is the capital of France?", "Space launch demo"), null);
  assert.equal(
    demoIntent("show me the rocket launch", "how far away is the moon?")?.sceneId,
    "rocket-launch",
  );
});

// ---------------------------------------------------------------------------
// The space surface still resolves through space-core's matcher.

test("space demos delegate to the one space matcher, both languages", () => {
  const cases = [
    ["how far away is the moon?", "earth-moon"],
    ["show me the solar system", "solar-system"],
    ["rocket launch animation", "rocket-launch"],
    ["orbital launch", "rocket-launch"],
    ["hur långt bort är månen?", "earth-moon"],
    ["rymduppskjutning", "rocket-launch"],
    ["raketanimation", "rocket-launch"],
    ["visa mig solsystemet", "solar-system"],
  ];
  for (const [q, sceneId] of cases) {
    const m = demoIntent(q);
    assert.equal(m?.kind, "space", q);
    assert.equal(m?.sceneId, sceneId, q);
  }
});

test("a space match keeps the language its pattern set fired in", () => {
  assert.equal(demoIntent("show me the solar system")?.lang, "en");
  assert.equal(demoIntent("visa mig solsystemet")?.lang, "sv");
});

// ---------------------------------------------------------------------------
// The building blocks.

test("showVerbLang: recognises the ask in both languages, and only the ask", () => {
  // "demo" and "animation" are the same word in both languages — they mark the
  // ask without deciding its language, so the subject gets to.
  assert.equal(showVerbLang("demo"), "neutral");
  assert.equal(showVerbLang("animation"), "neutral");
  assert.equal(showVerbLang("show me a chart"), "en");
  assert.equal(showVerbLang("visualisera det"), "sv");
  assert.equal(showVerbLang("animera"), "sv");
  assert.equal(showVerbLang("what happened in 2026?"), "");
  assert.equal(showVerbLang(""), "");
  assert.equal(showVerbLang(null), "");
});

test("isBareShowAsk: only messages that are nothing but the ask", () => {
  for (const q of [
    "Show me visually",
    "show me visually.",
    "visualize it",
    "animate it",
    "a visual please",
    "what does it look like?",
    "visa mig visuellt",
    "visualisera det",
    "hur ser det ut?",
  ]) {
    assert.equal(isBareShowAsk(q), true, q);
  }
  for (const q of [
    "show me the moon and the earth",
    "visualize the launch cadence of the three providers",
    "visa mig solsystemet",
    "",
  ]) {
    assert.equal(isBareShowAsk(q), false, q);
  }
});

test("demoIntentMatch is pure and never throws on junk input", () => {
  for (const junk of [null, undefined, 42, {}, [], "", "   ", "\n\n"]) {
    assert.equal(demoIntentMatch(junk), null, String(junk));
    assert.equal(demoIntent(junk, junk), null, String(junk));
  }
});

// ---------------------------------------------------------------------------
// The prompt input.

test("demoSurfaceTitle: page surfaces only, English, empty otherwise", () => {
  // The pipeline feeds this to the answer prompts; a space match goes through
  // `spaceScene` instead, so this must stay empty for one. No page-only surface
  // ships today, which is why every case here is a space match or a miss.
  assert.equal(demoSurfaceTitle("Space launch demo"), "");
  assert.equal(demoSurfaceTitle("what is the capital of France?"), "");
  assert.equal(demoSurfaceTitle("show me visually", "Space launch demo"), "");
});

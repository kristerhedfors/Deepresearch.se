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
  assert.ok(DEMOS.length >= 2, "expected a real registry, not a stub");
  const ids = new Set();
  for (const d of DEMOS) {
    assert.ok(d.id && !ids.has(d.id), `duplicate or missing id: ${d.id}`);
    ids.add(d.id);
    assert.ok(["space", "page", "watch"].includes(d.kind), `unknown kind: ${d.kind}`);
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
  assert.equal(demoById("watch")?.path, "/watch/");
  assert.equal(demoById("nope"), null);
});

// ---------------------------------------------------------------------------
// The reported cases, verbatim. These two messages are why this module exists
// — feedback #49 and #50, 2026-07-29 — so they are the regression floor.

test("feedback #49: \"Seiko watch demo\" resolves to the watch builder", () => {
  const m = demoIntent("Seiko watch demo");
  assert.equal(m?.id, "watch");
  // Kind "watch", not "page": feedback #52 moved the builder INTO the turn, so
  // the ask resolves to an inline render the conversation drives rather than a
  // card linking out of it.
  assert.equal(m?.kind, "watch");
  assert.equal(m?.path, "/watch/");
  assert.equal(m?.lang, "en");
});

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
  // Same for a page surface.
  assert.equal(demoIntent("show me visually", "Seiko watch demo")?.id, "watch");
});

test("a subject-carrying message is never overridden by its prior turn", () => {
  // "Seiko watch demo" then a real question: the question wins on its own
  // terms, and an unrelated one matches nothing at all.
  assert.equal(demoIntent("What is the capital of France?", "Seiko watch demo"), null);
  assert.equal(
    demoIntent("show me the rocket launch", "Seiko watch demo")?.sceneId,
    "rocket-launch",
  );
});

// ---------------------------------------------------------------------------
// The watch surface: subject + verb, or an unmistakable phrase.

test("watch demo: the unmistakable phrases need no verb", () => {
  for (const q of [
    "watch builder",
    "the watch configurator",
    "build your own watch",
    "watch modding",
    "nh35 mod",
  ]) {
    assert.equal(demoIntent(q)?.id, "watch", `EN: ${q}`);
  }
  for (const q of [
    "klockbyggare",
    "bygga en egen klocka",
    "klockmodding",
    "moddad klocka",
  ]) {
    const m = demoIntent(q);
    assert.equal(m?.id, "watch", `SV: ${q}`);
    assert.equal(m?.lang, "sv", `SV lang: ${q}`);
  }
});

test("watch demo: a subject needs a show verb beside it", () => {
  // Subject alone is a research question and stays one.
  assert.equal(demoIntent("what is the seiko nh35 movement?"), null);
  assert.equal(demoIntent("vad är seiko nh35 för urverk?"), null);
  // Subject + verb is a demo ask.
  assert.equal(demoIntent("show me a seiko watch")?.id, "watch");
  assert.equal(demoIntent("visa mig en seiko-klocka")?.id, "watch");
  assert.equal(demoIntent("nh36 demo")?.id, "watch");
  assert.equal(demoIntent("visualisera en klocka")?.id, "watch");
});

// ---------------------------------------------------------------------------
// Feedback #55, verbatim and in full. The reported session opened with "Build
// me a fancy seiko watch" and mounted NOTHING — two independent misses, both
// pinned below so neither can come back.

test("feedback #55: \"Build me a fancy seiko watch\" mounts the builder", () => {
  const m = demoIntent("Build me a fancy seiko watch");
  assert.equal(m?.id, "watch", "the verbatim message that reported no watch animation");
  assert.equal(m?.kind, "watch");
  assert.equal(m?.lang, "en");
});

test("feedback #55 root cause 1: the make verb takes an indirect object and adjectives", () => {
  // The old `always` pattern was /\bbuild (a|your|my|the) (own )?watch\b/ — a
  // determiner IMMEDIATELY after the verb. Everything a person actually types
  // between the two fell out of it.
  for (const q of [
    "build me a watch",
    "build me a fancy seiko watch",
    "build us a custom nh36 watch",
    "make me a nice diver watch",
    "create a dream seiko",
    "put together a watch for me",
  ]) {
    assert.equal(demoIntent(q)?.id, "watch", q);
  }
});

test("feedback #55 root cause 2: \"build\" is a verb, not only \"builder\"", () => {
  // SHOW_VERBS carried /\bbuilder?\b/, which matches "builder" and never
  // "build" (the `?` binds the r) — so the subject+verb path had no verb
  // either. The make-verb family is what closes it.
  assert.equal(showVerbLang("build a watch"), "", "still not a SHOW verb");
  assert.equal(demoIntent("build a watch")?.id, "watch", "but it is a MAKE verb");
});

test("feedback #55: building, creating, designing and modding all mount it (EN)", () => {
  for (const q of [
    "design my own watch",
    "designing a seiko dial",
    "I want to design a watch",
    "help me create a watch",
    "let's build a seiko",
    "customize a seiko watch",
    "configure a nh35 watch",
    "mod my seiko",
    "modding a seiko",
    "assemble a watch",
    "can you make a watch for me",
    "how do i build a watch",
  ]) {
    assert.equal(demoIntent(q)?.id, "watch", `EN: ${q}`);
  }
});

test("Swedish language parity: every EN make-verb form has its SV twin", () => {
  // Invariant 6 — the SV set carries the definite forms Swedish suffixes onto
  // the noun ("urtavlan"), the compound verbs, and the diacritic-dropped
  // spellings a Swede types on a foreign keyboard. Note there is no trailing
  // \b anywhere near å/ä/ö: it would never fire (the palaeogenomics skill).
  const pairs = [
    ["build me a fancy seiko watch", "bygg mig en fin seiko-klocka"],
    ["build a watch", "bygga en klocka"],
    ["design my own watch", "designa min egen klocka"],
    ["design a dial", "designa urtavlan"],
    ["create a new seiko", "skapa en ny seiko"],
    ["mod my seiko", "modda min seiko"],
    ["I want to build a watch", "jag vill bygga en klocka"],
    // Asymmetric on purpose, and the right kind of asymmetry: "boett" is a
    // watch case and nothing else, while the English "case" is a court case, a
    // test case and a use case, so it only counts next to "watch".
    ["can you design a watch case", "kan du designa ett boett"],
    ["make the dial black", "gör urtavlan svart"],
    ["draw a dial", "rita en urtavla"],
    ["watch build", "klockbygge"],
    ["assemble a watch", "montera ihop en klocka"],
    ["customize a watch", "anpassa en klocka"],
  ];
  for (const [en, sv] of pairs) {
    assert.equal(demoIntent(en)?.id, "watch", `EN: ${en}`);
    const m = demoIntent(sv);
    assert.equal(m?.id, "watch", `SV: ${sv}`);
    assert.equal(m?.lang, "sv", `SV lang: ${sv}`);
  }
});

test("Swedish language parity: diacritic-dropped spellings still fire", () => {
  // "gör" typed as "gor", "sätt" as "satt", "något" as "nagot" — a foreign
  // keyboard is the common case, not the exception.
  for (const q of ["gor urtavlan svart", "bygg mig en klocka", "designa nagot till min klocka"]) {
    assert.equal(demoIntent(q)?.id, "watch", `SV: ${q}`);
  }
});

test("a make verb without a watch subject mounts nothing", () => {
  // The verb half never fires on its own — the subject is what says which
  // surface, and there is no builder for a bookshelf.
  for (const q of [
    "build me a react app",
    "design a database schema",
    "create a new project",
    "bygg mig en webbapp",
    "designa en databas",
  ]) {
    assert.equal(demoIntent(q), null, q);
  }
});

test("a factual watch question with no make verb stays prose, EN and SV", () => {
  // The widened gate must not swallow research. None of these asks for a build.
  for (const q of [
    "what is the seiko nh35 movement?",
    "who owns Seiko?",
    "when did Seiko release the SKX007?",
    "the history of Seiko watches",
    "vad är seiko nh35 för urverk?",
    "hur mycket kostar en Seiko-klocka?",
    "vad är klockan?",
    "vem äger Seiko?",
  ]) {
    assert.equal(demoIntent(q), null, q);
  }
});

test("a borrowed subject word is vetoed, EN and SV", () => {
  // "watch list" is the subject word doing a different job. A make verb beside
  // it ("build a watch list") would otherwise mount the builder on a portfolio
  // question.
  for (const q of [
    "build a watch list of stocks",
    "create a watchdog timer",
    "bygg en bevakningslista",
    // "watch build" is a mod build; "watch the build logs" is CI.
    "watch the build logs for this deploy",
    "let me watch build output",
  ]) {
    assert.equal(demoIntent(q), null, q);
  }
});

test("watch demo: the bare English verb \"watch\" never fires alone", () => {
  // `watch` is a common verb — these must all stay research questions, or the
  // card would mount on half the conversations on the site.
  for (const q of [
    "watch out for rate limits",
    "I watched the demo video yesterday",
    "watch this space for updates",
    "how do I watch the deploy logs?",
  ]) {
    assert.equal(demoIntent(q), null, q);
  }
});

test("watch demo: Swedish parity for the subject+verb form", () => {
  // Invariant 6 — the SV set carries definite forms and the diacritic-dropped
  // typing a Swede produces on a foreign keyboard.
  assert.equal(demoIntent("visa mig klockan")?.id, "watch");
  assert.equal(demoIntent("demo av urtavlan")?.id, "watch");
  assert.equal(demoIntent("animera armbandsuret")?.id, "watch");
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
  // `spaceScene` instead, so this must stay empty for one.
  assert.equal(demoSurfaceTitle("Seiko watch demo"), "The NHxx watch builder");
  assert.equal(demoSurfaceTitle("visa mig klockbyggaren"), "The NHxx watch builder");
  assert.equal(demoSurfaceTitle("Space launch demo"), "");
  assert.equal(demoSurfaceTitle("what is the capital of France?"), "");
  assert.equal(demoSurfaceTitle("show me visually", "Seiko watch demo"), "The NHxx watch builder");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MODES,
  CAPTURABLE_AGENTS,
  LINKEDIN,
  PLAN_DEFAULTS,
  SHAPES,
  bitrateCapKbps,
  buildFilterGraph,
  HEAD_FLASH,
  captureSlug,
  checkDelivery,
  contentEnd,
  headTrim,
  examplePrompts,
  expandMatrix,
  ffmpegArgs,
  formatPlan,
  lastContentSample,
  mergeIntervals,
  mergeSegments,
  modeForAgent,
  parseProbe,
  parseSignature,
  pickPrompts,
  planContent,
  planEdit,
  posterArgs,
  posterAtMs,
  resolveShape,
  secs,
  readableSignature,
  stillSpans,
  waitSpans,
} from "./capture-core.mjs";
import { DEFAULT_CHAT_MODE } from "../public/js/chat-mode-core.js";

// A timeline as the driver writes it: samples every `step` ms, with the
// signature changing only where something happened on screen.
const timeline = (spec, step = 250) => {
  const out = [];
  let t = 0;
  let n = 0;
  for (const { ms, moving } of spec) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      out.push({ t, sig: moving ? `s${n++}` : `s${n}` });
      t += step;
    }
    if (!moving) n++;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Shapes and delivery limits
// ---------------------------------------------------------------------------

test("every shape records a smaller viewport than it delivers, so text reads in a feed", () => {
  for (const shape of Object.values(SHAPES)) {
    if (!shape.out) continue; // "raw" delivers the source frame by definition
    assert.ok(
      shape.out.width >= shape.viewport.width,
      `${shape.id}: the delivery frame must be at least the captured viewport`,
    );
  }
});

test("an unknown shape falls back to portrait rather than throwing", () => {
  assert.equal(resolveShape("nonsense").id, "portrait");
  assert.equal(resolveShape(null).id, "portrait");
  assert.equal(resolveShape("square").id, "square");
});

test("every shape's delivery frame is inside LinkedIn's aspect range", () => {
  for (const shape of Object.values(SHAPES)) {
    if (!shape.out) continue;
    const { ok, problems } = checkDelivery({ width: shape.out.width, height: shape.out.height });
    assert.ok(ok, `${shape.id}: ${problems.join(" ")}`);
  }
});

test("delivery check names the real LinkedIn fences", () => {
  const tooLong = checkDelivery({ seconds: 700 });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.problems.join(" "), /10-minute/);

  const tooShort = checkDelivery({ seconds: 1 });
  assert.equal(tooShort.ok, false);

  const tooTall = checkDelivery({ width: 200, height: 1000 }); // 1:5
  assert.equal(tooTall.ok, false);
  assert.match(tooTall.problems.join(" "), /Aspect/);

  // Over our own target but inside LinkedIn's limit: a warning, not a refusal.
  const chunky = checkDelivery({ bytes: LINKEDIN.target_bytes * 2, seconds: 30, width: 1080, height: 1350 });
  assert.equal(chunky.ok, true);
  assert.match(chunky.warnings.join(" "), /--max-mb/);
});

// ---------------------------------------------------------------------------
// The run matrix
// ---------------------------------------------------------------------------

test("every capturable agent maps to a chat mode the composer has", () => {
  for (const agent of CAPTURABLE_AGENTS) {
    assert.ok(AGENT_MODES[agent], `${agent} has no mode`);
    assert.equal(modeForAgent(agent), AGENT_MODES[agent]);
  }
  // A typo produces an obviously-wrong run, not a dead harness. The fallback is
  // the DEFAULT chat mode: it read "normal" until the general research agent was
  // retired (2026-08-13), and the default is a real domain agent's mode now.
  assert.equal(modeForAgent("not-an-agent"), DEFAULT_CHAT_MODE);
  assert.equal(modeForAgent("not-an-agent"), "science");
});

test("example prompts come from the shipped starter queues", () => {
  // `cyber` in the retired `research` agent's place — the capture matrix names
  // agents, and the general one no longer has a queue to draw from.
  const prompts = examplePrompts("cyber");
  assert.ok(prompts.length > 4);
  for (const p of prompts) {
    assert.ok(p.text.length > 20, "a starter must carry enough to act on");
    assert.ok(["en", "sv"].includes(p.lang));
  }
  assert.ok(
    prompts.some((p) => p.lang === "sv"),
    "invariant 6: a capture batch must be able to draw Swedish prompts",
  );
});

test("a language filter selects one audience's prompts", () => {
  const sv = examplePrompts("cyber", { lang: "sv" });
  assert.ok(sv.length > 0);
  assert.ok(sv.every((p) => p.lang === "sv"));
});

test("ranked starters are picked before untried ones", () => {
  // Asked of a queue that HAS ranks: the retired `research` queue used to be the
  // one with a rank history deep enough to test against, and the queues that
  // carry one now are the older modes (introspection, orchestrator,
  // outrospection, agent-builder). The new domain queues — `cyber`, `scholar` —
  // are untried by construction, so ranking them is what the starter evaluation
  // loop is for, not what this test can assume.
  const picked = pickPrompts("introspection", 3);
  assert.equal(picked.length, 3);
  const ranks = picked.map((p) => p.rank).filter((r) => typeof r === "number");
  assert.ok(ranks.length > 0, "the introspection queue has ranked entries, so a pick must use them");
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), "ranked picks descend");
});

test("asking for more prompts than the queue holds wraps instead of running dry", () => {
  const queue = examplePrompts("models");
  const picked = pickPrompts("models", queue.length + 2);
  assert.equal(picked.length, queue.length + 2);
});

test("the matrix is agent-major so an interrupted batch covers whole agents", () => {
  const runs = expandMatrix({
    agents: ["cyber", "introspection"],
    models: ["model-a", "model-b"],
    prompts: {
      cyber: [{ id: "r1", text: "one", lang: "en", xp: 1 }],
      introspection: [{ id: "i1", text: "two", lang: "en" }],
    },
  });
  assert.deepEqual(
    runs.map((r) => `${r.agent}/${r.model}/${r.starter}`),
    ["cyber/model-a/r1", "cyber/model-b/r1", "introspection/model-a/i1", "introspection/model-b/i1"],
  );
  assert.equal(runs[0].mode, "cyber");
  assert.equal(runs[2].mode, "introspection");
  assert.equal(runs[0].xp, 1);
});

test("a run slug is filesystem-safe and identifies agent, model and prompt", () => {
  const slug = captureSlug({ agent: "cyber", model: "mistralai/Devstral-Small-2505", starter: "cyb-sv-elpris" });
  assert.match(slug, /^[a-z0-9_-]+$/);
  assert.ok(slug.includes("cyber"));
  assert.ok(slug.includes("cyb-sv-elpris"));
  // Two different models must not collide into one directory.
  assert.notEqual(slug, captureSlug({ agent: "cyber", model: "openai/gpt-x", starter: "cyb-sv-elpris" }));
});

// ---------------------------------------------------------------------------
// Dead-time detection
// ---------------------------------------------------------------------------

test("a span of unchanged signatures is dead time", () => {
  const samples = timeline([
    { ms: 1000, moving: true }, //  0 – 1000 typing
    { ms: 8000, moving: false }, // 1000 – 9000 the pipeline is thinking
    { ms: 2000, moving: true }, // 9000 – 11000 tokens streaming
  ]);
  const spans = stillSpans(samples, { minStillMs: 1500 });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 1000);
  // The span ends at the LAST sample known to be idle, one step before the
  // change was observed — the frame where the answer appears is never cut.
  assert.equal(spans[0].end, 8750);
});

test("a pause shorter than the threshold is left alone", () => {
  const samples = timeline([
    { ms: 2000, moving: true },
    { ms: 1000, moving: false },
    { ms: 2000, moving: true },
  ]);
  assert.deepEqual(stillSpans(samples, { minStillMs: 1500 }), []);
});

test("stillSpans survives a degenerate timeline", () => {
  assert.deepEqual(stillSpans([]), []);
  assert.deepEqual(stillSpans([{ t: 0, sig: "a" }]), []);
  // Unordered samples are sorted, not trusted.
  const spans = stillSpans(
    [
      { t: 4000, sig: "a" },
      { t: 0, sig: "a" },
      { t: 8000, sig: "b" },
    ],
    { minStillMs: 1000 },
  );
  assert.deepEqual(spans, [{ start: 0, end: 4000 }]);
});

test("overlapping intervals merge", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 0, end: 100 },
      { start: 90, end: 200 },
      { start: 300, end: 400 },
      { start: 500, end: 500 },
    ]),
    [
      { start: 0, end: 200 },
      { start: 300, end: 400 },
    ],
  );
});

// ---------------------------------------------------------------------------
// The edit plan
// ---------------------------------------------------------------------------

const RUN = timeline([
  { ms: 2000, moving: true }, //     0 –  2000  the prompt goes in
  { ms: 20000, moving: false }, //   2000 – 22000  the pipeline researches
  { ms: 4000, moving: true }, //    22000 – 26000  the answer streams
  { ms: 6000, moving: false }, //   26000 – 32000  nothing more happens
]);

test("dead air is cut, and a hold keeps the state that was reached readable", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, minStillMs: 1500, holdMs: 600 });
  assert.equal(plan.waitMode, "cut");
  assert.ok(plan.cutMs > 20000, "both dead spans should be removed");
  assert.ok(plan.outMs < 10000, "a 32 s run becomes a short clip");
  // The first kept segment runs past the moment the wait began, by the hold.
  assert.equal(plan.segments[0].start, 0);
  assert.equal(plan.segments[0].end, 2600);
  assert.ok(
    plan.segments.every((s) => s.end > s.start),
    "no empty segments reach ffmpeg",
  );
});

test("waitMode 'speed' keeps the wait on screen instead of cutting it", () => {
  const cut = planEdit({ sourceMs: 32000, samples: RUN, waitMode: "cut" });
  const sped = planEdit({ sourceMs: 32000, samples: RUN, waitMode: "speed", waitSpeed: 8 });
  assert.equal(sped.cutMs, 0, "nothing is dropped");
  assert.ok(sped.outMs > cut.outMs, "the sped-up wait still costs some seconds");
  assert.ok(sped.outMs < 32000 / 2, "but far less than watching it in real time");
  assert.ok(sped.segments.some((s) => s.kind === "wait" && s.speed === 8));
});

test("waitMode 'keep' is the unedited run at the chosen speed", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, waitMode: "keep", speed: 2 });
  assert.equal(plan.cutMs, 0);
  // 31750, not 32000: "keep" is about dead AIR. The clip still ends on the last
  // frame the timeline proves carried content, never on unsampled teardown.
  assert.equal(plan.keptMs, 31750);
  assert.ok(Math.abs(plan.segmentsMs - 31750 / 2) < 1);
});

test("the chosen speed applies to the parts where something happens", () => {
  const at1 = planEdit({ sourceMs: 32000, samples: RUN, speed: 1 });
  const at2 = planEdit({ sourceMs: 32000, samples: RUN, speed: 2 });
  // segmentsMs, not outMs: the end hold is a fixed freeze, not something the
  // playback multiplier touches.
  assert.ok(Math.abs(at1.segmentsMs / 2 - at2.segmentsMs) < 1);
  assert.equal(at2.keptMs, at1.keptMs, "speed changes playback, not what is kept");
  assert.equal(at1.outMs - at1.segmentsMs, at1.endHoldMs);
});

test("trims drop the head and tail of the recording", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, trimStartMs: 1000, trimEndMs: 2000, waitMode: "keep" });
  assert.equal(plan.segments[0].start, 1000);
  assert.equal(plan.segments[plan.segments.length - 1].end, 30000);
});

test("a recording with no timeline at all still produces one playable segment", () => {
  const plan = planEdit({ sourceMs: 12000, samples: [] });
  // The head flash is dropped on the assumed default; nothing else is known,
  // so the rest of the file is one segment.
  assert.deepEqual(plan.segments, [{ start: HEAD_FLASH.fallbackMs, end: 12000, kind: "action", speed: 1 }]);
  assert.equal(plan.headTrimSource, "assumed");
  assert.equal(plan.cutMs, 0);
  assert.equal(plan.waitMs, 0);
  assert.equal(plan.contentStatus, "unknown", "nothing to locate the last content frame with");
});

test("a run that is entirely dead air keeps the hold rather than encoding nothing", () => {
  const dead = timeline([{ ms: 30000, moving: false }]);
  const plan = planEdit({ sourceMs: 30000, samples: dead });
  assert.ok(plan.segments.length >= 1, "an empty segment list would break the encoder");
  assert.ok(plan.outMs > 0);
});

test("bad inputs fall back to the documented defaults", () => {
  const plan = planEdit({ sourceMs: 10000, samples: RUN, speed: 0, waitSpeed: -3, waitMode: "wat" });
  assert.equal(plan.speed, PLAN_DEFAULTS.speed);
  assert.equal(plan.waitMode, PLAN_DEFAULTS.waitMode);
});

test("contiguous same-speed segments fuse into one trim", () => {
  assert.deepEqual(
    mergeSegments([
      { start: 0, end: 1000, kind: "wait", speed: 1 },
      { start: 1000, end: 2000, kind: "action", speed: 1 },
      { start: 2000, end: 3000, kind: "wait", speed: 8 },
    ]),
    [
      { start: 0, end: 2000, kind: "action", speed: 1 },
      { start: 2000, end: 3000, kind: "wait", speed: 8 },
    ],
  );
});

// ---------------------------------------------------------------------------
// The head flash and the last frame with content
// ---------------------------------------------------------------------------
//
// The driver's real signature grammar (tests/capture.mjs contentSignature):
// msgs|steps|finished|answerLen|step|stats. A torn-down or navigated-away page
// reads 0|0|0|0||0.

const SIG = (msgs, steps, finished, answerLen, step = "", stats = 0) =>
  `${msgs}|${steps}|${finished}|${answerLen}|${step}|${stats}`;
const BLANK = SIG(0, 0, 0, 0);

test("a content signature is read, and an unknown format is treated as content", () => {
  const answering = parseSignature(SIG(3, 7, 5, 1842, "Writing report…", 1));
  assert.equal(answering.known, true);
  assert.equal(answering.answerLen, 1842);
  assert.equal(answering.stats, true);
  assert.equal(answering.content, true);

  const torndown = parseSignature(BLANK);
  assert.equal(torndown.known, true);
  assert.equal(torndown.content, false, "a blank page is the whole point of the check");

  // An empty composer before the prompt goes in is also "no content" — nothing
  // of the run is on screen yet.
  assert.equal(parseSignature(SIG(0, 0, 0, 0, "", 0)).content, false);

  // Anything this module cannot parse counts as content: footage is never
  // deleted on the strength of a format guess.
  assert.equal(parseSignature("s17").known, false);
  assert.equal(parseSignature("s17").content, true);
  assert.equal(parseSignature("").content, false);
  assert.equal(parseSignature(null).content, false);
});

// ---------------------------------------------------------------------------
// A TICKING ACTIVITY BAR IS WAIT TIME — the #CAP-10 regression
// ---------------------------------------------------------------------------
//
// Owner review of #CAP-10 (2026-08-14): "video waits and waits for answer and
// then just the last frame shows the bottom of the reply. We should cut speed
// up stale wait time to allow viewing of entire answer generation." The clip
// was 54 555 ms recorded and 43 644 ms delivered at 1.25x — 54555 / 1.25 =
// 43644 exactly, so not one millisecond was accelerated, in a run that was
// mostly the pipeline searching. The activity bar ticked faster than any
// usable `--min-still`, so the full signature never repeated and the old
// detector found no dead air at all.

/**
 * A research run: the prompt goes in, the activity bar ticks once a second for
 * half a minute, then tokens stream. The tick is FASTER than any usable
 * `--min-still`, which is the shape #CAP-10 had.
 */
const researchRun = ({ searchMs = 30000, streamMs = 20000, tickMs = 1000, step = 250 } = {}) => {
  const samples = [];
  let t = 0;
  const searchStart = 0;
  for (; t < searchMs; t += step) {
    const k = Math.floor(t / tickMs) + 1;
    samples.push({ t, sig: SIG(2, k, Math.max(0, k - 1), 0, `Searching round ${k}`, 0) });
  }
  const streamStart = t;
  for (let len = 40; t < streamStart + streamMs; t += step, len += 40) {
    samples.push({ t, sig: SIG(3, 9, 9, len, "", t + step >= streamStart + streamMs ? 1 : 0) });
  }
  return { samples, searchStart, streamStart, sourceMs: t };
};

test("readableSignature keeps what a viewer reads and drops the activity bar", () => {
  // Two samples one search round apart: everything a viewer can READ is equal.
  assert.equal(
    readableSignature(SIG(2, 3, 2, 0, "Searching round 3")),
    readableSignature(SIG(2, 9, 8, 0, "Searching round 9")),
  );
  // The three fields that do carry something to read each move it.
  assert.notEqual(readableSignature(SIG(2, 3, 2, 0)), readableSignature(SIG(3, 3, 2, 0)));
  assert.notEqual(readableSignature(SIG(2, 3, 2, 0)), readableSignature(SIG(2, 3, 2, 120)));
  assert.notEqual(readableSignature(SIG(2, 3, 2, 0, "", 0)), readableSignature(SIG(2, 3, 2, 0, "", 1)));
  // A format this module does not know compares exactly as it always did.
  assert.equal(readableSignature("s17"), "s17");
  assert.equal(readableSignature(null), "");
});

test("a ticking activity bar is wait time, not activity", () => {
  const { samples } = researchRun();
  // The old rule — byte-identical signatures — finds nothing here, because the
  // bar ticks faster than the threshold. That is the whole bug.
  assert.deepEqual(stillSpans(samples, { minStillMs: 1500 }), []);

  const spans = waitSpans(samples, { minStillMs: 1500 });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, "thinking", "the pipeline was visibly working, not frozen");
  assert.ok(spans[0].end - spans[0].start > 29000, `the whole search phase: ${spans[0].end - spans[0].start} ms`);
});

test("a frozen stretch and a working one are told apart", () => {
  const frozen = [];
  for (let t = 0; t < 8000; t += 250) frozen.push({ t, sig: SIG(2, 4, 4, 900, "Done", 1) });
  const spans = waitSpans(frozen, { minStillMs: 1500 });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, "dead", "nothing moved at all — a frozen frame");
});

test("#CAP-10: the wait is accelerated instead of playing out in real time", () => {
  const { samples, sourceMs, streamStart } = researchRun();
  const plan = planEdit({ sourceMs, samples, waitMode: "speed", speed: 1.25, waitSpeed: 8, minStillMs: 1500 });

  // What #CAP-10 delivered: every millisecond at the action speed, nothing sped
  // up. If this ever holds again the clip is unwatchable for the same reason.
  const unedited = sourceMs / 1.25;
  assert.ok(
    plan.outMs < unedited * 0.75,
    `the wait must be compressed, not replayed: ${Math.round(plan.outMs)} ms vs ${Math.round(unedited)} ms`,
  );
  assert.ok(plan.thinkingMs > 29000, "the search phase is measured as thinking");
  assert.equal(plan.deadMs, 0, "nothing in this run was ever frozen");
  assert.equal(plan.waitMs, plan.deadMs + plan.thinkingMs);

  // And the point of accelerating it: the answer streaming survives whole, at
  // the action speed, so the entire generation is watchable.
  const streaming = plan.segments.filter((s) => s.start >= streamStart - 250);
  assert.ok(streaming.length > 0);
  for (const s of streaming) {
    assert.equal(s.kind, "action", "the answer streaming is never treated as a wait");
    assert.equal(s.speed, 1.25);
  }
});

test("--wait cut accelerates the research phase instead of deleting it", () => {
  const { samples, sourceMs } = researchRun();
  const cut = planEdit({ sourceMs, samples, waitMode: "cut", waitSpeed: 8, minStillMs: 1500 });

  const thinking = cut.segments.filter((s) => s.kind === "thinking");
  assert.equal(thinking.length, 1, "the search phase is still in the clip");
  assert.equal(thinking[0].speed, 8);
  assert.equal(cut.cutMs, 0, "nothing was frozen, so nothing was dropped");

  // A genuinely frozen tail IS dropped by the same mode.
  const withFreeze = [...samples];
  let t = sourceMs;
  const frozenSig = samples[samples.length - 1].sig;
  for (let i = 0; i < 40; i++, t += 250) withFreeze.push({ t, sig: frozenSig });
  const frozen = planEdit({ sourceMs: t, samples: withFreeze, waitMode: "cut", minStillMs: 1500 });
  assert.ok(frozen.deadMs > 8000, `the frozen tail is measured: ${frozen.deadMs} ms`);
  assert.ok(frozen.cutMs > 8000, "and cut, because nobody loses anything when a frozen frame goes");
});

test("the plan prints the wait breakdown a reviewer argues from", () => {
  const { samples, sourceMs } = researchRun();
  const text = formatPlan(planEdit({ sourceMs, samples, waitMode: "speed" }), { shape: "portrait" });
  assert.match(text, /thinking/);
  assert.match(text, /frozen/);
});

test("the last frame with content is found past a blank tail", () => {
  const samples = [
    { t: 0, sig: BLANK },
    { t: 250, sig: SIG(2, 3, 1, 40) },
    { t: 500, sig: SIG(2, 5, 5, 900, "", 1) },
    { t: 750, sig: BLANK }, // navigated away / torn down
    { t: 1000, sig: BLANK },
  ];
  const last = lastContentSample(samples);
  assert.equal(last?.t, 500);
  assert.equal(contentEnd({ samples }).ms, 500);
  assert.equal(contentEnd({ samples }).status, "found");
  assert.equal(contentEnd({ samples }).source, "sample");
});

test("a marker raises the content end — an Agent Studio run's app page has no chat DOM", () => {
  const samples = [
    { t: 0, sig: SIG(2, 5, 5, 900, "", 1) },
    { t: 250, sig: BLANK }, // walked to /app/<slug>/ — still the best footage in the clip
    { t: 500, sig: BLANK },
  ];
  const end = contentEnd({ samples, markers: [{ t: 480, id: "app_done" }] });
  assert.equal(end.ms, 480);
  assert.equal(end.source, "marker");
});

test("a blank recording and a missing timeline are told apart", () => {
  assert.deepEqual(contentEnd({ samples: [{ t: 0, sig: BLANK }] }), { ms: null, status: "blank", source: null });
  assert.deepEqual(contentEnd({}), { ms: null, status: "unknown", source: null });
});

test("the cut ends on the last content frame, not at end-of-file", () => {
  // The recording outlives the run: the sampler stops, then Playwright tears
  // the context down, and those last seconds are nobody's choice.
  const samples = [
    { t: 2000, sig: SIG(1, 0, 0, 0) },
    { t: 2250, sig: SIG(2, 4, 4, 700, "", 1) },
  ];
  const plan = planEdit({ sourceMs: 9000, samples, waitMode: "keep" });
  const last = plan.segments[plan.segments.length - 1];
  assert.equal(last.end, 2250, "the 6.75 s of teardown after the last sample is not the ending");
  assert.equal(plan.contentEndMs, 2250);
  assert.equal(plan.contentStatus, "found");
  assert.equal(plan.tailMs, 0);

  // …and the raw tail can be asked for back.
  const raw = planEdit({ sourceMs: 9000, samples, waitMode: "keep", endAtContent: false });
  assert.equal(raw.segments[raw.segments.length - 1].end, 9000);
  assert.ok(raw.tailMs > 6000, "which is exactly what the delivery check then flags");
});

test("--trim-end can only shorten the clip further, never extend it", () => {
  const samples = [
    { t: 1000, sig: SIG(1, 1, 0, 10) },
    { t: 5000, sig: SIG(2, 4, 4, 700, "", 1) },
  ];
  const plan = planEdit({ sourceMs: 9000, samples, waitMode: "keep", trimEndMs: 5500 });
  assert.equal(plan.segments[plan.segments.length - 1].end, 3500);
});

test("the page-load flash is trimmed off the head, measured from the timeline", () => {
  // The sampler starts once the app is up, so the first sample is evidence of
  // when there was something to look at. The white flash lives before it.
  assert.deepEqual(headTrim({ samples: [{ t: 3200, sig: BLANK }] }), { ms: HEAD_FLASH.maxMs, status: "measured" });
  assert.deepEqual(headTrim({ samples: [{ t: 900, sig: BLANK }] }), { ms: 900, status: "measured" });
  // A fast first sample must not leave a residual flash (measured at ~650 ms).
  assert.deepEqual(headTrim({ samples: [{ t: 200, sig: BLANK }] }), { ms: HEAD_FLASH.fallbackMs, status: "measured" });
  // A timeline covering frame zero has measured the head instead of guessing.
  assert.deepEqual(headTrim({ samples: [{ t: 0, sig: BLANK }] }), { ms: 0, status: "measured" });
  // Nothing to measure: assume the flash is there, because it always is.
  assert.deepEqual(headTrim({}), { ms: HEAD_FLASH.fallbackMs, status: "assumed" });
  assert.ok(HEAD_FLASH.fallbackMs > 650, "the flash was measured at ~0.65 s (CAP-20/21/22, 2026-08-12)");
});

test("an explicit --trim-start wins over the measured head, including 0", () => {
  const samples = [{ t: 2000, sig: SIG(1, 1, 0, 10) }, { t: 4000, sig: SIG(2, 4, 4, 700, "", 1) }];
  const auto = planEdit({ sourceMs: 9000, samples, waitMode: "keep" });
  assert.equal(auto.headTrimMs, HEAD_FLASH.maxMs);
  assert.equal(auto.headTrimSource, "measured");
  assert.equal(auto.segments[0].start, HEAD_FLASH.maxMs);

  const kept = planEdit({ sourceMs: 9000, samples, waitMode: "keep", trimStartMs: 0 });
  assert.equal(kept.headTrimMs, 0);
  assert.equal(kept.headTrimSource, "explicit");
  assert.equal(kept.segments[0].start, 0);
});

test("the end hold freezes the finished state and is counted as output time", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN });
  assert.equal(plan.endHoldMs, PLAN_DEFAULTS.endHoldMs);
  assert.ok(plan.endHoldMs >= 1000, "a feed reader needs a beat to read the answer");
  assert.equal(plan.outMs, plan.segmentsMs + plan.endHoldMs, "the bitrate cap and the duration check read outMs");

  const none = planEdit({ sourceMs: 32000, samples: RUN, endHoldMs: 0 });
  assert.equal(none.endHoldMs, 0);
  assert.equal(none.outMs, none.segmentsMs);
});

test("the end hold is a tpad clone AFTER the frame rate is normalised", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, endHoldMs: 1200 });
  const graph = buildFilterGraph(plan, { shape: "portrait" });
  assert.ok(graph.includes("tpad=stop_mode=clone:stop_duration=1.200"));
  assert.ok(
    graph.indexOf("fps=30") < graph.indexOf("tpad="),
    "a Playwright webm is variable-rate; cloning before fps= can hold one very long frame",
  );
  assert.ok(graph.endsWith("format=yuv420p[v]"));
  assert.ok(!buildFilterGraph(planEdit({ sourceMs: 32000, samples: RUN, endHoldMs: 0 })).includes("tpad="));
});

test("the poster is the frozen end state by default, so the deck card is diagnostic", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, endHoldMs: 1200 });
  const at = posterAtMs(plan);
  assert.ok(at > plan.segmentsMs, "inside the hold: the finished answer, not a mid-stream frame");
  assert.ok(at <= plan.outMs - 60, "and far enough inside that the seek still lands on a frame");
  // The old behaviour is still reachable, and an explicit offset still wins.
  assert.ok(Math.abs(posterAtMs(plan, { mode: "mid" }) - plan.outMs * 0.6) < 1);
  assert.equal(posterAtMs(plan, { atMs: 2500 }), 2500);
  // With no hold the poster is still the end, not the middle.
  const flat = planEdit({ sourceMs: 32000, samples: RUN, endHoldMs: 0 });
  assert.ok(posterAtMs(flat) > flat.outMs * 0.9);
  assert.ok(posterAtMs(flat) <= flat.outMs - 60);
});

test("the delivery check reports a clip whose ending cannot be trusted", () => {
  // A blank recording is a broken capture, not a judgement call.
  const blank = checkDelivery({ content: planContent(planEdit({ sourceMs: 9000, samples: [{ t: 500, sig: BLANK }] })) });
  assert.equal(blank.ok, false);
  assert.match(blank.problems.join(" "), /blank/i);

  // No timeline: it may be fine, but nobody checked.
  const unknown = checkDelivery({ content: planContent(planEdit({ sourceMs: 9000, samples: [] })) });
  assert.equal(unknown.ok, true);
  assert.match(unknown.warnings.join(" "), /could not be located/);

  // A kept tail past the last content frame is called out by length.
  const raw = planEdit({
    sourceMs: 9000,
    samples: [{ t: 1000, sig: SIG(2, 4, 4, 700, "", 1) }],
    waitMode: "keep",
    endAtContent: false,
  });
  assert.match(checkDelivery({ content: planContent(raw) }).warnings.join(" "), /after the last frame with content/);

  // A clip that opens on the flash is called out too — that frame is what a
  // looping player shows the instant the clip ends.
  assert.match(
    checkDelivery({ content: { status: "found", tailMs: 0, endHoldMs: 1200, headTrimMs: 0 } }).warnings.join(" "),
    /page-load flash/,
  );

  // A good plan says nothing at all.
  const good = checkDelivery({ content: planContent(planEdit({ sourceMs: 32000, samples: RUN, trimStartMs: 750 })) });
  assert.deepEqual([...good.problems, ...good.warnings], []);

  // And a caller that passes no content block is unchanged (shapes, aspect).
  assert.deepEqual(checkDelivery({ width: 1080, height: 1350 }), { ok: true, problems: [], warnings: [] });
});

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

test("the filter graph trims, rebases and concatenates every segment", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN });
  const graph = buildFilterGraph(plan, { shape: "portrait" });
  const chains = graph.split(";");
  assert.equal(chains.length, plan.segments.length + 2, "one chain per segment, plus concat, plus the tail");
  for (const [i, s] of plan.segments.entries()) {
    assert.ok(graph.includes(`trim=start=${secs(s.start)}:end=${secs(s.end)}`));
    assert.ok(graph.includes(`setpts=(PTS-STARTPTS)/${s.speed}[c${i}]`), "STARTPTS must be rebased for concat");
  }
  assert.ok(graph.includes(`concat=n=${plan.segments.length}:v=1:a=0[cv]`));
  assert.ok(graph.includes("scale=1080:1350:force_original_aspect_ratio=decrease"));
  assert.ok(graph.includes("pad=1080:1350"), "letterbox rather than crop — the transcript loses meaning at the edges");
  assert.ok(graph.endsWith("format=yuv420p[v]"));
});

test("the raw shape resamples nothing", () => {
  const plan = planEdit({ sourceMs: 5000, samples: [] });
  const graph = buildFilterGraph(plan, { shape: "raw" });
  assert.ok(!graph.includes("scale="));
  // ",pad=" rather than "pad=": the end hold's `tpad=` contains that substring.
  assert.ok(!graph.includes(",pad="));
  assert.ok(graph.includes("fps=30"));
});

test("an empty plan is refused rather than producing a broken command", () => {
  assert.throws(() => buildFilterGraph({ segments: [] }), /no segments/);
});

test("the encoder settings are the ones LinkedIn actually plays", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN });
  const args = ffmpegArgs({ input: "raw.webm", output: "final.mp4", plan, shape: "portrait" });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("-c:v"), "libx264");
  assert.equal(flag("-pix_fmt"), "yuv420p", "10-bit or 4:4:4 renders as a black rectangle in the feed");
  assert.equal(flag("-profile:v"), "high");
  assert.equal(flag("-movflags"), "+faststart", "without this the video does not start until it has downloaded");
  assert.ok(args.includes("-an"), "LinkedIn autoplays muted; a silent track buys nothing");
  assert.equal(args[args.length - 1], "final.mp4");
  // Arguments are an array, so a filter graph full of : , [ ] is never quoted.
  assert.ok(args.some((a) => a.includes("concat=")));
});

test("a size budget becomes a bitrate cap; without one the encode is quality-targeted", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN });
  const uncapped = ffmpegArgs({ input: "a.webm", output: "b.mp4", plan });
  assert.ok(!uncapped.includes("-maxrate"));
  const capped = ffmpegArgs({ input: "a.webm", output: "b.mp4", plan, maxBytes: 8 * 1024 * 1024 });
  assert.ok(capped.includes("-maxrate"));
  assert.ok(capped.includes("-bufsize"));
});

test("the bitrate cap lands the file under the budget", () => {
  const kbps = bitrateCapKbps(10 * 1024 * 1024, 60_000);
  assert.ok(kbps !== null);
  const predictedBytes = ((kbps || 0) * 1000 * 60) / 8;
  assert.ok(predictedBytes <= 10 * 1024 * 1024, "the headroom must not be optimistic");
  assert.equal(bitrateCapKbps(null, 60_000), null);
  assert.equal(bitrateCapKbps(1024, 0), null);
});

test("the poster is a single frame from the edited file", () => {
  const args = posterArgs({ input: "final.mp4", output: "poster.jpg", atMs: 2500, width: 720 });
  assert.deepEqual(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2), ["-ss", "2.500"]);
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "seek before input, or the decode is needlessly slow");
  assert.ok(args.includes("-frames:v"));
  assert.equal(args[args.length - 1], "poster.jpg");
});

test("ffprobe output degrades to nulls rather than throwing", () => {
  const parsed = parseProbe({
    format: { duration: "12.5", size: "1048576" },
    streams: [{ width: 1080, height: 1350, r_frame_rate: "30/1" }],
  });
  assert.deepEqual(parsed, { seconds: 12.5, bytes: 1048576, width: 1080, height: 1350, fps: 30 });
  assert.deepEqual(parseProbe(null), { seconds: null, bytes: null, width: null, height: null, fps: null });
  assert.equal(parseProbe({ streams: [{ r_frame_rate: "0/0" }] }).fps, null);
});

test("the plan renders as something an operator can argue with before encoding", () => {
  const text = formatPlan(planEdit({ sourceMs: 32000, samples: RUN }), { shape: "portrait" });
  assert.match(text, /source/);
  assert.match(text, /wait time/);
  assert.match(text, /output/);
  assert.match(text, /4:5 portrait/);
});

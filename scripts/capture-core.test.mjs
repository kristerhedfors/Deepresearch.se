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
  captureSlug,
  checkDelivery,
  examplePrompts,
  expandMatrix,
  ffmpegArgs,
  formatPlan,
  mergeIntervals,
  mergeSegments,
  modeForAgent,
  parseProbe,
  pickPrompts,
  planEdit,
  posterArgs,
  resolveShape,
  secs,
  stillSpans,
} from "./capture-core.mjs";

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
  // A typo produces an obviously-wrong run, not a dead harness.
  assert.equal(modeForAgent("not-an-agent"), "normal");
});

test("example prompts come from the shipped starter queues", () => {
  const prompts = examplePrompts("research");
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
  const sv = examplePrompts("research", { lang: "sv" });
  assert.ok(sv.length > 0);
  assert.ok(sv.every((p) => p.lang === "sv"));
});

test("ranked starters are picked before untried ones", () => {
  const picked = pickPrompts("research", 3);
  assert.equal(picked.length, 3);
  const ranks = picked.map((p) => p.rank).filter((r) => typeof r === "number");
  assert.ok(ranks.length > 0, "the research queue has ranked entries, so a pick must use them");
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), "ranked picks descend");
});

test("asking for more prompts than the queue holds wraps instead of running dry", () => {
  const queue = examplePrompts("models");
  const picked = pickPrompts("models", queue.length + 2);
  assert.equal(picked.length, queue.length + 2);
});

test("the matrix is agent-major so an interrupted batch covers whole agents", () => {
  const runs = expandMatrix({
    agents: ["research", "introspection"],
    models: ["model-a", "model-b"],
    prompts: {
      research: [{ id: "r1", text: "one", lang: "en", xp: 1 }],
      introspection: [{ id: "i1", text: "two", lang: "en" }],
    },
  });
  assert.deepEqual(
    runs.map((r) => `${r.agent}/${r.model}/${r.starter}`),
    ["research/model-a/r1", "research/model-b/r1", "introspection/model-a/i1", "introspection/model-b/i1"],
  );
  assert.equal(runs[0].mode, "normal");
  assert.equal(runs[2].mode, "introspection");
  assert.equal(runs[0].xp, 1);
});

test("a run slug is filesystem-safe and identifies agent, model and prompt", () => {
  const slug = captureSlug({ agent: "research", model: "mistralai/Devstral-Small-2505", starter: "res-sv-elpris" });
  assert.match(slug, /^[a-z0-9_-]+$/);
  assert.ok(slug.includes("research"));
  assert.ok(slug.includes("res-sv-elpris"));
  // Two different models must not collide into one directory.
  assert.notEqual(slug, captureSlug({ agent: "research", model: "openai/gpt-x", starter: "res-sv-elpris" }));
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
  assert.equal(plan.keptMs, 32000);
  assert.ok(Math.abs(plan.outMs - 16000) < 1);
});

test("the chosen speed applies to the parts where something happens", () => {
  const at1 = planEdit({ sourceMs: 32000, samples: RUN, speed: 1 });
  const at2 = planEdit({ sourceMs: 32000, samples: RUN, speed: 2 });
  assert.ok(Math.abs(at1.outMs / 2 - at2.outMs) < 1);
  assert.equal(at2.keptMs, at1.keptMs, "speed changes playback, not what is kept");
});

test("trims drop the head and tail of the recording", () => {
  const plan = planEdit({ sourceMs: 32000, samples: RUN, trimStartMs: 1000, trimEndMs: 2000, waitMode: "keep" });
  assert.equal(plan.segments[0].start, 1000);
  assert.equal(plan.segments[plan.segments.length - 1].end, 30000);
});

test("a recording with no timeline at all still produces one playable segment", () => {
  const plan = planEdit({ sourceMs: 12000, samples: [] });
  assert.deepEqual(plan.segments, [{ start: 0, end: 12000, kind: "action", speed: 1 }]);
  assert.equal(plan.cutMs, 0);
  assert.equal(plan.waitMs, 0);
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
  assert.ok(!graph.includes("pad="));
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
  assert.match(text, /dead air/);
  assert.match(text, /output/);
  assert.match(text, /4:5 portrait/);
});

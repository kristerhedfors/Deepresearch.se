import { test } from "node:test";
import assert from "node:assert/strict";

import { CAPTURABLE_AGENTS, expandMatrix, pickPrompts } from "./capture-core.mjs";
import {
  DEFAULT_MIN_STILL,
  DEFAULT_TARGET,
  addPayloadProblems,
  buildAddPayload,
  captureName,
  captureTag,
  chooseRuns,
  editArgs,
  fitMeta,
  formatPlan,
  formatSummary,
  normalizeQueueStatus,
  parseArgs,
  parseCaptureId,
  queueStatusUrl,
  recordArgs,
  responseError,
  validateOptions,
} from "./capture-topup.mjs";

// A three-agent starter registry, small enough to reason about by hand. `beta`
// carries a ranked entry so the ranked-first ordering is exercised, and `gamma`
// is deliberately shallow so a queue can run dry mid-plan.
const REGISTRY = {
  queues: {
    alpha: [
      { id: "al-one", text: "Alpha one", aspect: "a", lang: "en" },
      { id: "al-two", text: "Alpha two", aspect: "b", lang: "sv" },
      { id: "al-three", text: "Alpha three", aspect: "c", lang: "en" },
    ],
    beta: [
      { id: "be-one", text: "Beta one", aspect: "a", lang: "en" },
      { id: "be-two", text: "Beta two", aspect: "b", lang: "en", rank: 5 },
      { id: "be-three", text: "Beta three", aspect: "c", lang: "sv" },
    ],
    gamma: [{ id: "ga-only", text: "Gamma only", aspect: "a", lang: "en" }],
  },
};
const AGENTS = ["alpha", "beta", "gamma"];

const plan = (queueStatus, extra = {}) =>
  chooseRuns({ queueStatus, agents: AGENTS, registry: REGISTRY, ...extra });

// ---------------------------------------------------------------------------
// chooseRuns — the deficit
// ---------------------------------------------------------------------------

test("chooseRuns records exactly the deficit", () => {
  const p = plan({ target: 5, unanswered: 2, by_agent: {}, used: [] });
  assert.equal(p.target, 5);
  assert.equal(p.deficit, 3);
  assert.equal(p.runs.length, 3);
});

test("a full queue plans nothing", () => {
  const p = plan({ target: 20, unanswered: 20, used: [] });
  assert.equal(p.deficit, 0);
  assert.deepEqual(p.runs, []);
});

test("an over-full queue does not plan negative runs", () => {
  const p = plan({ target: 20, unanswered: 24, used: [] });
  assert.equal(p.deficit, 0);
  assert.equal(p.runs.length, 0);
});

test("--target overrides the server's target", () => {
  const p = plan({ target: 20, unanswered: 2, used: [] }, { target: 4 });
  assert.equal(p.target, 4);
  assert.equal(p.deficit, 2);
  assert.equal(p.runs.length, 2);
});

test("--limit caps the deficit without changing it", () => {
  const p = plan({ target: 9, unanswered: 0, used: [] }, { limit: 2 });
  assert.equal(p.deficit, 9);
  assert.equal(p.wanted, 2);
  assert.equal(p.runs.length, 2);
});

test("the default target is 20 when the server names none", () => {
  const p = plan({ unanswered: 0, used: [] });
  assert.equal(p.target, DEFAULT_TARGET);
  assert.equal(p.deficit, DEFAULT_TARGET);
});

test("the server's own deficit is used when it reports no unanswered count", () => {
  const p = plan({ target: 20, deficit: 3, used: [] });
  assert.equal(p.deficit, 3);
  assert.equal(p.runs.length, 3);
});

// ---------------------------------------------------------------------------
// chooseRuns — the spread
// ---------------------------------------------------------------------------

test("the spread goes to the agent with the fewest captures, ties in registry order", () => {
  const p = plan({ target: 3, unanswered: 0, by_agent: { alpha: 2, beta: 0, gamma: 1 }, used: [] });
  // beta is furthest behind (0), so it takes the first pick and reaches 1. That
  // ties it with gamma, and the tie breaks in registry order — beta again.
  // Only then is gamma the one furthest behind. alpha, already at 2, waits.
  assert.deepEqual(
    p.runs.map((r) => r.agent),
    ["beta", "beta", "gamma"],
  );
});

test("an empty deck round-robins in registry order", () => {
  const p = plan({ target: 6, unanswered: 0, by_agent: {}, used: [] });
  assert.deepEqual(
    p.runs.map((r) => r.agent),
    ["alpha", "beta", "gamma", "alpha", "beta", "alpha"],
  );
  // gamma has one starter only, so the sixth pick falls to alpha rather than
  // repeating gamma's prompt.
  assert.equal(p.runs.filter((r) => r.agent === "gamma").length, 1);
});

test("the projected per-agent counts come back with the plan", () => {
  const p = plan({ target: 3, unanswered: 0, by_agent: { alpha: 4 }, used: [] });
  assert.equal(p.counts.alpha, 4 + p.runs.filter((r) => r.agent === "alpha").length);
  assert.equal(p.counts.beta, p.runs.filter((r) => r.agent === "beta").length);
});

test("the real starter registry spreads twenty captures over every agent", () => {
  const p = chooseRuns({ queueStatus: { target: 20, unanswered: 0, used: [] } });
  assert.equal(p.runs.length, 20);
  const seen = new Set(p.runs.map((r) => r.agent));
  for (const agent of CAPTURABLE_AGENTS) assert.ok(seen.has(agent), `${agent} is missing from the plan`);
  const counts = CAPTURABLE_AGENTS.map((a) => p.runs.filter((r) => r.agent === a).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `uneven spread: ${counts.join(",")}`);
});

// ---------------------------------------------------------------------------
// chooseRuns — never re-record
// ---------------------------------------------------------------------------

test("a used (agent, starter) pair is never re-recorded", () => {
  const used = [
    { agent: "alpha", starter: "al-one" },
    { agent: "beta", starter: "be-two" },
  ];
  const p = plan({ target: 7, unanswered: 0, used });
  for (const r of p.runs) {
    assert.ok(!used.some((u) => u.agent === r.agent && u.starter === r.starter), `re-recorded ${r.starter}`);
  }
  assert.equal(p.runs.length, 7 - 2); // seven wanted, two pairs already in the deck
});

test("a pair used by ANOTHER agent does not block this agent's starter", () => {
  const p = plan({ target: 1, unanswered: 0, by_agent: {}, used: [{ agent: "beta", starter: "al-one" }] });
  assert.equal(p.runs[0].agent, "alpha");
  assert.equal(p.runs[0].starter, "al-one");
});

test("no starter appears twice within one plan", () => {
  const p = plan({ target: 7, unanswered: 0, used: [] });
  const keys = p.runs.map((r) => `${r.agent} ${r.starter}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ---------------------------------------------------------------------------
// chooseRuns — exhaustion
// ---------------------------------------------------------------------------

test("an exhausted agent drops out of the rotation and is reported", () => {
  const used = [{ agent: "gamma", starter: "ga-only" }];
  const p = plan({ target: 4, unanswered: 0, used });
  assert.ok(!p.runs.some((r) => r.agent === "gamma"));
  assert.deepEqual(p.skipped, [
    { agent: "gamma", reason: "all 1 starter in this queue are already in the deck" },
  ]);
});

test("running out of starters everywhere is a shortfall, not a crash", () => {
  const p = plan({ target: 99, unanswered: 0, used: [] });
  assert.equal(p.runs.length, 7); // 3 + 3 + 1 starters exist
  assert.equal(p.wanted, 99);
  assert.equal(p.shortfall, 92);
  assert.match(formatPlan(p), /short by 92/);
});

test("an agent with no queue at all is skipped with a reason", () => {
  const p = chooseRuns({
    queueStatus: { target: 2, unanswered: 0, used: [] },
    agents: ["alpha", "nosuchagent"],
    registry: REGISTRY,
  });
  assert.ok(p.skipped.some((s) => s.agent === "nosuchagent" && /no starters/.test(s.reason)));
  assert.ok(p.runs.every((r) => r.agent === "alpha"));
});

// ---------------------------------------------------------------------------
// chooseRuns — the prompts themselves
// ---------------------------------------------------------------------------

test("the offset selects the planned starter out of the recorder's own ordering", () => {
  const p = plan({ target: 6, unanswered: 0, used: [] });
  for (const r of p.runs) {
    const [picked] = pickPrompts(r.agent, 1, { offset: r.offset, registry: REGISTRY });
    assert.equal(picked.id, r.starter, `offset ${r.offset} on ${r.agent} does not select ${r.starter}`);
    assert.equal(picked.text, r.prompt);
  }
});

test("the offset survives the recorder's own matrix expansion", () => {
  // tests/capture.mjs does not take a starter id — it takes an agent, a
  // per-agent count and an offset, and expands them with expandMatrix. This is
  // the contract that makes `--offset <n>` select the planned prompt, and it is
  // the one thing that would silently record the WRONG question if it drifted.
  const p = chooseRuns({ queueStatus: { target: 8, unanswered: 0, used: [] }, models: ["m1"] });
  for (const r of p.runs) {
    const [expanded] = expandMatrix({ agents: [r.agent], models: ["m1"], perAgent: 1, offset: r.offset });
    assert.equal(expanded.starter, r.starter, `${r.agent} offset ${r.offset} expands to ${expanded.starter}`);
    assert.equal(expanded.prompt, r.prompt);
    assert.equal(expanded.mode, r.mode);
  }
});

test("ranked starters are planned before unranked ones", () => {
  const p = plan({ target: 1, unanswered: 0, by_agent: { alpha: 9, gamma: 9 }, used: [] });
  assert.equal(p.runs[0].agent, "beta");
  assert.equal(p.runs[0].starter, "be-two"); // rank 5 outranks registry order
  assert.equal(p.runs[0].offset, 0);
});

test("--lang restricts the plan to that language", () => {
  const p = plan({ target: 4, unanswered: 0, used: [] }, { lang: "sv" });
  assert.deepEqual(
    p.runs.map((r) => r.starter),
    ["al-two", "be-three"],
  );
  assert.ok(p.runs.every((r) => r.lang === "sv"));
  assert.ok(p.skipped.some((s) => s.agent === "gamma" && /lang “sv”/.test(s.reason)));
});

test("models are assigned round-robin; no models means the site default", () => {
  const withModels = plan({ target: 3, unanswered: 0, used: [] }, { models: ["m1", "m2"] });
  assert.deepEqual(
    withModels.runs.map((r) => r.model),
    ["m1", "m2", "m1"],
  );
  const without = plan({ target: 1, unanswered: 0, used: [] });
  assert.equal(without.runs[0].model, null);
});

test("every planned run carries a mode and a short name", () => {
  const p = chooseRuns({ queueStatus: { target: 3, unanswered: 0, used: [] } });
  for (const r of p.runs) {
    assert.equal(typeof r.mode, "string");
    assert.ok(r.mode.length > 0);
    assert.ok(r.name.length > 0);
  }
});

test("the same queue status always produces the same plan", () => {
  const status = { target: 12, unanswered: 3, by_agent: { alpha: 1, beta: 2 }, used: [{ agent: "beta", starter: "be-one" }] };
  assert.deepEqual(plan(status), plan(structuredClone(status)));
});

// ---------------------------------------------------------------------------
// normalizeQueueStatus
// ---------------------------------------------------------------------------

test("normalizeQueueStatus tolerates a missing or malformed body", () => {
  const empty = normalizeQueueStatus(null);
  assert.deepEqual(empty, { target: null, unanswered: null, deficit: null, by_agent: {}, used: [] });
  const messy = normalizeQueueStatus({
    target: "20",
    unanswered: "6",
    by_agent: { research: "3", broken: "x" },
    used: [{ agent: "research", starter: "res-one" }, { agent: "" }, "scholar:sch-two", 7],
  });
  assert.equal(messy.target, 20);
  assert.equal(messy.unanswered, 6);
  assert.deepEqual(messy.by_agent, { research: 3 });
  assert.deepEqual(messy.used, [
    { agent: "research", starter: "res-one" },
    { agent: "scholar", starter: "sch-two" },
  ]);
});

test("normalizeQueueStatus unwraps a { queue: … } envelope", () => {
  assert.equal(normalizeQueueStatus({ queue: { target: 20, unanswered: 5 } }).unanswered, 5);
});

test("normalizeQueueStatus does not let an agent id touch the prototype", () => {
  const status = normalizeQueueStatus(JSON.parse('{"by_agent":{"__proto__":3,"research":1}}'));
  assert.deepEqual(status.by_agent, { research: 1 });
  assert.equal(Object.getPrototypeOf(status.by_agent), Object.prototype);
});

test("queueStatusUrl names the agent roster and the target", () => {
  assert.equal(
    queueStatusUrl("https://example.test", { agents: ["research", "scholar"], target: 20 }),
    "https://example.test/api/admin/captures/queue-status?agents=research%2Cscholar&target=20",
  );
  assert.equal(
    queueStatusUrl("https://example.test"),
    "https://example.test/api/admin/captures/queue-status",
  );
});

test("an unreadable queue status plans a full deck rather than nothing", () => {
  const p = plan({});
  assert.equal(p.target, DEFAULT_TARGET);
  assert.equal(p.deficit, DEFAULT_TARGET);
});

// ---------------------------------------------------------------------------
// captureName (CONTRACT §6)
// ---------------------------------------------------------------------------

test("captureName derives the contract's examples", () => {
  assert.equal(captureName({ agent: "research", starter: "res-sv-elpris" }), "Sv Elpris");
  assert.equal(captureName({ agent: "scholar", starter: "sch-vitamin-d" }), "Vitamin D");
  assert.equal(captureName({ agent: "introspection", starter: "int-pipeline" }), "Pipeline");
});

test("captureName caps at four words and never returns empty", () => {
  assert.equal(captureName({ starter: "res-a-b-c-d-e" }), "A B C D");
  assert.equal(captureName({ starter: "solo" }), "Solo");
  assert.equal(captureName({ starter: "", prompt: "Vad påverkar elpriset i Sverige just nu?" }), "Vad Påverkar Elpriset I");
  assert.equal(captureName({}), "Capture");
});

// ---------------------------------------------------------------------------
// The `capture <id>` reply
// ---------------------------------------------------------------------------

test("parseCaptureId reads the TEXT form scripts/captures prints", () => {
  const stdout = [
    "capture 12",
    "  video:  https://deepresearch.se/api/admin/captures/12/video",
    "  poster: https://deepresearch.se/api/admin/captures/12/poster",
  ].join("\n");
  assert.equal(parseCaptureId(stdout), 12);
});

test("parseCaptureId falls back to the raw JSON body (no jq installed)", () => {
  assert.equal(parseCaptureId(JSON.stringify({ capture: { id: 47 }, upload: {} })), 47);
  assert.equal(parseCaptureId(JSON.stringify({ id: 48 })), 48);
});

test("parseCaptureId falls back to an upload URL", () => {
  assert.equal(parseCaptureId("wrote /api/admin/captures/99/video\n"), 99);
});

test("responseError catches an error body behind a zero exit", () => {
  // scripts/captures is `curl -sS` without -f, so an HTTP 413/503 prints a JSON
  // error and exits 0. Missing that is how a row ends up with no video.
  assert.equal(responseError('{"error":"The video exceeds the 200 MB limit."}'), "The video exceeds the 200 MB limit.");
  assert.equal(responseError('  {"error": "No such capture."}\n'), "No such capture.");
  assert.equal(responseError('{"capture":{"id":12},"error":""}'), null);
  assert.equal(responseError("capture 12\n  video:  https://…"), null);
  assert.equal(responseError(""), null);
  assert.equal(responseError(null), null);
});

test("parseCaptureId returns null rather than a wrong id", () => {
  assert.equal(parseCaptureId(""), null);
  assert.equal(parseCaptureId("error: unauthorized"), null);
  assert.equal(parseCaptureId(null), null);
});

// ---------------------------------------------------------------------------
// The --add payload
// ---------------------------------------------------------------------------

const EDIT = {
  dir: "captures/2026-08-11-topup/01-research-res-sv-elpris/research__m__res-sv-elpris",
  output: "/tmp/final.mp4",
  poster: "/tmp/poster.jpg",
  shape: "portrait",
  source_ms: 54000,
  output_ms: 8400,
  cut_ms: 30000,
  dead_air_ms: 31000,
  wait_mode: "speed",
  speed: 1.25,
  segments: [{ start: 0, end: 1000, kind: "action", speed: 1.25 }],
  probe: { seconds: 8.4, bytes: 3_500_000, width: 1080, height: 1350, fps: 30 },
  meta: {
    slug: "research__m__res-sv-elpris",
    agent: "research",
    mode: "normal",
    model: "mistral-small",
    prompt: "Vad påverkar elpriset i Sverige just nu?",
    starter: "res-sv-elpris",
    lang: "sv",
  },
};

test("buildAddPayload carries everything edit.json provides", () => {
  const payload = buildAddPayload({ edit: EDIT, name: "Sv Elpris", commit: "abc1234" });
  assert.equal(payload.agent, "research");
  assert.equal(payload.mode, "normal");
  assert.equal(payload.model, "mistral-small");
  assert.equal(payload.starter, "res-sv-elpris");
  assert.equal(payload.lang, "sv");
  assert.equal(payload.shape, "portrait");
  assert.equal(payload.slug, "research__m__res-sv-elpris");
  assert.equal(payload.duration_ms, 8400);
  assert.equal(payload.source_ms, 54000);
  assert.equal(payload.cut_ms, 30000);
  assert.equal(payload.speed, 1.25);
  assert.equal(payload.wait_mode, "speed");
  assert.equal(payload.width, 1080);
  assert.equal(payload.height, 1350);
  assert.equal(payload.size_bytes, 3_500_000);
  assert.equal(payload.prompt, EDIT.meta.prompt);
  assert.equal(payload.label, EDIT.meta.prompt);
  assert.equal(payload.meta.source_ms, 54000);
  assert.deepEqual(addPayloadProblems(payload), []);
});

test("buildAddPayload carries the queue-v2 fields: name and commit_sha", () => {
  const payload = buildAddPayload({ edit: EDIT, name: "Sv Elpris", commit: "abc1234" });
  assert.equal(payload.name, "Sv Elpris");
  assert.equal(payload.commit_sha, "abc1234");
  // No name given: derived from the starter, never left blank.
  assert.equal(buildAddPayload({ edit: EDIT }).name, "Sv Elpris");
});

test("buildAddPayload omits nulls rather than sending them", () => {
  const payload = buildAddPayload({ edit: { ...EDIT, meta: { ...EDIT.meta, lang: null }, probe: {} } });
  assert.ok(!("lang" in payload));
  assert.ok(!("width" in payload));
  assert.ok(!("commit_sha" in payload));
  assert.equal(payload.size_bytes, 0);
});

test("addPayloadProblems names what the server would refuse", () => {
  const broken = buildAddPayload({ edit: { ...EDIT, output_ms: 0, meta: { ...EDIT.meta, model: "" } } });
  const problems = addPayloadProblems(broken);
  assert.ok(problems.some((p) => /duration_ms/.test(p)));
  assert.ok(problems.some((p) => /model/.test(p)));
});

test("fitMeta drops the segment list before it drops the provenance", () => {
  const fat = { ...EDIT, segments: Array.from({ length: 5000 }, (_, i) => ({ start: i, end: i + 1, kind: "action", speed: 1 })) };
  const fitted = fitMeta(fat);
  assert.ok(fitted, "meta was dropped entirely");
  assert.ok(!("segments" in fitted));
  assert.equal(fitted.segments_count, 5000);
  assert.equal(fitted.meta.agent, "research");
  assert.ok(JSON.stringify(fitted).length <= 20_000);
  // A small report is passed through untouched.
  assert.deepEqual(fitMeta(EDIT), EDIT);
  assert.equal(fitMeta(null), null);
});

// ---------------------------------------------------------------------------
// The shelled-out argv
// ---------------------------------------------------------------------------

const RUN = {
  agent: "research",
  mode: "normal",
  starter: "res-sv-elpris",
  prompt: "Vad påverkar elpriset?",
  lang: "sv",
  name: "Sv Elpris",
  offset: 3,
  model: "mistral-small",
};

test("recordArgs asks for exactly one run at the planned offset", () => {
  const opts = parseArgs(["--lang", "sv", "--base", "https://example.test"]);
  const args = recordArgs(RUN, opts, "/tmp/run-01");
  const pair = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "tests/capture.mjs");
  assert.equal(pair("--agents"), "research");
  assert.equal(pair("--per-agent"), "1");
  assert.equal(pair("--offset"), "3");
  assert.equal(pair("--limit"), "1");
  assert.equal(pair("--out"), "/tmp/run-01");
  assert.equal(pair("--models"), "mistral-small");
  assert.equal(pair("--lang"), "sv");
  assert.equal(pair("--base"), "https://example.test");
});

test("recordArgs leaves --models off when the site default should win", () => {
  const args = recordArgs({ ...RUN, model: null }, parseArgs([]), "/tmp/run-02");
  assert.ok(!args.includes("--models"));
});

test("editArgs defaults --min-still to 3500, the activity-bar value", () => {
  const args = editArgs("/tmp/cap", parseArgs([]));
  assert.equal(args[args.indexOf("--min-still") + 1], String(DEFAULT_MIN_STILL));
  assert.equal(DEFAULT_MIN_STILL, 3500);
  const lowered = editArgs("/tmp/cap", parseArgs(["--min-still", "1500", "--wait", "speed", "--speed", "1.25"]));
  assert.equal(lowered[lowered.indexOf("--min-still") + 1], "1500");
  assert.equal(lowered[lowered.indexOf("--wait") + 1], "speed");
  assert.equal(lowered[lowered.indexOf("--speed") + 1], "1.25");
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test("parseArgs reads both --flag value and --flag=value", () => {
  const opts = parseArgs(["--target=6", "--limit", "2", "--dry-run", "--agents=research,scholar"], {
    env: {},
    now: new Date(2026, 7, 11),
  });
  assert.equal(opts.target, 6);
  assert.equal(opts.limit, 2);
  assert.equal(opts.dryRun, true);
  assert.deepEqual(opts.agents, ["research", "scholar"]);
  assert.equal(opts.out, "captures/2026-08-11-topup");
  assert.equal(opts.publish, true);
});

test("parseArgs takes BASE_URL from the environment and strips its trailing slash", () => {
  assert.equal(parseArgs([], { env: { BASE_URL: "https://staging.test/" } }).base, "https://staging.test");
  assert.equal(parseArgs(["--no-publish"], { env: {} }).publish, false);
});

test("validateOptions names a bad agent, language and limit", () => {
  const errors = validateOptions(parseArgs(["--agents", "nope", "--lang", "de", "--limit", "0"], { env: {} }));
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => /Unknown agent/.test(e)));
  assert.ok(errors.some((e) => /Unknown language/.test(e)));
  assert.ok(errors.some((e) => /--limit/.test(e)));
  assert.deepEqual(validateOptions(parseArgs(["--agents", "research"], { env: {} })), []);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("formatPlan prints agent, starter, prompt and order", () => {
  const p = plan({ target: 2, unanswered: 0, used: [] });
  const text = formatPlan(p, { base: "https://example.test", out: "captures/x" });
  assert.match(text, /deficit 2/);
  assert.match(text, /alpha · al-one/);
  assert.match(text, /Alpha one/);
  assert.match(text, /https:\/\/example\.test/);
});

test("formatSummary shouts about a row whose video never landed", () => {
  const p = plan({ target: 7, unanswered: 5, used: [] });
  const results = [
    { run: p.runs[0], ok: true, id: 12, reason: null, warnings: [], durationMs: 1000, orphan: false },
    { run: p.runs[1], ok: false, id: 13, reason: "upload failed", warnings: [], durationMs: 500, orphan: true },
  ];
  const text = formatSummary({ plan: p, results });
  assert.match(text, /recorded 1\/2/);
  assert.match(text, /queue 6\/7 unanswered, still 1 short/); // 5 unanswered + 1 published
  assert.match(text, /ROWS WITH NO VIDEO/);
  assert.match(text, /scripts\/captures --upload 13/);
  assert.match(text, /#CAP-12/);
});

test("captureTag matches the repo's #CAP-<id> convention", () => {
  assert.equal(captureTag(7), "#CAP-7");
});

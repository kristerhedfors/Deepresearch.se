// Unit tests for the capture harness's pure half — everything in
// tests/capture.mjs that is a function of its arguments: the argv parser, the
// content signature, the output paths, and the two sidecar files the edit CLI
// and the admin uploader read.
//
// This file is run by the ROOT `npm test` (glob `tests/*.test.js`), on a
// checkout where `cd tests && npm install` has never happened. So it must not
// pull in `@playwright/test`, directly or transitively — which is why
// capture.mjs imports chromium lazily inside runBatch and ports
// stripCrossOriginAuth instead of importing tests/e2e/helpers.js. Importing
// this module at all is therefore part of what is being tested.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CAPTURABLE_AGENTS, SHAPES, expandMatrix } from "../scripts/capture-core.mjs";
import {
  DEFAULTS,
  MARKER_LABELS,
  buildMeta,
  buildTimeline,
  captureName,
  captureUrl,
  contentSignature,
  formatSummary,
  isLoopback,
  launchOptions,
  parseArgs,
  resolveAuth,
  runPaths,
  validateOptions,
} from "./capture.mjs";

/** parseArgs with the clock and environment pinned, so a default is a fact. */
const ARGS = (argv, env = {}) => parseArgs(argv, { env, now: new Date(2026, 7, 10, 12, 0, 0) });

// ---------------------------------------------------------------------------
// The argv parser
// ---------------------------------------------------------------------------

test("bare invocation resolves every documented default", () => {
  const o = ARGS([]);
  assert.deepEqual(o.agents, ["research"]);
  assert.equal(o.models, null, "no --models means 'ask the site for its default', not 'no models'");
  assert.equal(o.perAgent, DEFAULTS.perAgent);
  assert.equal(o.lang, null);
  assert.equal(o.offset, 0);
  assert.equal(o.shape, "portrait");
  assert.equal(o.out, "captures/2026-08-10");
  assert.equal(o.base, "https://deepresearch.se");
  assert.equal(o.budget, 60);
  assert.equal(o.search, true);
  assert.equal(o.sample, 250);
  assert.equal(o.timeout, 300_000);
  assert.equal(o.limit, null);
  assert.equal(o.headed, false);
  assert.equal(o.dryRun, false);
});

test("csv flags split, trim and drop empties", () => {
  const o = ARGS(["--agents", " research , introspection ,", "--models", "a/b,c/d"]);
  assert.deepEqual(o.agents, ["research", "introspection"]);
  assert.deepEqual(o.models, ["a/b", "c/d"]);
});

test("boolean flags take no value and do not eat the next argument", () => {
  const o = ARGS(["--dry-run", "--agents", "research", "--headed"]);
  assert.equal(o.dryRun, true);
  assert.equal(o.headed, true);
  assert.deepEqual(o.agents, ["research"], "--dry-run must not have swallowed --agents");
});

test("--limit and the other numeric flags parse as integers", () => {
  const o = ARGS(["--limit", "2", "--per-agent", "3", "--offset", "5", "--sample", "500", "--timeout", "90000", "--budget", "90"]);
  assert.equal(o.limit, 2);
  assert.equal(o.perAgent, 3);
  assert.equal(o.offset, 5);
  assert.equal(o.sample, 500);
  assert.equal(o.timeout, 90_000);
  assert.equal(o.budget, 90);
  // Garbage falls back to the default rather than poisoning the run with NaN.
  assert.equal(ARGS(["--sample", "wat"]).sample, DEFAULTS.sample);
});

test("--search takes on/off and BASE_URL supplies the target", () => {
  assert.equal(ARGS(["--search", "off"]).search, false);
  assert.equal(ARGS(["--search", "on"]).search, true);
  assert.equal(ARGS([], { BASE_URL: "http://127.0.0.1:8787" }).base, "http://127.0.0.1:8787");
  // --base wins over the environment, and a trailing slash never reaches the
  // wire (it would produce `//api/models` and shift the origin comparisons).
  assert.equal(ARGS(["--base", "https://x.example/"], { BASE_URL: "http://127.0.0.1:8787" }).base, "https://x.example");
});

test("--key=value is accepted as well as --key value", () => {
  const o = ARGS(["--agents=research,models", "--shape=square"]);
  assert.deepEqual(o.agents, ["research", "models"]);
  assert.equal(o.shape, "square");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("an unknown agent is refused and the message lists the valid ones", () => {
  const errors = validateOptions(ARGS(["--agents", "reserach"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /reserach/);
  for (const agent of CAPTURABLE_AGENTS) assert.ok(errors[0].includes(agent), `${agent} must be listed`);
});

test("every capturable agent passes validation", () => {
  assert.deepEqual(validateOptions(ARGS(["--agents", CAPTURABLE_AGENTS.join(",")])), []);
});

test("an unknown shape is refused and the message lists the valid ones", () => {
  const errors = validateOptions(ARGS(["--shape", "vertical"]));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /vertical/);
  for (const shape of Object.keys(SHAPES)) assert.ok(errors[0].includes(shape));
});

test("both a bad agent and a bad shape are reported in one pass", () => {
  // One run lost, not two: the operator fixes everything before re-launching.
  const errors = validateOptions(ARGS(["--agents", "nope", "--shape", "nope"]));
  assert.equal(errors.length, 2);
});

test("the remaining guards refuse what would produce an unusable batch", () => {
  assert.match(validateOptions(ARGS(["--lang", "de"]))[0], /language/);
  assert.match(validateOptions(ARGS(["--models", ""]))[0], /--models/);
  assert.match(validateOptions(ARGS(["--per-agent", "0"]))[0], /--per-agent/);
  assert.match(validateOptions(ARGS(["--limit", "0"]))[0], /--limit/);
  assert.match(validateOptions(ARGS(["--sample", "10"]))[0], /--sample/);
  assert.match(validateOptions(ARGS(["--timeout", "50"]))[0], /--timeout/);
  assert.deepEqual(validateOptions(ARGS(["--lang", "sv"])), []);
});

// ---------------------------------------------------------------------------
// The content signature
// ---------------------------------------------------------------------------

const PARTS = { msgs: 3, steps: 7, finished: 5, answerLen: 1842, step: "Writing report…", stats: false };

test("the signature is one short delimited string", () => {
  assert.equal(contentSignature(PARTS), "3|7|5|1842|Writing report…|0");
});

test("the signature is stable when nothing on screen moved", () => {
  // This is the whole basis of the edit: identical consecutive signatures are
  // what stillSpans proves to be dead time.
  assert.equal(contentSignature(PARTS), contentSignature({ ...PARTS }));
});

test("the signature changes on every visible change the editor must not cut", () => {
  const base = contentSignature(PARTS);
  assert.notEqual(contentSignature({ ...PARTS, answerLen: 1843 }), base, "the answer grew");
  assert.notEqual(contentSignature({ ...PARTS, msgs: 4 }), base, "a turn appeared");
  assert.notEqual(contentSignature({ ...PARTS, steps: 8 }), base, "a phase started");
  assert.notEqual(contentSignature({ ...PARTS, finished: 6 }), base, "a phase completed");
  assert.notEqual(contentSignature({ ...PARTS, step: "Validating…" }), base, "the phase label changed");
  assert.notEqual(contentSignature({ ...PARTS, stats: true }), base, "the run finished");
});

test("a label cannot forge a field boundary or churn on whitespace", () => {
  assert.equal(
    contentSignature({ ...PARTS, step: "  Search:\n “el|pris”  " }),
    contentSignature({ ...PARTS, step: "Search: “el/pris”" }),
  );
  // A long label is truncated, so a step that streams its own text does not
  // make every sample unique and defeat dead-air detection.
  const long = contentSignature({ ...PARTS, step: "x".repeat(200) });
  assert.equal(long.split("|")[4].length, 60);
});

test("a half-read sample degrades to zeroes rather than to NaN", () => {
  assert.equal(contentSignature({}), "0|0|0|0||0");
  assert.equal(contentSignature({ msgs: NaN, answerLen: undefined }), "0|0|0|0||0");
});

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

test("a run writes its four files under <out>/<slug>/", () => {
  const p = runPaths("captures/2026-08-10", "research__model-x__res-sv-elpris");
  assert.equal(p.dir, "captures/2026-08-10/research__model-x__res-sv-elpris");
  // `raw.webm` is what scripts/capture-edit.mjs looks for (isCaptureDir), so
  // the name is a contract, not a preference.
  assert.equal(p.video, "captures/2026-08-10/research__model-x__res-sv-elpris/raw.webm");
  assert.equal(p.timeline, "captures/2026-08-10/research__model-x__res-sv-elpris/timeline.json");
  assert.equal(p.meta, "captures/2026-08-10/research__model-x__res-sv-elpris/meta.json");
  assert.ok(p.videoTmp.startsWith(p.dir), "the scratch recording directory stays inside the run's own directory");
});

// ---------------------------------------------------------------------------
// timeline.json — the file the edit CLI plans from
// ---------------------------------------------------------------------------

test("the timeline is exactly the shape scripts/capture-edit.mjs reads", () => {
  const timeline = buildTimeline({
    samples: [
      { t: 0, sig: "1|0|0|0||0" },
      { t: 250, sig: "1|0|0|0||0" },
    ],
    markers: [
      { t: 1200, id: "send" },
      { t: 0, id: "open" },
    ],
    durationMs: 32_000,
    sampleMs: 250,
  });
  assert.deepEqual(Object.keys(timeline).sort(), ["durationMs", "markers", "sampleMs", "samples"]);
  assert.equal(timeline.durationMs, 32_000);
  assert.equal(timeline.sampleMs, 250);
  assert.deepEqual(timeline.samples, [
    { t: 0, sig: "1|0|0|0||0" },
    { t: 250, sig: "1|0|0|0||0" },
  ]);
  // Markers are sorted and labelled — the editor uses them as chapter titles.
  assert.deepEqual(timeline.markers, [
    { t: 0, id: "open", label: MARKER_LABELS.open },
    { t: 1200, id: "send", label: MARKER_LABELS.send },
  ]);
  // The whole file must survive JSON.parse(JSON.stringify(...)) unchanged;
  // that round trip is literally how the edit CLI reads it.
  assert.deepEqual(JSON.parse(JSON.stringify(timeline)), timeline);
});

test("a timeline assembled from a broken run is still plannable", () => {
  const timeline = buildTimeline({
    samples: [
      { t: 500, sig: "b" },
      { t: NaN, sig: "x" },
      /** @type {any} */ ({ t: 100 }),
      { t: 0, sig: "a" },
    ],
    markers: [{ t: 900, id: "timeout" }, /** @type {any} */ ({ id: "nope" })],
  });
  assert.deepEqual(timeline.samples, [
    { t: 0, sig: "a" },
    { t: 500, sig: "b" },
  ]);
  assert.deepEqual(timeline.markers, [{ t: 900, id: "timeout", label: MARKER_LABELS.timeout }]);
  assert.equal(timeline.durationMs, 0);
  assert.equal(timeline.sampleMs, DEFAULTS.sample);
});

// ---------------------------------------------------------------------------
// meta.json — read by the edit CLI's header line and by the admin uploader
// ---------------------------------------------------------------------------

test("meta.json carries the run's identity, the shape it was recorded at, and its timing", () => {
  const [run] = expandMatrix({
    agents: ["research"],
    models: ["mistralai/Devstral-Small-2505"],
    prompts: { research: [{ id: "res-sv-elpris", text: "Vad hände med elpriset?", lang: "sv", xp: 3 }] },
  });
  const meta = buildMeta(run, ARGS(["--budget", "60", "--search", "on"]), {
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_000_032_000,
    ok: true,
  });
  assert.deepEqual(meta, {
    slug: run.slug,
    agent: "research",
    mode: "normal",
    model: "mistralai/Devstral-Small-2505",
    prompt: "Vad hände med elpriset?",
    starter: "res-sv-elpris",
    xp: 3,
    lang: "sv",
    // The short human name the deck refers to a capture by, beside its
    // #CAP-<id> number. Derived from the starter id, so it needs no network.
    name: "SV Elpris",
    shape: "portrait",
    viewport: { width: 720, height: 900 },
    base: "https://deepresearch.se",
    // Null in a unit test: parseArgs is pure and leaves this for runBatch,
    // which is the only place allowed to shell out to git.
    commit_sha: null,
    intro: false,
    budget_s: 60,
    search: true,
    started_at: 1_760_000_000_000,
    ended_at: 1_760_000_032_000,
    durationMs: 32_000,
    ok: true,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// The intro switch and the capture's human name
// ---------------------------------------------------------------------------

test("a recording suppresses the intro with ?anim=0 unless --intro asks for it", () => {
  // The default. A clip is about the research run; an intro at the head is
  // seconds of every one of twenty clips spent on the same animation.
  assert.equal(captureUrl({ base: "https://deepresearch.se" }), "https://deepresearch.se/?anim=0");
  assert.equal(captureUrl({ base: "https://deepresearch.se", intro: true }), "https://deepresearch.se");
});

test("?anim=0 is appended without trampling a base that already carries a query", () => {
  assert.equal(captureUrl({ base: "http://127.0.0.1:8788/?x=1" }), "http://127.0.0.1:8788/?x=1&anim=0");
  // An explicit anim= the caller typed wins — including ?anim=1, which is the
  // supported way to record the intro deliberately.
  assert.equal(captureUrl({ base: "https://deepresearch.se/?anim=1" }), "https://deepresearch.se/?anim=1");
});

test("a capture's name is derived from the starter id, not the prompt", () => {
  // The starter id is already a hand-written slug of the subject, so this
  // needs no model call — which is what lets the queue top itself up
  // unattended.
  assert.equal(captureName({ starter: "res-sv-elpris" }), "SV Elpris");
  assert.equal(captureName({ starter: "sch-vitamin-d" }), "Vitamin D");
  assert.equal(captureName({ starter: "int-pipeline" }), "Pipeline");
});

test("a run with no usable starter id still gets a name rather than an empty card", () => {
  assert.equal(captureName({ prompt: "  Why do   electricity prices differ so much ?" }), "Why do electricity prices");
  assert.equal(captureName({}), "Untitled capture");
});

test("the commit is left for runBatch — parseArgs stays pure", () => {
  // parseArgs must not shell out to git: it is unit-tested with an injected
  // clock and environment, and a test that forks a process per call is a test
  // nobody runs.
  assert.equal(ARGS([]).commit, null);
  assert.equal(ARGS(["--commit", "abc123"]).commit, "abc123");
});

test("a failed run still writes meta, with the reason", () => {
  const [run] = expandMatrix({
    agents: ["research"],
    models: ["m"],
    prompts: { research: [{ id: "s1", text: "hello there friend", lang: "en" }] },
  });
  const meta = buildMeta(run, ARGS([]), { startedAt: 10, endedAt: 20, ok: false, error: "no answer within 300s" });
  assert.equal(meta.ok, false);
  assert.equal(meta.error, "no answer within 300s");
  assert.equal(meta.xp, null, "a starter with no #XP writes null rather than dropping the field");
});

// ---------------------------------------------------------------------------
// Browser plumbing that is decidable without a browser
// ---------------------------------------------------------------------------

test("a loopback target needs no credentials; a remote one does", () => {
  assert.ok(isLoopback("http://127.0.0.1:8787"));
  assert.ok(isLoopback("http://localhost:8787/"));
  assert.ok(!isLoopback("https://deepresearch.se"));

  const local = resolveAuth("http://127.0.0.1:8787", {});
  assert.ok(local.headers?.authorization.startsWith("Basic "), "wrangler.dev credentials are not secrets");
  assert.equal(local.local, true);

  const missing = resolveAuth("https://deepresearch.se", {});
  assert.equal(missing.headers, null);
  assert.match(missing.reason || "", /BASIC_AUTH_USER/);

  const remote = resolveAuth("https://deepresearch.se", { BASIC_AUTH_USER: "u", BASIC_AUTH_PASS: "p" });
  assert.equal(remote.headers?.authorization, "Basic " + Buffer.from("u:p").toString("base64"));
});

test("the TLS-1.2 cap and the proxy apply to remote targets only", () => {
  const exists = () => false;
  const proxied = launchOptions({ base: "https://deepresearch.se", env: { HTTPS_PROXY: "http://p:1" }, exists });
  assert.deepEqual(proxied.args, ["--ssl-version-max=tls1.2"]);
  assert.deepEqual(proxied.proxy, { server: "http://p:1" });

  // Routing loopback through an external proxy fails outright.
  const local = launchOptions({ base: "http://127.0.0.1:8787", env: { HTTPS_PROXY: "http://p:1" }, exists });
  assert.deepEqual(local.args, []);
  assert.equal(local.proxy, undefined);

  // The container's pre-installed Chromium is only pinned when it is there —
  // hard-coding the path makes the harness unrunnable on CI.
  assert.equal(launchOptions({ base: "https://x", env: {}, exists }).executablePath, undefined);
  assert.equal(
    launchOptions({ base: "https://x", env: {}, exists: () => true }).executablePath,
    "/opt/pw-browsers/chromium",
  );
  assert.equal(launchOptions({ base: "https://x", env: {}, exists, headed: true }).headless, false);
});

// ---------------------------------------------------------------------------
// The batch summary
// ---------------------------------------------------------------------------

test("the summary names each run's verdict and counts the batch", () => {
  const text = formatSummary([
    { slug: "research__m__s1", agent: "research", model: "m", starter: "s1", ok: true, durationMs: 42_000, error: null },
    { slug: "models__m__s2", agent: "models", model: "m", starter: "s2", ok: false, durationMs: 300_000, error: "no answer within 300s" },
  ]);
  assert.match(text, /✓ research__m__s1/);
  assert.match(text, /✗ models__m__s2/);
  assert.match(text, /no answer within 300s/);
  assert.match(text, /1\/2 captured\./);
  assert.equal(formatSummary([]), "No runs.\n");
});

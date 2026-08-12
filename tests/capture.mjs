#!/usr/bin/env node
// @ts-check
// Video capture: drive the deployed site through real research runs and record
// the browser. The first half of the capture pipeline — this RECORDS,
// `scripts/capture-edit.mjs` EDITS. The run matrix, the shapes and the timeline
// contract are shared with the editor through `scripts/capture-core.mjs`, which
// is the only place any of them is defined. See the **video-capture** skill.
//
//   node tests/capture.mjs --agents research --models mistralai/Devstral-Small-2505
//   node tests/capture.mjs --agents research,introspection --per-agent 2 --lang sv
//   node tests/capture.mjs --agents research --models x --dry-run
//   cd tests && npm run capture -- --agents research
//
// It writes one directory per run under `--out`:
//
//   <out>/<slug>/raw.webm      the recording, exactly as Playwright wrote it
//   <out>/<slug>/timeline.json the activity samples + markers the editor cuts on
//   <out>/<slug>/meta.json     what was run (agent, model, prompt, shape, timing)
//                              AND the run VERDICT — see below
//   <out>/<slug>/endframe.png  the last frame, as a still
//   <out>/<slug>/chatframe.png the transcript, for a run that then walked to an app
//   <out>/batch.json           the whole batch: options + one row per run
//
// THE RUN VERIFICATION GATE (owner directive, 2026-08-12, captures #CAP-21 and
// #CAP-22). Both clips were handed to the owner as good captures. #CAP-21's
// published app answered "401 — You didn't provide an API key" with its key
// field visibly filled; #CAP-22's answered "Error: could not get a response."
// Neither was caught, because nothing in this driver ever looked at what was ON
// SCREEN: a run was "done" when the `.stats` footer landed, and the server
// emits that footer from a `finally` (src/chat.js) — so a turn that ended in a
// red error message is indistinguishable from one that ended in an answer.
//
// So at the END OF EVERY RUN, for every agent, the driver now reads the page's
// final state (the assistant's text, whether the bubble is an error bubble, the
// console, the timeline's last signature), grades it with the pure
// `scripts/capture-guard.mjs`, and writes the verdict into meta.json. A run that
// fails is marked `ok: false` and reported LOUDLY in the batch summary. It is
// NOT aborted and its footage is NOT deleted — same posture as the Agent Studio
// app gate, and as invariant 2: one bad run costs one clip.
//
// FULL VISIBILITY is the point ("make sure you have full visibility and verify
// at least that far before presenting the user with the video"). endframe.png
// plus the answer text in meta.json mean a later reviewer — or a Claude Code
// session — can see that a run went wrong without decoding an mp4.
//
// OPTIONS
//   --agents <csv>      agent ids (default research). Unknown ids are refused.
//   --models <csv>      model ids as they appear in the #model dropdown.
//                       Omitted: the site's own first up model from /api/models.
//   --per-agent <n>     example prompts per agent (default 1)
//   --lang en|sv        restrict the example prompts to one language
//   --offset <n>        walk further down the starter queue (a second batch)
//   --shape portrait|square|landscape|raw   capture viewport (default portrait)
//   --out <dir>         capture root (default captures/<YYYY-MM-DD>)
//   --base <url>        target site (default $BASE_URL or https://deepresearch.se)
//   --budget <seconds>  the research time budget the app is opened with (default 60)
//   --search on|off     the web-search knob (default on)
//   --sample <ms>       activity sampling interval (default 250)
//   --timeout <ms>      per-run ceiling waiting for the turn to finish (default 300000)
//   --limit <n>         stop after n runs (a smoke run)
//   --intro             KEEP the intro animation (default: suppressed with
//                       ?anim=0 — a recording is about the research run)
//   --commit <sha>      override the recorded commit (default: git HEAD)
//   --headed            run headful, to watch it happen
//   --dry-run           print the expanded matrix and exit; no browser
//
// AUTH. The Se/rver app is behind the identity gate, so an unauthenticated `/`
// 302s to the anonymous `/cure` tier and `#form` never appears. The suite's
// break-glass Basic Auth is what makes `/` resolve to the signed-in app:
// BASIC_AUTH_USER / BASIC_AUTH_PASS, or — when the target is loopback — the
// wrangler.dev credentials `tests/playwright.config.js` declares, which are not
// secrets. The header is STRIPPED cross-origin (see stripCrossOriginAuth).
//
// WHY THE TIMELINE IS SAMPLED FROM NODE. A deep-research run is mostly waiting,
// and the editor cuts that wait by comparing consecutive content signatures
// (scripts/capture-core.mjs). An in-page `setInterval` would stop sampling
// exactly when the page stalls — which is the one recording worth watching
// closely — so the loop lives here and reaches in with `page.evaluate`. Every
// tick is caught: a sample lost to a navigation is a missing row, never a dead
// run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { starterName } from "../public/js/captures-core.js";
import {
  CAPTURABLE_AGENTS,
  DEFAULT_SHAPE,
  SHAPES,
  expandMatrix,
  formatDuration,
  resolveShape,
} from "../scripts/capture-core.mjs";
import { formatRunVerdict, gradeRun } from "../scripts/capture-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Where this repo's dev containers pre-install Chromium. Absent on CI. */
export const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

/**
 * The commit the working tree is at, recorded onto every capture so a clip is
 * traceable back to the code that produced it. The deck outlives the code, and
 * six merges later "why does this video not match the app" has no answer
 * without it.
 *
 * Fail-soft to null — no git, a tarball checkout, or a detached worktree must
 * cost a metadata field, never a recording. A null is honest; a guess is not.
 * @returns {string | null}
 */
export function headCommit(ref = "HEAD") {
  try {
    return execFileSync("git", ["rev-parse", ref], { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The commit to STAMP ON A CAPTURE, which is not always the working tree's.
 *
 * A recording is made against whatever the BASE is serving. For a loopback
 * base that is this working tree, so local HEAD is exactly right. For a REMOTE
 * base it is not: local HEAD names a commit the site has very likely never
 * run, and stamping it produces confident wrong provenance — which is worse
 * than none, because it invites someone to check out that commit to explain a
 * clip. The first twenty captures were stamped this way and had to be
 * corrected by hand.
 *
 * `origin/main` is the best available answer for a remote base: this repo
 * deploys main. It is still only a best answer — a branch build also deploys
 * here — which is why `deployedDigest` records what the site ACTUALLY served,
 * so a mismatch is detectable rather than assumed away.
 * @param {string} base
 * @returns {string | null}
 */
export function commitForBase(base) {
  if (isLoopback(base)) return headCommit();
  return headCommit("origin/main") || headCommit();
}

/**
 * A fingerprint of the source the site is ACTUALLY serving: the digest at the
 * head of the committed introspection snapshot, which every deploy rebuilds.
 * Read with a Range request, so it costs 300 bytes rather than 18 MB.
 *
 * Fail-soft to null: provenance is worth a request, never a recording.
 * @param {string} base
 * @param {Record<string, string>} headers
 * @returns {Promise<string | null>}
 */
export async function deployedDigest(base, headers) {
  try {
    const res = await fetch(`${base}/introspect/source-snapshot.json`, {
      headers: { ...headers, Range: "bytes=0-300" },
    });
    if (!res.ok && res.status !== 206) return null;
    const head = await res.text();
    return (head.match(/"digest"\s*:\s*"([0-9a-f]{16,64})"/) || [])[1] || null;
  } catch {
    return null;
  }
}

// Local-mode Basic Auth. Not secrets: the [vars] of wrangler.dev.toml, accepted
// only by a Worker running on this machine. Kept in step with
// tests/playwright.config.js, which is where they are declared.
const LOCAL_USER = "e2e";
const LOCAL_PASS = "e2e-local-worker-no-secret";

export const DEFAULTS = {
  agents: ["research"],
  perAgent: 1,
  offset: 0,
  shape: DEFAULT_SHAPE,
  base: "https://deepresearch.se",
  budget: 60,
  search: true,
  sample: 250,
  timeout: 300_000,
};

/** Flags that take no value. */
export const BOOLEAN_FLAGS = new Set(["dry-run", "headed", "help", "intro"]);

/** Languages the starter registry is written in (invariant 6). */
export const LANGS = ["en", "sv"];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CaptureOptions
 * @property {string[]} agents
 * @property {string[] | null} models   null = resolve the site's own default
 * @property {number} perAgent
 * @property {string | null} lang
 * @property {number} offset
 * @property {string} shape
 * @property {string} out
 * @property {string} base
 * @property {number} budget
 * @property {boolean} search
 * @property {number} sample
 * @property {number} timeout
 * @property {number | null} limit
 * @property {boolean} headed
 * @property {boolean} dryRun
 * @property {boolean} help
 */

/**
 * argv -> fully resolved options. Pure: the clock and the environment are
 * injected, so the default `--out` (which carries today's date) is testable
 * without freezing time globally.
 * @param {string[]} argv
 * @param {{ env?: Record<string, any>, now?: Date }} [ctx]
 * @returns {CaptureOptions}
 */
export function parseArgs(argv, ctx = {}) {
  const env = ctx.env || process.env;
  const now = ctx.now || new Date();
  /** @type {Record<string, any>} */
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] ?? "");
    if (!a.startsWith("--")) continue; // positional args mean nothing here
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS.has(key)) {
      raw[key] = true;
      continue;
    }
    raw[key] = eq === -1 ? argv[++i] : a.slice(eq + 1);
  }

  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const dateDir = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  return {
    agents: csv(raw.agents, DEFAULTS.agents),
    // Distinguish "not asked for" (resolve from /api/models) from "asked for
    // nothing" (an empty --models, which validation refuses).
    models: raw.models == null ? null : csv(raw.models, []),
    perAgent: int(raw["per-agent"], DEFAULTS.perAgent),
    lang: raw.lang == null ? null : String(raw.lang).toLowerCase(),
    offset: int(raw.offset, DEFAULTS.offset),
    shape: String(raw.shape || DEFAULTS.shape),
    out: raw.out ? String(raw.out) : join("captures", dateDir),
    // A trailing slash on the base would put `//api/models` on the wire and
    // move the cookie/strip origin comparisons off by one character.
    base: String(raw.base || env.BASE_URL || DEFAULTS.base).replace(/\/+$/, ""),
    budget: int(raw.budget, DEFAULTS.budget),
    search: onOff(raw.search, DEFAULTS.search),
    sample: int(raw.sample, DEFAULTS.sample),
    timeout: int(raw.timeout, DEFAULTS.timeout),
    limit: raw.limit == null ? null : int(raw.limit, 0),
    headed: raw.headed === true,
    // Intro OFF by default (owner directive): the long list of recorded
    // prompts is recorded without it. --intro opts back in for the one
    // combined cut that wants an intro beat.
    intro: raw.intro === true,
    // Left NULL here on purpose: parseArgs is pure (the clock and the env are
    // injected so it is testable), and resolving this means shelling out to
    // git. runBatch fills it in.
    commit: typeof raw.commit === "string" && raw.commit ? raw.commit : null,
    dryRun: raw["dry-run"] === true,
    help: raw.help === true,
  };
}

/**
 * Everything wrong with a set of options, as sentences an operator can act on.
 * Returned rather than thrown so the CLI can print all of them at once — a
 * typo'd agent AND a typo'd shape should cost one run, not two.
 * @param {CaptureOptions} opts
 * @returns {string[]}
 */
export function validateOptions(opts) {
  const errors = [];
  if (!opts.agents.length) {
    errors.push(`No agents selected. Valid agents: ${CAPTURABLE_AGENTS.join(", ")}.`);
  }
  for (const agent of opts.agents) {
    if (!CAPTURABLE_AGENTS.includes(agent)) {
      errors.push(`Unknown agent “${agent}”. Valid agents: ${CAPTURABLE_AGENTS.join(", ")}.`);
    }
  }
  if (!SHAPES[opts.shape]) {
    errors.push(`Unknown shape “${opts.shape}”. Valid shapes: ${Object.keys(SHAPES).join(", ")}.`);
  }
  if (opts.lang && !LANGS.includes(opts.lang)) {
    errors.push(`Unknown language “${opts.lang}”. Valid languages: ${LANGS.join(", ")}.`);
  }
  if (opts.models && !opts.models.length) {
    errors.push("--models was given with no model ids. Drop the flag to use the site's default model.");
  }
  if (opts.perAgent < 1) errors.push("--per-agent must be at least 1.");
  if (opts.limit != null && opts.limit < 1) errors.push("--limit must be at least 1.");
  // Below ~50 ms the evaluate round-trip dominates and the sampler just queues
  // behind itself; the editor's resolution is bounded by this number anyway.
  if (opts.sample < 50) errors.push("--sample must be at least 50 ms.");
  if (opts.timeout < 1000) errors.push("--timeout must be at least 1000 ms.");
  return errors;
}

/** @param {any} v @param {string[]} fallback */
function csv(v, fallback) {
  if (v == null) return fallback.slice();
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {any} v @param {number} fallback */
function int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** @param {any} v @param {boolean} fallback */
function onOff(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase();
  if (["on", "true", "1", "yes"].includes(s)) return true;
  if (["off", "false", "0", "no"].includes(s)) return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// The content signature
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SampleParts   the raw numbers read out of the page
 * @property {number} msgs         `.msg` elements (a turn appeared)
 * @property {number} steps        `.step` elements (a pipeline phase started)
 * @property {number} finished     `.step.finished` (a phase completed)
 * @property {number} answerLen    trimmed length of the last assistant answer
 * @property {string} step         the last step's label text
 * @property {boolean} stats       the turn's `.stats` footer carries text
 */

/**
 * One short string that changes when — and only when — something VISIBLE
 * changed. This is the whole basis of the edit: the editor treats a run of
 * identical signatures as provably dead time and cuts it, so anything left out
 * of the signature becomes motion the edit will happily delete, and anything
 * spurious put IN (a clock, a scroll offset, a spinner frame) defeats dead-time
 * detection completely and the clip stays as long as the run.
 *
 * Pure by design: the page half only reads numbers, the composition happens
 * here, and the format is pinned by a unit test rather than by whatever the DOM
 * did that afternoon.
 * @param {Partial<SampleParts>} [parts]
 * @returns {string}
 */
export function contentSignature(parts = {}) {
  return [
    n0(parts.msgs),
    n0(parts.steps),
    n0(parts.finished),
    n0(parts.answerLen),
    // `|` is the field separator and whitespace churns as a label re-renders,
    // so both are normalised out; the label is a phase name, not prose, so 60
    // characters is more than enough to tell two phases apart.
    String(parts.step ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 60),
    parts.stats ? 1 : 0,
  ].join("|");
}

/** @param {any} v */
function n0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * The page half of the sampler, serialized into the browser on every tick.
 *
 * `.content` rather than the whole `.msg.assistant`: the activity steps and the
 * stats footer live in the same element and are already represented by their
 * own fields, so counting their text into the answer length would make the
 * signature move for reasons the editor has already accounted for.
 * @returns {SampleParts}
 */
/* c8 ignore start — runs in the browser, not in Node */
function readPage() {
  const steps = document.querySelectorAll(".step");
  const assistants = document.querySelectorAll(".msg.assistant");
  const last = assistants[assistants.length - 1] || null;
  const body = last ? last.querySelector(".content") : null;
  const statsEl = last ? last.querySelector(".stats") : null;
  const lastStep = steps[steps.length - 1] || null;
  const label = lastStep ? lastStep.querySelector("summary") || lastStep : null;
  return {
    msgs: document.querySelectorAll(".msg").length,
    steps: steps.length,
    finished: document.querySelectorAll(".step.finished").length,
    answerLen: ((body || last)?.textContent || "").trim().length,
    step: (label?.textContent || "").trim(),
    stats: !!(statsEl?.textContent || "").trim(),
  };
}
/**
 * THE END STATE — everything the guard needs to decide whether this recording
 * captured the product working. Read once, at the end of the run.
 *
 * Deliberately more than the sampler reads. `readPage` exists to detect CHANGE
 * (its answer field is a length, because a length is all a cut needs); this
 * exists to detect FAILURE, so it carries the actual words, and — the part that
 * was missing entirely — whether the product itself has flagged the turn as an
 * error. `setError` puts `error-text` on the bubble (public/js/turns.js) for
 * every error a turn can hit, server- and client-side, so that class is the one
 * structural signal that holds for wording nobody has seen yet.
 * @returns {{ answerText: string, errorElement: boolean, errorText: string,
 *             statsPresent: boolean, statsText: string, msgs: number,
 *             steps: number, finishedSteps: number, title: string, url: string }}
 */
/* c8 ignore start — runs in the browser, not in Node */
function readFinalState() {
  const assistants = document.querySelectorAll(".msg.assistant");
  const last = assistants[assistants.length - 1] || null;
  const body = last ? last.querySelector(".content") : null;
  const statsEl = last ? last.querySelector(".stats") : null;
  const errorNodes = Array.prototype.slice.call(document.querySelectorAll(".msg.assistant .content.error-text"));
  return {
    answerText: ((body || last)?.textContent || "").trim().slice(0, 8000),
    errorElement: errorNodes.length > 0,
    errorText: errorNodes
      .map((e) => (e.textContent || "").trim())
      .join(" | ")
      .slice(0, 2000),
    statsPresent: !!(statsEl?.textContent || "").trim(),
    statsText: (statsEl?.textContent || "").trim().slice(0, 300),
    msgs: document.querySelectorAll(".msg").length,
    steps: document.querySelectorAll(".step").length,
    finishedSteps: document.querySelectorAll(".step.finished").length,
    title: String(document.title || "").slice(0, 200),
    url: String(location.href),
  };
}
/* c8 ignore stop */

/**
 * The end state, or an empty one. NEVER THROWS: a page that died still has to
 * produce a verdict, and "nothing could be read" is itself the strongest
 * possible failure — which is what the guard makes of an empty record.
 * @param {any} page
 */
async function sampleFinalState(page) {
  try {
    const s = await page?.evaluate(readFinalState);
    if (s && typeof s === "object") return s;
  } catch {
    /* a closed page, a navigation in flight — fall through */
  }
  return {
    answerText: "",
    errorElement: false,
    errorText: "",
    statsPresent: false,
    statsText: "",
    msgs: 0,
    steps: 0,
    finishedSteps: 0,
    title: "",
    url: "",
  };
}

/**
 * A still of whatever is on screen right now. Fail-soft to `false`: a
 * screenshot is evidence, never a reason to lose a recording.
 * @param {any} page
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function snapshot(page, path) {
  try {
    await page?.screenshot({ path, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Output paths, timeline and meta — the contract scripts/capture-edit.mjs reads
// ---------------------------------------------------------------------------

/**
 * Where one run's four files live. `raw.webm` is the name the editor looks for
 * (`isCaptureDir`), so it is not a preference.
 * @param {string} outRoot
 * @param {string} slug
 */
export function runPaths(outRoot, slug) {
  const dir = join(outRoot, slug);
  return {
    dir,
    video: join(dir, "raw.webm"),
    timeline: join(dir, "timeline.json"),
    meta: join(dir, "meta.json"),
    // The last frame as a still. The owner's ask after #CAP-21/#CAP-22: "could
    // you also have a look at the last frame of the video? That would tell you
    // it went wrong." A PNG beside the webm is what makes that possible without
    // an encoder, in a terminal, or from a later session reading the directory.
    endframe: join(dir, "endframe.png"),
    // For a run that walks away from the transcript (Agent Studio goes to the
    // published app), the transcript's own last frame — otherwise it is only
    // recoverable by scrubbing the video.
    chatframe: join(dir, "chatframe.png"),
    // Playwright names the video file itself, so it is recorded into a scratch
    // directory and moved afterwards.
    videoTmp: join(dir, "_video"),
  };
}

/** Human labels for the markers, used as chapter titles by the editor. */
export const MARKER_LABELS = {
  app_open: "opened the built app",
  app_done: "finished using the built app",
  open: "app opened",
  send: "prompt sent",
  first_token: "first token",
  done: "answer complete",
  timeout: "run timed out",
  error: "run failed",
};

/**
 * Samples + markers -> the exact `timeline.json` shape the editor reads.
 * Defensive about its inputs because a sampler tick that half-failed must not
 * be able to produce a file `planEdit` chokes on: non-finite offsets and
 * signature-less rows are dropped, and everything is sorted by time.
 * @param {{ samples?: Array<{t:number, sig:string}>, markers?: Array<{t:number, id:string, label?:string}>,
 *           durationMs?: number, sampleMs?: number }} input
 */
export function buildTimeline(input = {}) {
  const samples = (input.samples || [])
    .filter((s) => s && Number.isFinite(s.t) && typeof s.sig === "string")
    .map((s) => ({ t: Math.max(0, Math.round(s.t)), sig: s.sig }))
    .sort((a, b) => a.t - b.t);
  const markers = (input.markers || [])
    .filter((m) => m && m.id && Number.isFinite(m.t))
    .map((m) => ({
      t: Math.max(0, Math.round(m.t)),
      id: String(m.id),
      label: m.label || MARKER_LABELS[/** @type {keyof typeof MARKER_LABELS} */ (m.id)] || String(m.id),
    }))
    .sort((a, b) => a.t - b.t);
  return {
    durationMs: Math.max(0, Math.round(Number(input.durationMs) || 0)),
    sampleMs: Math.max(1, Math.round(Number(input.sampleMs) || DEFAULTS.sample)),
    samples,
    markers,
  };
}

/**
 * The URL a capture opens.
 *
 * `?anim=0` is the documented off-switch for the intro phase — the inverse of
 * the `?anim=1` that forces it on (docs/INTRO-BASELINE.md §3). A recording is
 * about the research run, so the intro is suppressed unless `--intro` asks for
 * it (which is how the one combined LinkedIn cut that DOES want an intro gets
 * recorded).
 *
 * Built by hand rather than with `new URL(...).searchParams` so a base that
 * already carries a query keeps it verbatim: these bases are typed by hand on
 * the command line and a silently re-encoded one is a confusing way to lose a
 * run.
 * @param {{ base: string, intro?: boolean }} opts
 * @returns {string}
 */
export function captureUrl(opts) {
  const base = String(opts.base || "");
  if (opts.intro) return base;
  if (/[?&]anim=/.test(base)) return base; // an explicit anim= wins
  if (base.includes("?")) return base + "&anim=0";
  // A bare origin needs its path back before a query: "https://host?x" is legal
  // but "https://host/?x" is what every other URL in this repo looks like, and
  // the difference shows up in logs and in the cookie/origin comparisons.
  return base + (/^https?:\/\/[^/]+$/.test(base) ? "/" : "") + "?anim=0";
}

/**
 * The short, human, few-word name a capture is referred to by, next to its
 * `#CAP-<id>` number ("produce a review of #12, the electricity one").
 *
 * Derived from the STARTER ID rather than the prompt: the id is already a
 * hand-written slug of what the prompt is about (`res-sv-elpris` → "Elpris",
 * `sch-vitamin-d` → "Vitamin D"), so stripping the prefix and title-casing gives a
 * usable name with no model call, no network, and no per-prompt maintenance —
 * which matters because the queue tops itself up unattended. It is a DEFAULT:
 * `scripts/captures --name <id> "…"` improves any one of them by hand.
 * @param {{ agent?: string, starter?: string, prompt?: string }} run
 * @returns {string}
 */
export function captureName(run) {
  const derived = starterName(run?.starter);
  if (derived) return derived;
  // No usable starter id (a hand-driven run): fall back to the prompt's first
  // few words, which is worse but never empty — an unnamed card in a deck of
  // twenty is the one nobody can refer to.
  const fromPrompt = String(run?.prompt || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return fromPrompt || "Untitled capture";
}

/**
 * The `meta.json` shape — read by the editor (for the header line and the
 * default shape) and by the admin uploader.
 * @param {import("../scripts/capture-core.mjs").CaptureRun} run
 * @param {CaptureOptions} opts
 * @param {{ startedAt: number, endedAt: number, ok: boolean, error?: string | null }} timing
 */
export function buildMeta(run, opts, timing) {
  const shape = resolveShape(opts.shape);
  return {
    slug: run.slug,
    agent: run.agent,
    mode: run.mode,
    model: run.model,
    prompt: run.prompt,
    starter: run.starter,
    xp: run.xp == null ? null : run.xp,
    lang: run.lang,
    name: captureName(run),
    shape: shape.id,
    viewport: { ...shape.viewport },
    base: opts.base,
    // The COMMIT the site was serving when this was recorded. Without it a
    // clip is un-reproducible: the deck outlives the code, and "why does the
    // video not match the app" has no answer six merges later. Resolved once
    // per batch (see `headCommit`) and null when git is unavailable, which is
    // honest rather than a guess.
    commit_sha: opts.commit || null,
    deployed_digest: opts.deployedDigest || null,
    intro: !!opts.intro,
    budget_s: opts.budget,
    search: !!opts.search,
    started_at: timing.startedAt,
    ended_at: timing.endedAt,
    durationMs: Math.max(0, timing.endedAt - timing.startedAt),
    ok: !!timing.ok,
    error: timing.error || null,
    // The Agent Studio verdict, when there was one: what the built app scored
    // when the capture walked to it and used it. Null for every other agent.
    // The publish step reads `app_e2e.pass` and skips a capture that failed —
    // a clip of a build that does not work is worse than no clip.
    app_e2e: timing.appE2E || null,
    // THE RUN VERDICT and the end state it was reached from — the whole of
    // "full visibility" (owner directive, 2026-08-12). Present on every real
    // recording; omitted when the caller observed nothing, which is only ever a
    // unit test constructing a meta by hand.
    ...(timing.verdict ? { verdict: timing.verdict } : {}),
    ...(timing.observed ? { observed: timing.observed } : {}),
    ...(timing.frames ? { frames: timing.frames } : {}),
  };
}

/**
 * The end state, cut down to what belongs in a metadata file: enough to see
 * WHAT WENT WRONG without opening the video, not enough to make meta.json a
 * transcript dump.
 *
 * Head AND tail of the answer, because `setError` APPENDS its message to
 * whatever had streamed (public/js/turns.js: `turn.text + "\n\n[" + message +
 * "]"`). A head-only excerpt is exactly the excerpt that cannot show the error.
 * @param {any} state
 * @param {any} [extra]
 */
export function summariseObserved(state, extra = {}) {
  const s = state && typeof state === "object" ? state : {};
  const answer = String(s.answerText ?? "").replace(/\s+/g, " ").trim();
  return {
    answer_chars: answer.length,
    answer_head: answer.slice(0, 400),
    answer_tail: answer.length > 700 ? answer.slice(-300) : "",
    error_element: s.errorElement === true,
    error_text: String(s.errorText ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    stats_present: s.statsPresent === true,
    stats_text: String(s.statsText ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    msgs: Number(s.msgs) || 0,
    steps: Number(s.steps) || 0,
    finished_steps: Number(s.finishedSteps) || 0,
    final_url: String(s.url ?? "").slice(0, 300),
    ...extra,
  };
}

/**
 * The batch summary, as a table an operator reads in the terminal.
 *
 * A failed run is then spelled out AGAIN underneath, verdict by verdict. That
 * repetition is deliberate: #CAP-21 and #CAP-22 were handed to the owner as
 * good captures, and a one-line row in a table of twenty is how a bad run gets
 * scrolled past. The block at the bottom says which clips must not be
 * presented, and why, in words.
 * @param {Array<{ slug: string, agent: string, model: string, starter: string, ok: boolean, durationMs: number, error: string | null, verdict?: any }>} rows
 * @returns {string}
 */
export function formatSummary(rows) {
  if (!rows.length) return "No runs.\n";
  const width = Math.min(64, Math.max(...rows.map((r) => r.slug.length)));
  const lines = rows.map(
    (r) =>
      `  ${r.ok ? "✓" : "✗"} ${r.slug.padEnd(width)}  ${formatDuration(r.durationMs).padStart(7)}` +
      (r.error ? `  ${r.error}` : ""),
  );
  const ok = rows.filter((r) => r.ok).length;
  const out = [...lines, "", `${ok}/${rows.length} captured.`];

  const failed = rows.filter((r) => !r.ok);
  if (failed.length) {
    out.push("", `${failed.length} run${failed.length === 1 ? "" : "s"} FAILED VERIFICATION — do not present ${failed.length === 1 ? "it" : "them"} as a good capture:`);
    for (const r of failed) {
      const reasons = Array.isArray(r.verdict?.reasons) ? r.verdict.reasons : [];
      out.push(`  ✗ ${r.slug}`);
      if (!reasons.length && r.error) out.push(`      ${r.error}`);
      for (const reason of reasons) out.push(`      ${reason?.id ?? "?"}: ${reason?.detail ?? ""}`);
      out.push(`      the last frame is beside the recording: ${join(r.slug, "endframe.png")}`);
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Browser plumbing
// ---------------------------------------------------------------------------

/** Same test as tests/playwright.config.js: a loopback target is the dev Worker. */
/** @param {string} base */
export function isLoopback(base) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(String(base || ""));
}

/**
 * The break-glass Authorization header, or a reason there isn't one.
 *
 * Loopback needs no configuration: the dev Worker's credentials are published
 * in wrangler.dev.toml, and requiring env vars there is what stopped anyone
 * running the e2e suite for free (docs/TESTING-GAP-ANALYSIS.md, gap A4).
 * @param {string} base
 * @param {Record<string, any>} [env]
 * @returns {{ local: boolean, headers: Record<string, string> | null, reason?: string }}
 */
export function resolveAuth(base, env = process.env) {
  const local = isLoopback(base);
  const user = local ? LOCAL_USER : env.BASIC_AUTH_USER;
  const pass = local ? LOCAL_PASS : env.BASIC_AUTH_PASS;
  if (!user || !pass) {
    return {
      local,
      headers: null,
      reason:
        `${base} needs break-glass credentials: set BASIC_AUTH_USER / BASIC_AUTH_PASS, ` +
        "or point --base at a local Worker (http://127.0.0.1:8787).",
    };
  }
  return { local, headers: { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } };
}

/**
 * Chromium launch options, matching tests/playwright.config.js.
 *
 * The container pre-installs Chromium at a fixed path and sets
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so Playwright's own resolution finds
 * nothing — but hard-coding that path makes the harness unrunnable anywhere
 * else, hence the existence check. Outbound HTTPS here goes through an agent
 * proxy that re-signs TLS and resets Chromium's TLS 1.3 ClientHello, so the
 * browser leg is capped at 1.2; none of that applies to loopback, where routing
 * through an external proxy would fail outright.
 * @param {{ base: string, env?: Record<string, any>, headed?: boolean, exists?: (p: string) => boolean }} o
 */
export function launchOptions(o) {
  const env = o.env || process.env;
  const exists = o.exists || existsSync;
  const proxied = !isLoopback(o.base) && !!env.HTTPS_PROXY;
  return {
    headless: !o.headed,
    ...(exists(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {}),
    args: proxied ? ["--ssl-version-max=tls1.2"] : [],
    ...(proxied ? { proxy: { server: String(env.HTTPS_PROXY) } } : {}),
  };
}

/**
 * Strip the break-glass `Authorization` header from CROSS-ORIGIN requests.
 *
 * Ported from tests/e2e/helpers.js rather than imported, because that module
 * pulls in `@playwright/test` at the top level and this file must stay
 * importable — for its unit tests — on a checkout with no tests/node_modules.
 *
 * It is not optional. Playwright attaches `extraHTTPHeaders` to EVERY request
 * the context makes, third-party ones included: it hands the admin password to
 * other hosts, and it breaks the sandbox outright (the CheerpX runtime is a
 * cross-origin dynamic import, which fails with an `authorization` header on
 * it, so the VM dies at "loading CheerpX…" every time). A capture of that is a
 * capture of the fail-soft fallback, silently.
 * @param {any} context
 * @param {string} base
 */
export async function stripCrossOriginAuth(context, base) {
  const siteOrigin = new URL(base).origin;
  await context.route(
    (/** @type {string} */ url) => {
      try {
        return new URL(url).origin !== siteOrigin;
      } catch {
        return false;
      }
    },
    async (/** @type {any} */ route) => {
      const headers = { ...route.request().headers() };
      delete headers.authorization;
      delete headers.Authorization;
      await route.continue({ headers });
    },
  );
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a predicate from NODE until it holds or the deadline passes. Node-side
 * on purpose: the same reason the sampler is (a wedged page must not be able to
 * stop the clock), and it means the "done" signal is read off the samples the
 * timeline already carries instead of a second in-page watcher.
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @param {number} [stepMs]
 */
async function waitUntil(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/**
 * Record one CaptureRun. Never throws: a failure becomes `{ ok: false, error }`
 * with whatever video and timeline were produced still on disk, because a
 * stalled run is exactly the recording worth looking at (invariant 2 — a
 * helper phase degrades, it does not break the request).
 * @param {any} browser
 * @param {import("../scripts/capture-core.mjs").CaptureRun} run
 * @param {CaptureOptions} opts
 * @param {{ headers: Record<string, string>, ignoreHTTPSErrors: boolean }} net
 */
export async function captureRun(browser, run, opts, net) {
  const shape = resolveShape(opts.shape);
  const paths = runPaths(resolve(ROOT, opts.out), run.slug);
  mkdirSync(paths.videoTmp, { recursive: true });

  /** @type {Array<{t:number, sig:string}>} */
  const samples = [];
  /** @type {Array<{t:number, id:string}>} */
  const markers = [];
  const state = { armed: false, firstToken: false, done: false };

  const startedAt = Date.now();
  let t0 = startedAt;
  /** @type {string | null} */
  let error = null;
  let context = null;
  let page = null;
  let stopSampler = () => {};
  /** @type {any} */
  let appE2E = null;
  /** The transcript's end state, read BEFORE any walk away from the chat. */
  /** @type {any} */
  let chatState = null;
  /** Console/page errors the CHAT threw, for the guard. */
  /** @type {string[]} */
  const consoleErrors = [];
  const frames = { endframe: false, chatframe: false };

  const mark = (/** @type {string} */ id) => markers.push({ t: Date.now() - t0, id });

  try {
    context = await browser.newContext({
      viewport: shape.viewport,
      // Recording the CSS viewport 1:1 keeps the type as large relative to the
      // frame as the site laid it out; the editor upscales to the delivery
      // frame afterwards (capture-core.mjs, "why the capture viewport is
      // smaller than the output").
      recordVideo: { dir: paths.videoTmp, size: shape.viewport },
      extraHTTPHeaders: net.headers,
      ignoreHTTPSErrors: net.ignoreHTTPSErrors,
      // NO INTRO in a recording (owner directive, 2026-08-11). A capture is
      // about the RESEARCH RUN; an intro animation at the head is seconds of
      // every clip spent on something the viewer did not come for, and it is
      // identical across all twenty.
      //
      // Belt AND braces, because these are two independent mechanisms and the
      // recording is expensive to redo:
      //   - `reducedMotion: "reduce"` is one of the three suppression gates
      //     docs/INTRO-BASELINE.md §3 already documents for all three intro
      //     tiers, and it works on any deploy including ones that predate the
      //     parameter below.
      //   - `?anim=0` (added to the URL in `captureUrl`) is the explicit,
      //     documented switch the owner asked for, and unlike the media query
      //     it says what it means.
      reducedMotion: opts.intro ? "no-preference" : "reduce",
    });
    await stripCrossOriginAuth(context, opts.base);
    await context.addCookies([{ name: "dr_privacy_ack", value: "1", url: opts.base }]);
    // The same three keys openApp pins, so the app opens in a known state
    // rather than in whatever the last session on this profile left behind.
    // `dr_chat_mode` is what puts the composer into this run's agent.
    await context.addInitScript(
      ([ws, budget, mode]) => {
        localStorage.setItem("web_search", ws);
        localStorage.setItem("budget_s", budget);
        localStorage.setItem("dr_chat_mode", mode);
      },
      [opts.search ? "on" : "off", String(opts.budget), run.mode],
    );

    page = await context.newPage();
    // Recording starts with the page, so this is frame zero for every offset
    // written into timeline.json.
    t0 = Date.now();
    // A dialog left unanswered blocks the page forever and the capture records
    // a frozen screen for the whole timeout.
    page.on("dialog", (/** @type {any} */ d) => d.accept().catch(() => {}));
    // What the page threw, for the guard to judge. Bounded, because a page
    // stuck in an error loop can produce thousands and none of them says
    // anything the first twenty did not.
    page.on("console", (/** @type {any} */ m) => {
      try {
        if (String(m.type?.() || "") === "error" && consoleErrors.length < 40) {
          consoleErrors.push(String(m.text?.() || "").slice(0, 300));
        }
      } catch {
        /* a message that would not read is not worth a failed run */
      }
    });
    page.on("pageerror", (/** @type {any} */ e) => {
      if (consoleErrors.length < 40) {
        consoleErrors.push(String(e instanceof Error ? `${e.name}: ${e.message}` : e).slice(0, 300));
      }
    });

    await page.goto(captureUrl(opts), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#form", { state: "visible", timeout: 60_000 });

    // The chat mode is read in TWO places — the `dr_chat_mode` cache pinned
    // above (first paint and the send path) and the server's `chat_mode`,
    // which app.js adopts once /api/settings resolves. e2e pins the second by
    // patching the response; a capture must show the REAL control instead, so
    // it drives `#modesel` itself once the app has settled. Mode before model:
    // several modes narrow the model list, so selecting a model first can have
    // it replaced out from under the run.
    await selectMode(page, run.mode);

    // The model select is `hidden` in some modes, so wait for ATTACHED and
    // force the selection past the actionability check — an agent whose
    // dropdown is not on screen still runs on the model it is told to.
    await page.waitForSelector("#model", { state: "attached", timeout: 30_000 });
    // WAIT for the option, don't just read the list: the dropdown is filled
    // asynchronously from /api/models, so an immediate read finds an empty
    // <select> and every run fails on a model that is perfectly present.
    const present = await page
      .waitForFunction(
        (/** @type {string} */ id) =>
          Array.from(document.querySelectorAll("#model option")).some(
            (o) => /** @type {HTMLOptionElement} */ (o).value === id,
          ),
        run.model,
        { timeout: 30_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!present) {
      const options = await page.$$eval("#model option", (/** @type {any[]} */ els) => els.map((e) => e.value));
      throw new Error(
        `model “${run.model}” is not in the #model dropdown (${options.length} options; e.g. ${options.slice(0, 3).join(", ") || "none"})`,
      );
    }
    await page.selectOption("#model", run.model, { force: true, timeout: 15_000 });

    stopSampler = startSampler(page, { sampleMs: opts.sample, samples, markers, state, t0 });
    mark("open");

    await page.fill("#input", run.prompt);
    await page.click("#send");
    state.armed = true;
    mark("send");

    // The turn is complete when the `done` stats land in the footer — the same
    // signal helpers.js waitForDone uses, here read off the sampler.
    const finished = await waitUntil(() => state.done, opts.timeout);
    mark(finished ? "done" : "timeout");
    if (!finished) error = `no answer within ${Math.round(opts.timeout / 1000)}s`;

    // Let the last paint settle so the final frame is not mid-render — a clip
    // that ends on a half-drawn answer reads as a crash.
    await sleep(1500);

    // READ THE TRANSCRIPT'S END STATE, before anything walks away from it.
    // This is the observation that did not exist when #CAP-21 and #CAP-22 were
    // presented as good captures: `state.done` only ever meant "the stats
    // footer landed", and the server emits that footer after an error too.
    chatState = await sampleFinalState(page);

    // AGENT STUDIO: a build is only worth showing if the thing it built works.
    // So the capture does not stop at the transcript — it walks to the
    // published app and uses it, ON CAMERA, and the verdict decides whether
    // this clip is published at all (owner directive, 2026-08-11).
    if (finished && run.mode === "sdk") {
      // The app walk navigates THIS page, so the transcript's own last frame is
      // otherwise only recoverable by scrubbing the video.
      frames.chatframe = await snapshot(page, paths.chatframe);
      appE2E = await checkBuiltApp(page, opts, mark);
      if (appE2E && !appE2E.pass) {
        error = `the built app failed its end-to-end test: ${appE2E.failures.join("; ")}`;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    mark("error");
  } finally {
    stopSampler();
    // THE LAST FRAME, always — including on the error path, which is the path
    // whose last frame is worth the most. Taken before the context is closed,
    // because the page is gone after that.
    frames.endframe = await snapshot(page, paths.endframe);
    // If the run never got as far as reading the transcript (it threw during
    // setup, or timed out inside the walk), read whatever is there now. An
    // empty record is itself a failing verdict, which is the right answer.
    if (!chatState) chatState = await sampleFinalState(page);
    const video = page?.video?.() || null;
    // ALWAYS close: Playwright only flushes the video file on context close, so
    // an early return here is a lost recording.
    try {
      await context?.close();
    } catch {
      /* already gone */
    }
    await saveVideo(video, paths);
  }

  const endedAt = Date.now();
  const durationMs = Math.max(0, endedAt - t0);
  const timeline = buildTimeline({ samples, markers, durationMs, sampleMs: opts.sample });
  writeFileSync(paths.timeline, JSON.stringify(timeline, null, 2));

  // THE GATE. Every agent, every run — not just Agent Studio, and not just when
  // something already went wrong. `error` at this point is what the driver knew
  // (a timeout, a thrown step, a failed app); the guard adds what was ON SCREEN.
  const verdict = gradeRun({
    agent: run.agent,
    mode: run.mode,
    answerText: chatState?.answerText || "",
    errorElement: chatState?.errorElement === true,
    errorText: chatState?.errorText || "",
    statsPresent: chatState?.statsPresent === true,
    steps: chatState?.steps || 0,
    finishedSteps: chatState?.finishedSteps || 0,
    consoleErrors,
    lastSignature: timeline.samples.length ? timeline.samples[timeline.samples.length - 1].sig : null,
    timedOut: /^no answer within /.test(String(error || "")),
    driverError: error,
    appE2E,
    // What the BUILT APP said on its own screen. `app_answered` (check seven)
    // already grades this, but the guard names it in the run's own verdict so
    // meta.json says in one place what a reviewer would have seen.
    appText: appE2E?.appText || "",
  });
  // A run that fails verification is NOT a good capture, whatever the driver
  // thought. It is still written to disk, verdict and all — collect and report
  // (invariant 2): one bad run costs one clip, never the batch.
  if (!verdict.ok && !error) error = `failed run verification: ${verdict.summary}`;

  const meta = buildMeta(run, opts, {
    startedAt,
    endedAt,
    ok: verdict.ok && !error,
    error,
    appE2E,
    verdict,
    observed: summariseObserved(chatState, {
      console_errors: consoleErrors.slice(0, 10),
      app_text_head: String(appE2E?.appText || "").replace(/\s+/g, " ").trim().slice(0, 400),
    }),
    frames: {
      endframe: frames.endframe ? "endframe.png" : null,
      chatframe: frames.chatframe ? "chatframe.png" : null,
    },
  });
  writeFileSync(paths.meta, JSON.stringify(meta, null, 2));

  return {
    slug: run.slug,
    agent: run.agent,
    model: run.model,
    starter: run.starter,
    ok: verdict.ok && !error,
    durationMs,
    error,
    appE2E,
    verdict,
  };
}

/**
 * The published app's URL, from the SDK build chip's href.
 *
 * Pure so the "did this build actually publish anything" decision is testable
 * without a browser. Returns null for the chip's empty/`#` resting state,
 * which is how "the build never finished" is told apart from "it finished and
 * the app is broken" — two different verdicts.
 * @param {string | null | undefined} href
 * @param {string} base
 * @returns {string | null}
 */
export function publishedAppUrl(href, base) {
  const raw = typeof href === "string" ? href.trim() : "";
  if (!raw || raw === "#") return null;
  const m = raw.match(/\/app\/([a-z0-9][a-z0-9-]*)\/?$/i);
  if (!m) return null;
  return `${String(base).replace(/\/+$/, "")}/app/${m[1]}/`;
}

/**
 * AGENT STUDIO's second half: walk to the app the build just published and USE
 * it, while the recording is still running.
 *
 * Two things at once, both owner directives (2026-08-11). The clip gains the
 * only part that proves the build was real — the app being used — and the run
 * gains a VERDICT, because "only keep those videos that also pass an
 * end-to-end test of the generated app" needs something to pass.
 *
 * Fail-soft in one direction only: anything that stops the check from running
 * (no chip, no slug, a module that would not load) is reported as a failure
 * rather than swallowed, because silently publishing an unchecked build is the
 * outcome this exists to prevent. What it must never do is throw — that would
 * cost the recording as well as the verdict.
 * @param {any} page
 * @param {CaptureOptions} opts
 * @param {(id: string) => void} mark
 * @returns {Promise<any | null>}
 */
async function checkBuiltApp(page, opts, mark) {
  const fail = (/** @type {string} */ reason) => ({ pass: false, url: null, checks: [], failures: [reason] });
  let href = null;
  try {
    // The chip is populated when the build publishes; give it a moment, since
    // the publish lands just after the stats do.
    await page.waitForFunction(
      () => {
        const a = document.getElementById("sdkbuildlink");
        return !!(a && !a.hidden && a.getAttribute("href") && a.getAttribute("href") !== "#");
      },
      { timeout: 20_000 },
    );
    href = await page.getAttribute("#sdkbuildlink", "href");
  } catch {
    return fail("the build published no app (the /app/ link never appeared)");
  }
  const url = publishedAppUrl(href, opts.base);
  if (!url) return fail(`the build chip's link is not an /app/ URL (${href})`);

  mark("app_open");
  try {
    const { exerciseApp, gradeApp } = await import("./app-e2e.mjs");
    const observations = await exerciseApp(page, url, { timeout: 45_000 });
    const graded = gradeApp(observations);
    mark("app_done");
    return {
      ...graded,
      url,
      slug: url.replace(/\/$/, "").split("/").pop(),
      // What the app WROTE when it was used. #CAP-22's said "Error: could not
      // get a response." and the verdict said pass — so the words themselves go
      // into meta.json, where a reviewer can read them.
      appText: String(observations?.reply?.added || observations?.reply?.text || "").slice(0, 1000),
    };
  } catch (e) {
    mark("app_done");
    return fail(`the end-to-end check could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Put the composer into a chat mode through its own dropdown.
 *
 * A mode this deployment does not offer is a HARD failure for the run: a batch
 * that silently recorded the wrong agent is worse than one that recorded
 * nothing, and the difference is invisible in the finished clip.
 * @param {any} page
 * @param {string} mode
 */
async function selectMode(page, mode) {
  await page.waitForSelector("#modesel", { state: "attached", timeout: 30_000 });
  const options = await page.$$eval("#modesel option", (/** @type {any[]} */ els) => els.map((e) => e.value));
  if (!options.includes(mode)) {
    throw new Error(`chat mode “${mode}” is not offered by this deployment (has: ${options.join(", ") || "none"})`);
  }
  const current = await page.$eval("#modesel", (/** @type {any} */ el) => el.value);
  // Already there (the localStorage pin took): selecting again would fire a
  // change event and replay the mode's entry animation mid-recording.
  if (current !== mode) {
    await page.selectOption("#modesel", mode, { force: true, timeout: 15_000 });
    // The mode swap re-themes the composer and can rebuild the model list.
    await sleep(500);
  }

  // AND THEN HOLD IT. The mode is read in two places, and the second one
  // arrives late: app.js adopts the server's `chat_mode` from /api/settings
  // whenever that resolves, which can be seconds after the dropdown was set.
  // The early return above made this worse rather than better — the
  // `dr_chat_mode` pin means the dropdown ALREADY reads the wanted mode, so
  // selectMode returned satisfied, and then settings landed and knocked it
  // back to `normal`.
  //
  // That is not a cosmetic race. It silently records THE WRONG AGENT: an
  // Agent Studio capture that reverted to Deep Research answers by printing
  // code as prose and never builds anything, and the clip looks fine unless
  // you read the composer. Observed on 2026-08-11, twice in one batch.
  //
  // So: watch the value for a window, re-apply if it drifts, and fail the run
  // if it will not hold — the same posture as an unavailable mode, for the
  // same reason.
  const deadline = Date.now() + 8_000;
  let reapplied = 0;
  for (;;) {
    await sleep(500);
    const now = await page.$eval("#modesel", (/** @type {any} */ el) => el.value).catch(() => null);
    if (now !== mode) {
      if (++reapplied > 3) {
        throw new Error(`chat mode “${mode}” will not stick (the composer keeps reverting to “${now}”)`);
      }
      await page.selectOption("#modesel", mode, { force: true, timeout: 15_000 });
      await sleep(500);
      continue;
    }
    if (Date.now() >= deadline) return;
  }
}

/**
 * Move the recording Playwright named for itself to `raw.webm`.
 * `video.saveAs` waits for the file to finish being written; the readdir path
 * is the fallback for a context that died before the Video handle existed.
 * @param {any} video
 * @param {ReturnType<typeof runPaths>} paths
 */
async function saveVideo(video, paths) {
  try {
    if (video) {
      await video.saveAs(paths.video);
      await video.delete().catch(() => {});
    } else {
      const found = readdirSync(paths.videoTmp).find((f) => f.endsWith(".webm"));
      if (found) renameSync(join(paths.videoTmp, found), paths.video);
    }
  } catch {
    /* no recording — the timeline and meta are still worth keeping */
  }
  try {
    rmSync(paths.videoTmp, { recursive: true, force: true });
  } catch {
    /* leftovers are harmless */
  }
}

/**
 * The Node-driven activity sampler. One tick in flight at a time (`busy`): a
 * slow evaluate must not queue ticks behind itself and then dump a burst of
 * same-instant samples into the timeline.
 * @param {any} page
 * @param {{ sampleMs: number, samples: Array<{t:number,sig:string}>, markers: Array<{t:number,id:string}>,
 *           state: { armed: boolean, firstToken: boolean, done: boolean }, t0: number }} ctx
 * @returns {() => void} stop
 */
function startSampler(page, ctx) {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const parts = await page.evaluate(readPage);
      if (parts && !stopped) {
        const t = Date.now() - ctx.t0;
        ctx.samples.push({ t, sig: contentSignature(parts) });
        if (ctx.state.armed && parts.answerLen > 0 && !ctx.state.firstToken) {
          ctx.state.firstToken = true;
          ctx.markers.push({ t, id: "first_token" });
        }
        if (ctx.state.armed && parts.stats) ctx.state.done = true;
      }
    } catch {
      // A navigation in flight, a closed page, a detached context: skip this
      // sample. The editor tolerates gaps; it does not tolerate a dead run.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, ctx.sampleMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

/**
 * The site's own default model: the first one it reports as up. Asking the
 * deployment rather than hard-coding an id means a capture never records a
 * model the catalog has since dropped.
 * @param {CaptureOptions} opts
 * @param {Record<string, string>} headers
 * @returns {Promise<string[]>}
 */
async function siteDefaultModels(opts, headers) {
  const res = await fetch(`${opts.base}/api/models`, { headers });
  if (!res.ok) throw new Error(`GET ${opts.base}/api/models -> ${res.status}`);
  const body = /** @type {any} */ (await res.json());
  const pick = (body?.models || []).find((/** @type {any} */ m) => m && m.up !== false);
  if (!pick) throw new Error(`no up model in ${opts.base}/api/models — pass --models`);
  return [pick.id];
}

/** @param {import("../scripts/capture-core.mjs").CaptureRun[]} runs @param {CaptureOptions} opts */
function printMatrix(runs, opts) {
  const shape = resolveShape(opts.shape);
  console.log(
    `${runs.length} run${runs.length === 1 ? "" : "s"} · ${shape.label} ` +
      `${shape.viewport.width}x${shape.viewport.height} · ${opts.base} · search ${opts.search ? "on" : "off"} · ` +
      `budget ${opts.budget}s → ${opts.out}`,
  );
  for (const [i, r] of runs.entries()) {
    console.log(`  ${String(i + 1).padStart(3)}  ${r.agent} · ${r.mode} · ${r.model} · ${r.starter} [${r.lang}]`);
    console.log(`       “${truncate(r.prompt, 100)}”`);
    console.log(`       → ${join(opts.out, r.slug)}/raw.webm`);
  }
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {CaptureOptions} opts
 * @returns {Promise<number>} process exit code
 */
export async function runBatch(opts) {
  const errors = validateOptions(opts);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    return 1;
  }

  // Resolved HERE rather than in parseArgs, which is pure and unit-tested:
  // this shells out to git. One resolution per batch, so every clip in a batch
  // carries the same commit even if the tree moves under a long run.
  if (!opts.commit) opts.commit = commitForBase(opts.base);

  const auth = resolveAuth(opts.base);
  // A dry run that already names its models touches nothing: no credentials, no
  // network, no browser. Printing the matrix is how a batch is argued about
  // before it is spent, so it must work on a machine with no secrets — the same
  // reason the edit CLI's --dry-run works without ffmpeg.
  const needsSite = !opts.models || !opts.dryRun;
  if (needsSite && !auth.headers) {
    console.error(`✗ ${auth.reason}`);
    return 1;
  }

  // What the SITE is actually serving, so a wrong `commit_sha` is detectable
  // rather than believed. One request per batch, and null is fine.
  if (needsSite && auth.headers && !opts.dryRun) {
    opts.deployedDigest = await deployedDigest(opts.base, auth.headers);
  }

  let models = opts.models;
  if (!models) {
    try {
      models = await siteDefaultModels(opts, auth.headers || {});
      console.log(`No --models given; using the site's default: ${models.join(", ")}`);
    } catch (e) {
      console.error(`✗ could not resolve a model (${e instanceof Error ? e.message : e}). Pass --models.`);
      return 1;
    }
  }

  let runs = expandMatrix({
    agents: opts.agents,
    models,
    perAgent: opts.perAgent,
    ...(opts.lang ? { lang: opts.lang } : {}),
    offset: opts.offset,
  });
  if (opts.limit != null && opts.limit >= 0) runs = runs.slice(0, opts.limit);
  if (!runs.length) {
    console.error("✗ Nothing to capture: the matrix expanded to no runs.");
    return 1;
  }

  printMatrix(runs, opts);
  if (opts.dryRun) return 0;

  const outRoot = resolve(ROOT, opts.out);
  mkdirSync(outRoot, { recursive: true });

  // Lazy, so the pure helpers above stay importable (and unit-testable) on a
  // checkout where `cd tests && npm install` has never been run.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch(launchOptions({ base: opts.base, headed: opts.headed }));
  const net = {
    headers: auth.headers || {},
    ignoreHTTPSErrors: !auth.local && !!process.env.HTTPS_PROXY,
  };

  const startedAt = Date.now();
  const rows = [];
  try {
    for (const [i, run] of runs.entries()) {
      console.log(`\n── ${i + 1}/${runs.length}  ${run.slug}`);
      // captureRun is total: one bad run costs its own recording, never the
      // batch. Guarded anyway, because a browser-level failure (a crashed
      // Chromium) surfaces here rather than inside it.
      let row;
      try {
        row = await captureRun(browser, run, opts, net);
      } catch (e) {
        row = {
          slug: run.slug,
          agent: run.agent,
          model: run.model,
          starter: run.starter,
          ok: false,
          durationMs: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      rows.push(row);
      console.log(
        `   ${row.ok ? "✓" : "✗"} ${formatDuration(row.durationMs)}${row.error ? `  ${row.error}` : ""}`,
      );
    }
  } finally {
    await browser.close().catch(() => {});
  }

  writeFileSync(
    join(outRoot, "batch.json"),
    JSON.stringify(
      { started_at: startedAt, ended_at: Date.now(), options: { ...opts, models }, runs: rows },
      null,
      2,
    ),
  );
  console.log(`\n${formatSummary(rows)}`);
  console.log(`→ ${join(outRoot, "batch.json")}`);
  console.log(`Next: node scripts/capture-edit.mjs --all ${opts.out}`);

  // Non-zero only when NOTHING was captured: a batch that lost one run to a
  // stalled pipeline still produced footage, and a red exit would hide that.
  return rows.every((r) => !r.ok) ? 1 : 0;
}

/** The CLI's own header block, so the help text cannot drift from the source. */
function helpText() {
  const lines = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2);
  const out = [];
  for (const line of lines) {
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/ ?/, ""));
  }
  return out.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  return await runBatch(opts);
}

// Importable for tests; only the CLI invocation runs main.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

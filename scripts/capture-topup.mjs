#!/usr/bin/env node
// @ts-check
// Capture TOP-UP — the one command that keeps the review queue full.
//
//   node scripts/capture-topup.mjs --dry-run
//   node scripts/capture-topup.mjs --target 20 --models <id>
//   node scripts/capture-topup.mjs --limit 3 --lang sv
//
// The review deck (`/captures/`) is supposed to hold TWENTY unanswered videos
// spanning every agent. A verdict removes one; this command puts it back. It
// is the fourth stage of the capture pipeline glued together end to end —
// record (`tests/capture.mjs`) → edit (`scripts/capture-edit.mjs`) → publish
// (`scripts/captures`) — driven by what the server says the deck is missing.
//
// WHAT IT DOES
//   1. GET /api/admin/captures/queue-status  → target, unanswered, deficit,
//      per-agent counts, and every (agent, starter) pair already in the deck.
//   2. deficit <= 0 → print the queue and exit 0. Safe to run on a timer.
//   3. Otherwise PLAN: pick `deficit` (agent, starter) pairs — see chooseRuns.
//   4. Per run: record one browser run, cut the dead air, publish the row and
//      push the two files.
//   5. Print what it recorded, what the queue looks like afterwards, and what
//      it skipped and why.
//
// A FAILED RUN NEVER ABORTS THE TOP-UP (invariant 2, and the same posture the
// recorder already takes inside a batch): failures are collected and reported,
// and the exit code is non-zero only when EVERY attempted run failed.
//
// OPTIONS
//   --target <n>        queue size to aim for (default: the server's, else 20)
//   --limit <n>         record at most n runs this pass
//   --dry-run           print the exact plan; record, encode and publish nothing
//   --queue-status-file <path>
//                       read the queue status from a JSON file instead of the
//                       API, so a plan can be reviewed with no credentials and
//                       no deployed endpoint
//   --agents <csv>      restrict the spread to these agents (default: all)
//   --models <csv>      model ids; omitted, each run takes the site's own default
//   --lang en|sv        draw only that language's starters
//   --shape portrait|square|landscape|raw    (default portrait)
//   --out <dir>         capture root (default captures/<YYYY-MM-DD>-topup)
//   --base <url>        target site (default $BASE_URL or https://deepresearch.se)
//   --budget <seconds>  research time budget the app is opened with (default 90)
//   --search on|off     the web-search knob (default on)
//   --timeout <ms>      per-run ceiling waiting for the turn to finish
//   --headed            record headful, to watch it happen
//   --min-still <ms>    dead-air threshold for the edit (default 3500 — see below)
//   --hold <ms> / --speed <n> / --wait cut|speed|keep / --wait-speed <n>
//   --crf <n> / --preset <name> / --max-mb <n>
//   --no-publish        record and edit, but create no rows and upload nothing
//   --help
//
// WHY --min-still 3500 IS THE DEFAULT HERE. The editor's own default is 1500,
// which suits a direct answer with no search phase. A research run posts a new
// activity step every couple of seconds, so at 1500 nearly every gap counts as
// dead air and the cut plan strobes between the action speed and the wait
// speed — measured at thirteen segments on a 54 s run, five at 3500. Every run
// this command records has an activity bar, so 3500 is the default and the flag
// is there to lower it deliberately.
//
// AUTH. Same break-glass credentials as `scripts/captures` and the e2e suite:
// BASIC_AUTH_USER / BASIC_AUTH_PASS, with BASE_URL overriding the target.
// `--dry-run --queue-status-file <json>` needs neither.

import { starterName } from "../public/js/captures-core.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPTURABLE_AGENTS, examplePrompts, formatDuration, modeForAgent, pickPrompts } from "./capture-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** The queue size the owner asked for: twenty unanswered videos, all agents. */
export const DEFAULT_TARGET = 20;

/** See the header: 1500 strobes on anything with an activity bar. */
export const DEFAULT_MIN_STILL = 3500;

export const DEFAULTS = {
  target: null,
  limit: null,
  base: "https://deepresearch.se",
  budget: 90,
  search: true,
  shape: "portrait",
  minStill: DEFAULT_MIN_STILL,
};

/** Flags that take no value. */
export const BOOLEAN_FLAGS = new Set(["dry-run", "headed", "help", "no-publish"]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * argv -> resolved options. Pure: the clock and the environment are injected so
 * the dated default `--out` is testable without freezing time globally.
 * @param {string[]} argv
 * @param {{ env?: Record<string, any>, now?: Date }} [ctx]
 */
export function parseArgs(argv, ctx = {}) {
  const env = ctx.env || process.env;
  const now = ctx.now || new Date();
  /** @type {Record<string, any>} */
  const raw = {};
  for (let i = 0; i < (argv || []).length; i++) {
    const a = String(argv[i] ?? "");
    if (!a.startsWith("--")) continue;
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
    target: raw.target == null ? null : int(raw.target, DEFAULT_TARGET),
    limit: raw.limit == null ? null : int(raw.limit, 0),
    dryRun: raw["dry-run"] === true,
    queueStatusFile: raw["queue-status-file"] ? String(raw["queue-status-file"]) : null,
    agents: raw.agents == null ? [] : csv(raw.agents),
    models: raw.models == null ? [] : csv(raw.models),
    lang: raw.lang == null ? null : String(raw.lang).toLowerCase(),
    shape: String(raw.shape || DEFAULTS.shape),
    out: raw.out ? String(raw.out) : join("captures", `${dateDir}-topup`),
    // A trailing slash would put `//api/...` on the wire.
    base: String(raw.base || env.BASE_URL || DEFAULTS.base).replace(/\/+$/, ""),
    budget: int(raw.budget, DEFAULTS.budget),
    search: onOff(raw.search, DEFAULTS.search),
    timeout: raw.timeout == null ? null : int(raw.timeout, 0),
    headed: raw.headed === true,
    publish: raw["no-publish"] !== true,
    help: raw.help === true,
    edit: {
      minStill: int(raw["min-still"], DEFAULTS.minStill),
      hold: raw.hold == null ? null : int(raw.hold, 0),
      speed: raw.speed == null ? null : Number(raw.speed),
      wait: raw.wait == null ? null : String(raw.wait),
      waitSpeed: raw["wait-speed"] == null ? null : Number(raw["wait-speed"]),
      crf: raw.crf == null ? null : int(raw.crf, 0),
      preset: raw.preset == null ? null : String(raw.preset),
      maxMb: raw["max-mb"] == null ? null : Number(raw["max-mb"]),
    },
  };
}

/**
 * Everything wrong with a set of options, as sentences an operator can act on.
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {string[]}
 */
export function validateOptions(opts) {
  const errors = [];
  for (const agent of opts.agents) {
    if (!CAPTURABLE_AGENTS.includes(agent)) {
      errors.push(`Unknown agent “${agent}”. Valid agents: ${CAPTURABLE_AGENTS.join(", ")}.`);
    }
  }
  if (opts.lang && !["en", "sv"].includes(opts.lang)) {
    errors.push(`Unknown language “${opts.lang}”. Valid languages: en, sv.`);
  }
  if (opts.target != null && opts.target < 0) errors.push("--target cannot be negative.");
  if (opts.limit != null && opts.limit < 1) errors.push("--limit must be at least 1.");
  if (opts.edit.minStill < 0) errors.push("--min-still cannot be negative.");
  return errors;
}

/** @param {any} v */
function csv(v) {
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
// The queue status
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} QueueStatus
 * @property {number | null} target
 * @property {number | null} unanswered
 * @property {number | null} deficit
 * @property {Record<string, number>} by_agent
 * @property {Array<{ agent: string, starter: string }>} used
 */

/**
 * The server's answer -> the shape the planner reads. Defensive on purpose: the
 * endpoint is the one part of this pipeline another session owns, and a missing
 * field must degrade the plan rather than crash the top-up. A response wrapped
 * in `{ queue: … }` is unwrapped, `used` accepts either objects or
 * `"agent:starter"` strings, and anything unreadable becomes an empty deck —
 * which plans a full 20 rather than none, the safer direction to be wrong in
 * for a command whose `--dry-run` is reviewed before it spends browser time.
 * @param {any} json
 * @returns {QueueStatus}
 */
export function normalizeQueueStatus(json) {
  const src = (json && typeof json === "object" && (json.queue_status || json.queue || json)) || {};
  /** @type {Record<string, number>} */
  const by_agent = {};
  const rawAgents = src.by_agent && typeof src.by_agent === "object" ? src.by_agent : {};
  for (const [agent, n] of Object.entries(rawAgents)) {
    const count = Number(n);
    // "__proto__" as a key must be a counter, not a prototype assignment.
    if (!agent || agent === "__proto__" || !Number.isFinite(count)) continue;
    by_agent[agent] = Math.max(0, Math.trunc(count));
  }
  /** @type {Array<{ agent: string, starter: string }>} */
  const used = [];
  for (const entry of Array.isArray(src.used) ? src.used : []) {
    if (typeof entry === "string") {
      const [agent, starter] = entry.split(/[:/]/);
      if (agent && starter) used.push({ agent: agent.trim(), starter: starter.trim() });
      continue;
    }
    const agent = typeof entry?.agent === "string" ? entry.agent.trim() : "";
    const starter = typeof entry?.starter === "string" ? entry.starter.trim() : "";
    if (agent && starter) used.push({ agent, starter });
  }
  return {
    target: num(src.target),
    unanswered: num(src.unanswered),
    deficit: num(src.deficit),
    by_agent,
    used,
  };
}

/** @param {any} v */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The queue-status URL, with the two things the endpoint lets a caller name:
 * the agent roster (so an agent with nothing in the deck comes back as a 0
 * rather than an absent key — the Worker deliberately does not carry the
 * starter registry) and the target.
 * @param {string} base
 * @param {{ agents?: string[], target?: number | null }} [o]
 * @returns {string}
 */
export function queueStatusUrl(base, o = {}) {
  const url = new URL(`${base}/api/admin/captures/queue-status`);
  const agents = (o.agents || []).filter(Boolean);
  if (agents.length) url.searchParams.set("agents", agents.join(","));
  if (o.target != null) url.searchParams.set("target", String(o.target));
  return url.toString();
}

/**
 * @param {{ base: string, auth: string, agents?: string[], target?: number | null, fetchImpl?: typeof fetch }} o
 * @returns {Promise<QueueStatus>}
 */
export async function fetchQueueStatus(o) {
  const url = queueStatusUrl(o.base, { agents: o.agents, target: o.target });
  const f = o.fetchImpl || fetch;
  const res = await f(url, { headers: { authorization: o.auth, accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText || ""}`.trim());
  return normalizeQueueStatus(await res.json());
}

// ---------------------------------------------------------------------------
// The plan — which prompts to record
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PlannedRun
 * @property {string} agent
 * @property {string} mode
 * @property {string} starter
 * @property {string} prompt
 * @property {string} lang
 * @property {string} name     the short descriptive name (CONTRACT §6)
 * @property {number} offset   index into the agent's ranked-first starter order
 * @property {string | null} model  null = let the recorder use the site default
 */

/**
 * Choose which (agent, starter) pairs to record.
 *
 * THE JUDGEMENT, in three rules:
 *
 *   1. SPREAD. The owner asked for twenty videos spanning every agent, so each
 *      pick goes to the agent with the FEWEST captures in the deck, counting
 *      the ones this pass has already planned. Ties break in registry order
 *      (`CAPTURABLE_AGENTS`, which is `MODE_AGENTS` — the same order the mode
 *      dropdown uses), so the same queue status always yields the same plan.
 *   2. NEVER REPEAT. A pair already in `used` — in ANY status, answered or not
 *      — is not recorded again. Re-recording is what the version thread is for,
 *      not what the top-up is for.
 *   3. THE PROMPTS ARE THE SHIPPED STARTERS. They come from the same queues the
 *      empty composer shows, through `pickPrompts`, ranked entries first. Never
 *      improvised and never lifted from `chat_logs`: a video is published to an
 *      audience, and a full-visibility log is not consent for that (the
 *      **video-capture** and **starter-prompts** skills both say so).
 *
 * An agent whose queue is exhausted simply drops out of the rotation — the next
 * agent takes its turn — and the reason is reported rather than swallowed, so a
 * short top-up says WHY it came up short.
 *
 * Pure: no clock, no network, no filesystem. The registry can be injected, which
 * is how the spread is tested without depending on the shipped starter data.
 *
 * @param {{ queueStatus?: any, target?: number | null, limit?: number | null,
 *           agents?: string[], models?: string[], lang?: string | null, registry?: any }} input
 * @returns {{ target: number, unanswered: number, deficit: number, wanted: number,
 *             runs: PlannedRun[], skipped: Array<{ agent: string, reason: string }>,
 *             shortfall: number, counts: Record<string, number> }}
 */
export function chooseRuns(input = {}) {
  const qs = normalizeQueueStatus(input.queueStatus || {});
  const agents = (input.agents && input.agents.length ? input.agents : CAPTURABLE_AGENTS).filter(Boolean);
  const models = (input.models || []).filter(Boolean);

  const target = input.target == null ? (qs.target == null ? DEFAULT_TARGET : qs.target) : input.target;
  const unanswered = qs.unanswered == null ? 0 : qs.unanswered;
  // Recompute rather than trust `deficit` whenever the caller named its own
  // target — the server's deficit answers a different question then. With no
  // `unanswered` to work from, the server's own number is all there is.
  const deficit =
    input.target == null && qs.unanswered == null && qs.deficit != null
      ? Math.max(0, Math.trunc(qs.deficit))
      : Math.max(0, Math.trunc(target - unanswered));
  const wanted = input.limit == null ? deficit : Math.max(0, Math.min(deficit, Math.trunc(input.limit)));

  const used = new Set(qs.used.map((u) => pairKey(u.agent, u.starter)));
  const promptOpts = {
    ...(input.lang ? { lang: input.lang } : {}),
    ...(input.registry ? { registry: input.registry } : {}),
  };

  /** @type {Map<string, PlannedRun[]>} */
  const pools = new Map();
  /** @type {Array<{ agent: string, reason: string }>} */
  const skipped = [];
  for (const agent of agents) {
    // The ranked-first order pickPrompts imposes, taken whole so an index into
    // it IS the `--offset` that selects that entry for the recorder. Asking for
    // exactly the queue length avoids pickPrompts' wrap-around, which exists to
    // repeat the best prompts and is the opposite of what a top-up wants.
    const queue = examplePrompts(agent, promptOpts);
    const ordered = pickPrompts(agent, queue.length, promptOpts);
    const pool = ordered
      .map((s, offset) => ({
        agent,
        mode: modeForAgent(agent),
        starter: s.id,
        prompt: s.text,
        lang: s.lang || "en",
        name: captureName({ agent, starter: s.id, prompt: s.text }),
        offset,
        model: null,
      }))
      .filter((r) => !used.has(pairKey(agent, r.starter)));
    pools.set(agent, pool);
    if (!pool.length) {
      skipped.push({
        agent,
        reason: ordered.length
          ? `all ${ordered.length} starter${ordered.length === 1 ? "" : "s"} in this queue are already in the deck`
          : `no starters in the registry queue${input.lang ? ` for lang “${input.lang}”` : ""}`,
      });
    }
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const agent of agents) counts[agent] = qs.by_agent[agent] || 0;

  /** @type {PlannedRun[]} */
  const runs = [];
  while (runs.length < wanted) {
    // Fewest captures first; registry order breaks the tie, which is what makes
    // the same input produce the same plan every time.
    let pick = null;
    for (const agent of agents) {
      if (!(pools.get(agent) || []).length) continue;
      if (pick == null || counts[agent] < counts[pick]) pick = agent;
    }
    if (pick == null) break; // every queue exhausted — report the shortfall
    const run = /** @type {PlannedRun[]} */ (pools.get(pick)).shift();
    if (!run) break;
    counts[pick] += 1;
    runs.push({ ...run, model: models.length ? models[runs.length % models.length] : null });
  }

  return { target, unanswered, deficit, wanted, runs, skipped, shortfall: Math.max(0, wanted - runs.length), counts };
}

/** @param {string} agent @param {string} starter */
function pairKey(agent, starter) {
  return `${agent} ${starter}`;
}

/**
 * A short few-word descriptive name (CONTRACT §6): strip the agent prefix from
 * the starter id, dashes to spaces, title-case, four words at most. Derived, so
 * a recording is never blocked on naming — a human improves it later with
 * `scripts/captures --set <id> '{"name":"…"}'`.
 * @param {{ agent?: string, starter?: string | null, prompt?: string | null }} o
 * @returns {string}
 */
export function captureName(o = {}) {
  const derived = starterName(o?.starter);
  if (derived) return derived;
  const fromPrompt = String(o?.prompt || "").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return fromPrompt || "Untitled capture";
}

// ---------------------------------------------------------------------------
// Publishing — the payload and the `capture <id>` reply
// ---------------------------------------------------------------------------

/** The cap src/captures.js puts on the serialized meta object. */
export const META_CAP = 20_000;

/**
 * Shrink the edit report until it fits the server's meta cap.
 *
 * `serializeMeta` drops the whole object when it is too long, which would throw
 * away the agent/model/prompt provenance along with it. The segment list is the
 * only unbounded part, so it goes first, and a minimal record survives either
 * way.
 * @param {any} edit
 * @param {number} [cap]
 */
export function fitMeta(edit, cap = META_CAP) {
  if (!edit || typeof edit !== "object") return null;
  const fits = (/** @type {any} */ v) => {
    try {
      const json = JSON.stringify(v);
      return !!json && json.length <= cap;
    } catch {
      return false;
    }
  };
  if (fits(edit)) return edit;
  const { segments, ...rest } = edit;
  const trimmed = { ...rest, segments_count: Array.isArray(segments) ? segments.length : 0 };
  if (fits(trimmed)) return trimmed;
  const minimal = {
    dir: edit.dir,
    shape: edit.shape,
    source_ms: edit.source_ms,
    output_ms: edit.output_ms,
    cut_ms: edit.cut_ms,
    dead_air_ms: edit.dead_air_ms,
    wait_mode: edit.wait_mode,
    speed: edit.speed,
    segments_count: Array.isArray(segments) ? segments.length : 0,
    probe: edit.probe,
    meta: edit.meta,
  };
  return fits(minimal) ? minimal : null;
}

/**
 * The `POST /api/admin/captures` body for a finished edit.
 *
 * Everything `edit.json` provides plus the two fields the queue-v2 contract
 * added: `name` (the short descriptive name the owner refers to a clip by) and
 * `commit_sha` (the commit this version was recorded at, which is what makes a
 * run reproducible).
 * @param {{ edit: any, name?: string | null, commit?: string | null, label?: string | null }} o
 */
/**
 * The Agent Studio end-to-end verdict carried on a capture's edit report, or
 * null when the run was not an Agent Studio one (every other agent).
 *
 * Pure and separate from the gate that uses it, so "what counts as a failure"
 * is testable without recording anything. An `app_e2e` present but shapeless
 * reads as a FAILURE rather than an absence: a verdict that cannot be
 * understood must not be treated as consent to publish.
 * @param {any} edit  the parsed edit.json
 * @returns {{ pass: boolean, failures?: string[] } | null}
 */
export function appVerdictOf(edit) {
  const v = edit && edit.meta ? edit.meta.app_e2e : null;
  if (v == null) return null;
  if (typeof v !== "object" || typeof v.pass !== "boolean") {
    return { pass: false, failures: ["the app_e2e verdict on this capture is malformed"] };
  }
  return v;
}

export function buildAddPayload(o) {
  const edit = o.edit || {};
  const meta = edit.meta || {};
  const probe = edit.probe || {};
  const prompt = String(meta.prompt || "");
  const label = o.label || truncate(prompt, 160) || `Capture ${meta.slug || ""}`.trim();
  /** @type {Record<string, any>} */
  const payload = {
    label,
    name: o.name || captureName({ agent: meta.agent, starter: meta.starter, prompt }),
    slug: meta.slug || null,
    agent: meta.agent || null,
    mode: meta.mode || null,
    model: meta.model || null,
    prompt,
    starter: meta.starter || null,
    lang: meta.lang || null,
    shape: edit.shape || meta.shape || null,
    duration_ms: Math.round(Number(edit.output_ms) || 0),
    source_ms: Math.round(Number(edit.source_ms) || 0),
    cut_ms: Math.round(Number(edit.cut_ms) || 0),
    speed: Number(edit.speed) || 1,
    wait_mode: edit.wait_mode || null,
    width: intOrNull(probe.width),
    height: intOrNull(probe.height),
    size_bytes: intOrNull(probe.bytes) || 0,
    commit_sha: o.commit || null,
    meta: fitMeta(edit),
  };
  for (const key of Object.keys(payload)) if (payload[key] == null) delete payload[key];
  return payload;
}

/**
 * Everything that would make the server refuse the row, checked here so a
 * broken edit costs a message rather than a 400 nobody reads.
 * @param {Record<string, any>} payload
 * @returns {string[]}
 */
export function addPayloadProblems(payload) {
  const problems = [];
  if (!payload.label) problems.push("no label (the prompt was empty in meta.json)");
  if (!payload.agent) problems.push("no agent in meta.json");
  if (!payload.model) problems.push("no model in meta.json");
  if (!payload.prompt) problems.push("no prompt in meta.json");
  if (!(payload.duration_ms > 0)) problems.push("duration_ms is 0 — the edit produced no video");
  return problems;
}

/** @param {any} v */
function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * The new capture id out of `scripts/captures --add`.
 *
 * That CLI prints TEXT, not JSON — `capture 12` followed by the two upload
 * URLs — and only falls back to the raw JSON body when `jq` is missing. Both
 * shapes are parsed here; assuming the JSON one is how a batch of uploads gets
 * lost against a row id that was never read.
 * @param {string} stdout
 * @returns {number | null}
 */
export function parseCaptureId(stdout) {
  const text = String(stdout == null ? "" : stdout);
  const m = text.match(/^\s*capture\s+(\d+)\b/im);
  if (m) return Number(m[1]);
  try {
    const json = JSON.parse(text);
    const id = Number(json?.capture?.id ?? json?.id);
    if (Number.isFinite(id) && id > 0) return id;
  } catch {
    /* not JSON — fall through */
  }
  // Last resort: the id in an upload URL, `/api/admin/captures/12/video`.
  const u = text.match(/\/api\/admin\/captures\/(\d+)\//);
  return u ? Number(u[1]) : null;
}

/**
 * The `{"error": …}` an admin endpoint answers with, out of whatever
 * `scripts/captures` printed.
 *
 * This is not belt and braces: that CLI is `curl -sS` without `-f`, so an HTTP
 * 413 or 503 comes back on stdout as a JSON error object and the process still
 * EXITS 0. Reading only the exit status would report a video as uploaded when
 * the server refused the bytes — which is exactly the row-with-no-video that
 * renders as a broken card in the deck.
 * @param {string | null | undefined} stdout
 * @returns {string | null}
 */
export function responseError(stdout) {
  const text = String(stdout == null ? "" : stdout).trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    const err = json && typeof json.error === "string" ? json.error.trim() : "";
    return err || null;
  } catch {
    /* jq already reshaped it, or it is not JSON at all */
  }
  const m = text.match(/"error"\s*:\s*"([^"]*)"/);
  return m && m[1] ? m[1] : null;
}

/** The public reference tag (CONTRACT §1). @param {number} id */
export function captureTag(id) {
  return `#CAP-${id}`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The plan an operator reads before twenty browser runs are spent.
 * @param {ReturnType<typeof chooseRuns>} plan
 * @param {{ base?: string, out?: string }} [ctx]
 * @returns {string}
 */
export function formatPlan(plan, ctx = {}) {
  const lines = [];
  lines.push(
    `queue  ${plan.unanswered} unanswered of ${plan.target} target → deficit ${plan.deficit}` +
      (plan.wanted !== plan.deficit ? ` (recording ${plan.wanted}, --limit)` : ""),
  );
  if (ctx.base) lines.push(`site   ${ctx.base}`);
  if (ctx.out) lines.push(`out    ${ctx.out}`);
  lines.push("");
  if (!plan.runs.length) {
    lines.push("Nothing to record.");
  } else {
    lines.push(`${plan.runs.length} run${plan.runs.length === 1 ? "" : "s"}:`);
    for (const [i, r] of plan.runs.entries()) {
      lines.push(
        `  ${String(i + 1).padStart(3)}  ${r.agent} · ${r.starter} [${r.lang}] · ` +
          `${r.model || "site default model"} · offset ${r.offset} · “${r.name}”`,
      );
      lines.push(`       ${truncate(r.prompt, 100)}`);
    }
  }
  if (plan.skipped.length) {
    lines.push("");
    lines.push("skipped:");
    for (const s of plan.skipped) lines.push(`  · ${s.agent}: ${s.reason}`);
  }
  if (plan.shortfall > 0) {
    lines.push("");
    lines.push(
      `short by ${plan.shortfall}: every remaining starter is already in the deck. ` +
        "Add starters to the registry, or re-cut an existing capture as a new version.",
    );
  }
  const spread = Object.entries(plan.counts)
    .map(([a, n]) => `${a} ${n}`)
    .join(" · ");
  if (spread) {
    lines.push("");
    lines.push(`deck after this pass: ${spread}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * @typedef {Object} RunResult
 * @property {PlannedRun} run
 * @property {boolean} ok
 * @property {number | null} id
 * @property {string | null} reason
 * @property {string[]} warnings
 * @property {number} durationMs
 * @property {boolean} orphan   row created, video bytes missing
 */

/**
 * What happened, what the queue looks like now, and what was skipped.
 * @param {{ plan: ReturnType<typeof chooseRuns>, results: RunResult[] }} o
 * @returns {string}
 */
export function formatSummary(o) {
  const results = o.results || [];
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const orphans = results.filter((r) => r.orphan);
  const lines = ["", "── top-up summary"];
  for (const r of results) {
    lines.push(
      `  ${r.ok ? "✓" : "✗"} ${r.id ? captureTag(r.id).padEnd(9) : "—".padEnd(9)} ` +
        `${r.run.agent} · ${r.run.starter} · “${r.run.name}”  ${formatDuration(r.durationMs)}` +
        (r.reason ? `  ${r.reason}` : ""),
    );
    for (const w of r.warnings) lines.push(`      ! ${w}`);
  }
  const published = ok.length;
  const after = o.plan.unanswered + published;
  lines.push("");
  lines.push(`recorded ${published}/${results.length}; queue ${after}/${o.plan.target} unanswered` + (after < o.plan.target ? `, still ${o.plan.target - after} short` : ""));
  if (failed.length) {
    lines.push("");
    lines.push(`${failed.length} failed:`);
    for (const r of failed) lines.push(`  · ${r.run.agent} · ${r.run.starter}: ${r.reason || "unknown"}`);
  }
  if (orphans.length) {
    lines.push("");
    lines.push("!! ROWS WITH NO VIDEO — these render as broken cards until the bytes land:");
    for (const r of orphans) {
      lines.push(`   ${captureTag(Number(r.id))}  scripts/captures --upload ${r.id} <final.mp4>`);
    }
  }
  if (o.plan.skipped.length) {
    lines.push("");
    lines.push("skipped:");
    for (const s of o.plan.skipped) lines.push(`  · ${s.agent}: ${s.reason}`);
  }
  return lines.join("\n") + "\n";
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
  const str = String(s || "");
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// ---------------------------------------------------------------------------
// Shelling out — record, edit, publish
// ---------------------------------------------------------------------------

/**
 * The argv for one recording. One run per invocation: `--per-agent 1` with the
 * `--offset` that selects exactly the planned starter out of the ranked-first
 * order `chooseRuns` indexed into, and `--limit 1` as a belt-and-braces cap.
 * @param {PlannedRun} run
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {string} outDir
 * @returns {string[]}
 */
export function recordArgs(run, opts, outDir) {
  const args = [
    "tests/capture.mjs",
    "--agents", run.agent,
    "--per-agent", "1",
    "--offset", String(run.offset),
    "--limit", "1",
    "--out", outDir,
    "--base", opts.base,
    "--shape", opts.shape,
    "--budget", String(opts.budget),
    "--search", opts.search ? "on" : "off",
  ];
  if (run.model) args.push("--models", run.model);
  if (opts.lang) args.push("--lang", opts.lang);
  if (opts.timeout != null) args.push("--timeout", String(opts.timeout));
  if (opts.headed) args.push("--headed");
  return args;
}

/**
 * The argv for one edit. `--min-still` always carries a value (3500 unless the
 * operator lowered it) because the editor's own default strobes on a run with
 * an activity bar.
 * @param {string} captureDir
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {string[]}
 */
export function editArgs(captureDir, opts) {
  const e = opts.edit;
  const args = ["scripts/capture-edit.mjs", captureDir, "--min-still", String(e.minStill), "--shape", opts.shape];
  if (e.hold != null) args.push("--hold", String(e.hold));
  if (e.speed != null) args.push("--speed", String(e.speed));
  if (e.wait != null) args.push("--wait", e.wait);
  if (e.waitSpeed != null) args.push("--wait-speed", String(e.waitSpeed));
  if (e.crf != null) args.push("--crf", String(e.crf));
  if (e.preset != null) args.push("--preset", e.preset);
  if (e.maxMb != null) args.push("--max-mb", String(e.maxMb));
  return args;
}

/**
 * The one capture directory under a per-run root — the directory the recorder
 * named for itself from agent/model/starter. Found rather than computed, so the
 * top-up does not have to predict the model id when the recorder resolves the
 * site's default.
 * @param {string} root
 * @returns {string | null}
 */
export function findRecordedDir(root) {
  if (!existsSync(root)) return null;
  const kids = readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  return kids.find((p) => existsSync(join(p, "raw.webm")) || existsSync(join(p, "raw.mp4"))) || null;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** @param {string} cmd @param {string[]} args */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], ...opts });
}

/** @param {string} cmd @param {string[]} args */
function runCapture(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
}

/** The commit this version was recorded at. Read-only; never writes git state. */
export function headCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const sha = r.status === 0 ? String(r.stdout || "").trim() : "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

// ---------------------------------------------------------------------------
// One run, end to end
// ---------------------------------------------------------------------------

/**
 * Record → edit → publish one planned run. Never throws: every failure becomes
 * a `{ ok: false, reason }` so the loop above it can carry on with the next
 * run, which is the whole point of a command that runs unattended.
 * @param {PlannedRun} planned
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ commit: string | null, index: number }} ctx
 * @returns {RunResult}
 */
function topUpOne(planned, opts, ctx) {
  const startedAt = Date.now();
  /** @type {RunResult} */
  const result = {
    run: planned,
    ok: false,
    id: null,
    reason: null,
    warnings: [],
    durationMs: 0,
    orphan: false,
  };
  const done = (/** @type {string | null} */ reason, ok = false) => {
    result.reason = reason;
    result.ok = ok;
    result.durationMs = Date.now() - startedAt;
    return result;
  };

  const runRoot = resolve(
    ROOT,
    opts.out,
    `${String(ctx.index + 1).padStart(2, "0")}-${planned.agent}-${planned.starter}`.replace(/[^a-zA-Z0-9._-]/g, "-"),
  );

  // 1. record
  const rec = run(process.execPath, recordArgs(planned, opts, runRoot));
  if (rec.status !== 0) {
    return done(`recording exited ${rec.status}${rec.error ? ` (${rec.error.message})` : ""}`);
  }
  const captureDir = findRecordedDir(runRoot);
  if (!captureDir) return done(`no recording under ${runRoot} (Playwright wrote no raw.webm)`);

  const meta = readJson(join(captureDir, "meta.json")) || {};
  if (meta.ok === false) return done(`the run did not complete: ${meta.error || "unknown"}`);
  if (meta.starter && meta.starter !== planned.starter) {
    // The offset the plan computed and the one the recorder resolved must agree
    // — they read the same registry through the same ranked-first order. A
    // mismatch means the plan and the footage are about different prompts, and
    // publishing it would put the wrong prompt on the card.
    return done(`recorded starter “${meta.starter}” is not the planned “${planned.starter}” — plan and recorder disagree`);
  }

  // 2. edit
  const ed = run(process.execPath, editArgs(captureDir, opts));
  if (ed.status !== 0) return done(`edit exited ${ed.status}${ed.error ? ` (${ed.error.message})` : ""}`);
  const edit = readJson(join(captureDir, "edit.json"));
  if (!edit) return done(`no edit.json in ${captureDir} — the encode produced nothing`);
  const video = edit.output && existsSync(edit.output) ? edit.output : join(captureDir, "final.mp4");
  if (!existsSync(video)) return done(`no final.mp4 in ${captureDir}`);

  if (!opts.publish) {
    result.warnings.push(`--no-publish: ${video} was left on disk`);
    return done(null, true);
  }

  // THE AGENT STUDIO GATE (owner directive, 2026-08-11): "only keep those app
  // studio creation videos that also pass end2end test of the generated app".
  // The recorder walked to the published app and used it; if that failed, the
  // clip stays on disk with its verdict and never reaches the deck. A video of
  // a build that does not work is worse than no video — it is a demo of a
  // broken thing, filed as if it were a demo of a working one.
  const verdict = appVerdictOf(edit);
  if (verdict && verdict.pass === false) {
    return done(`the built app failed its end-to-end test — NOT published: ${(verdict.failures || []).join("; ") || "no reason recorded"}`);
  }

  // 3. publish the row
  const payload = buildAddPayload({ edit, name: planned.name, commit: ctx.commit });
  const problems = addPayloadProblems(payload);
  if (problems.length) return done(`cannot publish: ${problems.join("; ")}`);

  const captures = (/** @type {string[]} */ args) => runCapture("bash", [resolve(ROOT, "scripts/captures"), ...args]);
  const add = captures(["--add", JSON.stringify(payload)]);
  const addError = failureOf(add);
  if (addError) return done(`scripts/captures --add failed: ${addError}`);
  const id = parseCaptureId(add.stdout);
  if (!id) return done(`could not read a capture id out of --add: ${firstLine(add.stdout) || "(no output)"}`);
  result.id = id;

  // 4. the bytes. A row whose video never landed renders as a broken card, so
  // this failure is loud and named rather than a quiet non-zero.
  const up = captures(["--upload", String(id), video]);
  const upError = failureOf(up);
  if (upError) {
    result.orphan = true;
    return done(
      `${captureTag(id)} EXISTS BUT HAS NO VIDEO — upload failed (${upError}). ` +
        `Retry: scripts/captures --upload ${id} ${video}`,
    );
  }

  const posterPath = edit.poster && existsSync(edit.poster) ? edit.poster : join(captureDir, "poster.jpg");
  if (existsSync(posterPath)) {
    const po = captures(["--poster", String(id), posterPath]);
    const poError = failureOf(po);
    if (poError) {
      result.warnings.push(`poster upload failed (${poError}) — the card falls back to the first frame`);
    }
  } else {
    result.warnings.push("no poster.jpg was produced");
  }
  return done(null, true);
}

/** @param {any} s */
function firstLine(s) {
  return String(s || "").trim().split("\n")[0] || "";
}

/**
 * Why one `scripts/captures` call failed, or null when it worked. Both halves
 * matter: a non-zero exit AND an error body behind a zero exit (see
 * responseError).
 * @param {{ status?: number | null, stderr?: any, stdout?: any, error?: Error }} r
 * @returns {string | null}
 */
function failureOf(r) {
  if (r.error) return r.error.message;
  if (r.status !== 0) return firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.status}`;
  return responseError(r.stdout);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** The header block IS the help text — one place to keep current. */
function helpText() {
  const out = [];
  for (const line of readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2)) {
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/ ?/, ""));
  }
  return out.join("\n");
}

/**
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {Promise<number>} process exit code
 */
export async function topUp(opts) {
  const errors = validateOptions(opts);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    return 1;
  }

  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  const auth = user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : null;

  /** @type {QueueStatus} */
  let queueStatus;
  if (opts.queueStatusFile) {
    const json = readJson(resolve(ROOT, opts.queueStatusFile));
    if (!json) {
      console.error(`✗ could not read --queue-status-file ${opts.queueStatusFile} as JSON.`);
      return 1;
    }
    queueStatus = normalizeQueueStatus(json);
    console.log(`queue status read from ${opts.queueStatusFile} (no API call)`);
  } else {
    if (!auth) {
      console.error(
        "✗ Set BASIC_AUTH_USER / BASIC_AUTH_PASS (break-glass credentials), " +
          "or plan offline with --dry-run --queue-status-file <json>.",
      );
      return 1;
    }
    try {
      queueStatus = await fetchQueueStatus({
        base: opts.base,
        auth,
        agents: opts.agents.length ? opts.agents : CAPTURABLE_AGENTS,
        target: opts.target,
      });
    } catch (e) {
      console.error(`✗ ${e instanceof Error ? e.message : e}`);
      console.error("  If the endpoint is not deployed yet: --dry-run --queue-status-file <json>.");
      return 1;
    }
  }

  const plan = chooseRuns({
    queueStatus,
    target: opts.target,
    limit: opts.limit,
    agents: opts.agents,
    models: opts.models,
    lang: opts.lang,
  });

  if (plan.deficit <= 0) {
    console.log(
      `Queue is full: ${plan.unanswered} unanswered of ${plan.target}. Nothing recorded.\n` +
        `deck: ${Object.entries(plan.counts).map(([a, n]) => `${a} ${n}`).join(" · ")}`,
    );
    return 0;
  }

  console.log(formatPlan(plan, { base: opts.base, out: opts.out }));
  if (opts.dryRun) {
    console.log("--dry-run: nothing recorded, encoded or published.");
    return 0;
  }
  if (!plan.runs.length) return 0;
  if (opts.publish && !auth) {
    console.error("✗ publishing needs BASIC_AUTH_USER / BASIC_AUTH_PASS. Re-run with --no-publish to record only.");
    return 1;
  }

  const commit = headCommit();
  if (!commit) console.log("! git HEAD unreadable — rows will carry no commit_sha");

  /** @type {RunResult[]} */
  const results = [];
  for (const [i, planned] of plan.runs.entries()) {
    console.log(`\n── ${i + 1}/${plan.runs.length}  ${planned.agent} · ${planned.starter} · “${planned.name}”`);
    let res;
    try {
      res = topUpOne(planned, opts, { commit, index: i });
    } catch (e) {
      // topUpOne is total, so this only fires on something outside it (a spawn
      // the OS refused). One bad run still costs one clip, never the pass.
      res = {
        run: planned,
        ok: false,
        id: null,
        reason: e instanceof Error ? e.message : String(e),
        warnings: [],
        durationMs: 0,
        orphan: false,
      };
    }
    results.push(res);
    console.log(`   ${res.ok ? "✓" : "✗"} ${res.id ? captureTag(res.id) : ""} ${res.reason || ""}`.trimEnd());
  }

  console.log(formatSummary({ plan, results }));
  // Non-zero only when EVERY attempted run failed: a pass that added four of
  // six still filled the deck, and a red exit would hide that.
  return results.length && results.every((r) => !r.ok) ? 1 : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  return await topUp(opts);
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

// @ts-check
// Video capture — the PURE core. Everything here is a function of its
// arguments: no filesystem, no browser, no ffmpeg process, no clock. The two
// callers are `tests/capture.mjs` (the Playwright driver that records the
// browser) and `scripts/capture-edit` (the ffmpeg post-production CLI), and
// they share this module so the run matrix, the cut plan and the encoder
// settings have exactly one definition. Unit-tested in
// `scripts/capture-core.test.mjs`.
//
// WHY A TIMELINE INSTEAD OF SCENE DETECTION
//
// A deep-research run is mostly WAITING: the composer sends, then the activity
// bar sits still for ten to ninety seconds while the pipeline searches, then
// tokens stream. ffmpeg's own scene detection cannot tell "the pipeline is
// thinking" from "the answer paused mid-sentence" — both look like a static
// frame — and a fixed threshold either keeps the dead air or eats the pauses
// that make an answer readable.
//
// So the DRIVER decides what "activity" means and writes it down: it samples
// the page at a fixed interval and records a content SIGNATURE (step count,
// answer length, phase). Consecutive identical signatures are provably dead
// time — nothing on screen changed — and this module turns those spans into
// cuts. The result is deterministic and reviewable: `--dry-run` prints the
// exact segment list, so an edit can be argued about before a frame is
// encoded.
//
// WHY THE CAPTURE VIEWPORT IS SMALLER THAN THE OUTPUT
//
// A LinkedIn feed plays video in a box a few centimetres wide on a phone. What
// decides whether a research run reads there is not pixel sharpness, it is how
// large the text is RELATIVE TO THE FRAME. Recording a 1080-wide CSS viewport
// and encoding it 1:1 gives a crisp video nobody can read. So each shape
// records a small CSS viewport (the site lays out in its narrow, large-type
// mode) and upscales with lanczos. Legibility beats sharpness in a feed.

import { MODE_AGENTS, resolveQueue } from "../public/js/starters-core.js";
import { STARTERS } from "../public/js/starters-data.js";

// ---------------------------------------------------------------------------
// Shapes — capture viewport + delivery frame, one entry per aspect ratio
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Shape
 * @property {string} id
 * @property {string} label
 * @property {{ width: number, height: number }} viewport  CSS pixels recorded
 * @property {{ width: number, height: number } | null} out  delivery frame (null = keep source)
 * @property {string} why
 */

/** @type {Record<string, Shape>} */
export const SHAPES = {
  // The default. 4:5 is the tallest ratio LinkedIn renders at full width in
  // the feed, so it occupies the most screen for the same scroll — and a chat
  // transcript is a vertical thing, which is the other half of the argument.
  portrait: {
    id: "portrait",
    label: "4:5 portrait (LinkedIn feed)",
    viewport: { width: 720, height: 900 },
    out: { width: 1080, height: 1350 },
    why: "Tallest ratio LinkedIn renders full-width; matches a vertical transcript.",
  },
  square: {
    id: "square",
    label: "1:1 square",
    viewport: { width: 800, height: 800 },
    out: { width: 1080, height: 1080 },
    why: "Safe everywhere, including cross-posting to networks that crop tall video.",
  },
  landscape: {
    id: "landscape",
    label: "16:9 landscape",
    viewport: { width: 1280, height: 720 },
    out: { width: 1920, height: 1080 },
    why: "For a wide UI shot (the workflow graph, the terminal pane) or embedding on a page.",
  },
  // No scaling, no padding — the source frame straight through the cut plan.
  // For inspecting an edit before committing to a delivery frame.
  raw: {
    id: "raw",
    label: "source frame, unscaled",
    viewport: { width: 1280, height: 800 },
    out: null,
    why: "Review the cut plan without resampling; not a delivery format.",
  },
};

export const DEFAULT_SHAPE = "portrait";

/**
 * @param {string | null | undefined} id
 * @returns {Shape}
 */
export function resolveShape(id) {
  return SHAPES[String(id || DEFAULT_SHAPE)] || SHAPES[DEFAULT_SHAPE];
}

// ---------------------------------------------------------------------------
// The delivery target — what "optimized for LinkedIn" actually means
// ---------------------------------------------------------------------------
//
// These are LinkedIn's published limits for a feed video, not guesses. They
// are FENCES, not targets: the encoder settings below aim far under them,
// because the number that decides whether a video gets watched on a phone is
// how fast it starts, not how close to 5 GB it got.

export const LINKEDIN = {
  container: "mp4",
  video_codec: "h264",
  audio_codec: "aac",
  max_bytes: 5 * 1024 * 1024 * 1024, // 5 GB — the hard upload ceiling
  max_seconds: 600, // 10 minutes
  min_seconds: 3,
  // Aspect ratios accepted, expressed as width/height.
  min_aspect: 1 / 2.4,
  max_aspect: 2.4,
  max_frame: { width: 1920, height: 1920 },
  // What we actually aim for. A feed video is watched muted, on a phone, in a
  // scroll — a small file that starts instantly is worth more than headroom.
  target_bytes: 40 * 1024 * 1024,
  target_seconds: 90,
  fps: 30,
};

/**
 * Whether a finished file would be accepted by LinkedIn, and what is off.
 * Advisory: the edit CLI prints these rather than refusing to write a file.
 * @param {{ bytes?: number, seconds?: number, width?: number, height?: number, fps?: number }} v
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function checkDelivery(v) {
  const problems = [];
  const warnings = [];
  if (typeof v.bytes === "number" && v.bytes > LINKEDIN.max_bytes) {
    problems.push(`${mb(v.bytes)} MB exceeds LinkedIn's 5 GB upload limit.`);
  }
  if (typeof v.seconds === "number") {
    if (v.seconds > LINKEDIN.max_seconds) problems.push(`${v.seconds.toFixed(1)} s exceeds the 10-minute feed limit.`);
    if (v.seconds < LINKEDIN.min_seconds) problems.push(`${v.seconds.toFixed(1)} s is under the 3-second minimum.`);
    if (v.seconds > LINKEDIN.target_seconds) {
      warnings.push(
        `${v.seconds.toFixed(1)} s is over the ${LINKEDIN.target_seconds} s that holds a feed audience — raise --speed or lower --min-still.`,
      );
    }
  }
  if (typeof v.width === "number" && typeof v.height === "number" && v.width > 0 && v.height > 0) {
    const aspect = v.width / v.height;
    if (aspect < LINKEDIN.min_aspect || aspect > LINKEDIN.max_aspect) {
      problems.push(`Aspect ${aspect.toFixed(2)}:1 is outside LinkedIn's 1:2.4 – 2.4:1 range.`);
    }
    if (v.width > LINKEDIN.max_frame.width || v.height > LINKEDIN.max_frame.height) {
      warnings.push(`${v.width}x${v.height} is above 1920 on one side; LinkedIn will re-encode it.`);
    }
  }
  if (typeof v.bytes === "number" && v.bytes > LINKEDIN.target_bytes) {
    warnings.push(`${mb(v.bytes)} MB is over the ${mb(LINKEDIN.target_bytes)} MB we aim for — pass --max-mb to cap the bitrate.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

/** @param {number} bytes */
const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// ---------------------------------------------------------------------------
// The run matrix — selected agents x selected models x example prompts
// ---------------------------------------------------------------------------
//
// "Selected agents" is the product-facing word; the wire calls it a CHAT MODE.
// MODE_AGENTS (starters-core.js) is the one mapping, so inverting it here
// keeps the capture harness pointed at the same agent ids the starter registry
// and sdk/AGENTS.json use. An agent with no mode of its own (`secure`, which
// is a TIER rather than a dropdown entry) is reachable by naming its mode
// explicitly.

/** @type {Record<string, string>} agent id -> chat mode id */
export const AGENT_MODES = Object.fromEntries(Object.entries(MODE_AGENTS).map(([mode, agent]) => [agent, mode]));

/** Agents the capture harness can drive from the Se/rver composer. */
export const CAPTURABLE_AGENTS = Object.values(MODE_AGENTS);

/**
 * The chat mode that puts the composer into a given agent. Unknown names fall
 * back to Deep Research rather than throwing — a typo should produce a run
 * that is obviously the wrong agent, not a dead harness.
 * @param {string} agent
 * @returns {string}
 */
export function modeForAgent(agent) {
  return AGENT_MODES[agent] || "normal";
}

/**
 * The example prompts for an agent, in registry order.
 *
 * These are the STARTER PROMPTS the empty composer already shows (the
 * **starter-prompts** skill): synthetic by construction, written to name a
 * subject AND a task, and EN/SV balanced. That last property is why they are
 * the right corpus for a capture: a video made from real chat_logs would
 * publish one user's question to an audience, and a video made from
 * improvised prompts would drift away from what the product actually opens
 * with.
 *
 * `lang` filters to one language when a capture is aimed at one audience.
 * @param {string} agent
 * @param {{ lang?: string, registry?: any }} [opts]
 * @returns {Array<{ id: string, text: string, aspect: string, lang: string, xp?: number, rank?: number }>}
 */
export function examplePrompts(agent, opts = {}) {
  const queue = resolveQueue(opts.registry || STARTERS, agent);
  return opts.lang ? queue.filter((s) => s.lang === opts.lang) : queue;
}

/**
 * Pick `n` prompts for an agent, RANKED FIRST.
 *
 * A capture is a showcase, so it takes the starters an eval run has actually
 * scored (`rank`, written by hand from a recorded run — see the
 * starter-prompts skill) before the untried ones, and keeps registry order
 * within each band so repeated runs of the same command pick the same
 * prompts. `offset` walks further down the queue for a second batch.
 * @param {string} agent
 * @param {number} n
 * @param {{ lang?: string, offset?: number, registry?: any }} [opts]
 */
export function pickPrompts(agent, n, opts = {}) {
  const queue = examplePrompts(agent, opts);
  const ranked = queue.filter((s) => typeof s.rank === "number").sort((a, b) => (b.rank || 0) - (a.rank || 0));
  const rest = queue.filter((s) => typeof s.rank !== "number");
  const ordered = [...ranked, ...rest];
  const offset = Math.max(0, Math.floor(opts.offset || 0));
  if (!ordered.length || n <= 0) return [];
  // Wrap rather than run dry: asking for more captures than the queue holds
  // should repeat the best prompts, not silently produce fewer runs.
  return Array.from({ length: n }, (_, i) => ordered[(offset + i) % ordered.length]);
}

/**
 * @typedef {Object} CaptureRun
 * @property {string} agent
 * @property {string} mode      the chat mode the composer is put into
 * @property {string} model     the model id selected in the dropdown
 * @property {string} prompt    the message sent
 * @property {string} starter   the starter id the prompt came from
 * @property {number} [xp]      the starter's #XP number, when it has one
 * @property {string} lang
 * @property {string} slug      filesystem-safe identity for this run
 */

/**
 * Expand selected agents x selected models x example prompts into runs.
 *
 * The ordering is agent-major, then model, then prompt, so a partial run
 * (interrupted, or --limit'ed) still covers whole agents rather than leaving
 * every agent half-captured.
 * @param {{ agents: string[], models: string[], perAgent?: number, lang?: string, offset?: number, registry?: any, prompts?: Record<string, Array<any>> }} spec
 * @returns {CaptureRun[]}
 */
export function expandMatrix(spec) {
  const agents = (spec.agents || []).filter(Boolean);
  const models = (spec.models || []).filter(Boolean);
  const perAgent = spec.perAgent == null ? 1 : Math.max(0, Math.floor(spec.perAgent));
  /** @type {CaptureRun[]} */
  const runs = [];
  for (const agent of agents) {
    const prompts = spec.prompts?.[agent] || pickPrompts(agent, perAgent, spec);
    for (const model of models) {
      for (const p of prompts) {
        runs.push({
          agent,
          mode: modeForAgent(agent),
          model,
          prompt: p.text,
          starter: p.id,
          ...(p.xp ? { xp: p.xp } : {}),
          lang: p.lang || "en",
          slug: captureSlug({ agent, model, starter: p.id }),
        });
      }
    }
  }
  return runs;
}

/**
 * A filesystem- and URL-safe identity for one run. Deliberately readable —
 * these become directory names an operator scrolls through.
 * @param {{ agent: string, model: string, starter: string }} run
 */
export function captureSlug(run) {
  return [run.agent, run.model, run.starter].map(slugPart).filter(Boolean).join("__");
}

/** @param {string} s */
function slugPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ---------------------------------------------------------------------------
// The activity timeline -> dead-time detection
// ---------------------------------------------------------------------------

/**
 * One sample written by the driver: a millisecond offset into the recording
 * and an opaque signature of what was on screen.
 * @typedef {{ t: number, sig: string }} Sample
 */
/**
 * A named moment (send, first token, done) — used for chapter labels and for
 * trimming the head/tail, never for cutting.
 * @typedef {{ t: number, id: string, label?: string }} Marker
 */

/**
 * Maximal spans during which the signature never changed.
 *
 * The END of a span is the LAST sample known to be idle, not the sample where
 * the change was observed: a change seen at sample m happened somewhere in
 * (t[m-1], t[m]], so ending the span at t[m-1] guarantees the frame where new
 * content appears is never inside a cut. That one-sample conservatism is the
 * difference between an edit that feels tight and one that clips the first
 * word of every answer.
 * @param {Sample[]} samples  ascending by t
 * @param {{ minStillMs?: number }} [opts]
 * @returns {Array<{ start: number, end: number }>}
 */
export function stillSpans(samples, opts = {}) {
  const minStillMs = opts.minStillMs == null ? 1500 : opts.minStillMs;
  const s = (samples || []).filter((x) => x && Number.isFinite(x.t)).slice().sort((a, b) => a.t - b.t);
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];
  if (s.length < 2) return spans;
  let runStart = 0; // index where the current identical-signature run began
  for (let i = 1; i <= s.length; i++) {
    const changed = i === s.length || s[i].sig !== s[runStart].sig;
    if (!changed) continue;
    const start = s[runStart].t;
    const end = s[i - 1].t;
    if (end - start >= minStillMs) spans.push({ start, end });
    runStart = i;
  }
  return spans;
}

/**
 * Merge overlapping/touching intervals. Exported because both the planner and
 * the driver's own trimming need it.
 * @param {Array<{ start: number, end: number }>} intervals
 * @returns {Array<{ start: number, end: number }>}
 */
export function mergeIntervals(intervals) {
  const sorted = (intervals || []).filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  /** @type {Array<{ start: number, end: number }>} */
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The edit plan
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Segment
 * @property {number} start   source ms
 * @property {number} end     source ms
 * @property {"action" | "wait"} kind
 * @property {number} speed   playback multiplier (2 = twice as fast)
 */
/**
 * @typedef {Object} EditPlan
 * @property {number} sourceMs
 * @property {Segment[]} segments
 * @property {number} keptMs   source time that survives the cut
 * @property {number} cutMs    source time removed outright
 * @property {number} outMs    finished duration after the speed ramps
 * @property {number} waitMs   source time the driver measured as dead
 * @property {string} waitMode
 * @property {number} speed
 */

export const PLAN_DEFAULTS = {
  /** A pause shorter than this is part of the rhythm of reading, not dead air. */
  minStillMs: 1500,
  /** Head of every dead span kept, so the state that was reached is readable. */
  holdMs: 600,
  /** Playback speed for the parts where something is happening. */
  speed: 1,
  /** What to do with dead air: drop it, or run it fast so the wait stays legible. */
  waitMode: /** @type {"cut" | "speed" | "keep"} */ ("cut"),
  /** Multiplier for waitMode "speed". */
  waitSpeed: 8,
  /** Shortest kept fragment — below this a cut reads as a glitch, not an edit. */
  minSegmentMs: 200,
};

/** @type {readonly string[]} */
export const WAIT_MODES = ["cut", "speed", "keep"];

/**
 * Turn a recording plus its activity timeline into an ordered segment list.
 *
 * Everything the ffmpeg layer needs is decided here, in plain numbers, so an
 * edit can be reviewed (`--dry-run`) and unit-tested without encoding a frame.
 * @param {{ sourceMs: number, samples?: Sample[], markers?: Marker[], trimStartMs?: number, trimEndMs?: number,
 *           minStillMs?: number, holdMs?: number, speed?: number, waitMode?: string, waitSpeed?: number,
 *           minSegmentMs?: number }} input
 * @returns {EditPlan}
 */
export function planEdit(input) {
  const d = PLAN_DEFAULTS;
  const sourceMs = Math.max(0, Number(input.sourceMs) || 0);
  const speed = positive(input.speed, d.speed);
  const waitSpeed = positive(input.waitSpeed, d.waitSpeed);
  const waitMode = WAIT_MODES.includes(String(input.waitMode)) ? String(input.waitMode) : d.waitMode;
  const holdMs = input.holdMs == null ? d.holdMs : Math.max(0, input.holdMs);
  const minSegmentMs = input.minSegmentMs == null ? d.minSegmentMs : Math.max(0, input.minSegmentMs);
  const from = clamp(input.trimStartMs || 0, 0, sourceMs);
  const to = clamp(sourceMs - (input.trimEndMs || 0), from, sourceMs);

  const spans = stillSpans(input.samples || [], { minStillMs: input.minStillMs == null ? d.minStillMs : input.minStillMs });
  const waitMs = spans.reduce((n, s) => n + (s.end - s.start), 0);

  // Each dead span keeps `holdMs` at its head; the rest is the wait interval.
  const waits = mergeIntervals(
    spans
      .map((s) => ({ start: clamp(s.start + holdMs, from, to), end: clamp(s.end, from, to) }))
      .filter((s) => s.end - s.start >= minSegmentMs),
  );

  /** @type {Segment[]} */
  const segments = [];
  let cursor = from;
  for (const w of waits) {
    if (w.start > cursor) segments.push({ start: cursor, end: w.start, kind: "action", speed });
    if (waitMode === "cut") {
      // dropped entirely
    } else {
      segments.push({ start: w.start, end: w.end, kind: "wait", speed: waitMode === "speed" ? waitSpeed : speed });
    }
    cursor = w.end;
  }
  if (to > cursor) segments.push({ start: cursor, end: to, kind: "action", speed });

  const usable = segments.filter((s) => s.end - s.start >= minSegmentMs);
  const merged = mergeSegments(usable.length ? usable : segments.filter((s) => s.end > s.start));

  const keptMs = merged.reduce((n, s) => n + (s.end - s.start), 0);
  const outMs = merged.reduce((n, s) => n + (s.end - s.start) / s.speed, 0);
  return {
    sourceMs,
    segments: merged,
    keptMs,
    cutMs: Math.max(0, to - from - keptMs),
    outMs,
    waitMs,
    waitMode,
    speed,
  };
}

/**
 * Fuse contiguous segments that play at the same speed — one trim filter
 * instead of two, and one less concat boundary for the encoder to flush a
 * keyframe at.
 * @param {Segment[]} segments
 * @returns {Segment[]}
 */
export function mergeSegments(segments) {
  /** @type {Segment[]} */
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speed === s.speed && Math.abs(last.end - s.start) < 1) {
      last.end = s.end;
      if (s.kind === "action") last.kind = "action";
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(Math.max(Number(v) || 0, lo), hi);
}
/** @param {any} v @param {number} fallback */
function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Seconds, at the precision ffmpeg's trim filter actually resolves. */
/** @param {number} ms */
export function secs(ms) {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * The `-filter_complex` graph for a plan.
 *
 * One `trim`+`setpts` chain per segment, concatenated, then the delivery
 * scale/pad/fps/format tail. `setpts=(PTS-STARTPTS)/N` is what makes a segment
 * play at N times speed; dividing by 1 is a no-op the filter still needs,
 * because STARTPTS must be rebased for concat to butt the segments together.
 *
 * No audio path: a Playwright recording carries no audio track, so the whole
 * graph is video-only and the encoder is told `-an`. Adding music is a
 * separate, later `-i` — see the skill.
 * @param {EditPlan} plan
 * @param {{ shape?: string, fps?: number, pad?: string }} [opts]
 * @returns {string}
 */
export function buildFilterGraph(plan, opts = {}) {
  const segments = plan.segments || [];
  if (!segments.length) throw new Error("Nothing to encode: the plan has no segments.");
  const shape = resolveShape(opts.shape);
  const fps = positive(opts.fps, LINKEDIN.fps);
  const pad = opts.pad || "black";

  const chains = segments.map(
    (s, i) => `[0:v]trim=start=${secs(s.start)}:end=${secs(s.end)},setpts=(PTS-STARTPTS)/${s.speed}[c${i}]`,
  );
  const labels = segments.map((_, i) => `[c${i}]`).join("");
  chains.push(`${labels}concat=n=${segments.length}:v=1:a=0[cv]`);

  const tail = [];
  if (shape.out) {
    const { width, height } = shape.out;
    // decrease + pad rather than crop: a research transcript loses its meaning
    // when the edges go, so letterbox instead of cutting the composer off.
    tail.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    tail.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${pad}`);
    tail.push(`setsar=1`);
  }
  tail.push(`fps=${fps}`);
  tail.push(`format=yuv420p`);
  chains.push(`[cv]${tail.join(",")}[v]`);
  return chains.join(";");
}

/**
 * Bitrate cap, in kbit/s, that lands a clip of `outMs` under `maxBytes`.
 * Returns null when no cap was asked for. The 0.94 headroom covers the
 * container overhead the muxer adds on top of the video stream.
 * @param {number | null | undefined} maxBytes
 * @param {number} outMs
 * @returns {number | null}
 */
export function bitrateCapKbps(maxBytes, outMs) {
  if (!maxBytes || !(outMs > 0)) return null;
  const kbps = Math.floor(((maxBytes * 8 * 0.94) / (outMs / 1000)) / 1000);
  return Math.max(200, kbps);
}

export const ENCODE_DEFAULTS = {
  crf: 21,
  preset: "slow",
  fps: LINKEDIN.fps,
};

/**
 * The full ffmpeg argv for one edit. Returned as an ARRAY and spawned without
 * a shell, so nothing in a filter graph or a path is ever quoted or escaped —
 * the class of bug that makes an edit pipeline unreliable.
 *
 * Encoder choices, each load-bearing for LinkedIn:
 *   libx264 high profile + yuv420p — the only combination every LinkedIn
 *     client decodes; a 10-bit or 4:4:4 stream shows as a black rectangle.
 *   +faststart — moves the moov atom to the front so playback starts before
 *     the file has finished downloading. Without it a feed video looks broken.
 *   -an — no audio track at all. LinkedIn autoplays muted; a silent AAC track
 *     buys nothing and costs a stream.
 *   -crf with an optional -maxrate/-bufsize cap — quality-targeted by default,
 *     size-capped only when the caller names a budget.
 * @param {{ input: string, output: string, plan: EditPlan, shape?: string, fps?: number,
 *           crf?: number, preset?: string, maxBytes?: number | null, pad?: string }} o
 * @returns {string[]}
 */
export function ffmpegArgs(o) {
  const fps = positive(o.fps, ENCODE_DEFAULTS.fps);
  const graph = buildFilterGraph(o.plan, { shape: o.shape, fps, pad: o.pad });
  const crf = o.crf == null ? ENCODE_DEFAULTS.crf : o.crf;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", o.input,
    "-filter_complex", graph,
    "-map", "[v]",
    "-an",
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.0",
    "-preset", o.preset || ENCODE_DEFAULTS.preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
  const cap = bitrateCapKbps(o.maxBytes, o.plan.outMs);
  if (cap) args.push("-maxrate", `${cap}k`, "-bufsize", `${cap * 2}k`);
  args.push(o.output);
  return args;
}

/**
 * argv for the poster frame (the still LinkedIn shows before playback). `-ss`
 * BEFORE `-i` seeks by keyframe, which is fast and accurate enough for a
 * thumbnail; the frame is taken from the EDITED file, so the offset is in
 * output time.
 * @param {{ input: string, output: string, atMs?: number, width?: number }} o
 * @returns {string[]}
 */
export function posterArgs(o) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-ss", secs(o.atMs == null ? 1000 : o.atMs),
    "-i", o.input,
    "-frames:v", "1",
  ];
  if (o.width) args.push("-vf", `scale=${o.width}:-2:flags=lanczos`);
  args.push("-q:v", "3", o.output);
  return args;
}

/** argv for probing a finished (or raw) file's duration and frame size. */
/** @param {string} input */
export function ffprobeArgs(input) {
  return [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration,size:stream=width,height,r_frame_rate",
    "-of", "json",
    input,
  ];
}

/**
 * ffprobe's JSON -> the few numbers the pipeline uses. Fail-soft: a probe that
 * did not run, or ran against a file ffprobe could not parse, yields nulls
 * rather than throwing, and the caller falls back to the driver's own timing.
 * @param {any} json
 * @returns {{ seconds: number | null, bytes: number | null, width: number | null, height: number | null, fps: number | null }}
 */
export function parseProbe(json) {
  const fmt = json?.format || {};
  const stream = (json?.streams || [])[0] || {};
  const rate = String(stream.r_frame_rate || "");
  const m = rate.match(/^(\d+)\/(\d+)$/);
  return {
    seconds: num(fmt.duration),
    bytes: num(fmt.size),
    width: num(stream.width),
    height: num(stream.height),
    fps: m && Number(m[2]) ? Math.round((Number(m[1]) / Number(m[2])) * 100) / 100 : null,
  };
}

/** @param {any} v */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Human-readable rendering (the --dry-run view and the edit report)
// ---------------------------------------------------------------------------

/** @param {number} ms */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/**
 * The plan as a block an operator reads before spending encode time.
 * @param {EditPlan} plan
 * @param {{ shape?: string }} [opts]
 * @returns {string}
 */
export function formatPlan(plan, opts = {}) {
  const shape = resolveShape(opts.shape);
  const lines = [
    `source      ${formatDuration(plan.sourceMs)}`,
    `dead air    ${formatDuration(plan.waitMs)} measured, ${plan.waitMode === "cut" ? "cut" : plan.waitMode === "speed" ? "sped up" : "kept"}`,
    `removed     ${formatDuration(plan.cutMs)}`,
    `output      ${formatDuration(plan.outMs)}  (${shape.label})`,
    `compression ${plan.outMs > 0 ? (plan.sourceMs / plan.outMs).toFixed(1) : "—"}x shorter than the real run`,
    `segments    ${plan.segments.length}`,
  ];
  for (const [i, s] of plan.segments.entries()) {
    lines.push(
      `  ${String(i + 1).padStart(3)}  ${secs(s.start)}s → ${secs(s.end)}s  ${s.kind.padEnd(6)} ${s.speed}x`,
    );
  }
  return lines.join("\n") + "\n";
}

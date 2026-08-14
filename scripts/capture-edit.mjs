#!/usr/bin/env node
// @ts-check
// Capture post-production: a raw browser recording plus its activity timeline
// in, a LinkedIn-ready MP4 out. The second half of the capture pipeline —
// `tests/capture.mjs` records, this edits. See the **video-capture** skill.
//
//   node scripts/capture-edit.mjs captures/2026-08-14/cyber__…        one run
//   node scripts/capture-edit.mjs --all captures/2026-08-14           every run
//   node scripts/capture-edit.mjs <dir> --dry-run                      plan only
//
// What it does, in order:
//   1. reads meta.json + timeline.json + raw.webm from the capture directory
//   2. plans the cuts from the timeline (scripts/capture-core.mjs planEdit)
//   3. prints the plan — every segment, what was cut, how much shorter
//   4. runs one ffmpeg pass: trim → speed → concat → scale/pad → H.264
//   5. grabs a poster frame and probes the result
//   6. writes edit.json next to the video, and checks it against LinkedIn's
//      published limits
//
// OPTIONS
//   --shape portrait|square|landscape|raw   delivery frame (default portrait)
//   --speed <n>          playback speed for the parts where something happens
//   --wait cut|speed|keep  what to do with dead air (default cut)
//   --wait-speed <n>     multiplier for --wait speed (default 8)
//   --min-still <ms>     a pause must exceed this to count as dead (default 1500)
//   --hold <ms>          head of each dead span kept, so the state reads (default 600)
//   --end-hold <ms>      freeze the final content frame this long (default 1200)
//   --end-at eof         end at end-of-file instead of at the last content frame
//   --trim-start <ms>    head to drop; default is measured from the timeline
//                        (the page-load white flash). --trim-start 0 keeps it.
//   --trim-end <ms>      tail to drop, on top of ending at the last content frame
//   --crf <n>            quality target (lower is better; default 21)
//   --preset <name>      x264 preset (default slow)
//   --max-mb <n>         cap the file size by capping the bitrate
//   --fps <n>            output frame rate (default 30)
//   --poster-at <ms>     which output moment becomes the thumbnail
//   --poster end|mid     end (default) = the frozen finished answer; mid = 60% in
//   --out <file>         write the video somewhere other than <dir>/final.mp4
//   --dry-run            print the plan and the exact ffmpeg argv; encode nothing
//   --force              encode even when the recorded run FAILED verification
//                        (meta.json's verdict). Without it such a run is not
//                        encoded at all, so no final.mp4 exists to be uploaded
//                        by a later step that never read the verdict.
//
// ffmpeg and ffprobe must be on PATH (`apt-get install ffmpeg`,
// `brew install ffmpeg`). Without them --dry-run still works, which is how the
// plan is reviewed on a machine that has no encoder.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  checkDelivery,
  ffmpegArgs,
  ffprobeArgs,
  formatDuration,
  formatPlan,
  parseProbe,
  planContent,
  planEdit,
  posterArgs,
  posterAtMs,
  resolveShape,
} from "./capture-core.mjs";

// ---------------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const opts = { dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts.dirs.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "dry-run" || key === "all" || key === "help" || key === "force") {
      opts[key] = true;
      continue;
    }
    opts[key] = argv[++i];
  }
  return opts;
}

/** @param {any} v @param {number} [fallback] */
const n = (v, fallback) => (v == null || v === "" ? fallback : Number(v));

/** Does this binary exist and run? */
/** @param {string} bin */
function have(bin) {
  const r = spawnSync(bin, ["-version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A capture directory is anything holding a recording. `--all` walks one level.
/** @param {string} dir */
function isCaptureDir(dir) {
  return existsSync(join(dir, "raw.webm")) || existsSync(join(dir, "raw.mp4"));
}

/** @param {string} root */
function findCaptureDirs(root) {
  if (isCaptureDir(root)) return [root];
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => statSync(p).isDirectory() && isCaptureDir(p))
    .sort();
}

/** @param {string} dir */
function rawFile(dir) {
  for (const name of ["raw.webm", "raw.mp4"]) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

// ---------------------------------------------------------------------------
// One capture directory
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {Record<string, any>} opts
 * @returns {{ ok: boolean, dir: string, reason?: string, report?: any }}
 */
export function editCapture(dir, opts) {
  const input = rawFile(dir);
  if (!input) return { ok: false, dir, reason: "no raw.webm / raw.mp4 in this directory" };

  const meta = readJson(join(dir, "meta.json")) || {};
  const timeline = readJson(join(dir, "timeline.json")) || {};
  const samples = Array.isArray(timeline.samples) ? timeline.samples : [];
  const markers = Array.isArray(timeline.markers) ? timeline.markers : [];

  // The driver's own measured duration is the source of truth for planning:
  // the recording's container duration can lag the last sample by a frame or
  // two, and a plan that runs past the end of the file makes ffmpeg emit an
  // empty final segment.
  const sourceMs = n(opts["source-ms"], timeline.durationMs || meta.durationMs || 0) || 0;
  if (!sourceMs) {
    return { ok: false, dir, reason: "no duration in timeline.json/meta.json — pass --source-ms" };
  }

  const shape = resolveShape(opts.shape || meta.shape);
  const plan = planEdit({
    sourceMs,
    samples,
    markers,
    // Left undefined, the head trim is derived from the timeline (the
    // page-load white flash). `--trim-start 0` opts out explicitly.
    trimStartMs: n(opts["trim-start"], undefined),
    trimEndMs: n(opts["trim-end"], 0),
    minStillMs: n(opts["min-still"], undefined),
    holdMs: n(opts.hold, undefined),
    endHoldMs: n(opts["end-hold"], undefined),
    endAtContent: String(opts["end-at"] || "content") !== "eof",
    speed: n(opts.speed, undefined),
    waitMode: opts.wait,
    waitSpeed: n(opts["wait-speed"], undefined),
  });

  const output = opts.out ? resolve(String(opts.out)) : join(dir, "final.mp4");
  const poster = join(dir, "poster.jpg");
  const maxBytes = opts["max-mb"] ? Number(opts["max-mb"]) * 1024 * 1024 : null;
  const encodeArgs = ffmpegArgs({
    input,
    output,
    plan,
    shape: shape.id,
    fps: n(opts.fps, undefined),
    crf: n(opts.crf, undefined),
    preset: opts.preset,
    maxBytes,
  });

  console.log(`\n── ${basename(dir)}`);
  if (meta.prompt) console.log(`   ${meta.agent || "?"} · ${meta.model || "?"}\n   “${truncate(meta.prompt, 96)}”`);
  console.log(formatPlan(plan, { shape: shape.id }));

  // The tail verdict does not need the encoder, so it is printed on a dry run
  // too — which is the only view available on a machine without ffmpeg, and
  // the whole point is to catch "this clip ends on nothing" BEFORE encoding.
  const tailCheck = checkDelivery({ content: planContent(plan) });
  for (const p of tailCheck.problems) console.log(`   ✗ ${p}`);
  for (const w of tailCheck.warnings) console.log(`   ! ${w}`);

  // THE VERDICT IS ENFORCED HERE, and this is the only place it can be. The
  // driver grades every run and writes the verdict into meta.json, but grading
  // a run and refusing to ship it are two different things: #CAP-21 and #CAP-22
  // were both recorded, encoded, uploaded and put in front of the owner with
  // their failure sitting in the last frame. "A capture whose app fails is not
  // published" was a convention, and a convention is not a mechanism.
  //
  // Refusing at the EDIT stage rather than at upload is deliberate: it costs
  // the encode too, and it means no final.mp4 exists to be uploaded by hand or
  // by a later loop that never saw the verdict. The clip and its endframe.png
  // stay on disk with their reasons, exactly as a failed Agent Studio app does.
  //
  // --force is the override, and it prints what it is overriding — a batch that
  // deliberately ships a known-bad clip (to show the failure, say) can, but
  // nobody does it by accident.
  const verdict = meta.verdict;
  if (verdict && verdict.ok === false) {
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : [];
    const lines = reasons.map((r) => `     · ${r?.detail || r?.id || String(r)}`).join("\n");
    console.log(`   ✗ the recorded run FAILED verification\n${lines}`);
    console.log(`     endframe: ${join(dir, "endframe.png")}`);
    // A dry run still prints its plan: inspecting a failed run is exactly when
    // you want to see one, and nothing is produced by looking.
    if (!opts["dry-run"] && !opts.force) {
      return {
        ok: false,
        dir,
        reason: "the recorded run FAILED verification — not encoding it; re-record, or --force",
      };
    }
    if (opts.force) console.log("   ! --force: encoding it anyway");
  }

  if (opts["dry-run"]) {
    console.log(`ffmpeg ${encodeArgs.join(" ")}\n`);
    return { ok: true, dir, report: { plan, dryRun: true, linkedin: tailCheck } };
  }

  if (!have("ffmpeg")) {
    return { ok: false, dir, reason: "ffmpeg is not on PATH (apt-get install ffmpeg / brew install ffmpeg)" };
  }

  const started = Date.now();
  const run = spawnSync("ffmpeg", encodeArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (run.status !== 0) {
    return { ok: false, dir, reason: `ffmpeg exited ${run.status}${run.error ? ` (${run.error.message})` : ""}` };
  }

  // The poster comes from the EDITED file, so its offset is output time — a
  // frame taken from the raw recording would usually land inside a cut. It is
  // taken from the END HOLD by default: the deck's card shows the poster, so
  // the poster has to be the frame that says whether the run succeeded
  // (owner directive, 2026-08-12). `--poster mid` restores the older 60%-in
  // frame, which showed an answer mid-stream and looked the same whether the
  // run finished or died.
  const posterAt = posterAtMs(plan, { atMs: n(opts["poster-at"], null), mode: opts.poster });
  spawnSync("ffmpeg", posterArgs({ input: output, output: poster, atMs: posterAt, width: shape.out?.width }), {
    stdio: "ignore",
  });
  if (!existsSync(poster)) console.log(`   ! no poster frame at ${Math.round(posterAt)} ms of output`);

  const probed = have("ffprobe")
    ? parseProbe(readProbe(output))
    : { seconds: plan.outMs / 1000, bytes: null, width: null, height: null, fps: null };
  const delivery = checkDelivery({
    bytes: probed.bytes ?? undefined,
    seconds: probed.seconds ?? undefined,
    width: probed.width ?? shape.out?.width,
    height: probed.height ?? shape.out?.height,
    content: planContent(plan),
  });

  const report = {
    dir,
    input,
    output,
    poster: existsSync(poster) ? poster : null,
    poster_at_ms: Math.round(posterAt),
    shape: shape.id,
    encoded_in_ms: Date.now() - started,
    source_ms: plan.sourceMs,
    output_ms: Math.round(plan.outMs),
    cut_ms: Math.round(plan.cutMs),
    dead_air_ms: Math.round(plan.waitMs),
    head_trim_ms: Math.round(plan.headTrimMs),
    head_trim_source: plan.headTrimSource,
    end_hold_ms: Math.round(plan.endHoldMs),
    content_end_ms: plan.contentEndMs == null ? null : Math.round(plan.contentEndMs),
    content_status: plan.contentStatus,
    tail_ms: Math.round(plan.tailMs),
    wait_mode: plan.waitMode,
    speed: plan.speed,
    segments: plan.segments,
    probe: probed,
    linkedin: delivery,
    meta,
  };
  writeFileSync(join(dir, "edit.json"), JSON.stringify(report, null, 2));

  const size = probed.bytes ? `${(probed.bytes / (1024 * 1024)).toFixed(1)} MB` : "?";
  console.log(
    `   → ${basename(output)}  ${formatDuration(plan.outMs)}  ${size}  ${probed.width || "?"}x${probed.height || "?"}`,
  );
  // The tail advisories were printed before the encode; don't say them twice.
  const said = new Set([...tailCheck.problems, ...tailCheck.warnings]);
  for (const p of delivery.problems) if (!said.has(p)) console.log(`   ✗ ${p}`);
  for (const w of delivery.warnings) if (!said.has(w)) console.log(`   ! ${w}`);
  return { ok: true, dir, report };
}

/** @param {string} file */
function readProbe(file) {
  const r = spawnSync("ffprobe", ffprobeArgs(file), { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** @param {string} s @param {number} max */
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.dirs.length) {
    // The header comment IS the help text — one place to keep current. Skip
    // the shebang and the `// @ts-check` pragma, then take comment lines up to
    // the first blank/code line.
    const header = [];
    for (const line of readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(2)) {
      if (!line.startsWith("//")) break;
      header.push(line.replace(/^\/\/ ?/, ""));
    }
    console.log(header.join("\n"));
    process.exit(opts.help ? 0 : 1);
  }
  const dirs = opts.all ? opts.dirs.flatMap((/** @type {string} */ d) => findCaptureDirs(d)) : opts.dirs;
  if (!dirs.length) {
    console.error("No capture directories found (a capture directory holds raw.webm).");
    process.exit(1);
  }
  if (opts.out && dirs.length > 1) {
    console.error("--out names one file; it cannot be combined with a multi-directory run.");
    process.exit(1);
  }
  if (opts.out) mkdirSync(resolve(String(opts.out), ".."), { recursive: true });

  let failed = 0;
  for (const dir of dirs) {
    const res = editCapture(dir, opts);
    if (!res.ok) {
      failed++;
      console.error(`   ✗ ${basename(dir)}: ${res.reason}`);
    }
  }
  console.log(`\n${dirs.length - failed}/${dirs.length} edited.`);
  process.exit(failed ? 1 : 0);
}

// Importable for tests; only the CLI invocation runs main.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();

#!/usr/bin/env node
// The introspection feature's source-snapshot bundler (see the
// **introspection** skill). Walks the git-TRACKED text files of this repo and
// writes them, uncompressed, into ONE deterministic JSON artifact:
//
//   public/introspect/source-snapshot.json
//
// That artifact is committed and deploys with the site like any other static
// asset, which is the whole point: the snapshot a deploy serves is BY
// CONSTRUCTION the exact source that deploy runs (same commit, same upload) —
// no GitHub fetch at runtime, no drift window, no decompression anywhere. Its
// three consumers:
//   1. src/introspect.js        — the DRS server enrichment (env.ASSETS.fetch)
//   2. public/js/stream.js + public/cure/drc.js — the browser fetches it and
//      mounts the tree into the CheerpX sandbox at /src (Tier-1 DataDevice:
//      pre-bundled raw bytes streamed host→guest; no archive to unpack)
//   3. public/js/introspect-core.js — builds the in-context source blocks
//
// Determinism: files sorted by path, no timestamp — regenerating from an
// unchanged tree is byte-identical, so `--check` (run by the unit suite,
// src/introspect.test.js) can enforce freshness: if you change any bundled
// source file, `npm test` fails until you re-run `npm run bundle`.
//
// Output format: one JSON object per line in `files` (git-diff friendly),
// {p: path, s: byte size, t: full text}. sha-256 digest over path+content.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "public/introspect/source-snapshot.json";

// The agent registry, written a second time as a standalone artifact. Both come
// from the same source of truth — `sdk/AGENTS.json`, which is also inside the
// snapshot — and `--check` fails if either has drifted, so the two copies cannot
// disagree without failing `npm test`. Why a copy at all: since the general
// agent was retired (2026-08-13) the Worker resolves the registry on EVERY chat
// request, and reading it out of the multi-megabyte snapshot would mean parsing
// five megabytes of source per isolate to reach forty kilobytes of specs.
// See public/js/introspect-core.js AGENTS_REGISTRY_PATH.
const AGENTS_SRC = "sdk/AGENTS.json";
const AGENTS_OUT = "public/introspect/agents.json";

// Text source only — the snapshot is for reading and grep'ing, not serving
// media. Everything here must stay valid UTF-8 (checked below anyway).
const TEXT_EXT = /\.(js|mjs|cjs|d\.ts|css|html|md|json|toml|txt|webmanifest|sh|py|yml|yaml)$/i;

// Not source: vendored libs (upstream code, big), icons/media (binary),
// lockfiles (noise), generated fixtures, and the snapshot itself (self-
// reference would make the artifact impossible to stabilize).
const EXCLUDE = [
  /^public\/vendor\//,
  /^public\/icons\//,
  /^public\/introspect\//,
  // The ancient-sample corpus (scripts/aadr-build.mjs) — a 2 MB generated DATA
  // artifact, not source. Bundling it would grow the snapshot every session
  // reads by a fifth and put 20,927 tab-separated rows in front of a model
  // asked how the site works.
  /^public\/aadr\//,
  // The Google Scholar venue-metrics table (scripts/scholar-venues.mjs) — same
  // reasoning: 4,652 generated rows of h5-index data, not source.
  /^public\/scholar\//,
  /(^|\/)package-lock\.json$/,
  /^tests\/fixtures\//,
];

// Safety valve: a single tracked text file larger than this is almost
// certainly data, not source — skipped (none exist today).
const PER_FILE_MAX = 512 * 1024;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/**
 * Files that WOULD be in the snapshot if they were tracked.
 *
 * The snapshot enumerates `git ls-files`, so a file that has merely been
 * created is invisible to it. Write a doc, regenerate, `git add -A`, commit —
 * and the artifact is one file short of the tree it claims to describe, which
 * only surfaces later as a STALE failure in CI. That sequence is easy to walk
 * into (it cost two CI cycles in one session), and the failure names the
 * artifact rather than the missed file, so the warning points at the cause.
 *
 * Untracked is not an error: a scratch file in the tree is ordinary. This only
 * warns, and only about paths the snapshot would otherwise have taken.
 */
function untrackedCandidates() {
  const out = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((p) => TEXT_EXT.test(p))
    .filter((p) => !EXCLUDE.some((re) => re.test(p)))
    .sort();
}

export function buildSnapshotJson() {
  const paths = trackedFiles()
    .filter((p) => TEXT_EXT.test(p))
    .filter((p) => !EXCLUDE.some((re) => re.test(p)))
    .sort();
  const files = [];
  let bytes = 0;
  const hash = createHash("sha256");
  for (const p of paths) {
    const buf = readFileSync(join(ROOT, p));
    if (buf.length > PER_FILE_MAX) continue;
    if (buf.includes(0)) continue; // binary masquerading as text
    const text = buf.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== buf.length) continue; // invalid UTF-8
    files.push({ p, s: buf.length, t: text });
    bytes += buf.length;
    hash.update(p);
    hash.update("\0");
    hash.update(buf);
  }
  const digest = hash.digest("hex");
  // One file entry per line: keeps the committed artifact diff- and
  // delta-friendly across commits that touch a handful of files.
  const head = JSON.stringify({ v: 1, digest, count: files.length, bytes });
  const lines = files.map((f) => JSON.stringify(f));
  return head.slice(0, -1) + ',"files":[\n' + lines.join(",\n") + "\n]}\n";
}

function main() {
  const check = process.argv.includes("--check");
  const json = buildSnapshotJson();
  const outPath = join(ROOT, OUT);
  // The registry copy is byte-identical to its source, deliberately: anything
  // clever here (re-serializing, stripping the prose notes) would be a second
  // place the two could differ.
  const agentsJson = readFileSync(join(ROOT, AGENTS_SRC), "utf8");
  const agentsOutPath = join(ROOT, AGENTS_OUT);
  if (check) {
    const currentAgents = existsSync(agentsOutPath) ? readFileSync(agentsOutPath, "utf8") : "";
    if (currentAgents !== agentsJson) {
      console.error(
        `STALE: ${AGENTS_OUT} does not match ${AGENTS_SRC}.\n` +
          "Re-run `npm run bundle` (node scripts/bundle-source.mjs) and commit the result.",
      );
      process.exit(1);
    }
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    if (current !== json) {
      console.error(
        `STALE: ${OUT} does not match the working tree.\n` +
          "Re-run `npm run bundle` (node scripts/bundle-source.mjs) and commit the result.",
      );
      // The likeliest cause, named rather than left to be rediscovered: the
      // snapshot took a file that was untracked when it last ran.
      const missed = untrackedCandidates();
      if (missed.length) {
        console.error(
          `\nNote: ${missed.length} untracked file(s) would belong in the snapshot. ` +
            "The snapshot enumerates `git ls-files`, so `git add` them BEFORE regenerating:\n" +
            missed.map((p) => `  ${p}`).join("\n"),
        );
      }
      process.exit(1);
    }
    console.log(`${OUT} and ${AGENTS_OUT} are up to date.`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  writeFileSync(agentsOutPath, agentsJson);
  const parsed = JSON.parse(json);
  console.log(`Wrote ${OUT}: ${parsed.count} files, ${parsed.bytes} bytes, digest ${parsed.digest.slice(0, 12)}…`);
  console.log(`Wrote ${AGENTS_OUT}: ${JSON.parse(agentsJson).agents.length} agents.`);
}

main();

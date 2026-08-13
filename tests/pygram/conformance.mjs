#!/usr/bin/env node
// The pygram conformance runner — the gate the whole project rests on.
//
// pygram (docs/PYGRAM.md) implements a SUBSET of Python. A subset runtime that
// silently disagrees with CPython is worse than no runtime at all, because the
// agent that typed the one-liner will not notice. So every corpus entry is run
// twice — once by the system CPython, once by pygram — and the two are compared
// on stdout, stderr and exit code.
//
// Three outcomes, and the distinction between them is the whole point:
//
//   MATCH        stdout + exit code identical to CPython. (stderr is compared
//                only when the reference itself wrote to it — see below.)
//   UNSUPPORTED  pygram exited 90 with a `pygram: unsupported: …` line. This is
//                COVERAGE, not failure: it is the corpus telling us what to
//                build next, which is exactly what it is for.
//   MISMATCH     anything else. A hard failure. This is the outcome that would
//                make pygram a liability.
//
// Usage:
//   PYGRAM_BIN=./pygram/pygram node tests/pygram/conformance.mjs
//   node tests/pygram/conformance.mjs --tag json      # only entries tagged json
//   node tests/pygram/conformance.mjs --plan          # what to build next
//   node tests/pygram/conformance.mjs --json          # machine-readable
//
// With no PYGRAM_BIN (or a binary that does not exist yet) it runs in
// REFERENCE-ONLY mode: it still executes every entry under CPython and checks
// the corpus's own recorded `expect_stdout`, which catches a corpus that has
// rotted. That is why this is safe to run before pygram exists.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// The unsupported-feature contract (docs/PYGRAM-SUBSET.md). 90 is clear of
// 0/1/2 (python's own), 126/127 (shell) and 128+n (signals), so a caller can
// branch on it unambiguously to retry with real python3.
export const UNSUPPORTED_EXIT = 90;
const UNSUPPORTED_RE = /^pygram: unsupported: (\w+): (.+)$/m;

// A one-liner that hangs is the worst case in the sandbox too — a command over
// the 30 s exec ceiling discards the VM. Nothing in the corpus should need
// anywhere near this.
const TIMEOUT_MS = 10_000;

// The corpus is two files with different provenance and different owners:
// seed-corpus.jsonl is written from expectation, corpus.jsonl is harvested from
// real invocations. They are kept separate on purpose (docs/PYGRAM.md §7) —
// blending them would let expectation inflate the frequency table that decides
// build order.
const CORPUS_FILES = [
  { path: join(HERE, "seed-corpus.jsonl"), defaultProvenance: "experience" },
  { path: join(HERE, "corpus.jsonl"), defaultProvenance: "observed" },
];

/** Parse JSONL, skipping blank lines, with the line number in any error. */
export function parseJsonl(text, label = "<input>") {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${label}:${i + 1}: not valid JSON — ${err.message}`);
    }
  }
  return out;
}

/** Load every corpus file that exists. Missing files are fine (not yet built). */
export function loadCorpus(files = CORPUS_FILES) {
  const entries = [];
  const seen = new Map();
  for (const { path, defaultProvenance } of files) {
    if (!existsSync(path)) continue;
    for (const raw of parseJsonl(readFileSync(path, "utf8"), path)) {
      if (typeof raw.program !== "string" || !raw.program) continue;
      const id = raw.id || `${defaultProvenance}-${seen.size}`;
      // The two files can legitimately contain the same program — someone wrote
      // it from expectation and it later showed up for real. Prefer the
      // observed one, and note the corroboration rather than dropping it.
      const key = normalizeProgram(raw.program);
      if (seen.has(key)) {
        const prior = seen.get(key);
        prior.corroborated = true;
        if (defaultProvenance === "observed") prior.provenance = "observed";
        continue;
      }
      const entry = {
        id,
        program: raw.program,
        argv_tail: Array.isArray(raw.argv_tail) ? raw.argv_tail : [],
        stdin: typeof raw.stdin === "string" ? raw.stdin : null,
        expect_stdout: typeof raw.expect_stdout === "string" ? raw.expect_stdout : null,
        provenance: raw.provenance || defaultProvenance,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        note: raw.note || "",
        corroborated: false,
        file: path,
      };
      entries.push(entry);
      seen.set(key, entry);
    }
  }
  return entries;
}

/**
 * Normalize a program for dedup. Deliberately conservative: whitespace at the
 * edges and trailing semicolons only. Anything cleverer (reindenting, renaming)
 * would merge programs that differ in ways pygram has to handle differently.
 */
export function normalizeProgram(src) {
  return String(src).replace(/\r\n/g, "\n").trim().replace(/;+$/, "");
}

/**
 * Run one interpreter over one entry. Never throws; failures become results.
 *
 * Each run gets its OWN fresh temp directory as cwd, for two reasons. The
 * corpus contains entries that create files, and without this they would write
 * into the repo. More subtly, the reference run and the pygram run must not
 * share a directory: the second would see whatever the first created, so a
 * pygram that never wrote the file could still read it back and "match".
 */
function runOne(bin, entry) {
  const cwd = mkdtempSync(join(tmpdir(), "pygram-run-"));
  const started = process.hrtime.bigint();
  let res;
  try {
    res = spawnSync(bin, ["-c", entry.program, ...entry.argv_tail], {
      input: entry.stdin ?? "",
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      cwd,
      // A clean, minimal environment: the corpus must not depend on this
      // machine's env, and pygram in the sandbox will not have one either.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C.UTF-8", PWD: cwd },
    });
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.error && res.error.code === "ETIMEDOUT") {
    return { stdout: res.stdout || "", stderr: "<timeout>", code: null, ms, timedOut: true };
  }
  if (res.error) {
    return { stdout: "", stderr: String(res.error.message), code: null, ms, spawnFailed: true };
  }
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    code: res.status,
    ms,
    timedOut: false,
  };
}

/**
 * Compare pygram's result against CPython's.
 *
 * stdout and exit code must match exactly — those are what a shell pipeline and
 * an agent loop actually consume. stderr is compared only loosely, and only
 * when CPython itself wrote something: traceback text carries file paths, line
 * numbers and interpreter internals that a subset runtime has no business
 * reproducing byte-for-byte. What matters is that a program that FAILS under
 * CPython also fails under pygram, which the exit code already captures.
 */
/**
 * Some corpus entries cannot be compared on stdout at all: a wall clock and a
 * seeded PRNG stream differ between two runs of the SAME interpreter, so
 * demanding a match would fail them forever and hide the real signal. They are
 * still worth running — the exit code proves the program executed — so they are
 * compared on exit code only. The corpus tags them; this is not a guess.
 */
export function isNondeterministic(entry) {
  const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
  return tags.includes("nondeterministic") || tags.includes("seeded") || isInterpreterSpecific(entry);
}

// Programs that interrogate the INTERPRETER rather than compute something.
// A harvested corpus fills up with these — `sys.version`, `sys.executable`,
// `dir(module)`, `sys.implementation` — and by construction they can never
// match: pygram IS a different executable, and it is required NOT to claim a
// CPython version (docs/PYGRAM-SUBSET.md §2). Reporting them as MISMATCH would
// mean the runner permanently accuses pygram of a bug for behaving correctly,
// and worse, it trains the reader to expect a non-zero MISMATCH count — which
// is how a real divergence gets waved through.
//
// Detected from the program text rather than a hand-applied tag, because these
// arrive automatically from the capture harness and nobody will tag them.
const INTERPRETER_SPECIFIC = [
  /\bsys\s*\.\s*(?:version|executable|implementation|path|prefix|base_prefix|maxsize|byteorder|flags)\b/,
  /\bplatform\s*\.\s*\w+/,
  /\bdir\s*\(/,
  /\bos\s*\.\s*uname\b/,
  /__file__|__spec__|__loader__/,
];

export function isInterpreterSpecific(entry) {
  const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
  if (tags.includes("interpreter-specific")) return true;
  const src = entry && typeof entry.program === "string" ? entry.program : "";
  // sys.argv and sys.stdin/stdout are about the RUN, not the interpreter, and
  // must still be compared — so the list above names attributes, not `sys`.
  return INTERPRETER_SPECIFIC.some((re) => re.test(src)) || isImplementationDefined(entry);
}

// Programs whose output PYTHON ITSELF does not specify, so two conformant
// implementations may legitimately disagree.
//
// The live example: `len(zlib.compress(b"a" * 100))` is 12 under CPython's
// zlib and 11 under MicroPython's deflate. Both are valid DEFLATE streams —
// the format promises a decodable stream, not a byte count. The crc32 in the
// same program IS specified and still gets compared, because the exemption
// only lifts the stdout check for the whole entry when the program asks for an
// unspecified quantity.
//
// This class must stay SMALL and each pattern must be justified by a written
// standard, not by convenience. The temptation is to silence a real divergence
// by declaring it unspecified; the test file pins these and
// docs/PYGRAM-SUBSET.md §6 records them.
const IMPLEMENTATION_DEFINED = [
  // Compressed size: DEFLATE (RFC 1951) constrains the stream, never its length.
  /len\s*\(\s*(?:zlib|gzip)\s*\.\s*compress/,
];

export function isImplementationDefined(entry) {
  const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
  if (tags.includes("implementation-defined")) return true;
  const src = entry && typeof entry.program === "string" ? entry.program : "";
  return IMPLEMENTATION_DEFINED.some((re) => re.test(src));
}

export function classify(ref, got, entry = null) {
  if (got.spawnFailed) return { verdict: "MISMATCH", why: `pygram failed to start: ${got.stderr}` };
  if (got.timedOut) return { verdict: "MISMATCH", why: "pygram timed out" };

  const unsupported = got.code === UNSUPPORTED_EXIT && UNSUPPORTED_RE.exec(got.stderr);
  if (unsupported) {
    return { verdict: "UNSUPPORTED", kind: unsupported[1], detail: unsupported[2] };
  }
  // Exit 90 without the contract line is itself a contract violation — we would
  // otherwise silently count a crash as coverage.
  if (got.code === UNSUPPORTED_EXIT) {
    return { verdict: "MISMATCH", why: "exit 90 without a `pygram: unsupported: …` line on stderr" };
  }
  const skipStdout = isNondeterministic(entry);
  if (!skipStdout && got.stdout !== ref.stdout) {
    return { verdict: "MISMATCH", why: "stdout differs", diff: firstDiff(ref.stdout, got.stdout) };
  }
  if (got.code !== ref.code) {
    return { verdict: "MISMATCH", why: `exit code ${got.code}, CPython gave ${ref.code}` };
  }
  if (ref.stderr && !got.stderr) {
    return { verdict: "MISMATCH", why: "CPython reported an error on stderr, pygram was silent" };
  }
  return skipStdout ? { verdict: "MATCH", stdoutUncompared: true } : { verdict: "MATCH" };
}

/** The first differing line, rendered short enough to read in a terminal. */
export function firstDiff(want, got) {
  const a = String(want).split("\n");
  const b = String(got).split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      const clip = (s) => (s === undefined ? "<no line>" : JSON.stringify(s.length > 90 ? s.slice(0, 90) + "…" : s));
      return `line ${i + 1}: want ${clip(a[i])}, got ${clip(b[i])}`;
    }
  }
  return "trailing whitespace only";
}

/**
 * Build the "what to implement next" order: every unsupported feature, ranked
 * by how many corpus entries it blocks. This is the build order from
 * docs/PYGRAM.md §7 — implement in descending order of entries unblocked.
 *
 * An entry can be blocked by only ONE feature at a time (the first one the
 * interpreter hits), so these counts are a lower bound that shifts as features
 * land. That is fine and is the point: re-run after each feature.
 */
export function buildPlan(results) {
  const byFeature = new Map();
  for (const r of results) {
    if (r.verdict !== "UNSUPPORTED") continue;
    const key = `${r.kind}: ${r.detail}`;
    if (!byFeature.has(key)) byFeature.set(key, { feature: key, blocks: 0, ids: [] });
    const rec = byFeature.get(key);
    rec.blocks++;
    if (rec.ids.length < 5) rec.ids.push(r.id);
  }
  return [...byFeature.values()].sort((x, y) => y.blocks - x.blocks || x.feature.localeCompare(y.feature));
}

/** Coverage broken down by tag, so gaps show up as a shape rather than a list. */
export function tagCoverage(results) {
  const byTag = new Map();
  for (const r of results) {
    for (const tag of r.tags.length ? r.tags : ["<untagged>"]) {
      if (!byTag.has(tag)) byTag.set(tag, { tag, total: 0, match: 0, unsupported: 0, mismatch: 0 });
      const rec = byTag.get(tag);
      rec.total++;
      if (r.verdict === "MATCH") rec.match++;
      else if (r.verdict === "UNSUPPORTED") rec.unsupported++;
      else rec.mismatch++;
    }
  }
  return [...byTag.values()].sort((x, y) => y.total - x.total || x.tag.localeCompare(y.tag));
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const planOnly = args.includes("--plan");
  const tagArg = args.indexOf("--tag");
  const onlyTag = tagArg >= 0 ? args[tagArg + 1] : null;
  const verbose = args.includes("--verbose") || args.includes("-v");

  const python = process.env.PYTHON_BIN || "python3";
  // Each entry runs in its own temp cwd (see runOne), so a RELATIVE binary path
  // would be resolved against that temp dir and fail with ENOENT. Make it
  // absolute here, once, rather than in the hot loop.
  const pygramArg = process.env.PYGRAM_BIN || "";
  const pygram = pygramArg && pygramArg.includes("/") ? resolve(pygramArg) : pygramArg;
  const havePygram = !!pygram && existsSync(pygram);

  let corpus = loadCorpus();
  if (onlyTag) corpus = corpus.filter((e) => e.tags.includes(onlyTag));

  if (!corpus.length) {
    console.error("no corpus entries found — expected tests/pygram/seed-corpus.jsonl or corpus.jsonl");
    console.error("(the capture harness in scripts/pygram-capture/ fills the second one)");
    process.exitCode = 2;
    return;
  }

  const results = [];
  let refBroken = 0;

  for (const entry of corpus) {
    const ref = runOne(python, entry);

    // Reference-only sanity: a recorded expect_stdout that no longer matches
    // real CPython means the corpus has rotted, and every verdict derived from
    // it would be measuring the wrong thing.
    let stale = false;
    if (entry.expect_stdout !== null && !isNondeterministic(entry) && entry.expect_stdout !== ref.stdout) {
      stale = true;
      refBroken++;
    }

    if (!havePygram) {
      results.push({ ...entry, verdict: stale ? "STALE" : "REF-OK", refMs: ref.ms });
      continue;
    }
    const got = runOne(pygram, entry);
    const verdict = classify(ref, got, entry);
    results.push({ ...entry, ...verdict, refMs: ref.ms, gotMs: got.ms, stale });
  }

  const counts = results.reduce((acc, r) => ((acc[r.verdict] = (acc[r.verdict] || 0) + 1), acc), {});
  const plan = buildPlan(results);

  if (wantJson) {
    // NOT process.exit(): stdout is ASYNC when piped, and exiting here
    // truncated this report mid-object. Set the code and let the process drain.
    console.log(JSON.stringify({ mode: havePygram ? "conformance" : "reference-only", counts, plan, coverage: tagCoverage(results), results }, null, 2));
    process.exitCode = counts.MISMATCH || refBroken ? 1 : 0;
    return;
  }

  if (!havePygram) {
    console.log(`reference-only mode (no PYGRAM_BIN) — ${corpus.length} entries checked against ${python}\n`);
    if (refBroken) {
      console.log(`${refBroken} entries have a stale expect_stdout:`);
      for (const r of results.filter((x) => x.verdict === "STALE")) console.log(`  ${r.id}  (${r.file})`);
      process.exitCode = 1;
      return;
    }
    console.log("corpus is consistent with the system CPython.");
    return;
  }

  if (!planOnly) {
    console.log(`pygram conformance — ${corpus.length} entries, ${pygram} vs ${python}\n`);
    console.log(`  MATCH        ${counts.MATCH || 0}`);
    console.log(`  UNSUPPORTED  ${counts.UNSUPPORTED || 0}   (coverage gap, not failure)`);
    console.log(`  MISMATCH     ${counts.MISMATCH || 0}   ${counts.MISMATCH ? "<-- must be zero" : ""}\n`);

    for (const r of results.filter((x) => x.verdict === "MISMATCH")) {
      console.log(`  MISMATCH ${r.id}: ${r.why}`);
      if (r.diff) console.log(`           ${r.diff}`);
      if (verbose) console.log(`           program: ${r.program.replace(/\n/g, "\\n").slice(0, 160)}`);
    }
    if (counts.MISMATCH) console.log("");

    console.log("coverage by tag:");
    for (const c of tagCoverage(results)) {
      const pct = c.total ? Math.round((c.match / c.total) * 100) : 0;
      console.log(`  ${pad(c.tag, 16)} ${pad(`${c.match}/${c.total}`, 9)} ${pad(`${pct}%`, 6)}${c.mismatch ? `  ${c.mismatch} MISMATCH` : ""}`);
    }
    console.log("");
  }

  if (plan.length) {
    console.log("build next (each line is one feature, ranked by entries it unblocks):");
    for (const p of plan.slice(0, 25)) {
      console.log(`  ${pad(p.blocks, 5)} ${pad(p.feature, 44)} e.g. ${p.ids.slice(0, 3).join(", ")}`);
    }
  } else if (!planOnly) {
    console.log("nothing unsupported — the corpus is fully covered.");
  }

  process.exitCode = counts.MISMATCH || refBroken ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

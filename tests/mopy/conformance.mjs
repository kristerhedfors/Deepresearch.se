#!/usr/bin/env node
// The Mixture-of-Pythons conformance + routing runner.
//
// pygram's runner (tests/pygram/conformance.mjs) answers ONE question: does
// pygram agree with CPython? Mopy adds a second interpreter and a classifier,
// so there are two more:
//
//   1. Does each engine agree with CPython?  — the same three-way verdict per
//      engine (MATCH / UNSUPPORTED / MISMATCH), where MISMATCH must be zero and
//      UNSUPPORTED is coverage, not failure.
//   2. Does the ROUTER send each program to an engine that can actually run it?
//      This is the new measurement and it has an asymmetric cost model:
//
//        UNSAFE   routed to an engine that MISMATCHES. Fatal — the whole point
//                 of the mixture is that a wrong route costs time, never
//                 correctness. Must be zero.
//        WASTED   routed to an engine that refuses (exit 90). Costs one extra
//                 process spawn (~2 ms) and nothing else.
//        LATE     routed past an engine that would have worked. Costs the
//                 difference in run time — this is the number the classifier is
//                 tuned to reduce.
//        IDEAL    routed to the cheapest engine that matches.
//
//   3. Does the DISPATCHER produce CPython's answer? The routing score above
//      grades the FIRST guess; `mopy run` is allowed to recover from a bad one
//      (`main.rs::fall_onward`). So the mixture is measured as its own arm,
//      end to end, and that arm is the one CI gates on: an UNSAFE route the
//      dispatcher recovers from costs a spawn, while a mixture MISMATCH is a
//      wrong answer reaching the caller.
//
// Usage:
//   node tests/mopy/conformance.mjs                   # all three engines + routing
//   node tests/mopy/conformance.mjs --engine mopy     # one engine
//   node tests/mopy/conformance.mjs --plan            # what to build next in mopy
//   node tests/mopy/conformance.mjs --routing         # routing table only
//   node tests/mopy/conformance.mjs --json
//   node tests/mopy/conformance.mjs --limit 50 --tag json

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  firstDiff,
  isNondeterministic,
  loadCorpus,
  referencePython,
} from "../pygram/conformance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

export const UNSUPPORTED_EXIT = 90;
const TIMEOUT_MS = 10_000;

/**
 * The repository's dirty-file list, as git sees it.
 *
 * The runner EXECUTES every corpus program, and the corpus is harvested from a
 * real agent session — so it is full of programs that edit this repository's
 * own files. Each entry gets its own temp cwd, which contains relative paths;
 * 17 entries carry an ABSOLUTE path and 3 of those can write.
 *
 * This is not theoretical. During this project's first measurement runs, 34
 * tracked files were rewritten — including a duplicated function in
 * `src/pipeline-inputs.js` that broke 37 unrelated tests and cost a full
 * restore. The exact escape route was never pinned down afterwards, which is
 * precisely the argument for a net rather than a targeted fix: the run is
 * bracketed, anything that changed and was not dirty to begin with is reported
 * and RESTORED, and the run fails.
 *
 * It is a net, not a sandbox — it cannot undo a write outside the repository.
 * What it buys is that the next occurrence is loud instead of silent.
 */
export function repoDirtyList(root) {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  } catch {
    return null;
  }
}

/** The static musl build if it exists, else the glibc one. The difference is
 *  1.33 ms vs 0.24 ms of startup and 5 file opens vs 0 (scripts/mopy-build.sh),
 *  so measuring the wrong one understates mopy by more than everything else
 *  this benchmark varies. */
export function mopyBin() {
  if (process.env.MOPY_BIN) return process.env.MOPY_BIN;
  for (const t of ["x86_64-unknown-linux-musl", "i686-unknown-linux-musl"]) {
    const p = join(ROOT, `mopy/target/${t}/release/mopy`);
    if (existsSync(p)) return p;
  }
  return join(ROOT, "mopy/target/release/mopy");
}

/** The dispatcher, measured end to end. Not part of the ladder — it USES it. */
export function mixtureArm() {
  return {
    name: "mixture",
    path: mopyBin(),
    args: ["run"],
    env: {
      MOPY_PYGRAM: process.env.PYGRAM_BIN || join(ROOT, "pygram/build/pygram"),
      MOPY_CPYTHON: referencePython(),
    },
  };
}

/** The engine ladder, cheapest first. Order IS the routing preference. */
export const ENGINES = [
  { name: "mopy", bin: () => mopyBin() },
  { name: "pygram", bin: () => process.env.PYGRAM_BIN || join(ROOT, "pygram/build/pygram") },
  { name: "cpython", bin: () => referencePython() },
];

/** `<engine>: unsupported: <kind>: <detail>` — the shared refusal contract. */
function unsupportedLine(engine, stderr) {
  const re = new RegExp(`^${engine}: unsupported: (\\w[\\w-]*): (.+)$`, "m");
  return re.exec(stderr);
}

export function runOne(bin, entry, { cwd, prefix = [], extraEnv = {} }) {
  const args = [...prefix, "-c", entry.program, ...(entry.argv_tail || [])];
  const env = { ...process.env, ...extraEnv };
  // The capture shim logs every python invocation and the harvester folds those
  // logs back into the corpus as observed evidence. A conformance run executes
  // every entry, so without this the corpus would grow by its own test suite —
  // the contamination documented in docs/PYGRAM.md §7a.
  env.PYGRAM_CAPTURE = "0";
  delete env.PYGRAM_LOG;
  const r = spawnSync(bin, args, {
    input: entry.stdin ?? "",
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    cwd,
    env,
    maxBuffer: 64 << 20,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status ?? (r.signal ? 128 : 1),
    timedOut: r.error?.code === "ETIMEDOUT",
    spawnFailed: r.error != null && r.error.code !== "ETIMEDOUT",
    spawnError: r.error ? String(r.error.message || r.error.code) : "",
  };
}

export function classifyAgainst(ref, got, engine, entry) {
  if (got.spawnFailed) return { verdict: "MISMATCH", why: `${engine} failed to start: ${got.spawnError}` };
  if (got.timedOut) return { verdict: "MISMATCH", why: `${engine} timed out` };
  const u = unsupportedLine(engine, got.stderr);
  if (u) return { verdict: "UNSUPPORTED", kind: u[1], detail: u[2] };
  if (got.code === UNSUPPORTED_EXIT) {
    return { verdict: "MISMATCH", why: `exit 90 without a \`${engine}: unsupported: …\` line on stderr` };
  }
  const skipStdout = isNondeterministic(entry);
  if (!skipStdout && got.stdout !== ref.stdout) {
    return { verdict: "MISMATCH", why: "stdout differs", diff: firstDiff(ref.stdout, got.stdout) };
  }
  if (got.code !== ref.code) {
    return { verdict: "MISMATCH", why: `exit code ${got.code}, CPython gave ${ref.code}` };
  }
  if (ref.stderr && !got.stderr) {
    return { verdict: "MISMATCH", why: "CPython reported an error on stderr, this engine was silent" };
  }
  return { verdict: "MATCH", stdoutUncompared: skipStdout };
}

/** Ask the mopy binary where it would send a program. One parse, no execution. */
export function routeOf(mopyBin, program) {
  const r = spawnSync(mopyBin, ["route", "-c", program, "--json"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, PYGRAM_CAPTURE: "0" },
  });
  if (r.status !== 0 || !r.stdout) return { engine: "cpython", kind: "route-failed", detail: r.stderr?.trim() || "", imports: [] };
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { engine: "cpython", kind: "route-unparseable", detail: r.stdout.slice(0, 120), imports: [] };
  }
}

/**
 * The routing verdict for one entry, given every engine's measured result.
 *
 * `ideal` is the cheapest engine that MATCHED. If none matched, the program is
 * outside the mixture entirely and routing cannot be scored — those are counted
 * separately as NO-ENGINE rather than blamed on the classifier.
 */
export function scoreRoute(predicted, byEngine, order = ENGINES.map((e) => e.name)) {
  const ideal = order.find((n) => byEngine[n]?.verdict === "MATCH");
  if (!ideal) return { verdict: "NO-ENGINE", ideal: null };
  const got = byEngine[predicted];
  if (!got) return { verdict: "UNSAFE", ideal, why: `no result for predicted engine ${predicted}` };
  if (got.verdict === "MISMATCH") return { verdict: "UNSAFE", ideal, why: got.why };
  if (predicted === ideal) return { verdict: "IDEAL", ideal };
  if (got.verdict === "UNSUPPORTED") return { verdict: "WASTED", ideal };
  // Matched, but on a more expensive engine than necessary.
  return { verdict: "LATE", ideal };
}

function parseArgs(argv) {
  const o = { plan: false, json: false, routing: false, engine: null, tag: null, limit: 0, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") o.plan = true;
    else if (a === "--json") o.json = true;
    else if (a === "--routing") o.routing = true;
    else if (a === "--verbose" || a === "-v") o.verbose = true;
    else if (a === "--engine") o.engine = argv[++i];
    else if (a === "--tag") o.tag = argv[++i];
    else if (a === "--limit") o.limit = Number(argv[++i]) || 0;
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const engines = ENGINES.filter((e) => !opts.engine || e.name === opts.engine || e.name === "cpython")
    .map((e) => ({ ...e, path: e.name === "cpython" ? e.bin() : resolve(e.bin()) }));
  const mopy = engines.find((e) => e.name === "mopy");
  const available = engines.filter((e) => e.name === "cpython" || existsSync(e.path));
  const missing = engines.filter((e) => !available.includes(e));
  for (const m of missing) {
    console.error(`note: ${m.name} not built at ${m.path} — skipping that arm`);
  }

  const dirtyBefore = repoDirtyList(ROOT);

  let entries = loadCorpus();
  if (opts.tag) entries = entries.filter((e) => (e.tags || []).includes(opts.tag));
  if (opts.limit) entries = entries.slice(0, opts.limit);

  const refBin = referencePython();
  const results = [];
  const canRoute = mopy && available.includes(mopy);

  for (const entry of entries) {
    // Each entry gets its own working directory: corpus programs write files,
    // and without isolation one engine reads back what another just created.
    const cwd = mkdtempSync(join(tmpdir(), "mopy-conf-"));
    try {
      const ref = runOne(refBin, entry, { cwd });
      const byEngine = {};
      for (const e of available) {
        if (e.name === "cpython") {
          byEngine.cpython = { verdict: "MATCH", reference: true };
          continue;
        }
        const rmDir = mkdtempSync(join(tmpdir(), `mopy-${e.name}-`));
        try {
          const got = runOne(e.path, entry, { cwd: rmDir });
          byEngine[e.name] = classifyAgainst(ref, got, e.name, entry);
        } finally {
          rmSync(rmDir, { recursive: true, force: true });
        }
      }
      // The mixture arm: what the caller actually gets from `mopy run`. Its
      // refusal line, if any, is mopy's — the dispatcher relays whichever
      // engine answered, so `classifyAgainst` is told to expect "mopy".
      if (canRoute) {
        const mixDir = mkdtempSync(join(tmpdir(), "mopy-mixture-"));
        try {
          const mix = mixtureArm();
          const got = runOne(mix.path, entry, { cwd: mixDir, prefix: mix.args, extraEnv: mix.env });
          byEngine.mixture = classifyAgainst(ref, got, "mopy", entry);
        } finally {
          rmSync(mixDir, { recursive: true, force: true });
        }
      }
      const predicted = canRoute ? routeOf(mopy.path, entry.program) : null;
      const routing = predicted
        ? scoreRoute(predicted.engine, byEngine, available.map((e) => e.name))
        : null;
      results.push({ id: entry.id, tags: entry.tags || [], byEngine, predicted, routing, refCode: ref.code });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  reportRepoDamage(dirtyBefore);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ total: results.length, results }, null, 2) + "\n");
    return;
  }

  if (opts.plan) {
    const byFeature = new Map();
    for (const r of results) {
      const v = r.byEngine.mopy;
      if (!v || v.verdict !== "UNSUPPORTED") continue;
      const key = `${v.kind}: ${v.detail}`;
      if (!byFeature.has(key)) byFeature.set(key, { feature: key, blocks: 0, ids: [] });
      const rec = byFeature.get(key);
      rec.blocks++;
      if (rec.ids.length < 4) rec.ids.push(r.id);
    }
    const plan = [...byFeature.values()].sort((a, b) => b.blocks - a.blocks || a.feature.localeCompare(b.feature));
    console.log(`\nmopy build order — ${plan.length} distinct blockers over ${results.length} programs`);
    console.log("(an entry is blocked by the FIRST thing it hits, so counts shift as features land)\n");
    for (const p of plan.slice(0, 40)) {
      console.log(`${String(p.blocks).padStart(4)}  ${p.feature}`);
    }
    // Kind-level rollup: what to build, rather than which instance to fix.
    const byKind = new Map();
    for (const [k, v] of byFeature) {
      const kind = k.slice(0, k.indexOf(":"));
      byKind.set(kind, (byKind.get(kind) || 0) + v.blocks);
    }
    console.log("\nby kind:");
    for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(n).padStart(4)}  ${k}`);
    }
    return;
  }

  const n = results.length;
  if (!opts.routing) {
    console.log(`\nconformance over ${n} corpus programs (reference: ${refBin})\n`);
    console.log("engine     MATCH  UNSUPPORTED  MISMATCH   coverage");
    const shown = [...available.filter((e) => e.name !== "cpython")];
    if (canRoute) shown.push({ name: "mixture" });
    for (const e of shown) {
      const c = { MATCH: 0, UNSUPPORTED: 0, MISMATCH: 0 };
      for (const r of results) c[r.byEngine[e.name]?.verdict ?? "MISMATCH"]++;
      const pct = ((100 * c.MATCH) / n).toFixed(1);
      console.log(
        `${e.name.padEnd(10)} ${String(c.MATCH).padStart(5)}  ${String(c.UNSUPPORTED).padStart(11)}  ${String(c.MISMATCH).padStart(8)}   ${pct.padStart(6)}%`,
      );
    }
    let bad = 0;
    for (const r of results) {
      for (const e of shown) {
        const v = r.byEngine[e.name];
        if (v?.verdict === "MISMATCH") {
          bad++;
          if (bad <= 25 || opts.verbose) {
            console.log(`  MISMATCH  ${e.name.padEnd(7)} ${r.id}: ${v.why}${v.diff ? ` — ${v.diff}` : ""}`);
          }
        }
      }
    }
    if (bad > 25 && !opts.verbose) console.log(`  … ${bad - 25} more (use --verbose)`);
  }

  if (canRoute) {
    const c = { IDEAL: 0, WASTED: 0, LATE: 0, UNSAFE: 0, "NO-ENGINE": 0 };
    const chosen = {};
    for (const r of results) {
      c[r.routing.verdict]++;
      chosen[r.predicted.engine] = (chosen[r.predicted.engine] || 0) + 1;
    }
    const scored = n - c["NO-ENGINE"];
    console.log(`\nrouting over ${n} programs (${scored} have at least one engine that matches)\n`);
    console.log(`  IDEAL      ${String(c.IDEAL).padStart(4)}  routed to the cheapest engine that works`);
    console.log(`  WASTED     ${String(c.WASTED).padStart(4)}  engine refused; one extra spawn, right answer`);
    console.log(`  LATE       ${String(c.LATE).padStart(4)}  worked, but a cheaper engine would have too`);
    console.log(`  UNSAFE     ${String(c.UNSAFE).padStart(4)}  routed to an engine that MISMATCHES  <-- must be 0`);
    console.log(`  NO-ENGINE  ${String(c["NO-ENGINE"]).padStart(4)}  no engine matched; not the router's fault`);
    console.log(`\n  accuracy ${scored ? ((100 * c.IDEAL) / scored).toFixed(1) : "0.0"}% ideal, ` +
      `${scored ? ((100 * (c.IDEAL + c.LATE)) / scored).toFixed(1) : "0.0"}% correct-on-first-try`);
    console.log(`  predictions: ${Object.entries(chosen).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    for (const r of results) {
      if (r.routing.verdict === "UNSAFE") {
        const rescued = r.byEngine.mixture?.verdict === "MATCH" ? " (dispatcher recovered)" : "";
        console.log(`  UNSAFE ${r.id}: predicted ${r.predicted.engine} — ${r.routing.why}${rescued}`);
      }
    }

  }

  // CI gates on mopy and on the mixture. pygram's own divergences belong to
  // pygram's runner, not this one — reporting them here would make a failure in
  // a component look like a failure of the mixture.
  const gated = results.some(
    (r) => r.byEngine.mopy?.verdict === "MISMATCH" || r.byEngine.mixture?.verdict === "MISMATCH",
  );
  if (gated) process.exitCode = 1;
}

/** Restore anything the corpus wrote into the repository, and say so loudly. */
export function reportRepoDamage(dirtyBefore, root = ROOT, restore = true) {
  if (!dirtyBefore) return [];
  const after = repoDirtyList(root);
  if (!after) return [];
  const before = new Set(dirtyBefore);
  const collateral = after.filter((f) => !before.has(f));
  if (!collateral.length) return [];
  console.error(`\n!! ${collateral.length} repository files were changed by corpus programs:`);
  for (const f of collateral.slice(0, 20)) console.error(`   ${f}`);
  if (collateral.length > 20) console.error(`   … and ${collateral.length - 20} more`);
  if (restore) {
    const tracked = collateral.filter((f) => !f.startsWith("?"));
    try {
      if (tracked.length) execFileSync("git", ["checkout", "--", ...tracked], { cwd: root });
      console.error("   restored (tracked files only; untracked leftovers are listed above)");
    } catch (e) {
      console.error(`   COULD NOT RESTORE: ${e.message}`);
    }
  }
  process.exitCode = 1;
  return collateral;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

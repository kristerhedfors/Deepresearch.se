#!/usr/bin/env node
// Embeds the harvested arXiv corpus and pushes it into a Cloudflare Vectorize
// index, so the Worker can serve dense retrieval (src/arxiv-rag.js) instead of
// hitting arXiv's rate-limited query API on every search.
//
//   node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv
//   node scripts/arxiv-vectorize.mjs --index … --limit 20000   # a slice first
//
// WHY THIS EXISTS SEPARATELY FROM arxiv-index.mjs: that script builds the
// local binary pack the CLI bake-off searches (335 MB of int8 vectors on
// disk). A Worker cannot read that pack, and re-deriving it in the cloud would
// mean shipping the whole file somewhere. This script skips the pack entirely:
// corpus rows → embeddings → Vectorize, in streamed batches.
//
// ---- the design constraint that shapes everything here ---------------------
// The machine running this is EPHEMERAL and the corpus is gitignored, so any
// progress held only on local disk is lost when the container goes away. A
// build that embeds everything and uploads at the end can therefore lose an
// hour of paid embedding work to a restart. So this script uploads
// INCREMENTALLY — each batch is embedded, written as NDJSON, upserted, and
// recorded in a checkpoint file before the next batch starts. Vectorize itself
// is the durable store, and a resumed run skips every id already pushed.
// Re-running after any interruption is always the right move.
//
// Auth: BERGET_API_KEY (embeddings, via scripts/embed-providers.mjs, so the
// HF failover and the adaptive over-length recovery come along) and wrangler's
// own Cloudflare credentials for the upsert. Node's built-in fetch ignores
// HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 — set it when running behind the
// agent proxy or every embedding call fails with a 503 "DNS resolution
// failure" that looks like Berget being down.

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PASSAGE_PREFIX, buildPassage } from "../public/js/arxiv-rag-core.js";
import { embedBatch } from "./embed-providers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Batch sizing: 256 is the embedder's measured sweet spot (~46-47k prompt
// tokens/s at concurrency 8 on real abstracts). The upsert batch is smaller
// because wrangler sends the NDJSON in one request and Vectorize caps a single
// upsert; 1000 rows of 1024 floats is about 8 MB of JSON, which is comfortable.
const EMBED_BATCH = 256;
const UPSERT_BATCH = 1000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { index: "deepresearch-se-arxiv", corpus: "data/arxiv/raw", work: "data/arxiv/vectorize", limit: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--index") out.index = String(value());
    else if (flag === "--corpus") out.corpus = String(value());
    else if (flag === "--work") out.work = String(value());
    else if (flag === "--limit") out.limit = Number(value());
    else if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.limit) || out.limit < 0) throw new Error("--limit must be >= 0");
  return out;
}

/**
 * The Vectorize metadata for one paper. Deliberately SHORT keys and a cut
 * abstract: metadata rides in every query response, and src/arxiv-rag.js reads
 * exactly these fields. Authors are joined with ";" rather than stored as an
 * array so the row stays flat.
 * @param {any} paper
 */
export function vectorMetadata(paper) {
  const abstract = String(paper.abstract || "").replace(/\s+/g, " ").trim();
  return {
    t: String(paper.title || "").replace(/\s+/g, " ").trim().slice(0, 300),
    // 900 chars is what the cross-encoder gets to judge on (Berget serves
    // bge-reranker-v2-m3 behind a 512-token window covering query+document),
    // so storing more would be paid-for weight nothing reads.
    a: abstract.slice(0, 900),
    au: (paper.authors || []).slice(0, 8).join("; ").slice(0, 300),
    c: String(paper.primary || (paper.categories || [])[0] || ""),
    d: String(paper.updated || "").slice(0, 10),
  };
}

/**
 * One corpus row → the NDJSON line Vectorize ingests.
 *
 * `values` MUST be a plain array. The embedder returns Float32Array, and
 * JSON.stringify turns a typed array into an OBJECT (`{"0":0.1,"1":…}`) rather
 * than an array — which Vectorize rejects with the unhelpful
 * "failed to parse upsert vectors request in ndjson format: line Some(0) was
 * not expected format [code: 40023]". Array.from is the whole fix.
 *
 * @param {any} paper
 * @param {number[] | Float32Array} values
 */
export function vectorLine(paper, values) {
  return JSON.stringify({
    id: String(paper.id),
    values: Array.from(values),
    metadata: vectorMetadata(paper),
  });
}

/** Reads every harvested shard, de-duplicated by id (a paper updated in-window
 * appears in every month shard it touched — dedup is mandatory).
 * @param {string} dir
 * @param {Set<string>} skip ids already pushed (checkpoint)
 * @param {number} limit 0 = no cap
 */
async function* corpusRows(dir, skip, limit) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  const seen = new Set();
  let yielded = 0;
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn last line from an interrupted harvest
      }
      const id = String(row?.id || "");
      if (!id || seen.has(id) || skip.has(id)) continue;
      if (!row.abstract || row.abstract.length < 200) continue; // the index's own filter
      seen.add(id);
      yield row;
      if (limit && ++yielded >= limit) {
        rl.close();
        return;
      }
    }
  }
}

/**
 * Push one NDJSON file into Vectorize via wrangler. Returns true on success.
 * @param {string} index
 * @param {string} file
 */
function upsert(index, file) {
  const res = spawnSync(
    "npx",
    ["wrangler", "vectorize", "upsert", index, "--file", file, "--batch-size", String(UPSERT_BATCH)],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900000 },
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  if (res.status !== 0) {
    console.error(`  upsert FAILED: ${out.trim().split("\n").slice(-4).join(" | ")}`);
    return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/arxiv-vectorize.mjs [--index NAME] [--corpus DIR] [--limit N] [--dry-run]");
    return;
  }
  const corpusDir = join(ROOT, args.corpus);
  const workDir = join(ROOT, args.work);
  await mkdir(workDir, { recursive: true });
  const statePath = join(workDir, "pushed.json");

  /** @type {Set<string>} */
  let pushed = new Set();
  try {
    pushed = new Set(JSON.parse(await readFile(statePath, "utf8")).ids || []);
    console.log(`resuming — ${pushed.size} ids already in the index`);
  } catch {
    /* first run */
  }

  let batch = [];
  let batchNo = 0;
  let embedded = 0;
  const started = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    batchNo++;
    const passages = batch.map((p) => PASSAGE_PREFIX + buildPassage(p, "title_abstract"));
    // embedBatch resolves to {vectors}, not the array itself — destructure it.
    // Getting this wrong produced NDJSON with no `values` key at all, which
    // Cloudflare rejected with an opaque "line Some(0) was not expected
    // format", so the shape is asserted here where the message can be useful.
    const { vectors } = await embedBatch(passages);
    if (!Array.isArray(vectors) || vectors.length !== batch.length) {
      throw new Error(`embedder returned ${vectors?.length} vectors for ${batch.length} passages`);
    }
    if (!vectors[0] || typeof vectors[0][0] !== "number" || !vectors[0].length) {
      throw new Error(`embedder returned a malformed vector (${vectors[0]?.constructor?.name}) — expected numbers`);
    }
    const file = join(workDir, `batch-${String(batchNo).padStart(5, "0")}.ndjson`);
    await writeFile(file, batch.map((p, i) => vectorLine(p, vectors[i])).join("\n") + "\n");
    if (args.dryRun) {
      // A dry run must NOT touch the checkpoint: recording ids it never
      // uploaded would make the next real run skip them, silently leaving
      // holes in the index.
      console.log(`  batch ${batchNo}: +${batch.length} embedded (dry run — not uploaded, not checkpointed)`);
      embedded += batch.length;
      batch = [];
      return;
    }
    if (!upsert(args.index, file)) {
      throw new Error(`upsert failed on batch ${batchNo} — rerun to resume from the checkpoint`);
    }
    for (const p of batch) pushed.add(String(p.id));
    // Checkpoint AFTER the upsert, so a crash re-does at most one batch rather
    // than silently skipping it.
    await writeFile(statePath, JSON.stringify({ ids: [...pushed] }));
    embedded += batch.length;
    const rate = embedded / Math.max(1, (Date.now() - started) / 1000);
    console.log(`  batch ${batchNo}: +${batch.length} (${pushed.size} total, ${rate.toFixed(1)}/s)`);
    batch = [];
  };

  for await (const row of corpusRows(corpusDir, pushed, args.limit)) {
    batch.push(row);
    if (batch.length >= EMBED_BATCH) await flush();
  }
  await flush();

  console.log(`done — ${pushed.size} vectors in ${args.index} (${((Date.now() - started) / 60000).toFixed(1)} min)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

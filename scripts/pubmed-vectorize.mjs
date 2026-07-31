#!/usr/bin/env node
// Embeds the harvested PubMed corpus and pushes it into a Cloudflare Vectorize
// index, so the Worker can serve dense retrieval over the biomedical
// literature (src/pubmed-rag.js) the way src/arxiv-rag.js serves arXiv.
//
//   node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed
//   node scripts/pubmed-vectorize.mjs --index … --limit 50000     # a slice first
//   node scripts/pubmed-vectorize.mjs --index … --dry-run --limit 512
//
// Auth: BERGET_API_KEY (embeddings, through scripts/embed-providers.mjs, so the
// Hugging Face failover and the adaptive over-length recovery come along) and
// wrangler's own Cloudflare credentials for the upsert. Node's built-in fetch
// ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 — set it behind an agent
// proxy or every embedding call fails with a 503 "DNS resolution failure" that
// reads exactly like Berget being down.
//
// The checkpoint/upsert machinery is shared with the arXiv fill
// (scripts/vectorize-upsert.mjs); everything corpus-specific is here.
//
// ---- what makes this fill different from the arXiv one --------------------
//
// * **Dedup is doing much more work.** A daily update file carries new,
//   revised AND deleted citations, so a paper corrected twice since the
//   baseline appears in three shards. arXiv's double-count was 3.4%; measure
//   this corpus's with scripts/pubmed-corpus.mjs before costing a build, since
//   Vectorize bills per unique vector.
// * **Withdrawn citations are removed, not just skipped.** The harvester
//   records every `<DeleteCitation>` PMID in its state file. Those ids are
//   excluded here, and `--prune` deletes any that a previous run already
//   pushed — an index that keeps serving retracted citations is worse than one
//   that is merely incomplete.
// * **The passage budget bites.** PubMed abstracts run about a third longer
//   than arXiv's, so a majority of records lose their tail at the 1200-char
//   e5 window. That is a known, measured limitation of this tier rather than a
//   bug to be fixed here — see docs/PUBMED-RAG.md.

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PASSAGE_PREFIX, buildPassage, vectorMetadata } from "../public/js/pubmed-core.js";
import { embedBatch } from "./embed-providers.mjs";
import { assertVectors, loadCheckpoint, recordPushed, upsertFile, vectorLine } from "./vectorize-upsert.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 256 is the embedder's measured sweet spot (~46-47k prompt tokens/s at
// concurrency 8 on real abstracts).
const EMBED_BATCH = 256;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    index: "deepresearch-se-pubmed",
    corpus: "data/pubmed/raw",
    state: "data/pubmed/state/done.json",
    work: "data/pubmed/vectorize",
    limit: 0,
    dryRun: false,
    prune: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--index") out.index = String(value());
    else if (flag === "--corpus") out.corpus = String(value());
    else if (flag === "--state") out.state = String(value());
    else if (flag === "--work") out.work = String(value());
    else if (flag === "--limit") out.limit = Number(value());
    else if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--prune") out.prune = true;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.limit) || out.limit < 0) throw new Error("--limit must be >= 0");
  return out;
}

/**
 * Every harvested shard, de-duplicated by PMID, newest shard first so a capped
 * run indexes the most recent literature.
 *
 * Shards are read in DESCENDING file order and the first sighting of a PMID
 * wins, which is also the freshest revision of that citation — the update
 * files are cumulative, so the highest-numbered shard holding a PMID has its
 * latest text.
 *
 * @param {string} dir
 * @param {Set<string>} skip ids already pushed (checkpoint)
 * @param {Set<string>} deleted withdrawn PMIDs
 * @param {number} limit 0 = no cap
 */
export async function* corpusRows(dir, skip, deleted, limit) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  // An empty corpus directory pushes nothing, prints "done — 0 vectors" and
  // exits 0. At this scale that is always a mistake, so it is an error.
  if (!files.length) {
    throw new Error(`No .jsonl shards in ${dir} — did you mean ${dir.replace(/\/$/, "")}/raw ?`);
  }
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
      const pmid = String(row?.pmid || "");
      const id = String(row?.id || "");
      if (!pmid || !id || seen.has(pmid) || skip.has(id) || deleted.has(pmid)) continue;
      seen.add(pmid);
      yield row;
      if (limit && ++yielded >= limit) {
        rl.close();
        return;
      }
    }
  }
}

/**
 * PMIDs the archive marked withdrawn, from the harvester's state file.
 * @param {string} statePath
 * @returns {Promise<Set<string>>}
 */
export async function readDeleted(statePath) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return new Set((state?.deleted || []).map(String));
  } catch {
    return new Set();
  }
}

/**
 * Remove withdrawn citations that an earlier run already pushed. Cheap when
 * there is nothing to do, and skipping it leaves retracted papers citable.
 * @param {string} index
 * @param {string[]} ids
 */
function deleteVectors(index, ids) {
  if (!ids.length) return true;
  const res = spawnSync("npx", ["wrangler", "vectorize", "delete-vectors", index, "--ids", ...ids], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
  if (res.status !== 0) {
    console.error(`  prune FAILED: ${`${res.stdout || ""}${res.stderr || ""}`.trim().split("\n").slice(-3).join(" | ")}`);
    return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/pubmed-vectorize.mjs [--index NAME] [--corpus DIR] [--limit N] [--dry-run] [--prune]");
    return;
  }
  const corpusDir = join(ROOT, args.corpus);
  const workDir = join(ROOT, args.work);
  await mkdir(workDir, { recursive: true });
  const statePath = join(workDir, "pushed.txt");

  const pushed = await loadCheckpoint(statePath);
  if (pushed.size) console.log(`resuming — ${pushed.size.toLocaleString()} ids already in the index`);
  const deleted = await readDeleted(join(ROOT, args.state));
  if (deleted.size) console.log(`${deleted.size} withdrawn citations will be skipped`);

  if (args.prune) {
    const stale = [...deleted].map((p) => `pmid:${p}`).filter((id) => pushed.has(id));
    if (!stale.length) console.log("prune: nothing already pushed has since been withdrawn");
    else if (deleteVectors(args.index, stale)) console.log(`pruned ${stale.length} withdrawn citations from ${args.index}`);
  }

  let batch = [];
  let batchNo = 0;
  let embedded = 0;
  const started = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    batchNo++;
    const passages = batch.map((r) => PASSAGE_PREFIX + buildPassage(r, "title_abstract"));
    const { vectors } = await embedBatch(passages);
    assertVectors(vectors, batch.length);
    const file = join(workDir, `batch-${String(batchNo).padStart(5, "0")}.ndjson`);
    await writeFile(file, batch.map((r, i) => vectorLine(r.id, vectors[i], vectorMetadata(r))).join("\n") + "\n");
    if (args.dryRun) {
      // A dry run must NOT touch the checkpoint: recording ids it never
      // uploaded would make the next real run skip them, leaving holes.
      console.log(`  batch ${batchNo}: +${batch.length} embedded (dry run — not uploaded, not checkpointed)`);
      embedded += batch.length;
      batch = [];
      return;
    }
    if (!upsertFile(args.index, file, ROOT)) {
      throw new Error(`upsert failed on batch ${batchNo} — rerun to resume from the checkpoint`);
    }
    await recordPushed(statePath, batch.map((r) => String(r.id)));
    for (const r of batch) pushed.add(String(r.id));
    embedded += batch.length;
    const rate = embedded / Math.max(1, (Date.now() - started) / 1000);
    console.log(`  batch ${batchNo}: +${batch.length} (${pushed.size.toLocaleString()} total, ${rate.toFixed(1)}/s)`);
    batch = [];
  };

  for await (const row of corpusRows(corpusDir, pushed, deleted, args.limit)) {
    batch.push(row);
    if (batch.length >= EMBED_BATCH) await flush();
  }
  await flush();

  console.log(`done — ${pushed.size.toLocaleString()} vectors in ${args.index} (${((Date.now() - started) / 60000).toFixed(1)} min)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

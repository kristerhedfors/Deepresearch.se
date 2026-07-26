#!/usr/bin/env node
// The FULL-TEXT tier of the arXiv RAG database — tier 2, filled ON DEMAND.
//
//   node scripts/arxiv-fulltext.mjs 2607.00042 2606.01131      # warm two papers
//   node scripts/arxiv-fulltext.mjs --stats
//
// Tier 1 (scripts/arxiv-index.mjs) holds one vector per paper over title +
// abstract and answers "which papers are relevant" for all 326,814 of them.
// This tier holds ~52 vectors per paper over the body and answers "what does
// section 4 say" — but only for papers something has actually asked to read.
//
// Why on demand rather than a bulk build, in one line each (docs/ARXIV-RAG.md
// §9 has the measurements): the whole corpus would be 13.3M vectors, past
// Vectorize's 10M per-index limit; ~1.2 TB of source, which has to come from
// arXiv's requester-pays S3 bucket rather than by crawling; ~18 h and ~€89.
// On demand it is ~101 KB, ~5 s and ~€0.0004 per paper, and the cache warms
// exactly where the research goes.
//
// Storage is one self-contained blob per paper, deliberately shaped like an R2
// object so moving this to R2 is a put/get swap and nothing else:
//
//   data/arxiv/fulltext/<id>.json
//     { v, id, model, dims, built, source, chunks: [{seq, heading, text}],
//       vectors: [b64 int8] }
//
// Nothing here searches globally, which is the point: stage 2 only ever scans
// the blobs of the ~20 candidate papers stage 1 chose, so the full-text tier
// needs no ANN index and has no size ceiling.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PASSAGE_PREFIX, b64ToInt8, fullTextChunks, fullTextPassage, int8ToB64, latexBody, quantizeInt8 } from "../public/js/arxiv-rag-core.js";
import { EMBED_MODEL, embedAll } from "./embed-providers.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FULLTEXT_DIR = join(ROOT, "data/arxiv/fulltext");

// arXiv asks that bulk downloading go through its requester-pays S3 bucket
// rather than this endpoint. On-demand fetching of the handful of papers one
// research run actually reads is ordinary use; a loop over the corpus is not.
// The concurrency cap and the polite delay below keep it the former.
const EPRINT = "https://export.arxiv.org/e-print/";
const UA = "deepresearch.se-arxiv-fulltext/1.0 (+https://deepresearch.se)";
const FETCH_CONCURRENCY = 3;
const POLITE_DELAY_MS = 400;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} id */
const blobPath = (id) => join(FULLTEXT_DIR, `${id.replace(/\//g, "_")}.json`);

/** @param {string} id */
export async function isWarm(id) {
  try {
    return (await stat(blobPath(id))).size > 0;
  } catch {
    return false;
  }
}

/**
 * Pull one paper's LaTeX source and concatenate every .tex in it. Some
 * submissions are a single gzipped .tex rather than a tarball, and some are
 * PDF-only — the last is why the measured yield is 78% and why this returns ""
 * rather than throwing.
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function fetchLatex(id) {
  const dir = await mkdtemp(join(tmpdir(), "arxiv-ft-"));
  try {
    const res = await fetch(EPRINT + id, { headers: { "user-agent": UA } });
    if (!res.ok) return "";
    const buf = Buffer.from(await res.arrayBuffer());
    const archive = join(dir, "src.gz");
    await writeFile(archive, buf);
    try {
      await run("tar", ["xzf", archive, "-C", dir]);
    } catch {
      // Not a tarball: try it as one gzipped file.
      try {
        const { stdout } = await run("gunzip", ["-c", archive], { maxBuffer: 1e8, encoding: "utf8" });
        return typeof stdout === "string" && /\\(document|section|begin)/.test(stdout) ? stdout : "";
      } catch {
        return "";
      }
    }
    /** @param {string} d @returns {Promise<string[]>} */
    const walk = async (d) => {
      const entries = await readdir(d, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith(".tex")) out.push(p);
      }
      return out;
    };
    const files = await walk(dir);
    const texts = (await Promise.all(files.map((f) => readFile(f, "utf8").catch(() => "")))).filter(Boolean);
    if (!texts.length) return "";
    // A submission is often a wrapper plus \input fragments. Concatenating and
    // then looking for \begin{document} finds the WRAPPER's — which may be
    // three lines long — and throws the paper away: 2606.00096 has 100 KB of
    // .tex and yielded 89 characters that way. So pick the richest actual
    // document body, then append every fragment that has no document of its
    // own (those are the \input targets, whose prose lives nowhere else).
    const wrapped = texts.filter((t) => /\\begin\{document\}/.test(t));
    let fragments = texts.filter((t) => !/\\begin\{document\}/.test(t));
    const bodies = wrapped.map(latexBody).sort((a, b) => b.length - a.length);
    let main = bodies[0];
    if (!main) {
      // No file declares a document at all. Promote the longest fragment and
      // REMOVE it from the fragment list, or it is emitted twice and every
      // chunk of the paper is duplicated.
      fragments = [...fragments].sort((a, b) => b.length - a.length);
      main = fragments.shift() || "";
    }
    return `\\begin{document}\n${main}\n${fragments.join("\n")}\n\\end{document}`;
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Build (or return) one paper's full-text blob.
 * @param {string} id
 * @param {{ force?: boolean, provider?: string }} [opts]
 * @returns {Promise<{ id: string, chunks: number, cached: boolean, ok: boolean, reason?: string }>}
 */
export async function warmPaper(id, opts = {}) {
  if (!opts.force && (await isWarm(id))) {
    const blob = JSON.parse(await readFile(blobPath(id), "utf8"));
    return { id, chunks: blob.chunks?.length || 0, cached: true, ok: true };
  }
  const tex = await fetchLatex(id);
  if (!tex) return { id, chunks: 0, cached: false, ok: false, reason: "no LaTeX source (PDF-only submission)" };
  const chunks = fullTextChunks(tex);
  if (!chunks.length) return { id, chunks: 0, cached: false, ok: false, reason: "no extractable body text" };
  const { vectors } = await embedAll(chunks.map((c) => PASSAGE_PREFIX + fullTextPassage(c)), {
    model: EMBED_MODEL,
    provider: opts.provider,
  });
  await mkdir(FULLTEXT_DIR, { recursive: true });
  await writeFile(
    blobPath(id),
    JSON.stringify({
      v: 1,
      id,
      model: EMBED_MODEL,
      dims: vectors[0]?.length || 0,
      built: new Date().toISOString(),
      source: "latex",
      chunks,
      vectors: vectors.map((v) => int8ToB64(quantizeInt8(v))),
    }),
  );
  return { id, chunks: chunks.length, cached: false, ok: true };
}

/**
 * Warm many papers with a small, polite pool.
 * @param {string[]} ids
 * @param {{ force?: boolean, provider?: string, onEach?: (r: any) => void }} [opts]
 */
export async function warmPapers(ids, opts = {}) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const at = cursor++;
      if (at >= ids.length) return;
      const r = await warmPaper(ids[at], opts).catch((err) => ({ id: ids[at], chunks: 0, cached: false, ok: false, reason: err.message }));
      results.push(r);
      opts.onEach?.(r);
      if (!r.cached) await sleep(POLITE_DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker));
  return results;
}

/**
 * Load warmed blobs, decoded for scanning. Missing papers are simply absent —
 * stage 2 degrades to whatever it has rather than failing the search.
 * @param {string[]} ids
 * @returns {Promise<Array<{ id: string, chunks: any[], vectors: Int8Array[] }>>}
 */
export async function loadFullText(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const blob = JSON.parse(await readFile(blobPath(id), "utf8"));
      if (blob?.v === 1 && Array.isArray(blob.vectors) && blob.vectors.length === blob.chunks.length) {
        out.push({ id, chunks: blob.chunks, vectors: blob.vectors.map(b64ToInt8) });
      }
    } catch {
      /* not warmed */
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  if (argv.includes("--stats")) {
    let files = [];
    try {
      files = (await readdir(FULLTEXT_DIR)).filter((f) => f.endsWith(".json"));
    } catch {
      console.log("No full-text cache yet.");
      return;
    }
    let bytes = 0;
    let chunks = 0;
    for (const f of files) {
      const st = await stat(join(FULLTEXT_DIR, f));
      bytes += st.size;
      chunks += JSON.parse(await readFile(join(FULLTEXT_DIR, f), "utf8")).chunks.length;
    }
    console.log(
      `full-text cache: ${files.length} papers · ${chunks} chunks (${(chunks / (files.length || 1)).toFixed(1)}/paper) · ` +
        `${(bytes / 1e6).toFixed(1)} MB (${Math.round(bytes / (files.length || 1) / 1024)} KB/paper)`,
    );
    return;
  }
  const fromFile = get("--ids-file", "");
  let ids = argv.filter((a) => /^\d{4}\.\d{4,5}$/.test(a));
  if (fromFile) {
    const rl = createReadStream(join(ROOT, fromFile), "utf8");
    let buf = "";
    for await (const c of rl) buf += c;
    ids = ids.concat(buf.split(/\s+/).filter((x) => /^\d{4}\.\d{4,5}$/.test(x)));
  }
  if (!ids.length) {
    console.log('usage: node scripts/arxiv-fulltext.mjs <arxiv-id> [...] [--ids-file f] [--force] [--stats]');
    process.exit(1);
  }
  const t0 = Date.now();
  let ok = 0;
  const res = await warmPapers(ids, {
    force: argv.includes("--force"),
    provider: get("--embed-provider", ""),
    onEach: (r) => {
      if (r.ok) ok++;
      process.stdout.write(`  ${r.id}  ${r.ok ? `${String(r.chunks).padStart(3)} chunks${r.cached ? " (cached)" : ""}` : `SKIPPED — ${r.reason}`}\n`);
    },
  });
  console.log(`\n${ok}/${res.length} papers warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1]?.endsWith("arxiv-fulltext.mjs")) {
  main().catch((err) => {
    console.error("arxiv-fulltext failed:", err.stack || err.message);
    process.exit(1);
  });
}

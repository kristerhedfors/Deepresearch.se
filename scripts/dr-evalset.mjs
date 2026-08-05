#!/usr/bin/env node
// @ts-check
// Build the committed ground-truth eval sets under tests/evalsets/.
//
// The existing research benchmark (tests/eval-bench.mjs) judges 20 hand-written
// questions BLIND — a strong judge reads the answer and scores it 1-5. That
// measures whether an answer reads well and cites plausibly. It cannot measure
// whether the answer is RIGHT, because there is no right answer written down.
//
// These sets close that gap by importing published benchmarks that ship gold
// answers, so a run produces an accuracy figure a stranger can check:
//
//   frames      Google FRAMES — 824 multi-hop questions, each built from a set
//               of named Wikipedia pages, with a short gold answer. The closest
//               public analogue to what this pipeline does: retrieve several
//               documents, reason across them, answer. Shipping the source
//               pages also lets us measure RETRIEVAL recall, not just accuracy.
//   simpleqa    OpenAI SimpleQA — 4326 single-fact questions chosen to be hard
//               to answer from parametric memory but easy to verify. The
//               hallucination probe: every question has one short answer.
//   browsecomp  OpenAI BrowseComp — 1266 questions deliberately built so the
//               answer is hard to find and easy to verify. The ceiling probe.
//
// Sampling is SEEDED (tests/dr-evalset-core.mjs sampleIndices) so a rebuild
// picks the same questions; a before/after comparison that resampled would be
// measuring the sample.
//
// BrowseComp rows stay XOR-OBFUSCATED in the committed file, decrypted at load
// time by the runner. That is not decoration: the obfuscation exists so the
// answers do not end up in a training corpus, and a public repo that commits
// them in the clear is exactly the leak it guards against.
//
// Usage:
//   node scripts/dr-evalset.mjs                 build every set at default n
//   node scripts/dr-evalset.mjs --only frames   one set
//   node scripts/dr-evalset.mjs --n 100         override the sample size
//   node scripts/dr-evalset.mjs --seed 7        override the seed (then say so)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, sampleIndices, xorDecrypt } from "../tests/dr-evalset-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "tests", "evalsets");

const argv = process.argv.slice(2);
const arg = (/** @type {string} */ name, /** @type {string|null} */ dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ONLY = arg("--only");
const SEED = Number(arg("--seed", "20260805"));
const N_OVERRIDE = arg("--n") ? Number(arg("--n")) : null;

const SOURCES = {
  frames: {
    n: 60,
    kind: "multihop",
    license: "Apache-2.0 (google/frames-benchmark, Hugging Face)",
    origin: "https://huggingface.co/datasets/google/frames-benchmark",
    note: "Multi-hop questions over named Wikipedia pages; gold answer + gold source URLs.",
  },
  simpleqa: {
    n: 60,
    kind: "single-fact",
    license: "MIT (openai/simple-evals)",
    origin: "https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv",
    note: "Short-answer factual questions with a gold answer and supporting URLs.",
  },
  browsecomp: {
    n: 30,
    kind: "hard-browse",
    license: "MIT (openai/simple-evals)",
    origin: "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv",
    note: "Deliberately hard-to-find answers. Rows kept XOR-obfuscated; decrypted at load.",
  },
};

/** @param {string} url */
async function get(url, { json = false } = {}) {
  const res = await fetch(url, { headers: { "user-agent": "deepresearch.se-evalset/1" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return json ? res.json() : res.text();
}

// --- frames -----------------------------------------------------------------
// Pulled through the Hugging Face datasets-server rows API rather than the
// parquet: no parquet reader, no dependency, and the rows API caps at 100 per
// call so it paginates in nine requests.
async function buildFrames(n) {
  const ds = "google%2Fframes-benchmark";
  const first = await get(
    `https://datasets-server.huggingface.co/rows?dataset=${ds}&config=default&split=test&offset=0&length=1`,
    { json: true },
  );
  const total = first.num_rows_total;
  const want = new Set(sampleIndices(total, n, SEED));
  /** @type {any[]} */
  const rows = [];
  for (let off = 0; off < total; off += 100) {
    // Only fetch a page that contains at least one wanted index.
    if (![...want].some((i) => i >= off && i < off + 100)) continue;
    const page = await get(
      `https://datasets-server.huggingface.co/rows?dataset=${ds}&config=default&split=test&offset=${off}&length=100`,
      { json: true },
    );
    for (const r of page.rows) if (want.has(r.row_idx)) rows.push(r);
  }
  return {
    total,
    items: rows.map((r) => {
      const row = r.row;
      const links = Object.keys(row)
        .filter((k) => /^wikipedia_link_/.test(k))
        .map((k) => row[k])
        .filter((v) => typeof v === "string" && /^https?:\/\//.test(v));
      return {
        id: `frames-${String(r.row_idx).padStart(4, "0")}`,
        question: String(row.Prompt || "").trim(),
        answer: String(row.Answer || "").trim(),
        goldUrls: links,
        tags: String(row.reasoning_types || "")
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }),
  };
}

// --- simpleqa ---------------------------------------------------------------
async function buildSimpleQa(n) {
  const csv = await get(SOURCES.simpleqa.origin);
  const rows = parseCsv(csv);
  const want = sampleIndices(rows.length, n, SEED);
  return {
    total: rows.length,
    items: want.map((i) => {
      const r = rows[i];
      // `metadata` is a Python dict literal, not JSON. We only want the urls
      // and the topic, so pull them with two narrow regexes rather than
      // pretending to parse Python.
      const urls = [...String(r.metadata).matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
      const topic = String(r.metadata).match(/'topic':\s*'([^']*)'/)?.[1] || "";
      const answerType = String(r.metadata).match(/'answer_type':\s*'([^']*)'/)?.[1] || "";
      return {
        id: `simpleqa-${String(i).padStart(4, "0")}`,
        question: r.problem.trim(),
        answer: r.answer.trim(),
        goldUrls: urls,
        tags: [topic, answerType].filter(Boolean),
      };
    }),
  };
}

// --- browsecomp -------------------------------------------------------------
async function buildBrowseComp(n) {
  const csv = await get(SOURCES.browsecomp.origin);
  const rows = parseCsv(csv);
  const want = sampleIndices(rows.length, n, SEED);
  return {
    total: rows.length,
    items: want.map((i) => {
      const r = rows[i];
      // Verify the row decrypts before committing it — a silently corrupt row
      // would only surface mid-battery as an unanswerable question.
      const probe = xorDecrypt(r.problem, r.canary);
      if (!probe || probe.length < 10) throw new Error(`browsecomp row ${i} failed to decrypt`);
      return {
        id: `browsecomp-${String(i).padStart(4, "0")}`,
        enc: { question: r.problem, answer: r.answer, canary: r.canary },
        tags: [r.problem_topic].filter(Boolean),
      };
    }),
  };
}

const BUILDERS = { frames: buildFrames, simpleqa: buildSimpleQa, browsecomp: buildBrowseComp };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = ONLY ? ONLY.split(",").map((s) => s.trim()) : Object.keys(SOURCES);
  for (const name of names) {
    const meta = SOURCES[/** @type {keyof typeof SOURCES} */ (name)];
    if (!meta) throw new Error(`unknown set: ${name}`);
    const n = N_OVERRIDE ?? meta.n;
    process.stdout.write(`building ${name} (n=${n}, seed=${SEED}) … `);
    const { total, items } = await BUILDERS[/** @type {keyof typeof BUILDERS} */ (name)](n);
    const payload = {
      set: name,
      kind: meta.kind,
      origin: meta.origin,
      license: meta.license,
      note: meta.note,
      sample: { seed: SEED, n: items.length, of: total },
      items,
    };
    const file = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 1) + "\n");
    console.log(`${items.length}/${total} → ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

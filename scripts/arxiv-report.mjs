#!/usr/bin/env node
// Renders the bake-off's JSON results into the findings tables in
// docs/ARXIV-RAG.md, between the <!-- RESULTS:A --> / <!-- RESULTS:B -->
// markers.
//
//   node scripts/arxiv-report.mjs --a data/arxiv/eval-families-20k.json \
//                                 --b data/arxiv/eval-index-full.json
//
// The numbers in the doc are generated, never transcribed: a hand-copied
// benchmark table drifts from its data on the first rerun, and a findings
// document that disagrees with its own measurements is worse than none.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "docs/ARXIV-RAG.md";

/** @param {any} data @param {string} caption */
function renderTable(data, caption) {
  const rows = Object.entries(data.results).filter(([k]) => !k.startsWith("_"));
  const hasNdcg = rows.some(([, r]) => r.langs.en?.ndcg10 !== undefined);
  const head = hasNdcg
    ? "| pipeline | EN r@1 | EN r@10 | EN MRR | EN nDCG@10 | SV r@1 | SV r@10 | SV MRR | SV nDCG@10 | ms/q |"
    : "| pipeline | EN r@1 | EN r@10 | EN MRR | SV r@1 | SV r@10 | SV MRR | ms/q |";
  const sep = head.replace(/[^|]+/g, "---");
  const lines = [caption, "", head, sep];
  for (const [name, r] of rows) {
    const en = r.langs.en || {};
    const sv = r.langs.sv || {};
    const cells = hasNdcg
      ? [en["r@1"], en["r@10"], en.mrr, en.ndcg10, sv["r@1"], sv["r@10"], sv.mrr, sv.ndcg10]
      : [en["r@1"], en["r@10"], en.mrr, sv["r@1"], sv["r@10"], sv.mrr];
    lines.push(`| \`${name}\` | ${cells.map((c) => (c === undefined ? "–" : c)).join(" | ")} | ${r.latencyMs?.en ?? "–"} |`);
  }
  const n = data.needleQueries;
  lines.push(
    "",
    `${data.corpus.toLocaleString("en-US")} papers · ${n} needle queries · ${data.topicalQueries} topical queries. ` +
      `r@k and MRR are percentages over the needle set; nDCG@10 is over the graded topical set. ` +
      `Binomial standard error on r@10 at n=${n} is about ±${(Math.sqrt(0.25 / n) * 100).toFixed(1)} points, so treat smaller gaps as ties.`,
  );
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f) => {
    const i = argv.indexOf(f);
    return i < 0 ? "" : argv[i + 1];
  };
  let doc = await readFile(join(ROOT, DOC), "utf8");
  for (const [flag, marker, caption] of [
    ["--a", "RESULTS:A", "### 4.2 Experiment A — which text to embed (20,000 papers)"],
    ["--b", "RESULTS:B", "### 4.3 Experiment B — the retrieval stack at full scale"],
  ]) {
    const path = get(flag);
    if (!path) continue;
    const data = JSON.parse(await readFile(join(ROOT, path), "utf8"));
    const block = renderTable(data, caption);
    const re = new RegExp(`<!-- ${marker} -->[\\s\\S]*?<!-- /${marker} -->|<!-- ${marker} -->`);
    if (!re.test(doc)) throw new Error(`Marker ${marker} not found in ${DOC}`);
    doc = doc.replace(re, `<!-- ${marker} -->\n${block}\n<!-- /${marker} -->`);
    console.log(`Rendered ${marker} from ${path}`);
  }
  await writeFile(join(ROOT, DOC), doc);
}

if (process.argv[1]?.endsWith("arxiv-report.mjs")) {
  main().catch((err) => {
    console.error("arxiv-report failed:", err.message);
    process.exit(1);
  });
}

export { renderTable };

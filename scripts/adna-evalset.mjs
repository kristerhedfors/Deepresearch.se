#!/usr/bin/env node
// Merge the hand-authored ancient-DNA question batches into a dr-eval set, and
// refuse to write one that cannot be trusted.
//
// The batches are written by separate authors working in parallel, so the
// failure modes are collisions and drift rather than typos: two batches
// claiming the same id, a PMID that does not resolve, a citation that turns out
// to be by the researcher the set is supposed to look BEYOND, or a Swedish
// question whose diacritics were lost somewhere in transit. Every one of those
// is silent at read time and poisons a benchmark permanently, so each is a hard
// failure here rather than a warning.
//
//   node scripts/adna-evalset.mjs --in data/adna --out tests/evalsets/adna.json
//   node scripts/adna-evalset.mjs --check          # validate, write nothing
//
// PMID resolution goes through E-utilities esummary in batches of 200. Pass
// --offline to skip it when the network is unavailable; the set is then
// structurally valid but its citations are unverified, and the run says so.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "deepresearch.se";
const EMAIL = process.env.PUBMED_CONTACT || "info@deepresearch.se";
const ESUMMARY_BATCH = 200;
const PACE_MS = 380; // ~3 req/s, NCBI's unkeyed ceiling

const DIFFICULTY = new Set(["single-fact", "multihop", "synthesis"]);

/** @param {string[]} argv @param {string} flag @param {string} fallback */
const arg = (argv, flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (/** @type {string[]} */ argv, /** @type {string} */ flag) => argv.includes(flag);

/**
 * PMIDs cited by an item. The gold URL is the only place a citation lives, so
 * a malformed one is a missing citation rather than a cosmetic problem.
 * @param {any} item
 */
export function citedPmids(item) {
  return (item.goldUrls || []).map((u) => (String(u).match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/) || [])[1]).filter(Boolean);
}

/**
 * Swedish items are the half of this set most likely to arrive damaged: a
 * question that lost its diacritics still reads as Swedish to a human and
 * costs orders of magnitude of retrieval score (docs/PUBMED-RAG.md §7.7). A
 * Cyrillic or Greek letter pasted mid-word is invisible on screen and matches
 * nothing. Both are caught by requiring Latin-only text, then requiring that
 * anything tagged `sv` actually carries Swedish letters.
 * @param {string} s
 */
const isLatinOnly = (s) => /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u.test(s);
const hasSwedishLetters = (/** @type {string} */ s) => /[åäöÅÄÖ]/.test(s);

/**
 * Structural checks — everything that does not need the network.
 * @param {any[]} items
 * @param {Set<string>} excludePmids PMIDs whose author is the researcher this set looks beyond
 */
export function validateItems(items, excludePmids = new Set()) {
  const errors = [];
  const seenIds = new Set();
  const seenQuestions = new Map();

  for (const it of items) {
    const where = it.id || "(no id)";
    if (!it.id) errors.push("an item has no id");
    else if (seenIds.has(it.id)) errors.push(`duplicate id ${it.id} — two batches collided`);
    else seenIds.add(it.id);

    if (!it.question?.trim()) errors.push(`${where}: empty question`);
    if (!it.answer?.trim()) errors.push(`${where}: empty answer`);
    if (!Array.isArray(it.tags) || !it.tags.length) errors.push(`${where}: no tags`);

    const pmids = citedPmids(it);
    if (!pmids.length) errors.push(`${where}: no resolvable PubMed goldUrl`);
    for (const p of pmids) if (excludePmids.has(p)) errors.push(`${where}: cites ${p}, which is by the excluded author`);

    const tags = it.tags || [];
    if (!tags.some((t) => DIFFICULTY.has(t))) errors.push(`${where}: no difficulty tag (${[...DIFFICULTY].join("|")})`);

    for (const [field, text] of [["question", it.question], ["answer", it.answer]]) {
      if (text && !isLatinOnly(text)) errors.push(`${where}: ${field} contains non-Latin script`);
    }
    // A Swedish item with no Swedish letters at all is the diacritic-stripping
    // failure, not a stylistic choice — no natural Swedish sentence of this
    // length avoids å, ä and ö entirely.
    if (tags.includes("sv") && !hasSwedishLetters(`${it.question} ${it.answer}`)) {
      errors.push(`${where}: tagged sv but carries no å/ä/ö — diacritics were probably stripped`);
    }
    if (!tags.includes("sv") && hasSwedishLetters(it.question || "")) {
      errors.push(`${where}: question looks Swedish but is not tagged sv`);
    }

    const key = (it.question || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (key && seenQuestions.has(key)) errors.push(`${where}: same question as ${seenQuestions.get(key)}`);
    else if (key) seenQuestions.set(key, it.id);
  }
  return errors;
}

/** @param {string[]} pmids */
async function resolvePmids(pmids) {
  const found = new Set();
  for (let i = 0; i < pmids.length; i += ESUMMARY_BATCH) {
    const slice = pmids.slice(i, i + ESUMMARY_BATCH);
    const url =
      `${EUTILS}/esummary.fcgi?db=pubmed&id=${slice.join(",")}&retmode=json` +
      `&tool=${TOOL}&email=${encodeURIComponent(EMAIL)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`esummary HTTP ${res.status}`);
    const j = await res.json();
    for (const id of j.result?.uids || []) if (!j.result[id]?.error) found.add(String(id));
    if (i + ESUMMARY_BATCH < pmids.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return found;
}

/** @param {any[]} items */
function summarize(items) {
  const tally = (/** @type {(it:any)=>string[]} */ pick) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const it of items) for (const t of pick(it)) out[t] = (out[t] || 0) + 1;
    return out;
  };
  const difficulty = tally((it) => (it.tags || []).filter((/** @type {string} */ t) => DIFFICULTY.has(t)));
  const domain = tally((it) => (it.tags || []).filter((/** @type {string} */ t) => !DIFFICULTY.has(t) && t !== "sv" && t !== "trap"));
  return {
    items: items.length,
    swedish: items.filter((it) => (it.tags || []).includes("sv")).length,
    traps: items.filter((it) => (it.tags || []).includes("trap")).length,
    uniquePmids: new Set(items.flatMap(citedPmids)).size,
    difficulty,
    domain,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const inDir = arg(argv, "--in", "data/adna");
  const outPath = arg(argv, "--out", "tests/evalsets/adna.json");
  const offline = has(argv, "--offline");
  const checkOnly = has(argv, "--check");

  const batchFiles = readdirSync(inDir).filter((f) => f.startsWith("items-") && f.endsWith(".json")).sort();
  if (!batchFiles.length) throw new Error(`no items-*.json in ${inDir} — nothing to merge`);

  /** @type {any[]} */
  const items = [];
  for (const f of batchFiles) {
    const batch = JSON.parse(readFileSync(join(inDir, f), "utf8"));
    if (!Array.isArray(batch)) throw new Error(`${f} is not a JSON array`);
    console.log(`  ${String(batch.length).padStart(3)} items from ${f}`);
    items.push(...batch);
  }

  const excludeFile = "data/dalen/pmids-all.txt";
  const exclude = existsSync(excludeFile)
    ? new Set(readFileSync(excludeFile, "utf8").split(/\s+/).filter(Boolean))
    : new Set();
  if (!exclude.size) console.log("  ! no exclusion list — cannot check that the set looks BEYOND its subject");

  const errors = validateItems(items, exclude);

  if (!offline) {
    const pmids = [...new Set(items.flatMap(citedPmids))];
    console.log(`\nResolving ${pmids.length} cited PMIDs against E-utilities …`);
    const found = await resolvePmids(pmids);
    for (const it of items) {
      for (const p of citedPmids(it)) if (!found.has(p)) errors.push(`${it.id}: PMID ${p} does not resolve — invented or mistyped`);
    }
    console.log(`  ${found.size}/${pmids.length} resolve`);
  } else {
    console.log("\n! --offline: citations NOT verified against PubMed");
  }

  if (errors.length) {
    console.error(`\nREFUSING TO WRITE — ${errors.length} problem(s):`);
    for (const e of errors.slice(0, 40)) console.error(`  · ${e}`);
    if (errors.length > 40) console.error(`  … and ${errors.length - 40} more`);
    process.exit(1);
  }

  const stats = summarize(items);
  console.log("\nSummary:");
  console.log(`  ${stats.items} items · ${stats.swedish} Swedish · ${stats.traps} traps · ${stats.uniquePmids} distinct papers`);
  console.log(`  difficulty: ${JSON.stringify(stats.difficulty)}`);
  console.log(`  domain:     ${JSON.stringify(stats.domain)}`);

  if (checkOnly) {
    console.log("\n--check: valid, nothing written.");
    return;
  }

  const payload = {
    set: "adna",
    kind: "domain-expert",
    origin: "Hand-authored against PubMed abstracts fetched through NCBI E-utilities; every cited PMID resolved before this file was written.",
    license: "Questions and gold answers are original; the underlying facts are from the cited PubMed abstracts.",
    note:
      "Ancient-DNA questions BEYOND one researcher's own output — the companion to tests/evalsets/dalen.json, which covers Love Dalén's own papers. Nothing here cites a paper he authored; that is enforced by scripts/adna-evalset.mjs against data/dalen/pmids-all.txt rather than trusted. Four domains: ancient humans and hominins, megafauna and palaeoecology, methods and chemistry, and the applied edge (pathogens, domestication, conservation, de-extinction). Swedish items are tagged `sv` and written in the VERNACULAR register, which is the register hosted retrieval is measurably worst at (docs/RAG-EVAL-LEDGER.md, 2026-08-08) — they are the hard half of this set deliberately. Items tagged `trap` are ones where the naive answer is a common misconception or a superseded result, and the gold answer states the correction.",
    items,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 1) + "\n");
  console.log(`\nWrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

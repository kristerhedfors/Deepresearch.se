#!/usr/bin/env node
// Merge hand-authored question batches into a dr-eval set, and refuse to write
// one that cannot be trusted.
//
// The batches are written by separate authors working in parallel, so the
// failure modes are collisions and drift rather than typos: two batches
// claiming the same id, a citation that does not resolve, a citation by an
// author the set is supposed to look BEYOND, or a Swedish question whose
// diacritics were lost somewhere in transit. Every one of those is silent at
// read time and poisons a benchmark permanently, so each is a hard failure
// here rather than a warning.
//
//   node scripts/evalset-build.mjs --in data/adna  --out tests/evalsets/adna.json
//   node scripts/evalset-build.mjs --in data/aisec --out tests/evalsets/aisec.json
//   node scripts/evalset-build.mjs --in data/adna  --check    # validate, write nothing
//
// Citations may point at EITHER corpus, because the domains differ in where
// their literature lives: ancient DNA is almost entirely PubMed, AI security
// almost entirely arXiv, and consciousness research is genuinely split. PMIDs
// resolve through E-utilities esummary (200 per call); arXiv ids through the
// arXiv API (which, unlike E-utilities, reports an unknown id by simply
// omitting it — so absence is measured by set difference, not by an error).
// Pass --offline to skip resolution when the network is unavailable; the set
// is then structurally valid but its citations are unverified, and it says so.
//
// The per-set prose lives in SETS below rather than in the caller, so the note
// that ships inside an eval set is reviewable in the same diff as the checks
// that guarantee it.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
// HTTPS, not HTTP. arXiv's own docs give the http:// form and it works from a
// normal network, but behind this environment's egress proxy it returns a
// 0-byte body with no error — which would make every arXiv citation look
// unresolvable and fail the whole set for a reason that has nothing to do with
// the citations.
const ARXIV_API = "https://export.arxiv.org/api/query";
const TOOL = "deepresearch.se";
const EMAIL = process.env.PUBMED_CONTACT || "info@deepresearch.se";
const ESUMMARY_BATCH = 200;
const ARXIV_BATCH = 100;
const PACE_MS = 380; // ~3 req/s, NCBI's unkeyed ceiling
const ARXIV_PACE_MS = 3100; // arXiv asks for ~3s between calls; it is not enforced, which is why we do it

const DIFFICULTY = new Set(["single-fact", "multihop", "synthesis"]);

/**
 * Per-set identity. `exclude` names a file of ids the set must NOT cite —
 * the mechanism that keeps a "look beyond this group" set honest.
 */
const SETS = {
  adna: {
    kind: "domain-expert",
    exclude: "data/palaeogenomics/pmids-all.txt",
    note:
      "Ancient-DNA questions BEYOND one research group's own output — the companion to tests/evalsets/palaeogenomics.json, which covers that group's own papers. Nothing here cites a paper it authored; that is enforced against a committed id list rather than trusted, so the two sets stay genuinely disjoint and a gain on one cannot be a gain on the other in disguise. Four domains: ancient humans and hominins, megafauna and palaeoecology, methods and chemistry, and the applied edge (pathogens, domestication, conservation, de-extinction). Swedish items are tagged `sv` and written in the VERNACULAR register, which is the register hosted retrieval is measurably worst at (docs/RAG-EVAL-LEDGER.md, 2026-08-08) — they are the hard half of this set deliberately. Items tagged `trap` are ones where the naive answer is a common misconception or a superseded result, and the gold answer states the correction.",
  },
  aisec: {
    kind: "domain-expert",
    note:
      "AI CYBERSECURITY, in both directions: the security OF machine-learning systems (adversarial examples, poisoning, backdoors, model extraction, membership inference, prompt injection, jailbreaks, agent security) and machine learning AS a security tool (intrusion and malware detection, fuzzing, vulnerability discovery, LLM pentest agents, deepfake detection), plus the system and policy layer around both. Citations are mostly arXiv and some PubMed — medical-device security and clinical-ML privacy are real parts of this field and live in PubMed. Swedish items are tagged `sv` and written in the VERNACULAR register. Items tagged `trap` are ones where the naive answer is a claim the primary literature does not support: a defence later broken by an adaptive attack, a benchmark result that does not survive temporal splitting, an evaluation number quoted outside its stated conditions.",
  },
  longevity: {
    kind: "domain-expert",
    note:
      "LONGEVITY AND AGEING BIOLOGY, across the whole arc the field actually spans: the hallmarks of ageing and the mechanisms under them (nutrient sensing, autophagy, proteostasis, DNA repair, mitochondrial function, epigenetic drift), cellular senescence and the SASP, comparative and model-organism biology (C. elegans, Drosophila, killifish, naked mole-rat, dog ageing), the evolutionary theory that explains why ageing exists at all, geroscience interventions from caloric restriction to rapamycin and senolytics, partial reprogramming and parabiosis, ageing clocks and biomarkers, human longevity genetics and epidemiology, and the demography and clinical translation where most of it either lands or fails. Citations are overwhelmingly PubMed — ageing biology is a life-science field — with a minority on arXiv for the quantitative slice: mortality modelling, evolutionary theory, systems-biology models and clock machine learning. Swedish items are tagged `sv`, vernacular register. This domain has an unusually high `trap` share by design, because it is unusually rich in results the popular account still repeats after the primary literature moved on — the free-radical and antioxidant story, resveratrol and the sirtuin activators, telomerase as a fountain of youth, blue-zone birth records, methylation clocks read as causal rather than correlational, and single-strain mouse lifespan results generalised to mammals. Every trap states a correction the literature itself makes, not scepticism of our own.",
  },
  aicon: {
    kind: "domain-expert",
    note:
      "AI CONSCIOUSNESS research, spanning the four things the question actually requires: machine consciousness proper (could an LLM be conscious, indicator properties, tests, self-models), the formal THEORIES the debate argues over (IIT, global workspace, higher-order, attention schema, predictive processing), the EMPIRICAL consciousness science those theories answer to (neural correlates, perturbational complexity, disorders of consciousness, anaesthesia, no-report paradigms), and the ethics that follow (moral status, AI welfare, philosophy of mind, animal consciousness as the comparative case). Citations are split between PubMed (consciousness science is overwhelmingly neuroscience) and arXiv. A caveat that shaped the set: much canonical philosophy of mind is in books and journals NEITHER corpus indexes, so where a landmark could not be fetched an indexed paper engaging the same argument was used instead — no question is built on a paraphrase of something unread. Swedish items are tagged `sv`, vernacular register. Items tagged `trap` correct a common misreading, most often a paper reported as claiming an AI is conscious when it claims something far weaker.",
  },
};

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
 * arXiv ids cited by an item, normalised to the VERSION-LESS form the index
 * keys on — `2307.15043v2` and `2307.15043` are the same document to us, and
 * a lookup with the version suffix would miss. Both id eras are accepted: the
 * post-2007 `2307.15043` and the old `cs/0501001` / `math.GT/0309136`.
 * @param {any} item
 */
export function citedArxiv(item) {
  const out = [];
  for (const u of item.goldUrls || []) {
    const m = String(u).match(/arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Every citation an item makes, in both corpora. @param {any} item */
export const citedAll = (item) => [...citedPmids(item), ...citedArxiv(item)];

/**
 * Swedish items are the half of this set most likely to arrive damaged: a
 * question that lost its diacritics still reads as Swedish to a human and
 * costs orders of magnitude of retrieval score (docs/PUBMED-RAG.md §7.7). A
 * Cyrillic or Greek letter pasted mid-word is invisible on screen and matches
 * nothing. Both are caught by requiring Latin-only text, then requiring that
 * anything tagged `sv` actually carries Swedish letters.
 * @param {string} s
 */
/**
 * The risk being guarded against is a CONFUSABLE character pasted mid-word —
 * a Cyrillic `е` inside an otherwise Latin word is invisible on screen and
 * matches nothing. Greek is a different matter: ε, σ, μ, φ and Δ are ordinary
 * mathematical notation in these fields, and an epsilon in a certified-
 * robustness question is correct rather than corrupt. So this denies the
 * confusable scripts instead of allowing only Latin.
 * @param {string} s
 */
const hasConfusableScript = (s) => /[\p{Script=Cyrillic}\p{Script=Armenian}]/u.test(String(s));
const hasSwedishLetters = (/** @type {string} */ s) => /[åäöÅÄÖ]/.test(s);

/**
 * Is this text actually written in Swedish?
 *
 * Diacritics alone cannot answer it. An English question citing Frässle,
 * Müller, Schrödinger or Ekström carries å/ä/ö and is not Swedish — that exact
 * false positive fired on a real item about binocular rivalry. Function words
 * are the reliable signal instead: they are frequent, they are not borrowed
 * into English prose, and no Swedish sentence long enough to be a question
 * avoids all of them. Two independent hits are required so a single stray
 * token (an "att" inside a quoted title) does not trip it.
 * @param {string} s
 */
const looksSwedish = (s) => {
  const words = String(s).toLowerCase().match(/[\p{L}]+/gu) || [];
  const seen = new Set(words.filter((w) => SWEDISH_FUNCTION_WORDS.has(w)));
  return seen.size >= 2;
};
// Every word here must be Swedish AND NOT also an English word, or an English
// question trips it: "de" falls out of "de-identified", and `man`, `under`,
// `till`, `men` and `en` are all ordinary English. Both of those fired as false
// positives on real items before this list was pruned.
const SWEDISH_FUNCTION_WORDS = new Set([
  "och", "att", "är", "som", "för", "inte", "med", "vad", "hur", "vilka", "vilken", "vilket",
  "den", "det", "ett", "på", "av", "från", "eller", "har", "hade", "kan", "kunde", "ska",
  "skulle", "sig", "när", "där", "här", "över", "mellan", "efter", "före", "genom", "mot",
  "utan", "varför", "sina", "sitt", "deras", "denna", "detta", "dessa", "hos", "samt",
]);

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

    // A citation may be to either corpus — which one depends on the domain,
    // not on the item. What is never acceptable is neither.
    const cites = citedAll(it);
    if (!cites.length) errors.push(`${where}: no resolvable PubMed or arXiv goldUrl`);
    for (const p of citedPmids(it)) if (excludePmids.has(p)) errors.push(`${where}: cites ${p}, which is by the excluded author`);

    const tags = it.tags || [];
    if (!tags.some((t) => DIFFICULTY.has(t))) errors.push(`${where}: no difficulty tag (${[...DIFFICULTY].join("|")})`);

    for (const [field, text] of [["question", it.question], ["answer", it.answer]]) {
      if (text && hasConfusableScript(text)) errors.push(`${where}: ${field} contains a confusable non-Latin character`);
    }
    // A Swedish item with no Swedish letters at all is the diacritic-stripping
    // failure, not a stylistic choice — no natural Swedish sentence of this
    // length avoids å, ä and ö entirely.
    if (tags.includes("sv") && !hasSwedishLetters(`${it.question} ${it.answer}`)) {
      errors.push(`${where}: tagged sv but carries no å/ä/ö — diacritics were probably stripped`);
    }
    if (!tags.includes("sv") && looksSwedish(it.question || "")) {
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

/**
 * Which of these arXiv ids exist. The API does NOT error on an unknown id — it
 * simply returns fewer entries than you asked for — so existence is a set
 * difference over the ids echoed back, never an HTTP status. Ids come back
 * versioned (`2307.15043v2`) regardless of how they were asked for, so the
 * version is stripped before comparison.
 * @param {string[]} ids
 */
async function resolveArxiv(ids) {
  const found = new Set();
  /** @type {Record<string, number>} */
  const categories = {};
  for (let i = 0; i < ids.length; i += ARXIV_BATCH) {
    const slice = ids.slice(i, i + ARXIV_BATCH);
    const url = `${ARXIV_API}?id_list=${slice.join(",")}&max_results=${slice.length}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`);
    const xml = await res.text();
    for (const entry of xml.split("<entry>").slice(1)) {
      const id = (entry.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/) || [])[1];
      if (!id) continue;
      found.add(id.replace(/v\d+$/, ""));
      // The PRIMARY category is a cheap coherence signal. Resolution proves a
      // paper exists; it cannot prove it is the paper the question is about.
      // With several authors working in one shared scratch directory, a
      // clobbered helper script once produced a batch of astro-ph results for
      // a security query — real ids, real papers, entirely wrong subject. A
      // category histogram makes that visible in one line instead of needing
      // 45 abstracts read back.
      const cat = (entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/) || [])[1];
      if (cat) categories[cat] = (categories[cat] || 0) + 1;
    }
    if (i + ARXIV_BATCH < ids.length) await new Promise((r) => setTimeout(r, ARXIV_PACE_MS));
  }
  return { found, categories };
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
    pubmedPapers: new Set(items.flatMap(citedPmids)).size,
    arxivPapers: new Set(items.flatMap(citedArxiv)).size,
    difficulty,
    domain,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const inDir = arg(argv, "--in", "data/adna");
  const setName = arg(argv, "--set", basename(inDir));
  const outPath = arg(argv, "--out", `tests/evalsets/${setName}.json`);
  const offline = has(argv, "--offline");
  const checkOnly = has(argv, "--check");

  const cfg = SETS[/** @type {keyof typeof SETS} */ (setName)];
  if (!cfg) throw new Error(`unknown set "${setName}" — add it to SETS with its note and exclusion list`);

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

  // Only some sets are defined against an author they must avoid; a set with
  // no `exclude` is not missing a check, it simply has nothing to exclude.
  const exclude = cfg.exclude && existsSync(cfg.exclude)
    ? new Set(readFileSync(cfg.exclude, "utf8").split(/\s+/).filter(Boolean))
    : new Set();
  if (cfg.exclude && !exclude.size) {
    console.log(`  ! ${cfg.exclude} is missing — cannot check that the set looks BEYOND its subject`);
  }

  const errors = validateItems(items, exclude);

  if (!offline) {
    const pmids = [...new Set(items.flatMap(citedPmids))];
    const arxiv = [...new Set(items.flatMap(citedArxiv))];
    if (pmids.length) {
      console.log(`\nResolving ${pmids.length} cited PMIDs against E-utilities …`);
      const found = await resolvePmids(pmids);
      for (const it of items) {
        for (const p of citedPmids(it)) if (!found.has(p)) errors.push(`${it.id}: PMID ${p} does not resolve — invented or mistyped`);
      }
      console.log(`  ${found.size}/${pmids.length} resolve`);
    }
    if (arxiv.length) {
      console.log(`Resolving ${arxiv.length} cited arXiv ids against the arXiv API …`);
      const { found, categories } = await resolveArxiv(arxiv);
      for (const it of items) {
        for (const a of citedArxiv(it)) if (!found.has(a)) errors.push(`${it.id}: arXiv ${a} does not resolve — invented or mistyped`);
      }
      console.log(`  ${found.size}/${arxiv.length} resolve`);
      const byCount = Object.entries(categories).sort((a, b) => b[1] - a[1]);
      console.log(`  primary categories: ${byCount.map(([c, n]) => `${c} ${n}`).join(", ")}`);
    }
  } else {
    console.log("\n! --offline: citations NOT verified against either corpus");
  }

  if (errors.length) {
    console.error(`\nREFUSING TO WRITE — ${errors.length} problem(s):`);
    for (const e of errors.slice(0, 40)) console.error(`  · ${e}`);
    if (errors.length > 40) console.error(`  … and ${errors.length - 40} more`);
    process.exit(1);
  }

  const stats = summarize(items);
  console.log("\nSummary:");
  console.log(
    `  ${stats.items} items · ${stats.swedish} Swedish · ${stats.traps} traps · ` +
      `${stats.pubmedPapers} PubMed + ${stats.arxivPapers} arXiv papers`,
  );
  console.log(`  difficulty: ${JSON.stringify(stats.difficulty)}`);
  console.log(`  domain:     ${JSON.stringify(stats.domain)}`);

  if (checkOnly) {
    console.log("\n--check: valid, nothing written.");
    return;
  }

  const payload = {
    set: setName,
    kind: cfg.kind,
    origin:
      "Hand-authored against abstracts fetched from NCBI E-utilities and the arXiv API; every cited id resolved against its corpus before this file was written.",
    license: "Questions and gold answers are original; the underlying facts are from the cited abstracts.",
    note: cfg.note,
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

#!/usr/bin/env node
// Live verification for the introspection security-assessment capability: proves
// that a real model, given the injected OWASP reference block, ACCURATELY quotes
// the actual OWASP text from MULTIPLE different vulnerability categories — not
// one place, and not paraphrased-from-memory. This is the evidence behind the
// "hardcode the index and verify multi-source quoting" requirement.
//
// For each answer model it retrieves the OWASP block two ways — the committed
// DENSE index (Berget e5) AND the embedding-free LEXICAL path (what DRC/offline
// uses) — feeds each to the model, then checks how many DISTINCT OWASP
// categories were quoted VERBATIM (a ≥60-char normalized fragment of a retrieved
// chunk appearing in the answer, so a match can only come from the provided
// text, never memory). PASS = ≥2 distinct categories quoted accurately.
//
//   BERGET_API_KEY=… npm run verify:owasp
// Opt-in (needs the key), makes real calls — a live-verify tool, not a unit
// test; not run in CI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateSnapshot, validateRagIndex, retrieveSourceChunks,
  diversifyByCategory, lexicalRetrieveOwasp, buildOwaspReferenceBlock, owaspCategoryOf,
} from "../public/js/introspect-core.js";

const KEY = process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;
if (!KEY) throw new Error("Set BERGET_API_KEY to run the live OWASP quoting verification.");
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "introspect");
const raw = JSON.parse(readFileSync(join(DIR, "owasp-corpus.json"), "utf8"));
const corpus = validateSnapshot(raw);
const index = validateRagIndex(JSON.parse(readFileSync(join(DIR, "owasp-rag.json"), "utf8")));

const MODELS = (process.env.VERIFY_MODELS || "mistralai/Mistral-Medium-3.5-128B,mistralai/Mistral-Small-3.2-24B-Instruct-2506").split(",");
const QUERY =
  "Conduct a full security assessment of an LLM-powered deep-research web app: it takes untrusted web content into the model prompt, renders model output as markdown/HTML, has admin endpoints behind a session cookie, calls external providers, and enforces per-user quotas.";
const SYSTEM =
  "You are a security assessor. Perform a security assessment structured as ## Executive Summary, then ## Scope, then ## Findings. Classify findings against the OWASP Top 10 (LLM 2025 + Web 2021) passages provided, cite each category id, give a CVSS estimate with stated uncertainty, and — required — QUOTE the relevant OWASP passage VERBATIM for at least THREE different categories, attributing each quote to its category id.";

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
async function embed(q) {
  const r = await fetch("https://api.berget.ai/v1/embeddings", { method: "POST",
    headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: "intfloat/multilingual-e5-large", input: ["query: " + q] }) });
  return Float32Array.from((await r.json()).data[0].embedding);
}
async function chat(model, user) {
  const r = await fetch("https://api.berget.ai/v1/chat/completions", { method: "POST",
    headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], temperature: 0.2, max_tokens: 2200 }) });
  const j = await r.json();
  if (!j.choices) throw new Error(JSON.stringify(j).slice(0, 300));
  return j.choices[0].message.content || "";
}
function quotedCategories(hits, answer, WIN = 60) {
  const a = norm(answer);
  const cats = new Set();
  for (const h of hits) {
    const t = norm(h.text);
    for (let i = 0; i + WIN <= t.length; i += 12) {
      if (a.includes(t.slice(i, i + WIN))) { cats.add(owaspCategoryOf(h.p)); break; }
    }
  }
  return cats;
}

let failures = 0;
const qv = await embed(QUERY);
const dense = diversifyByCategory(retrieveSourceChunks(index, corpus, qv, index.vectors.length), 8, 2);
const lexical = lexicalRetrieveOwasp(corpus, QUERY, { k: 8, perCat: 2 });
console.log("dense block categories  :", [...new Set(dense.map((h) => owaspCategoryOf(h.p)))].join(", "));
console.log("lexical block categories:", [...new Set(lexical.map((h) => owaspCategoryOf(h.p)))].join(", "));

for (const model of MODELS) {
  for (const [label, hits] of [["dense", dense], ["lexical(offline)", lexical]]) {
    const answer = await chat(model, `App under assessment: ${QUERY}\n\n${buildOwaspReferenceBlock(hits, raw.sources)}\n\nWrite the assessment now.`);
    const cats = quotedCategories(hits, answer);
    const ok = cats.size >= 2;
    if (!ok) failures++;
    console.log(`\n${model} [${label}]: ${cats.size} categories quoted verbatim — ${[...cats].join(", ") || "(none)"}  → ${ok ? "PASS" : "FAIL"}`);
  }
}
console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

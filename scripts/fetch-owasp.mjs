#!/usr/bin/env node
// Downloads the FULL authoritative text of the two OWASP Top 10 documents this
// site's introspection security-assessment mode grounds itself in, and writes
// them as ONE committed corpus artifact:
//
//   public/introspect/owasp-corpus.json
//
//   - OWASP Top 10 for LLM Applications 2025 (LLM01…LLM10)
//   - OWASP Top 10 for Web Applications 2021 (A01…A10)
//
// The corpus is SNAPSHOT-SHAPED on purpose ({ v, digest, count, bytes, files:
// [{p,s,t}] }) so it reuses the introspection source machinery verbatim: the
// same deterministic chunker (introspect-core.js chunkSourceText), the same
// int8 RAG index format (scripts/bundle-owasp-rag.mjs → owasp-rag.json), and
// the same retrieval (retrieveSourceChunks). A parallel `sources` map carries
// each doc's citation metadata (category id, human title, canonical URL) so the
// enrichment can attribute a retrieved quote to LLM01:2025 / A01:2021 with a
// link. Because the artifact is committed and served by THIS deploy, the OWASP
// text the model quotes is frozen and reproducible — no fetch at request time.
//
// Text comes from the projects' OWN Markdown source of record (the definitive,
// clean full text — not the rendered SPA/WordPress pages):
//   - LLM:  github.com/OWASP/www-project-top-10-for-large-language-model-applications
//   - Web:  github.com/OWASP/Top10  (2021/docs/en)
//
// Run it to (re)fetch the corpus, then rebuild the index:
//   npm run fetch:owasp        # → public/introspect/owasp-corpus.json
//   npm run bundle:owasp-rag   # → public/introspect/owasp-rag.json
//   npm test                   # freshness check: index resolves against corpus
// Not part of `npm run bundle` and not run in CI (network) — a human refreshes
// it when OWASP publishes an update.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "public/introspect/owasp-corpus.json";

const LLM_RAW = "https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns";
const WEB_RAW = "https://raw.githubusercontent.com/OWASP/Top10/master/2021/docs/en";

// One entry per OWASP category. `file` is the raw-Markdown source; `id` is the
// stable corpus key (also the citation the model prints); `url` is the canonical
// human page for the Sources list.
const DOCS = [
  // ---- OWASP Top 10 for LLM Applications 2025 ----
  { family: "llm", cat: "LLM01", title: "Prompt Injection", file: "LLM01_PromptInjection.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/" },
  { family: "llm", cat: "LLM02", title: "Sensitive Information Disclosure", file: "LLM02_SensitiveInformationDisclosure.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/" },
  { family: "llm", cat: "LLM03", title: "Supply Chain", file: "LLM03_SupplyChain.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm032025-supply-chain/" },
  { family: "llm", cat: "LLM04", title: "Data and Model Poisoning", file: "LLM04_DataModelPoisoning.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm042025-data-and-model-poisoning/" },
  { family: "llm", cat: "LLM05", title: "Improper Output Handling", file: "LLM05_ImproperOutputHandling.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/" },
  { family: "llm", cat: "LLM06", title: "Excessive Agency", file: "LLM06_ExcessiveAgency.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm062025-excessive-agency/" },
  { family: "llm", cat: "LLM07", title: "System Prompt Leakage", file: "LLM07_SystemPromptLeakage.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/" },
  { family: "llm", cat: "LLM08", title: "Vector and Embedding Weaknesses", file: "LLM08_VectorAndEmbeddingWeaknesses.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/" },
  { family: "llm", cat: "LLM09", title: "Misinformation", file: "LLM09_Misinformation.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm092025-misinformation/" },
  { family: "llm", cat: "LLM10", title: "Unbounded Consumption", file: "LLM10_UnboundedConsumption.md", raw: LLM_RAW, url: "https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/" },
  // ---- OWASP Top 10 for Web Applications 2021 ----
  { family: "web", cat: "A01", title: "Broken Access Control", file: "A01_2021-Broken_Access_Control.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A01_2021-Broken_Access_Control/" },
  { family: "web", cat: "A02", title: "Cryptographic Failures", file: "A02_2021-Cryptographic_Failures.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A02_2021-Cryptographic_Failures/" },
  { family: "web", cat: "A03", title: "Injection", file: "A03_2021-Injection.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A03_2021-Injection/" },
  { family: "web", cat: "A04", title: "Insecure Design", file: "A04_2021-Insecure_Design.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A04_2021-Insecure_Design/" },
  { family: "web", cat: "A05", title: "Security Misconfiguration", file: "A05_2021-Security_Misconfiguration.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A05_2021-Security_Misconfiguration/" },
  { family: "web", cat: "A06", title: "Vulnerable and Outdated Components", file: "A06_2021-Vulnerable_and_Outdated_Components.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/" },
  { family: "web", cat: "A07", title: "Identification and Authentication Failures", file: "A07_2021-Identification_and_Authentication_Failures.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/" },
  { family: "web", cat: "A08", title: "Software and Data Integrity Failures", file: "A08_2021-Software_and_Data_Integrity_Failures.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/" },
  { family: "web", cat: "A09", title: "Security Logging and Monitoring Failures", file: "A09_2021-Security_Logging_and_Monitoring_Failures.md", raw: WEB_RAW, url: "https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/" },
  { family: "web", cat: "A10", title: "Server-Side Request Forgery (SSRF)", file: "A10_2021-Server-Side_Request_Forgery_(SSRF).md", raw: WEB_RAW, url: "https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_(SSRF)/" },
];

const YEAR = { llm: "2025", web: "2021" };

/** Light Markdown cleanup: drop image refs and mkdocs attribute lists that add
 *  noise to the embedded/quoted text, keep all prose, tables and headings. */
function cleanMarkdown(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](src) images
    .replace(/<img[^>]*>/gi, "") // <img> tags
    .replace(/\{:[^}]*\}/g, "") // {: style="…" } attr lists
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function main() {
  const files = [];
  const sources = {};
  for (const d of DOCS) {
    const id = `${d.cat}:${YEAR[d.family]} ${d.title}`;
    process.stdout.write(`  ${id} … `);
    const raw = await fetchText(`${d.raw}/${encodeURI(d.file)}`);
    const text = cleanMarkdown(raw);
    if (text.length < 500) throw new Error(`suspiciously short (${text.length} chars): ${id}`);
    files.push({ p: id, s: text.length, t: text });
    sources[id] = { cat: d.cat, family: d.family, year: YEAR[d.family], title: d.title, url: d.url };
    console.log(`${text.length} chars`);
  }
  // Deterministic digest of the concatenated corpus (id + text), so a change to
  // any doc changes the digest — the same idea as the source snapshot's digest.
  const digest = createHash("sha256")
    .update(files.map((f) => f.p + "\n" + f.t).join("\n\n"))
    .digest("hex");
  const corpus = {
    v: 1,
    digest,
    count: files.length,
    bytes: files.reduce((n, f) => n + f.s, 0),
    files,
    sources,
  };
  writeFileSync(join(ROOT, OUT), JSON.stringify(corpus) + "\n");
  console.log(
    `\nWrote ${OUT}: ${files.length} docs, ${(corpus.bytes / 1000).toFixed(0)}k chars, digest ${digest.slice(0, 12)}`,
  );
}

main().catch((err) => {
  console.error("fetch-owasp failed:", err.message);
  process.exit(1);
});

// Unit coverage for the /pulse/timeline subject taxonomy (scripts/pulse-themes.mjs).
// Pure text → tags; no git, no network. Runs in `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SUBJECTS, tagCommit, subject, subjectRegistry } from "./pulse-themes.mjs";

test("every subject has a unique key, label, hex colour, blurb and RegExp", () => {
  const keys = new Set();
  for (const s of SUBJECTS) {
    assert.ok(s.key && !keys.has(s.key), `duplicate/empty key: ${s.key}`);
    keys.add(s.key);
    assert.match(s.color, /^#[0-9a-fA-F]{6}$/, `${s.key} colour must be #rrggbb`);
    assert.ok(s.label && s.blurb, `${s.key} needs a label + blurb`);
    assert.ok(s.test instanceof RegExp, `${s.key} needs a RegExp test`);
  }
});

test("subject colours are distinct (entity-stable, never a repeated hue)", () => {
  const colors = SUBJECTS.map((s) => s.color.toLowerCase());
  assert.equal(new Set(colors).size, colors.length, "two subjects share a hue");
});

test("subjectRegistry() drops the regex but keeps the client fields", () => {
  const reg = subjectRegistry();
  assert.equal(reg.length, SUBJECTS.length);
  for (const r of reg) {
    assert.deepEqual(Object.keys(r).sort(), ["blurb", "color", "key", "label"]);
  }
});

test("tagCommit returns zero-to-many keys, in SUBJECTS order", () => {
  assert.deepEqual(tagCommit(""), []);
  assert.deepEqual(tagCommit("Merge barrier: re-point main_sha"), []);
  const multi = tagCommit("Regenerate the source-rag index for the on-device download fix");
  assert.ok(multi.includes("ondevice"));
  assert.ok(multi.includes("artifacts") || multi.includes("introspection"),
    "regen-of-artifacts commit should also read as artifacts/introspection");
  // order preserved
  const order = SUBJECTS.map((s) => s.key);
  const idx = multi.map((k) => order.indexOf(k));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});

// Representative real subject lines → the feature set they must land on.
const CASES = [
  ["On-device inference: 1-bit Bonsai models in the browser (Se/cure)", ["ondevice", "secure"]],
  ["Sandbox boot: tar-based /src seeding + a fail-soft seed timeout", ["sandbox"]],
  ["Widen hfIntent: hub-implied model vocabulary fires the HF Hub source", ["hf"]],
  ["Se/rver tokens: one ticket, one JWT — consolidated upstream-API grants", ["grants"]],
  ["Nearby-place asks run a location-biased Google Places search", ["maps"]],
  ["Help mode: the documentation-first layer of introspection", ["help", "introspection"]],
  ["OAuth connector: the discovery documents and the redirect allowlist", ["mcp"]],
  ["Fix the discovery pointer: a well-known URI is origin-relative", ["mcp"]],
  ["refactor(client): split embeds registry and recovery transport from stream.js", ["refactor"]],
  ["security: mechanical secret-leak prevention — scanner + pre-push hook (P-2)", ["security"]],
  ["auth: canonicalize www -> apex so Google OAuth redirect_uri matches", ["access"]],
  ["DistillSDK: core design docs (DESIGN, MANIFEST, ROADMAP, README)", ["sdk"]],
  ["arXiv RAG: harvester, index builder, search CLI, pipeline bake-off", ["arxiv"]],
  ["Record the cosine-vs-rerank measurement at two corpus sizes", ["arxiv"]],
  ["Execution environments: run the agent's shell on your own machine", ["execenv"]],
  ["Add a server-side execution environment: one ephemeral container per session", ["execenv"]],
  ["Agent platform: define, preview, prove and share agents through the SDK", ["agents", "sdk"]],
  ["Stage 5: the capability block becomes executed, not merely declared", ["agents"]],
  ["Cross-agent starter-prompt queue and evaluation system", ["starters"]],
  ["Refocus intro LinkedIn article on the research/innovation purpose", ["articles"]],
  ["Ingest PubMed as a second hosted corpus beside arXiv", ["pubmed", "arxiv"]],
  ["Create and fill the PubMed index; enable the PUBMED_INDEX binding", ["pubmed"]],
  ["Deep Science agent: peer-reviewed sources only, with Google Scholar", ["science"]],
  ["Add the palaeogenomics agent: Europe PMC + an ancient-sample corpus", ["science"]],
  ["Starship launch scene: hot-staging and a tower catch", ["games"]],
  ["Run the browser suite against a local Worker, in CI", ["tests"]],
  ["Add an invite / add-user interface for admins", ["admin"]],
  ["Ingest the whole ancient-DNA literature, and measure what it costs", ["ingest", "science"]],
  ["Harvest arXiv by leaf category set, and correct the OAI abandonment verdict", ["ingest", "arxiv"]],
  ["Commit the gold needle sets, and pin what committing them exposed", ["tests"]],
  ["Add 180 ancient-DNA questions, and fix a needle the index could never answer", ["science", "tests"]],
  ["The research planner stops reading the method we wrote to ourselves", ["pipeline"]],
];

// Swedish forms must tag the same subject as their English counterpart — the
// same EN/SV parity discipline the product's routing gates are held to.
const SV_PARITY = [
  ["Exekveringsmiljöer: kör agentens skal på din egen maskin", "execenv"],
  ["Omrankning av arXiv-träffar mätt mot cosinus", "arxiv"],
  ["Standardagenter blir data i registret, inte kod", "agents"],
  ["Startprompterna rankas nu tvärs över agenterna", "starters"],
  ["Artikelserien på LinkedIn får en ny ingång", "articles"],
  ["Biomedicinska träffar hämtas nu från det andra korpuset", "pubmed"],
  ["Expertgranskade källor och haplogrupperna som saknades", "science"],
  ["Rymdanimationen: stegseparation utan att tappa höjden", "games"],
  ["OAuth-flödet: kopplare mot Claude och ChatGPT", "mcp"],
  ["Skörda arXiv per kategorimängd och läs in båda domänerna", "ingest"],
  ["Inläsningarna körs om från kontrollpunkten", "ingest"],
  ["Frågebanken utökas med 180 forntida-DNA-frågor", "tests"],
  ["Forntida-DNA-frågorna som indexet aldrig kunde svara på", "science"],
  ["Frågeskrivningen läser inte längre metoden vi skrev till oss själva", "pipeline"],
];

for (const [line, key] of SV_PARITY) {
  test(`Swedish parity: ${line.slice(0, 40)}… → ${key}`, () => {
    assert.ok(tagCommit(line).includes(key),
      `expected "${key}" in [${tagCommit(line).join(", ")}] for: ${line}`);
  });
}

for (const [line, mustHave] of CASES) {
  test(`tags: ${line.slice(0, 48)}…`, () => {
    const got = tagCommit(line);
    for (const key of mustHave) {
      assert.ok(got.includes(key), `expected "${key}" in [${got.join(", ")}] for: ${line}`);
      assert.ok(subject(key), `unknown key ${key}`);
    }
  });
}

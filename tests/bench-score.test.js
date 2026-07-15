// Unit tests for the PURE helpers in bench-score.mjs. No network, no LLM —
// deterministic inputs/outputs only. Run: node --test tests/bench-score.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostnameOf,
  sourceDiversity,
  citationCoverage,
  reportStructure,
  aggregateScores,
  mean,
  median,
} from "./bench-score.mjs";

test("hostnameOf normalizes scheme, www, and case", () => {
  assert.equal(hostnameOf("https://www.Example.com/path?q=1"), "example.com");
  assert.equal(hostnameOf("http://sub.example.com"), "sub.example.com");
  assert.equal(hostnameOf("example.org/foo"), "example.org"); // no scheme
  assert.equal(hostnameOf("WWW.NASA.GOV"), "nasa.gov");
  assert.equal(hostnameOf(""), "");
  assert.equal(hostnameOf(null), "");
  assert.equal(hostnameOf(undefined), "");
});

test("sourceDiversity: empty list is a zero bundle", () => {
  const d = sourceDiversity([]);
  assert.equal(d.total, 0);
  assert.equal(d.uniqueDomains, 0);
  assert.equal(d.maxDomainShare, 0);
  assert.equal(d.score, 0);
  assert.equal(d.topDomain, null);
  assert.deepEqual(d.perDomain, {});
  assert.deepEqual(sourceDiversity(null), sourceDiversity(undefined));
});

test("sourceDiversity: all-distinct domains score high", () => {
  const d = sourceDiversity([
    { url: "https://a.com/x" },
    { url: "https://b.org/y" },
    { url: "https://c.net/z" },
    { url: "https://d.io/w" },
  ]);
  assert.equal(d.total, 4);
  assert.equal(d.uniqueDomains, 4);
  assert.equal(d.maxDomainShare, 0.25);
  assert.equal(d.herfindahl, 0.25); // 4 * (1/4)^2
  // breadth = 1, spread = 1 - 0.25 = 0.75 -> (1+0.75)/2 = 0.875
  assert.equal(d.score, 0.875);
});

test("sourceDiversity: the round-7 self-citation trap scores low", () => {
  // 5 sources, 4 from one company domain -> should surface as low diversity.
  const d = sourceDiversity([
    { url: "https://acme.com/a" },
    { url: "https://acme.com/b" },
    { url: "https://acme.com/c" },
    { url: "https://acme.com/d" },
    { url: "https://independent.org/e" },
  ]);
  assert.equal(d.total, 5);
  assert.equal(d.uniqueDomains, 2);
  assert.equal(d.topDomain, "acme.com");
  assert.equal(d.maxDomainShare, 0.8);
  // herfindahl = (4/5)^2 + (1/5)^2 = 0.64 + 0.04 = 0.68
  assert.equal(d.herfindahl, 0.68);
  // breadth = 2/5 = 0.4, spread = 0.32 -> (0.4+0.32)/2 = 0.36
  assert.equal(d.score, 0.36);
  assert.ok(d.score < 0.5, "self-citation-heavy run must score below 0.5");
});

test("sourceDiversity: www and scheme variants of one host collapse", () => {
  const d = sourceDiversity([
    { url: "https://www.example.com/1" },
    { url: "http://example.com/2" },
    { url: "example.com/3" },
  ]);
  assert.equal(d.uniqueDomains, 1);
  assert.equal(d.maxDomainShare, 1);
  // breadth 1/3 ≈ 0.333, spread 1-1=0 -> (0.333+0)/2 = 0.167
  assert.equal(d.score, 0.167);
});

test("sourceDiversity: single-domain triple concrete numbers", () => {
  const d = sourceDiversity([
    { url: "https://x.com/1" },
    { url: "https://x.com/2" },
    { url: "https://x.com/3" },
  ]);
  // breadth = 1/3 ≈ 0.333, herfindahl = 1, spread = 0 -> (0.333+0)/2 = 0.167
  assert.equal(d.uniqueDomains, 1);
  assert.equal(d.herfindahl, 1);
  assert.equal(d.score, 0.167);
});

test("citationCoverage: counts distinct [n] and detects Sources list", () => {
  const answer =
    "Fact one [1]. Fact two [2]. Restated fact one again [1].\n\nSources:\n[1] A\n[2] B";
  const c = citationCoverage(answer);
  assert.equal(c.distinctCitations, 2);
  assert.equal(c.maxCitationIndex, 2);
  assert.equal(c.hasSourcesList, true);
  assert.equal(c.score, 1);
});

test("citationCoverage: multi-ref brackets are split", () => {
  const c = citationCoverage("Combined claim [1, 2, 3].\nSources:\n[1] a");
  assert.equal(c.distinctCitations, 3);
  assert.equal(c.maxCitationIndex, 3);
});

test("citationCoverage: no citations, no sources", () => {
  const c = citationCoverage("Just prose with no markers at all.");
  assert.equal(c.distinctCitations, 0);
  assert.equal(c.hasSourcesList, false);
  assert.equal(c.maxCitationIndex, 0);
  assert.equal(c.score, 0);
});

test("citationCoverage: citations but no sources list = partial credit", () => {
  const c = citationCoverage("A claim [1] and another [2].");
  assert.equal(c.distinctCitations, 2);
  assert.equal(c.hasSourcesList, false);
  assert.equal(c.score, 0.5);
});

test("citationCoverage: markdown-heading Sources still detected", () => {
  assert.equal(citationCoverage("text [1]\n\n## Sources:\n[1] x").hasSourcesList, true);
  assert.equal(citationCoverage("text [1]\n\n**Sources:**\n[1] x").hasSourcesList, true);
});

test("citationCoverage: non-string input is safe", () => {
  const c = citationCoverage(null);
  assert.equal(c.distinctCitations, 0);
  assert.equal(c.score, 0);
});

test("mean and median utilities", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean([]), 0);
  assert.equal(mean([5]), 5);
  assert.equal(median([3, 1, 2]), 2); // odd, sorted middle
  assert.equal(median([4, 1, 2, 3]), 2.5); // even, avg of middle two
  assert.equal(median([]), 0);
  // non-numbers are ignored
  assert.equal(mean([1, "x", null, 3]), 2);
});

test("aggregateScores: mean/median per dimension + overall", () => {
  const per = [
    { scores: { citation: 4, coverage: 5, calibration: 3 } },
    { scores: { citation: 2, coverage: 3, calibration: 5 } },
    { scores: { citation: 3, coverage: 4, calibration: 4 } },
  ];
  const agg = aggregateScores(per);
  assert.equal(agg.count, 3);
  assert.equal(agg.scored, 3);
  assert.equal(agg.dimensions.citation.mean, 3); // (4+2+3)/3
  assert.equal(agg.dimensions.citation.median, 3);
  assert.equal(agg.dimensions.coverage.mean, 4); // (5+3+4)/3
  assert.equal(agg.dimensions.calibration.mean, 4); // (3+5+4)/3
  assert.equal(agg.dimensions.citation.n, 3);
  // per-entry overall = mean of its dims: [4, 3.333, 3.667]; mean = 3.667
  assert.equal(agg.overall.mean, 3.667);
});

test("aggregateScores: honors an explicit per-entry overall", () => {
  const per = [
    { scores: { citation: 5 }, overall: 5 },
    { scores: { citation: 1 }, overall: 1 },
  ];
  const agg = aggregateScores(per);
  assert.equal(agg.overall.mean, 3); // (5+1)/2 from explicit overalls
  assert.equal(agg.overall.median, 3);
});

test("aggregateScores: skips missing/non-numeric per dimension", () => {
  const per = [
    { scores: { citation: 4, coverage: 5 } },
    { scores: { citation: 2 } }, // no coverage
    { scores: { citation: null, coverage: 3 } }, // null skipped
  ];
  const agg = aggregateScores(per);
  assert.equal(agg.dimensions.citation.n, 2); // 4 and 2 only
  assert.equal(agg.dimensions.citation.mean, 3);
  assert.equal(agg.dimensions.coverage.n, 2); // 5 and 3
  assert.equal(agg.dimensions.coverage.mean, 4);
});

test("aggregateScores: accepts bare score objects (no scores wrapper)", () => {
  const agg = aggregateScores([{ citation: 4 }, { citation: 2 }]);
  assert.equal(agg.dimensions.citation.mean, 3);
});

test("aggregateScores: empty input is a zero bundle", () => {
  const agg = aggregateScores([]);
  assert.equal(agg.count, 0);
  assert.equal(agg.scored, 0);
  assert.deepEqual(agg.dimensions, {});
  assert.equal(agg.overall.mean, 0);
});

// --- reportStructure (the tier A/B's comprehensiveness readout) ------------

test("reportStructure: a full-tier-shaped report counts everything", () => {
  const answer = [
    "# EU AI Act Enforcement",
    "",
    "**The Act's first deadlines land in 2026, and enforcement is real.**",
    "",
    "## Current state",
    "",
    "Prohibited practices apply since Feb 2025 [1].",
    "",
    "### National authorities",
    "",
    "- Sweden named its authority [2]",
    "- Germany has not [3]",
    "",
    "## Key numbers",
    "",
    "| Provision | Deadline |",
    "|---|---|",
    "| GPAI rules | Aug 2025 |",
    "| High-risk | Aug 2026 |",
    "",
    "## Limitations and open questions",
    "",
    "Sources conflict on the GPAI code's status [1][3].",
    "",
    "Sources:",
    "- [1] Title — https://a.example",
    "- [2] Title — https://b.example",
    "- [3] Title — https://c.example",
  ].join("\n");
  const s = reportStructure(answer);
  assert.equal(s.hasTitle, 1);
  assert.equal(s.hasBoldLead, 1);
  assert.equal(s.hasLimitations, 1);
  assert.equal(s.h1, 1);
  assert.equal(s.h2, 3);
  assert.equal(s.h3, 1);
  assert.equal(s.tableRows, 3); // header + 2 data rows; separator excluded
  assert.equal(s.bullets, 2); // body bullets only — the Sources list is excluded
  assert.ok(s.words > 30 && s.words < 120);
});

test("reportStructure: a brief-shaped answer stays flat", () => {
  const answer =
    "**Yes — the deadline is Aug 2026.**\n\n- Key fact one [1]\n- Key fact two [2]\n\nSources:\n- [1] T — https://a.example\n- [2] T — https://b.example\n";
  const s = reportStructure(answer);
  assert.equal(s.hasTitle, 0);
  assert.equal(s.hasBoldLead, 1);
  assert.equal(s.hasLimitations, 0);
  assert.equal(s.h1 + s.h2 + s.h3, 0);
  assert.equal(s.tableRows, 0);
  assert.equal(s.bullets, 2);
  assert.ok(s.words < 25);
});

test("reportStructure: words count only the body before the Sources list", () => {
  const withList = "Answer body here.\n\nSources:\n- [1] " + "padding ".repeat(50) + "— https://a.example";
  assert.equal(reportStructure(withList).words, 3);
  // No Sources list at all -> the whole text is the body.
  assert.equal(reportStructure("Three words here").words, 3);
});

test("reportStructure: non-string input is a zero bundle", () => {
  const s = reportStructure(null);
  assert.equal(s.words, 0);
  assert.equal(s.h2, 0);
  assert.equal(s.hasTitle, 0);
});

test("reportStructure: all fields are numeric so aggregateScores can average them", () => {
  const agg = aggregateScores([
    { scores: reportStructure("**A.**\n\nSources:\n- [1] x") },
    { scores: reportStructure("# T\n\n**B.**\n\n## S\n\ntext [1]\n\nSources:\n- [1] x") },
  ]);
  assert.equal(agg.dimensions.hasTitle.mean, 0.5);
  assert.ok(agg.dimensions.words.n === 2);
});

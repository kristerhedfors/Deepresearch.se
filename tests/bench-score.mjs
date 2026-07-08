// Pure, dependency-free scoring + aggregation helpers for the LLM-judged
// research benchmark (see eval-bench.mjs for the live runner and
// bench-questions.mjs for the fixed question set).
//
// Everything here is deterministic and import-safe in plain Node — no
// network, no Berget/Exa, no DOM — so it is unit-tested directly in
// bench-score.test.js. The one function that *builds a prompt for* an LLM
// judge (buildJudgePrompt) is still pure: it only assembles a string, it
// does not call anything. Keeping the metrics that DON'T need a model
// (source diversity, citation coverage) separate from the ones that do
// (the judge's 1-5 scores) is the point — the non-LLM metrics are free,
// deterministic, and catch the round-7 "over-cites its own domain" class
// of regression without spending a judge token.

// --- domain helpers -------------------------------------------------------

// Extract a normalized registrable-ish hostname from a URL string. Mirrors
// src/pipeline.js's hostnameOf intent (lowercase, strip a leading "www.")
// but is written to be import-safe outside a Worker and tolerant of URLs
// with no scheme (Exa/registry entries are not always fully-qualified).
export function hostnameOf(url) {
  if (typeof url !== "string" || !url.trim()) return "";
  let u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u; // add scheme if missing
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    // Fall back to a crude host slice for genuinely malformed input.
    host = u.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0];
  }
  host = host.toLowerCase().replace(/^www\./, "");
  return host;
}

// --- non-LLM metric: source diversity ------------------------------------

// Domain-diversity metric over a trace's source list. `sources` is an array
// of { title?, url } (the shape the SSE search_done events and the answer's
// "Sources:" registry carry). Returns a bundle of raw counts plus a single
// normalized `score` in [0,1] that a summary can average.
//
// The headline signal for the round-7 self-citation trap is `maxDomainShare`
// (what fraction of all sources came from the single most-cited domain) and
// its inverse-flavored companions. `score` blends breadth (distinct domains
// per source) with concentration (1 - Herfindahl index of the domain
// distribution) so a run that cites 12 sources all from one site scores low
// even though it has "many" sources.
export function sourceDiversity(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const domains = list.map((s) => hostnameOf(s && s.url)).filter(Boolean);
  const total = domains.length;

  if (total === 0) {
    return {
      total: 0,
      uniqueDomains: 0,
      maxDomainShare: 0,
      topDomain: null,
      herfindahl: 0,
      score: 0,
      perDomain: {},
    };
  }

  const perDomain = {};
  for (const d of domains) perDomain[d] = (perDomain[d] || 0) + 1;
  const uniqueDomains = Object.keys(perDomain).length;

  let topDomain = null;
  let topCount = 0;
  for (const [d, c] of Object.entries(perDomain)) {
    if (c > topCount) {
      topCount = c;
      topDomain = d;
    }
  }
  const maxDomainShare = topCount / total;

  // Herfindahl-Hirschman index of the domain distribution: sum of squared
  // shares. 1.0 = everything from one domain (no diversity); →0 = spread
  // thin across many domains. (1 - HHI) is a clean concentration-diversity.
  let herfindahl = 0;
  for (const c of Object.values(perDomain)) {
    const share = c / total;
    herfindahl += share * share;
  }

  // Blend breadth (unique/total) with the concentration-diversity (1-HHI).
  // Both are in [0,1]; equal weight. A single source scores 1.0 on breadth
  // but the caller can read `total` to know it's thin.
  const breadth = uniqueDomains / total;
  const spread = 1 - herfindahl;
  const score = round3((breadth + spread) / 2);

  return {
    total,
    uniqueDomains,
    maxDomainShare: round3(maxDomainShare),
    topDomain,
    herfindahl: round3(herfindahl),
    score,
    perDomain,
  };
}

// --- non-LLM metric: citation coverage -----------------------------------

// Count distinct inline [n] citation markers in an answer and detect the
// presence of a trailing "Sources:" list — the two structural properties
// synthPrompt is supposed to guarantee. Returns counts plus a boolean; the
// judge separately scores whether each [n] actually SUPPORTS its sentence
// (that needs the source text, hence a model), but "are there citations at
// all, and a sources list" is mechanically checkable here for free.
export function citationCoverage(answerText) {
  const text = typeof answerText === "string" ? answerText : "";
  const nums = new Set();
  // Match [1], [12], and bracketed multi-refs like [1, 2] / [1,2,3].
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(",")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n)) nums.add(n);
    }
  }
  const distinctCitations = nums.size;
  // "Sources:" list — case-insensitive, at a line start (the synthPrompt
  // convention), tolerant of markdown bold/heading prefixes.
  const hasSourcesList = /(^|\n)\s*(?:#+\s*|\*+\s*)?sources\s*:/i.test(text);

  return {
    distinctCitations,
    hasSourcesList,
    // Highest citation index referenced — a cheap sanity signal: an answer
    // citing [9] with only 3 sources listed is likely hallucinating refs.
    maxCitationIndex: nums.size ? Math.max(...nums) : 0,
    // 1 if it has both any citation and a sources list, else a partial
    // credit so the number is aggregatable alongside the judge dimensions.
    score: round3((distinctCitations > 0 ? 0.5 : 0) + (hasSourcesList ? 0.5 : 0)),
  };
}

// --- aggregation ----------------------------------------------------------

// Aggregate an array of per-question result objects into mean/median per
// numeric dimension plus an overall. Each entry is expected to carry a
// `scores` object of { dimension: number } (the judge's citation/coverage/
// calibration on a 1-5 scale, plus the non-LLM diversity/citation scores
// normalized however the caller stored them). Non-numeric / missing values
// are skipped per-dimension (a failed run contributes nothing rather than a
// zero that silently drags the mean). `overall` is the mean of each entry's
// own overall if present, else the mean across all its numeric dimensions.
export function aggregateScores(perQuestion) {
  const entries = Array.isArray(perQuestion) ? perQuestion : [];
  const dims = {}; // dimension -> array of numbers

  const collect = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        (dims[k] || (dims[k] = [])).push(v);
      }
    }
  };

  const perQuestionOveralls = [];
  for (const e of entries) {
    const scores = e && e.scores ? e.scores : e;
    collect(scores);
    // A per-entry overall, if the caller computed one, feeds the top line.
    if (e && typeof e.overall === "number" && Number.isFinite(e.overall)) {
      perQuestionOveralls.push(e.overall);
    } else if (scores && typeof scores === "object") {
      const nums = Object.values(scores).filter(
        (v) => typeof v === "number" && Number.isFinite(v),
      );
      if (nums.length) perQuestionOveralls.push(mean(nums));
    }
  }

  const dimensions = {};
  for (const [k, arr] of Object.entries(dims)) {
    dimensions[k] = { n: arr.length, mean: round3(mean(arr)), median: round3(median(arr)) };
  }

  return {
    count: entries.length,
    scored: perQuestionOveralls.length,
    dimensions,
    overall: {
      mean: round3(mean(perQuestionOveralls)),
      median: round3(median(perQuestionOveralls)),
    },
  };
}

// --- judge prompt builder -------------------------------------------------

// Build the strict-JSON prompt handed to a strong judge model. The judge is
// given the question, the rubric coverage points, the answer, AND the
// numbered source registry the answer cited from — so it can check whether
// each [n] actually supports the sentence it's attached to (faithfulness),
// not just whether a citation is present. Scores are 1-5; the judge must
// return ONLY a JSON object. Kept pure (string assembly only) so the runner
// can send it through /api/chat in web-search-off mode like any other
// message.
export function buildJudgePrompt({ question, rubric, answer, sources }) {
  const rubricPoints = Array.isArray(rubric) && rubric.length
    ? rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "(no explicit rubric — judge coverage against what a well-researched answer to the question would need)";

  const registry = Array.isArray(sources) && sources.length
    ? sources
        .map((s, i) => `[${s.n ?? i + 1}] ${s.title || "(untitled)"} — ${s.url || "(no url)"}`)
        .join("\n")
    : "(no sources were captured in the trace)";

  return `You are a strict, impartial evaluator of an AI research assistant's answer. Score it on three dimensions, each on an integer 1-5 scale. Judge only what is present; do not reward length or fluency.

RESEARCH QUESTION:
${question}

RUBRIC — coverage points a strong answer should address:
${rubricPoints}

NUMBERED SOURCE REGISTRY the answer was allowed to cite from (each [n] in the answer refers to one of these):
${registry}

ANSWER UNDER EVALUATION:
${answer}

Score these THREE dimensions (integers 1-5, where 1 = poor, 3 = adequate, 5 = excellent):

1. citation — Citation faithfulness. For each inline [n] marker, does the cited source in the registry plausibly SUPPORT the specific claim in that sentence? Penalize citations that don't match their claim, citations to numbers absent from the registry, and confident factual claims carrying no citation at all. An answer with no sources available cannot score above 2 here.

2. coverage — Coverage of the rubric. How many of the rubric points does the answer substantively address (not just mention)? Full marks only if it covers essentially all of them with real content.

3. calibration — Calibration and honesty. Does it hedge appropriately where sources conflict, distinguish well-established from contested claims, and PLAINLY admit when the question is unanswerable or sources are insufficient — rather than inventing specifics? An answer that fabricates details for an unanswerable question scores 1.

Return ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:
{"citation": <1-5>, "coverage": <1-5>, "calibration": <1-5>, "notes": "<one or two sentences justifying the scores>"}`;
}

// --- small numeric utilities (exported for the test) ----------------------

export function mean(arr) {
  const a = (arr || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!a.length) return 0;
  return a.reduce((s, v) => s + v, 0) / a.length;
}

export function median(arr) {
  const a = (arr || []).filter((v) => typeof v === "number" && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function round3(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

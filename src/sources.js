// The cross-search source registry: every search result the pipeline
// collects lands here — deduped by URL, numbered in arrival order so [n]
// citations stay stable between synthesis and validation, and diversity-
// capped per domain. Pure data logic (no fetches, no model calls), extracted
// from pipeline.js so the registry rules are readable and testable on their
// own (sources.test.js).

// A round 7 assessment found that MORE and DEEPER searches don't
// automatically buy more independent verification — a genuinely
// well-researched, 19-search "deep" run on a company's own product still
// ended up citing that company's own site 4 of 6 times, because Exa's
// relevance ranking naturally surfaces whoever has published the most
// content about themselves. This is the classic relevance-vs-diversity
// tension search engines have long addressed with result diversification
// (Carbonell & Goldstein's Maximal Marginal Relevance is the canonical
// technique) — capping how many results from one origin can dominate a
// result set, independent of how a caller phrases its queries. Doing it
// here as a hard cap (not a prompt instruction) guarantees it regardless
// of whether a given model reliably follows the softer prompt-level asks
// in prompts.js (triagePrompt's mandatory independent-source query,
// gapPrompt's dominance check) — belt and suspenders, not either/or.
const DOMAIN_CAP = 3;

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// The diversity-cap key for a URL. Normally the hostname — but huggingface.co
// is a PLATFORM hosting millions of independently-authored repos (the same
// way subdomains separate independent blogs): keying the whole hub as one
// origin would cap an HF-focused research question (the HF Hub search in
// src/hf.js feeds sources here) at 3 hub sources TOTAL, starving exactly the
// registry that question needs. Key hf.co URLs by owner namespace instead
// (`huggingface.co/<owner>`), so the cap still does its real job — no single
// AUTHOR dominating (3 models from one org still cap) — while different
// owners count as the different origins they are. Papers share one
// `huggingface.co/papers` bucket (they're editorially independent arXiv
// mirrors, but capping the paper firehose at 3 is the conservative choice).
export function diversityKeyOf(url) {
  const host = hostnameOf(url);
  if (host !== "huggingface.co") return host;
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (!segs.length) return host;
    if (segs[0] === "papers") return `${host}/papers`;
    if (segs[0] === "datasets" || segs[0] === "spaces") {
      return segs[1] ? `${host}/${segs[1]}` : host;
    }
    return `${host}/${segs[0]}`;
  } catch {
    return host;
  }
}

// Adds search-result items to the registry. Sources beyond DOMAIN_CAP for
// their origin are held in an overflow list rather than dropped outright —
// backfillOverflowSources() uses them if the capped registry ends up short
// of maxSources (a niche topic with genuinely few distinct domains
// shouldn't be starved just to enforce diversity that isn't available).
export function addSources(state, items) {
  state.domainCounts ||= new Map();
  state.sourceOverflow ||= [];
  for (const item of items || []) {
    if (!item?.url || state.byUrl.has(item.url)) continue;
    if (state.sources.length >= state.plan.maxSources) return;
    const key = diversityKeyOf(item.url);
    const count = state.domainCounts.get(key) || 0;
    if (count >= DOMAIN_CAP) {
      state.sourceOverflow.push(item);
      continue;
    }
    state.domainCounts.set(key, count + 1);
    pushSource(state, item);
  }
}

// Called once before synthesis: if the domain cap left the registry short
// of maxSources (few distinct domains for a niche topic), backfill from
// the overflow — diversity that doesn't exist can't be enforced, and a
// smaller-than-planned source list would otherwise cost the answer real
// grounding for no benefit.
export function backfillOverflowSources(state) {
  const overflow = state.sourceOverflow || [];
  while (state.sources.length < state.plan.maxSources && overflow.length) {
    const item = overflow.shift();
    if (!item?.url || state.byUrl.has(item.url)) continue;
    pushSource(state, item);
  }
}

// Shared by addSources/backfillOverflowSources: numbers and registers one
// source entry. Assumes the caller has already checked for a duplicate URL.
function pushSource(state, item) {
  const entry = {
    n: state.sources.length + 1,
    title: item.title || item.url,
    url: item.url,
    highlights: (item.highlights || []).slice(0, 3),
  };
  state.byUrl.set(item.url, entry);
  state.sources.push(entry);
}

// The numbered-source block handed to the gap-check / synthesis / validation
// prompts, bounded to capChars (the budget plan's digestCap).
export function sourceDigest(sources, capChars) {
  const blocks = [];
  let used = 0;
  for (const s of sources) {
    const block = `[${s.n}] ${s.title}\n${s.url}\n${s.highlights.join(" … ")}`.trim();
    if (used + block.length > capChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

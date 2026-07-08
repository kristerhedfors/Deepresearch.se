// Hugging Face Hub search — a search-phase source for the research pipeline.
//
// When a research question explicitly targets Hugging Face (hfIntent), each
// search wave ALSO queries the HF Hub API alongside Exa, and the hits (models,
// datasets, papers — each with its live metadata) join the numbered source
// registry as ordinary citable sources. Wired the same deterministic,
// no-function-calling way as every other integration: intent detection is a
// pure regex, the API calls are direct timeout-bounded fetches, and every
// branch fails soft to "no HF results" (the Exa wave is untouched).
//
// Endpoint behavior was established empirically (2026-07-08, curl):
// - /api/models?search= and /api/datasets?search= are NAME-substring matches:
//   a verbose research query ("swedish speech recognition models") returns
//   NOTHING, while short keyword terms ("whisper swedish") work. Hence
//   hfTerms (noise-word stripping) + hfAttempts (a token-drop ladder retried
//   until an attempt returns hits). List responses already carry downloads/
//   likes/pipeline_tag/lastModified, so no per-hit detail fetch is needed.
//   Each attempt fetches TWO slices per endpoint (2026-07-08, user ask:
//   "no stale stuff unless really relevant"): sort=downloads (the canonical,
//   really-relevant repos — allowed to be old) and sort=lastModified (the
//   fresh ones — junk-guarded by a download floor, since brand-new 0-download
//   uploads dominate that sort). Merged, deduped, popular-first
//   (mergeSlices). expand[] params make downloads/likes/lastModified present
//   on EVERY sort (the plain list response omits lastModified except when
//   sorting by it — established empirically).
// - /api/papers/search?q= handles verbose queries fine (full-text), so it
//   gets the raw query, not the term ladder.
// - /api/quicksearch exists but is ALSO name-matching and its items are
//   shallow (id + trendingWeight only) — rejected.
//
// Auth: HUGGINGFACE_API_TOKEN (Worker secret) rides as a Bearer header when
// present — public search works without it, the token buys rate-limit
// headroom and gated-repo visibility. Optional by design: its absence
// changes nothing structurally. Minimal outbound request, same rule as
// Exa/Shodan/Maps: only the AI-derived search terms cross the wire — never
// the conversation, filenames, or any account identity.

const HF_TIMEOUT_MS = 6000;
const SLICE = 3; // per-sort fetch size (popular slice + fresh slice)
const MAX_PER_ENDPOINT = 5; // merged cap per endpoint (models / datasets)
const MIN_FRESH_DOWNLOADS = 20; // junk guard for the lastModified slice
const MAX_PAPERS = 3;

// Explicit-mention intent: "hugging face" / "huggingface" / hf.co URLs /
// a bare "HF" as its own word ("most downloaded whisper variants on HF") —
// requested explicitly, since on a research site "HF" overwhelmingly means
// Hugging Face. Known tradeoff, accepted: a question about HF radio ("HF
// propagation at night") also fires — the cost is one free, fail-soft hub
// search whose (likely zero or irrelevant) results the domain cap and the
// synthesis's source-grounding absorb. A bare org/name path remains NOT
// enough — no reliable way to distinguish it from a file path or package
// name without a lookup.
export function hfIntent(text) {
  return /hugging\s*face|huggingface|hf\.co\b|\bhf\b/i.test(String(text || ""));
}

// Noise words stripped before the name-substring search: platform words
// (hugging/face/hub), generic artifact words (model/dataset — the endpoint
// choice already encodes them), and common question/stop words. Keeps the
// domain-bearing terms ("whisper", "swedish", "speech").
const NOISE = new Set([
  "hugging", "face", "huggingface", "hub", "hf", "model", "models", "dataset",
  "datasets", "paper", "papers", "the", "a", "an", "and", "or", "of", "on",
  "in", "for", "to", "with", "by", "from", "at", "as", "is", "are", "was",
  "were", "be", "been", "what", "which", "who", "how", "most", "best", "top",
  "latest", "new", "newest", "recent", "popular", "downloaded", "available",
  "there", "that", "this", "these", "those", "list", "find", "search",
  // Search-INTENT qualifiers that triage/gap queries carry for Exa's benefit
  // (the independent-source and coverage rules) but that only sabotage a
  // name-substring match: a live probe showed the gap round's "swedish
  // speech recognition independent reviews" ranking "independent" as the
  // distinctive term and returning unrelated repos. Stripping them also
  // collapses such follow-ups to the same hfTermKey as the initial wave,
  // so the cross-wave dedup correctly skips the repeat hub search.
  "independent", "review", "reviews", "criticism", "critique", "comparison",
  "compare", "compared", "alternative", "alternatives", "versus", "vs",
  "analysis", "expert", "experts", "opinion", "opinions", "coverage",
  "news", "official", "announcement", "announcements", "third-party",
  // Question-meta words about the artifacts, not of them: a live probe
  // showed "whisper variants" ranking "variants" as the distinctive term
  // and returning name-matched junk; stripping it leaves the actual
  // subject ("whisper" → the canonical repos, sorted by downloads).
  "variant", "variants", "version", "versions", "fine-tunes", "finetunes",
  // Survey/sub-question meta words (a production trace showed gap queries
  // like "cybersecurity trends 2026" / "... discussions ..." all collapsing
  // to the same single-term hub search because these carried no name-match
  // value yet differentiated the dedup keys).
  "trends", "trend", "discussions", "discussion", "debates", "debate",
  "breakthroughs", "breakthrough", "innovations", "innovation",
  "challenges", "challenge", "developments", "development",
]);

export function hfTerms(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}._\/-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .slice(0, 6);
}

// Hub-generic terms: real content words that are nonetheless so common in
// repo names that a single-term search on them surfaces popular-but-
// irrelevant repos (a live run A trace showed "speech recognition" returning
// Russian emotion-recognition models and "recognition" alone returning
// table-transformers, all high-download). Used to RANK single-term fallback
// attempts (distinctive terms first), never to drop a term outright.
const GENERIC = new Set([
  "speech", "recognition", "text", "language", "image", "audio", "video",
  "vision", "classification", "generation", "translation", "detection",
  "segmentation", "question", "answering", "chat", "llm", "llms", "ai",
  "benchmark", "benchmarks", "evaluation", "eval", "agent", "agents",
  "data", "corpus", "embedding", "embeddings", "base", "large", "small",
  "instruct", "pretrained", "finetuned", "research", "web",
]);

// Attempt ladder for the name-substring endpoints, redesigned after a live
// run A trace: multi-word attempts almost never match (every word must
// appear in the repo NAME), and naive term-dropping kept the generic words
// while losing the distinctive one ("swedish speech recognition" degraded to
// "speech recognition" → junk). Established empirically: the single most
// DISTINCTIVE term + sort=downloads surfaces the canonical repos
// ("swedish" → KBLab's 2.5M-download Swedish ASR model at rank 1). So: the
// full join first (cheap, occasionally exact), then the top two single
// terms ranked non-generic-first / longer-first. Deduped, ≤3 attempts.
export function hfAttempts(terms) {
  const list = [];
  const push = (s) => {
    const v = s.trim();
    if (v && !list.includes(v)) list.push(v);
  };
  if (terms.length > 1) push(terms.join(" "));
  const ranked = terms
    // A bare year matches repo names indiscriminately — never let it be a
    // single-term attempt (it stays fine inside multi-term joins).
    .filter((t) => !/^(19|20)\d{2}$/.test(t))
    .sort((a, b) => {
      const ga = GENERIC.has(a) ? 1 : 0;
      const gb = GENERIC.has(b) ? 1 : 0;
      if (ga !== gb) return ga - gb;
      return b.length - a.length;
    });
  for (const t of ranked.slice(0, 2)) push(t);
  return list;
}

// Picks the wave's most SPECIFIC query for the hub search. A production
// trace showed the orchestrator's old batch[0] choice always selecting the
// generic angle ("latest cybersecurity discussions ...") while the wave also
// carried entity-bearing queries ("Hugging Face response to CVE-2026-4372")
// that the hub could actually answer — the web->hub insight flow. Score:
// identifier-looking terms (digits/dots/hyphens/slashes, excluding bare
// years) weigh 3, other non-generic content terms 1, generic terms 0;
// earliest query wins ties.
export function hfPickQuery(batch) {
  let best = batch[0];
  let bestScore = -1;
  for (const q of batch) {
    let score = 0;
    for (const t of hfTerms(q)) {
      if (/^(19|20)\d{2}$/.test(t)) continue;
      if (/[\d./-]/.test(t)) score += 3;
      else if (!GENERIC.has(t)) score += 1;
    }
    if (score > bestScore) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

// Stable key for one query's term set — the cross-wave dedup key (gap-round
// follow-ups often reduce to the same terms after noise-stripping; a live
// run A trace showed waves 2-3 re-running near-identical hub searches for
// zero new sources).
export function hfTermKey(query) {
  return hfTerms(query).join(" ");
}

// Planner vocabulary (spliced into the triage/gap prompts via the
// search-source registry, src/search-sources.js). A production screenshot
// (2026-07-08) showed "Latest on cybersecurity on hf" triaging to CLARIFY
// ("Could you clarify what 'hf' refers to…") — the planning model doesn't
// know this site's users mean Hugging Face by "hf", so the request died one
// step before this module's own intent detection (which does accept a bare
// "hf") could ever run. Spelling the referent out in queries also helps Exa
// ("hugging face cybersecurity" finds what "hf cybersecurity" doesn't).
export const hfPromptNote =
  ' On this site, "HF"/"hf" in a user message means Hugging Face (huggingface.co, the AI model/dataset hub) unless the context clearly says otherwise (e.g. HF radio propagation): treat it as a clear referent — never ask to clarify what "hf" means — and spell it out as "Hugging Face" in any queries.';

// The registry diversity-cap key for hf.co URLs (consulted via the
// search-source registry by src/sources.js). huggingface.co is a PLATFORM
// hosting millions of independently-authored repos: keying the whole hub as
// one origin would cap an HF-focused question at 3 hub sources TOTAL,
// starving exactly the registry that question needs. Key by owner namespace
// (`huggingface.co/<owner>`) so the cap still does its real job — no single
// AUTHOR dominating (3 models from one org still cap) — while different
// owners count as the different origins they are. Papers share one
// `huggingface.co/papers` bucket (editorially independent arXiv mirrors,
// but capping the paper firehose at 3 is the conservative choice).
export function hfDiversityKey(url) {
  const host = "huggingface.co";
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

// ---- pure mappers: one Hub API item -> one source-registry item ------------

const fmtCount = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : null);
const fmtDate = (d) => (typeof d === "string" ? d.slice(0, 10) : null);

export function toModelItem(m) {
  if (!m?.id) return null;
  const bits = [
    "Model on Hugging Face",
    m.pipeline_tag ? `task: ${m.pipeline_tag}` : null,
    fmtCount(m.downloads) ? `${fmtCount(m.downloads)} downloads` : null,
    fmtCount(m.likes) ? `${fmtCount(m.likes)} likes` : null,
    fmtDate(m.lastModified) ? `updated ${fmtDate(m.lastModified)}` : null,
    m.gated ? "gated" : null,
  ].filter(Boolean);
  return {
    url: `https://huggingface.co/${m.id}`,
    title: `${m.id} (Hugging Face model)`,
    highlights: [bits.join(" · ")],
  };
}

export function toDatasetItem(d) {
  if (!d?.id) return null;
  const bits = [
    "Dataset on Hugging Face",
    fmtCount(d.downloads) ? `${fmtCount(d.downloads)} downloads` : null,
    fmtCount(d.likes) ? `${fmtCount(d.likes)} likes` : null,
    fmtDate(d.lastModified) ? `updated ${fmtDate(d.lastModified)}` : null,
    d.gated ? "gated" : null,
  ].filter(Boolean);
  return {
    url: `https://huggingface.co/datasets/${d.id}`,
    title: `${d.id} (Hugging Face dataset)`,
    highlights: [bits.join(" · ")],
  };
}

export function toPaperItem(p) {
  const paper = p?.paper || p;
  if (!paper?.id || !paper?.title) return null;
  const title = String(paper.title).replace(/\s+/g, " ").trim();
  const bits = [
    "Paper on Hugging Face",
    fmtDate(paper.publishedAt) ? `published ${fmtDate(paper.publishedAt)}` : null,
  ].filter(Boolean);
  const summary = typeof paper.summary === "string" ? paper.summary.replace(/\s+/g, " ").trim().slice(0, 280) : "";
  return {
    url: `https://huggingface.co/papers/${paper.id}`,
    title: `${title} (Hugging Face paper)`,
    highlights: [bits.join(" · "), ...(summary ? [summary] : [])],
  };
}

// ---- the search itself ------------------------------------------------------

async function hfGet(env, url) {
  const headers = { accept: "application/json" };
  if (env.HUGGINGFACE_API_TOKEN) headers.authorization = `Bearer ${env.HUGGINGFACE_API_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(HF_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HF API ${res.status}`);
  return res.json();
}

// Merges the popular (sort=downloads) and fresh (sort=lastModified) slices
// of one attempt: popular first (the canonical repos — old is fine, they are
// the "really relevant" exception), then fresh items not already present and
// above the download floor (brand-new 0-download uploads dominate the
// lastModified sort and are noise, not "the latest and greatest"). Pure,
// exported for tests.
export function mergeSlices(popular, fresh, cap = MAX_PER_ENDPOINT, minFreshDownloads = MIN_FRESH_DOWNLOADS) {
  const out = [];
  const seen = new Set();
  for (const it of popular || []) {
    if (it?.id && !seen.has(it.id)) {
      seen.add(it.id);
      out.push(it);
    }
  }
  for (const it of fresh || []) {
    if (!it?.id || seen.has(it.id)) continue;
    if ((it.downloads || 0) < minFreshDownloads) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out.slice(0, cap);
}

// Runs the attempt ladder against one name-substring endpoint; returns the
// first attempt's hits (or []) plus every attempt it consumed (`tried`) so
// the caller can record them — a production trace showed three waves whose
// ladders collapsed to the SAME winning term, re-fetching identical results;
// recording consumed attempts lets the orchestrator skip them next wave.
// Attempts are sequential by design — the whole point is to only fall back
// when the previous attempt found nothing.
async function ladderSearch(env, base, attempts, expandFields) {
  const expand = expandFields.map((f) => `expand%5B%5D=${f}`).join("&");
  const tried = [];
  for (const q of attempts) {
    tried.push(q);
    const url = (sort) =>
      `${base}?search=${encodeURIComponent(q)}&limit=${SLICE}&sort=${sort}&${expand}`;
    const [popular, fresh] = await Promise.all([
      hfGet(env, url("downloads")).catch(() => []),
      hfGet(env, url("lastModified")).catch(() => []),
    ]);
    const list = mergeSlices(
      Array.isArray(popular) ? popular : [],
      Array.isArray(fresh) ? fresh : [],
    );
    if (list.length) return { list, tried };
  }
  return { list: [], tried };
}

// One HF Hub search for one planned query: models + datasets (term ladder)
// and papers (raw query), all concurrent, each branch independently fail-soft
// (a failed endpoint contributes zero items, never an error). Returns
// { items, counts, durationMs }.
// `skipKeys` (from the orchestrator's per-request state) removes ladder
// attempts ALREADY consumed by earlier waves — the models/datasets ladders
// then only run on genuinely new attempts (no more re-fetching the same
// repos three times), while the verbose-friendly papers search still runs
// for every distinct query (each wave's papers results kept contributing
// new items in the trace that motivated this). Returns `usedKeys` — the
// attempts consumed this call — for the orchestrator to record.
export async function hfSearch(env, log, query, { skipKeys } = {}) {
  const startedAt = Date.now();
  const terms = hfTerms(query);
  const attempts = hfAttempts(terms).filter((a) => !skipKeys?.has(a));
  const empty = { list: [], tried: [] };
  const [modelsR, datasetsR, papers] = await Promise.all([
    attempts.length ? ladderSearch(env, "https://huggingface.co/api/models", attempts, ["downloads", "likes", "lastModified", "pipeline_tag", "gated"]).catch(() => empty) : empty,
    attempts.length ? ladderSearch(env, "https://huggingface.co/api/datasets", attempts, ["downloads", "likes", "lastModified", "gated"]).catch(() => empty) : empty,
    hfGet(env, `https://huggingface.co/api/papers/search?q=${encodeURIComponent(String(query || "").slice(0, 200))}`).catch(() => []),
  ]);
  const items = [
    ...modelsR.list.slice(0, MAX_PER_ENDPOINT).map(toModelItem),
    ...datasetsR.list.slice(0, MAX_PER_ENDPOINT).map(toDatasetItem),
    ...(Array.isArray(papers) ? papers.slice(0, MAX_PAPERS).map(toPaperItem) : []),
  ].filter(Boolean);
  const usedKeys = [...new Set([...modelsR.tried, ...datasetsR.tried])];
  const durationMs = Date.now() - startedAt;
  log?.info?.("hf.search", {
    query: String(query || "").slice(0, 120),
    models: modelsR.list.length,
    datasets: datasetsR.list.length,
    papers: Array.isArray(papers) ? papers.length : 0,
    skipped_attempts: (skipKeys?.size || 0) > 0 ? hfAttempts(terms).length - attempts.length : 0,
    duration_ms: durationMs,
  });
  return { items, durationMs, usedKeys };
}

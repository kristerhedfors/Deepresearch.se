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
//   sort=downloads matches the common "most used / best known" intent and
//   keeps result order deterministic.
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
const MAX_MODELS = 4;
const MAX_DATASETS = 4;
const MAX_PAPERS = 3;

// Explicit-mention intent only: "hugging face" / "huggingface" / hf.co URLs /
// "HF hub". A bare "HF" or a bare org/name path is deliberately NOT enough —
// too ambiguous, and a false positive adds a spurious "Searching Hugging
// Face" step to an unrelated question.
export function hfIntent(text) {
  return /hugging\s*face|huggingface|hf\.co\b|\bhf\s+hub\b/i.test(String(text || ""));
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
  const ranked = [...terms].sort((a, b) => {
    const ga = GENERIC.has(a) ? 1 : 0;
    const gb = GENERIC.has(b) ? 1 : 0;
    if (ga !== gb) return ga - gb;
    return b.length - a.length;
  });
  for (const t of ranked.slice(0, 2)) push(t);
  return list;
}

// Stable key for one query's term set — the cross-wave dedup key (gap-round
// follow-ups often reduce to the same terms after noise-stripping; a live
// run A trace showed waves 2-3 re-running near-identical hub searches for
// zero new sources).
export function hfTermKey(query) {
  return hfTerms(query).join(" ");
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

// Runs the token-drop ladder against one name-substring endpoint; returns the
// first attempt's hits (or []). Attempts are sequential by design — the whole
// point is to only fall back when the previous attempt found nothing.
async function ladderSearch(env, base, attempts, limit) {
  for (const q of attempts) {
    const list = await hfGet(env, `${base}?search=${encodeURIComponent(q)}&limit=${limit}&sort=downloads`);
    if (Array.isArray(list) && list.length) return list;
  }
  return [];
}

// One HF Hub search for one planned query: models + datasets (term ladder)
// and papers (raw query), all concurrent, each branch independently fail-soft
// (a failed endpoint contributes zero items, never an error). Returns
// { items, counts, durationMs }.
export async function hfSearch(env, log, query) {
  const startedAt = Date.now();
  const terms = hfTerms(query);
  const attempts = hfAttempts(terms);
  const [models, datasets, papers] = await Promise.all([
    attempts.length ? ladderSearch(env, "https://huggingface.co/api/models", attempts, MAX_MODELS).catch(() => []) : [],
    attempts.length ? ladderSearch(env, "https://huggingface.co/api/datasets", attempts, MAX_DATASETS).catch(() => []) : [],
    hfGet(env, `https://huggingface.co/api/papers/search?q=${encodeURIComponent(String(query || "").slice(0, 200))}`).catch(() => []),
  ]);
  const items = [
    ...models.slice(0, MAX_MODELS).map(toModelItem),
    ...datasets.slice(0, MAX_DATASETS).map(toDatasetItem),
    ...(Array.isArray(papers) ? papers.slice(0, MAX_PAPERS).map(toPaperItem) : []),
  ].filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log?.info?.("hf.search", {
    query: String(query || "").slice(0, 120),
    models: models.length,
    datasets: datasets.length,
    papers: Array.isArray(papers) ? papers.length : 0,
    duration_ms: durationMs,
  });
  return { items, durationMs };
}

// Hugging Face Hub enrichment — resolves any Hugging Face model or dataset a
// research question names into live Hub metadata (task/pipeline, library,
// license, downloads, likes, parameter count, tags, gated status, last
// update), so a question about an AI model or dataset is answered against the
// real Hub record rather than the model's training-cutoff memory of it.
//
// Wired the same deterministic, no-function-calling, fail-soft way as the
// Shodan and Maps enrichments: the Worker extracts repo ids from the latest
// user message with pure, unit-tested heuristics and resolves them via the
// Hugging Face Hub REST API. The result is appended to the conversation as one
// labeled context block every downstream phase (triage/search/synthesis) can
// reason and search with — never blended into the user's own text.
//
// Runs server-side, same as Berget/Exa/Shodan/Maps: Worker-mediated so it's
// logged, timeout-bounded, and the API token never reaches the browser. Only
// the repo id itself crosses the wire to Hugging Face — never the user's
// question or any account/session identifier.
//
// Privacy boundary: a repo id is derived from the user's question/topic and
// sent to a third party, so — like Exa and the Maps forward geocode — this is
// gated behind the web-search toggle (the pipeline only calls it when web
// search is on). The HUGGINGFACE_API_TOKEN secret gates availability and, when
// present, is sent as a Bearer token for higher rate limits and access to any
// gated repos the token is entitled to.
//
// Fails soft in every branch: a missing token, no repo ids, a repo that isn't
// on the Hub (404), a timeout, or an API error all degrade to "no Hub data"
// (or an honest "not found" note so the model doesn't invent a model card)
// rather than blocking or delaying the chat.

import { textOf, lastUserMessage } from "./conversation.js";

const HUB_API = "https://huggingface.co/api";
const HUB_WEB = "https://huggingface.co";
const TIMEOUT_MS = 8000;
const MAX_REPOS = 5; // repo ids looked up per message
const MAX_TAGS = 8;

export function hfAvailable(env) {
  return !!env.HUGGINGFACE_API_TOKEN;
}

// ---- target extraction (pure — exported for unit tests) --------------------

// Hugging Face URL host + optional type segment → capture owner + optional
// name. Spaces are intentionally NOT matched (this enriches models/datasets).
const HF_URL_RE =
  /(?:huggingface\.co|hf\.co)\/(datasets\/|models\/|spaces\/)?([\w.-]+)(?:\/([\w.-]+))?/gi;
// A bare "owner/name" repo token, not inside a URL/path (the lookbehind/ahead
// reject a surrounding path separator so a URL's tail isn't re-matched).
const REPO_RE = /(?<![\w./@])([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?![\w./])/g;

// Reserved first path segments on huggingface.co that are pages, not repos.
const RESERVED_OWNERS = new Set([
  "docs", "blog", "pricing", "join", "login", "logout", "settings", "organizations",
  "api", "spaces", "chat", "learn", "tasks", "terms", "privacy", "notifications",
  "new", "search", "changelog", "posts", "enterprise", "models", "datasets",
]);

// Common "x/y" bigrams that are English/units/tech, not repo ids.
const SLASH_STOPLIST = new Set([
  "and/or", "either/or", "he/she", "she/he", "s/he", "him/her", "his/her", "her/his",
  "yes/no", "no/yes", "on/off", "off/on", "true/false", "false/true",
  "input/output", "output/input", "read/write", "write/read", "pass/fail",
  "client/server", "server/client", "http/https", "https/http", "tcp/ip", "ip/tcp",
  "w/o", "n/a", "a/b", "b/a", "i/o", "o/i", "km/h", "mi/h", "24/7", "do/while",
  "if/else", "get/set", "buy/sell", "win/loss", "pros/cons", "cost/benefit",
]);

// Strong Hugging Face cue: the message clearly means the Hub, so accept any
// owner/name token. Weak cue: locational to ML but common, so require the
// token to look repo-ish (a digit/hyphen/underscore or an uppercase letter).
const STRONG_HF_CUE = /\bhugging\s*face\b|\bhuggingface\b|\bhf\b|hf\.co/i;
const WEAK_HF_CUE =
  /\b(?:models?|datasets?|checkpoints?|pre-?trained|fine-?tuned?|weights|embeddings?|tokenizers?|transformers?)\b/i;

function isRepoish(id) {
  return /[-_0-9]/.test(id) || /[A-Z]/.test(id);
}

// A versioned-looking id (a hyphen AND a digit, e.g. "…/Llama-3.1-8B-Instruct",
// "…/gemma-2-9b") is unmistakably a repo, not an English/units "x/y" bigram —
// so it fires even with no "hugging face"/"model" cue word in the message.
function stronglyRepoish(id) {
  return /-/.test(id) && /\d/.test(id);
}

// Extracts Hugging Face repo ids from free text. Returns a deduped, capped
// array of { id, kind } where kind is "model" | "dataset" | "unknown"
// ("unknown" = a bare owner/name whose type the lookup resolves by trying
// models then datasets). URLs give a definite kind; bare tokens need an HF/ML
// cue (see above) to fire at all.
export function extractHfRepos(text) {
  const raw = typeof text === "string" ? text : "";
  const out = [];
  const seen = new Set();
  const add = (id, kind) => {
    const key = id.toLowerCase();
    if (!id || seen.has(key) || out.length >= MAX_REPOS) return;
    seen.add(key);
    out.push({ id, kind });
  };

  // 1) Explicit Hub URLs — unambiguous, any kind, no cue required.
  for (const m of raw.matchAll(HF_URL_RE)) {
    const seg = (m[1] || "").toLowerCase();
    if (seg === "spaces/") continue;
    const owner = m[2];
    const name = m[3];
    // A reserved first segment (docs/, blog/, spaces/, …) is a Hub page path,
    // never a repo — regardless of whether a sub-path follows.
    if (RESERVED_OWNERS.has(owner.toLowerCase())) continue;
    const id = name ? `${owner}/${name}` : owner;
    add(id, seg === "datasets/" ? "dataset" : "model");
  }

  // 2) Bare owner/name tokens. Scanned over a URL-stripped copy so a URL's
  // owner/name tail isn't re-matched as a bare token (which would mis-slice
  // "meta-llama/Llama-3-8B" into "llama/…"). A token fires when: a STRONG HF
  // cue is present (any token), a WEAK ML cue is present (repo-ish token), or
  // the token is versioned-looking on its own (no cue needed).
  const strong = STRONG_HF_CUE.test(raw);
  const weak = WEAK_HF_CUE.test(raw);
  const deUrled = raw.replace(/https?:\/\/\S+/gi, " ").replace(/\b(?:huggingface\.co|hf\.co)\/\S+/gi, " ");
  for (const m of deUrled.matchAll(REPO_RE)) {
    const id = `${m[1]}/${m[2]}`;
    if (SLASH_STOPLIST.has(id.toLowerCase())) continue;
    if (RESERVED_OWNERS.has(m[1].toLowerCase())) continue;
    const accept = strong || stronglyRepoish(id) || (weak && isRepoish(id));
    if (!accept) continue;
    add(id, "unknown");
  }
  return out;
}

// True when the message names anything the Hub enrichment could resolve — the
// pipeline's no-network gate.
export function messageNamesHfRepo(text) {
  return extractHfRepos(text).length > 0;
}

// ---- Hub REST calls --------------------------------------------------------

async function hubGet(env, log, path) {
  const headers = { Accept: "application/json" };
  if (env.HUGGINGFACE_API_TOKEN) headers.Authorization = `Bearer ${env.HUGGINGFACE_API_TOKEN}`;
  const resp = await fetch(`${HUB_API}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    // 404 = repo simply isn't on the Hub (the common "no data" case); 401/403 =
    // gated/private without access; anything else is a real error worth a warn.
    log[resp.status === 404 ? "info" : "warn"]("hf.error", { path, status: resp.status });
    return null;
  }
  return resp.json().catch(() => null);
}

function formatParams(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B params`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M params`;
  return `${n} params`;
}

function licenseOf(data) {
  const fromCard = data?.cardData?.license;
  if (typeof fromCard === "string" && fromCard) return fromCard;
  const tag = (Array.isArray(data?.tags) ? data.tags : []).find((t) => typeof t === "string" && t.startsWith("license:"));
  return tag ? tag.slice("license:".length) : "";
}

// Tags minus the noisy machine ones (license:, arxiv:, region:, dataset:, and
// the raw format tags) — keeps the human-meaningful topic/task/language tags.
function cleanTags(data) {
  const skip = /^(?:license:|arxiv:|region:|dataset:|base_model:|doi:)/i;
  const noise = new Set(["safetensors", "pytorch", "tensorboard", "gguf", "onnx", "transformers", "diffusers"]);
  return (Array.isArray(data?.tags) ? data.tags : [])
    .filter((t) => typeof t === "string" && !skip.test(t) && !noise.has(t))
    .slice(0, MAX_TAGS);
}

function summarize(data, kind) {
  const id = typeof data?.id === "string" ? data.id : "";
  const url = kind === "dataset" ? `${HUB_WEB}/datasets/${id}` : `${HUB_WEB}/${id}`;
  const gated = data?.gated && data.gated !== false ? String(data.gated) : "";
  return {
    id,
    kind,
    author: typeof data?.author === "string" ? data.author : "",
    task: kind === "model" && typeof data?.pipeline_tag === "string" ? data.pipeline_tag : "",
    library: typeof data?.library_name === "string" ? data.library_name : "",
    license: licenseOf(data),
    downloads: Number.isFinite(data?.downloads) ? data.downloads : null,
    likes: Number.isFinite(data?.likes) ? data.likes : null,
    params: kind === "model" ? formatParams(data?.safetensors?.total) : "",
    tags: cleanTags(data),
    gated,
    lastModified: typeof data?.lastModified === "string" ? data.lastModified.slice(0, 10) : "",
    url,
  };
}

// Resolves one repo id. A "model"/"dataset" hint goes straight to that
// endpoint; an "unknown" (bare owner/name) tries models, then datasets.
export async function lookupRepo(env, log, { id, kind }) {
  const tryModel = async () => {
    const d = await hubGet(env, log, `/models/${id}`);
    return d ? summarize(d, "model") : null;
  };
  const tryDataset = async () => {
    const d = await hubGet(env, log, `/datasets/${id}`);
    return d ? summarize(d, "dataset") : null;
  };
  if (kind === "model") return tryModel();
  if (kind === "dataset") return tryDataset();
  return (await tryModel()) || (await tryDataset());
}

// ---- rendering -------------------------------------------------------------

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function renderRepo(r) {
  const head = `${r.kind === "dataset" ? "Dataset" : "Model"} ${r.id} (${r.url}):`;
  const lines = [head];
  const facts = [];
  if (r.task) facts.push(`Task: ${r.task}`);
  if (r.library) facts.push(`Library: ${r.library}`);
  if (r.params) facts.push(r.params);
  if (r.license) facts.push(`License: ${r.license}`);
  if (facts.length) lines.push(`  ${facts.join(" · ")}`);
  const pop = [];
  if (r.downloads != null) pop.push(`${fmtNum(r.downloads)} downloads/mo`);
  if (r.likes != null) pop.push(`${fmtNum(r.likes)} likes`);
  if (r.gated) pop.push(`gated (${r.gated})`);
  if (pop.length) lines.push(`  ${pop.join(" · ")}`);
  if (r.tags.length) lines.push(`  Tags: ${r.tags.join(", ")}`);
  if (r.lastModified) lines.push(`  Last updated: ${r.lastModified}`);
  return lines.join("\n");
}

function detailLine(r) {
  const bits = [r.kind];
  if (r.task) bits.push(r.task);
  if (r.params) bits.push(r.params);
  if (r.downloads != null) bits.push(`${fmtNum(r.downloads)} dl`);
  return `${r.id} — ${bits.join(", ")}`;
}

// ---- orchestration ---------------------------------------------------------

// Runs the whole Hub lookup for one message's repo ids. Returns null when
// there's nothing to do, otherwise { block, details, count, durationMs }.
export async function runHuggingFaceLookup(env, log, conversation) {
  const startedAt = Date.now();
  if (!hfAvailable(env)) return null;
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const repos = extractHfRepos(lastUser);
  if (!repos.length) return null;

  const results = await Promise.all(repos.map((r) => lookupRepo(env, log, r)));
  const found = results.filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log.info("hf.lookup", { duration_ms: durationMs, targets: repos.length, found: found.length });

  const foundIds = new Set(found.map((r) => r.id.toLowerCase()));
  const notFound = repos.filter((r) => !foundIds.has(r.id.toLowerCase())).map((r) => r.id);

  if (!found.length) {
    const block =
      "\n\n--- Hugging Face Hub ---\n" +
      `No Hugging Face Hub record was found for: ${notFound.join(", ")}. ` +
      "These are not public models/datasets on the Hub (or are gated and not accessible).\n" +
      "--- End of Hugging Face Hub ---";
    return { block, details: notFound.map((id) => `${id} — not on the Hub`), count: 0, durationMs };
  }

  let body = found.map(renderRepo).join("\n\n");
  if (notFound.length) body += `\n\nNo Hub record for: ${notFound.join(", ")}.`;
  const block =
    "\n\n--- Hugging Face Hub (live model/dataset metadata from huggingface.co) ---\n" +
    body +
    "\n--- End of Hugging Face Hub ---";

  return {
    block,
    details: found.map(detailLine).concat(notFound.map((id) => `${id} — not on the Hub`)),
    count: found.length,
    durationMs,
  };
}

// @ts-check
// OUTROSPECTION — the pure core.
//
// Introspection points the site at ITSELF: the deployed source, answered from
// a committed snapshot. Outrospection is the mirror image, and the name is
// borrowed on purpose (Roman Krznaric): you learn what you are by looking
// OUTWARD — at other people's work, other architectures, other answers to the
// problem you are stuck inside. The stuck-ness is the point. A project that
// only ever reads its own source re-derives its own assumptions forever; the
// cure is not more self-analysis, it is a window.
//
// So this is the window: a running, tabloid-flavoured feed of everything
// happening OUTSIDE this repo that bears on what it is trying to be. Not
// general tech news — news filtered through seven LENSES that each answer a
// standing strategic question this project actually has:
//
//   one-dependency   is there a library significant enough to become our ONE
//                    big dependency? (invariant 5 says no dependencies; the
//                    honest version of that rule is "none yet")
//   browser-models   what can run in the browser now? (Se/cure's whole thesis
//                    is capability without a server; the Bonsai phone-inference
//                    work is the standing example of it not working yet)
//   edge-rag         retrieval that runs at the edge or in the tab
//   llm-architecture how people are structuring LLM applications
//   privacy-llm      provable privacy for LLM apps — the project's mission
//   agent-standards  agent/tool interchange standards (MCP and successors)
//   deep-research    other deep-research systems: the direct comparison set
//
// Each lens carries its own Exa queries, so "refresh" is a deterministic fan
// of searches, not a model deciding what to look for. Nothing here calls a
// model at all — the feed is search results, ranked and deduped, with the
// DELTA against what we already had marked as fresh. That is the whole
// mechanism: search, diff, highlight.
//
// Pure and dependency-free like bash-core.js / space-core.js / introspect-core.js:
// the browser imports it directly (the view), the Worker imports it through the
// façade src/outrospect.js, and scripts/outrospect-scan.mjs imports it in Node.
// One implementation, three faces — they can never disagree about what a lens
// is or which items are new.

// ---------------------------------------------------------------------------
// Caps. A feed item is a headline and a teaser, never a document.
// ---------------------------------------------------------------------------

export const OUTROSPECT_CAPS = {
  title: 300,
  url: 1000,
  teaser: 600,
  source: 120,
  items: 400, // per stream, merged
  known: 600, // client-supplied "I already have these" keys per refresh
  queriesPerRefresh: 3,
};

/** How long a newly first-seen item keeps its "fresh" flash. */
export const FRESH_WINDOW_MS = 36 * 3600 * 1000;

// ---------------------------------------------------------------------------
// The lens registry
//
// One entry per standing strategic question. `queries` are literal Exa search
// strings — deterministic, reviewable, and diffable in git; a lens's results
// change because the WORLD changed, not because a prompt drifted.
//
// `terms` / `termsSv` back lensMatch() below: the deterministic router that
// files a free-text note (a search in the view, a strategic idea posted from
// it) under a lens. Invariant 6 — every routing gate takes Swedish forms with
// the same breadth as English, definite forms and compounds included.
// ---------------------------------------------------------------------------

/**
 * One outward-looking lens.
 * @typedef {object} Lens
 * @property {string} id
 * @property {string} title EN display title
 * @property {string} titleSv SV display title
 * @property {string} question the standing strategic question it answers
 * @property {string} questionSv
 * @property {string[]} queries literal search strings (Exa)
 * @property {string[]} terms EN routing terms
 * @property {string[]} termsSv SV routing terms
 */

/** @type {Lens[]} */
export const OUTROSPECT_LENSES = [
  {
    id: "one-dependency",
    title: "The one big dependency",
    titleSv: "Det enda stora beroendet",
    question:
      "Is there a library significant enough that it would be worth breaking the zero-dependency rule for — and what would we build on top of it?",
    questionSv:
      "Finns det ett bibliotek som är betydelsefullt nog att bryta noll-beroende-regeln för — och vad skulle vi bygga ovanpå det?",
    queries: [
      "new JavaScript library dependency-free browser LLM applications",
      "single-dependency architecture library release 2026",
      "zero build step ESM library for AI applications",
    ],
    terms: ["dependency", "dependencies", "library", "libraries", "package", "npm", "vendored", "runtime dep"],
    termsSv: [
      "beroende",
      "beroendet",
      "beroenden",
      "beroendena",
      "bibliotek",
      "biblioteket",
      "biblioteken",
      "paket",
      "paketet",
      "paketen",
    ],
  },
  {
    id: "browser-models",
    title: "Models that run in the browser",
    titleSv: "Modeller som kör i webbläsaren",
    question:
      "Which models can actually run on the user's own device now? Se/cure's thesis needs them; the Bonsai phone-inference work is the standing example of the gap.",
    questionSv:
      "Vilka modeller kan faktiskt köra på användarens egen enhet nu? Se/cure:s tes kräver dem; Bonsai-arbetet med telefoninferens är det stående exemplet på glappet.",
    queries: [
      "WebGPU in-browser LLM inference new model release",
      "small language model on-device phone inference benchmark 2026",
      "Bonsai model browser inference wasm",
    ],
    terms: ["browser model", "on-device", "webgpu", "wasm", "bonsai", "local model", "phone inference", "quantized"],
    termsSv: [
      "webbläsarmodell",
      "webbläsarmodeller",
      "lokal modell",
      "lokala modeller",
      "modellen lokalt",
      "på enheten",
      "enhetsnära",
      "telefoninferens",
      "kvantiserad",
      "kvantiserade",
    ],
  },
  {
    id: "edge-rag",
    title: "RAG at the edge",
    titleSv: "RAG i kanten",
    question: "What new retrieval tricks work without a vector database in someone else's cloud?",
    questionSv: "Vilka nya retrieval-knep fungerar utan en vektordatabas i någon annans moln?",
    queries: [
      "client-side RAG browser vector search new technique",
      "edge retrieval augmented generation Cloudflare Workers pattern",
      "embedding index in browser IndexedDB retrieval 2026",
    ],
    terms: ["rag", "retrieval", "embedding", "embeddings", "vector search", "vector database", "reranking", "chunking"],
    termsSv: [
      "retrieval",
      "återvinning",
      "inbäddning",
      "inbäddningar",
      "vektorsökning",
      "vektordatabas",
      "vektordatabasen",
      "omrankning",
      "chunkning",
      "kunskapsbas",
      "kunskapsbasen",
    ],
  },
  {
    id: "llm-architecture",
    title: "Architecture for LLM applications",
    titleSv: "Arkitektur för LLM-applikationer",
    question: "How are other people structuring LLM applications — and does any of it beat a deterministic pipeline?",
    questionSv:
      "Hur strukturerar andra sina LLM-applikationer — och slår något av det en deterministisk pipeline?",
    queries: [
      "LLM application architecture pattern orchestration without function calling",
      "agent architecture deterministic pipeline versus tool calling",
      "new LLM app framework architecture post-mortem 2026",
    ],
    terms: ["architecture", "pipeline", "orchestration", "agent loop", "function calling", "tool use", "pattern"],
    termsSv: [
      "arkitektur",
      "arkitekturen",
      "arkitekturer",
      "pipeline",
      "pipelinen",
      "orkestrering",
      "orkestreringen",
      "agentloop",
      "verktygsanrop",
      "mönster",
      "mönstret",
    ],
  },
  {
    id: "privacy-llm",
    title: "Provable privacy for LLM apps",
    titleSv: "Bevisbar integritet i LLM-appar",
    question: "Who else is trying to make privacy a structural property rather than a policy line?",
    questionSv: "Vem mer försöker göra integritet till en strukturell egenskap i stället för en policyrad?",
    queries: [
      "client-side AI privacy architecture server sees no data",
      "confidential inference end-to-end encrypted LLM application",
      "local-first AI assistant privacy verifiable 2026",
    ],
    terms: ["privacy", "private", "encryption", "encrypted", "confidential", "local-first", "zero-knowledge", "e2ee"],
    termsSv: [
      "integritet",
      "integriteten",
      "privat",
      "privata",
      "kryptering",
      "krypteringen",
      "krypterad",
      "krypterade",
      "konfidentiell",
      "lokalt först",
      "nollkunskap",
      "sekretess",
      "sekretessen",
    ],
  },
  {
    id: "agent-standards",
    title: "Agent and tool interchange standards",
    titleSv: "Standarder för agent- och verktygsutbyte",
    question: "Which interchange standards are becoming real — and do ours (DRSW/1, DRPL/1) still make sense next to them?",
    questionSv:
      "Vilka utbytesstandarder blir verkliga — och håller våra (DRSW/1, DRPL/1) fortfarande måttet bredvid dem?",
    queries: [
      "Model Context Protocol MCP specification update new capability",
      "agent interoperability standard open specification 2026",
      "portable agent definition format specification",
    ],
    terms: ["mcp", "standard", "standards", "protocol", "specification", "interoperability", "interchange", "schema"],
    termsSv: [
      "standard",
      "standarden",
      "standarder",
      "standarderna",
      "protokoll",
      "protokollet",
      "specifikation",
      "specifikationen",
      "interoperabilitet",
      "utbytesformat",
      "gränssnitt",
    ],
  },
  {
    id: "deep-research",
    title: "Other deep-research systems",
    titleSv: "Andra deep research-system",
    question: "What are the other deep-research assistants doing that we are not?",
    questionSv: "Vad gör de andra deep research-assistenterna som vi inte gör?",
    queries: [
      "deep research agent system release comparison",
      "multi-step research assistant evaluation benchmark 2026",
      "autonomous web research agent citations quality",
    ],
    terms: ["deep research", "research agent", "research assistant", "citations", "synthesis", "search agent"],
    termsSv: [
      "djupforskning",
      "djupresearch",
      "forskningsagent",
      "forskningsassistent",
      "researchassistent",
      "källhänvisningar",
      "källor",
      "syntes",
      "syntesen",
      "sökagent",
    ],
  },
];

/** Every lens id, registry order. */
export const LENS_IDS = OUTROSPECT_LENSES.map((l) => l.id);

/**
 * One lens by id.
 * @param {unknown} id
 * @returns {Lens | null}
 */
export function lensById(id) {
  return OUTROSPECT_LENSES.find((l) => l.id === id) || null;
}

/**
 * Clamp any value to a known lens id.
 * @param {unknown} id
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeLens(id, fallback = LENS_IDS[0]) {
  return LENS_IDS.includes(/** @type {string} */ (id)) ? /** @type {string} */ (id) : fallback;
}

// The routing gate. Deterministic, no model call — the same posture as
// quizIntent / feedbackIntent / spaceIntent. Word-boundary matching so
// "library" doesn't fire on "libraries of congress" style noise while the
// Swedish compounds ("vektordatabasen", "beroendena") still hit, because they
// are listed as their own definite forms rather than stemmed.
/**
 * @param {string} term
 * @returns {RegExp}
 */
function termRe(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b is ASCII-only in JS, so a Swedish term ending in å/ä/ö gets an explicit
  // "not a word char and not a Swedish letter" tail instead.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

/**
 * File free text under a lens — which standing question does this note belong
 * to? Scores every lens by how many of its EN **and** SV terms appear (both
 * languages count equally, invariant 6); the best score wins, registry order
 * breaks ties, and no match at all returns null rather than guessing.
 * @param {unknown} text
 * @returns {string | null} the lens id, or null when nothing matched
 */
export function lensMatch(text) {
  const t = typeof text === "string" ? text : "";
  if (!t.trim()) return null;
  let best = null;
  let bestScore = 0;
  for (const lens of OUTROSPECT_LENSES) {
    let score = 0;
    for (const term of [...lens.terms, ...lens.termsSv]) {
      if (termRe(term).test(t)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = lens.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Feed items
// ---------------------------------------------------------------------------

/**
 * One item in the outward feed.
 * @typedef {object} FeedItem
 * @property {string} key stable identity (the normalized URL)
 * @property {string} lens which lens surfaced it
 * @property {string} title headline
 * @property {string} url
 * @property {string} teaser one-paragraph pull quote / highlight
 * @property {string} source display host ("simonwillison.net")
 * @property {number} first_seen ms epoch — when this feed first saw it
 * @property {string} [query] the search string that surfaced it
 * @property {boolean} [fresh] set by mergeFeed: first seen inside FRESH_WINDOW_MS
 */

/** @param {unknown} v @param {number} max @returns {string} */
function clamp(v, max) {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Stable identity for an item: the URL with the noise stripped, so the same
 * article found by two lenses (or two weeks apart, once with a tracking
 * parameter) is ONE item and never re-flashes as new.
 * @param {unknown} url
 * @returns {string} the normalized URL, or "" when unusable
 */
export function normalizeItemUrl(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.protocol = "https:";
  u.hostname = u.hostname.replace(/^www\./i, "").toLowerCase();
  u.hash = "";
  for (const p of [...u.searchParams.keys()]) {
    if (/^(?:utm_|ref$|ref_|source$|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(p)) u.searchParams.delete(p);
  }
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : "";
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return clamp(s, OUTROSPECT_CAPS.url);
}

/**
 * Display host for an item ("simonwillison.net").
 * @param {unknown} url
 * @returns {string}
 */
export function itemSource(url) {
  try {
    return clamp(new URL(String(url)).hostname.replace(/^www\./i, ""), OUTROSPECT_CAPS.source);
  } catch {
    return "";
  }
}

/**
 * Validate + normalize one raw item (from a search result, a stored row, or
 * the committed artifact). Anything without a usable URL and a title is
 * rejected — a headline-less item has nothing to show in a feed.
 * @param {unknown} raw
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, value: FeedItem } | { ok: false, error: string }}
 */
export function validateFeedItem(raw, { now = Date.now() } = {}) {
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
  if (!o) return { ok: false, error: "Item must be an object." };
  const key = normalizeItemUrl(o.url ?? o.key);
  if (!key) return { ok: false, error: "Item needs an http(s) url." };
  const title = clamp(o.title, OUTROSPECT_CAPS.title);
  if (!title) return { ok: false, error: "Item needs a title." };
  const firstSeen = Number(o.first_seen);
  return {
    ok: true,
    value: {
      key,
      lens: normalizeLens(o.lens),
      title,
      url: key,
      teaser: clamp(o.teaser, OUTROSPECT_CAPS.teaser),
      source: clamp(o.source, OUTROSPECT_CAPS.source) || itemSource(key),
      first_seen: Number.isFinite(firstSeen) && firstSeen > 0 ? firstSeen : now,
      query: clamp(o.query, OUTROSPECT_CAPS.title) || undefined,
    },
  };
}

/**
 * Turn one search result (the {title, url, highlights} shape both src/exa.js
 * and the scan script produce) into a feed item.
 * @param {string} lens
 * @param {{ title?: string, url?: string, highlights?: string[], text?: string }} result
 * @param {{ now?: number, query?: string }} [opts]
 * @returns {FeedItem | null}
 */
export function feedItemFromSearch(lens, result, { now = Date.now(), query = "" } = {}) {
  const highlights = Array.isArray(result?.highlights) ? result.highlights : [];
  const teaser = highlights.filter((h) => typeof h === "string").join(" … ") || String(result?.text || "");
  const v = validateFeedItem(
    { lens, title: result?.title, url: result?.url, teaser, first_seen: now, query },
    { now },
  );
  return v.ok ? v.value : null;
}

// ---------------------------------------------------------------------------
// The delta — the whole point of a scan
// ---------------------------------------------------------------------------

/**
 * The items in `incoming` we have never seen. `known` may be keys, urls, or
 * whole items — anything with a URL in it — so a caller can pass its stored
 * rows straight in without mapping first.
 * @param {Iterable<unknown>} known
 * @param {unknown[]} incoming
 * @returns {FeedItem[]} the genuinely new items, input order, deduped
 */
export function deltaItems(known, incoming) {
  const seen = new Set();
  for (const k of known || []) {
    const key = normalizeItemUrl(typeof k === "string" ? k : /** @type {any} */ (k)?.url ?? /** @type {any} */ (k)?.key);
    if (key) seen.add(key);
  }
  /** @type {FeedItem[]} */
  const out = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const v = validateFeedItem(raw);
    if (!v.ok || seen.has(v.value.key)) continue;
    seen.add(v.value.key);
    out.push(v.value);
  }
  return out;
}

/**
 * Merge any number of item streams (the committed artifact, the live D1 rows,
 * whatever a refresh just returned) into ONE feed: deduped by key keeping the
 * EARLIEST first_seen (so an item re-found next week keeps its original date
 * and does not flash as new again), newest first, capped, and each item
 * flagged `fresh` when it was first seen inside the window.
 * @param {unknown[][]} streams
 * @param {{ now?: number, freshWindowMs?: number, lens?: string | null, limit?: number }} [opts]
 * @returns {FeedItem[]}
 */
export function mergeFeed(streams, { now = Date.now(), freshWindowMs = FRESH_WINDOW_MS, lens = null, limit = OUTROSPECT_CAPS.items } = {}) {
  /** @type {Map<string, FeedItem>} */
  const byKey = new Map();
  for (const stream of Array.isArray(streams) ? streams : []) {
    for (const raw of Array.isArray(stream) ? stream : []) {
      const v = validateFeedItem(raw, { now });
      if (!v.ok) continue;
      const item = v.value;
      const prev = byKey.get(item.key);
      if (!prev) {
        byKey.set(item.key, item);
        continue;
      }
      // Keep the richer record but never let a later sighting reset the date.
      byKey.set(item.key, {
        ...prev,
        ...item,
        first_seen: Math.min(prev.first_seen, item.first_seen),
        teaser: prev.teaser.length >= item.teaser.length ? prev.teaser : item.teaser,
      });
    }
  }
  let items = [...byKey.values()];
  if (lens) items = items.filter((i) => i.lens === lens);
  items.sort((a, b) => b.first_seen - a.first_seen || a.title.localeCompare(b.title));
  return items.slice(0, Math.max(0, limit)).map((i) => ({ ...i, fresh: now - i.first_seen <= freshWindowMs }));
}

/**
 * Per-lens counts for the feed's header strip.
 * @param {FeedItem[]} items
 * @returns {Record<string, { total: number, fresh: number }>}
 */
export function lensTally(items) {
  /** @type {Record<string, { total: number, fresh: number }>} */
  const tally = {};
  for (const id of LENS_IDS) tally[id] = { total: 0, fresh: 0 };
  for (const i of Array.isArray(items) ? items : []) {
    const t = tally[i?.lens];
    if (!t) continue;
    t.total++;
    if (i.fresh) t.fresh++;
  }
  return tally;
}

/**
 * The queries a refresh should run for a lens — capped, so one visit never
 * fans out the whole registry at a search provider's expense. `offset` walks
 * the list across successive refreshes so every query gets its turn.
 * @param {string} lensId
 * @param {{ max?: number, offset?: number }} [opts]
 * @returns {string[]}
 */
export function refreshQueries(lensId, { max = OUTROSPECT_CAPS.queriesPerRefresh, offset = 0 } = {}) {
  const lens = lensById(normalizeLens(lensId));
  if (!lens) return [];
  const n = Math.min(Math.max(0, max), lens.queries.length);
  const start = ((offset % lens.queries.length) + lens.queries.length) % lens.queries.length;
  return Array.from({ length: n }, (_, i) => lens.queries[(start + i) % lens.queries.length]);
}

/**
 * The lens most in need of a refresh: the one whose newest item is oldest
 * (a lens with nothing at all is the stalest of all). This is what a visit
 * refreshes on the user's behalf — the feed heals its own thin spots instead
 * of re-searching whatever is already busiest.
 * @param {FeedItem[]} items
 * @param {{ skip?: string[] }} [opts] lenses on cooldown
 * @returns {string} a lens id (always — falls back to the first lens)
 */
export function stalestLens(items, { skip = [] } = {}) {
  /** @type {Record<string, number>} */
  const newest = {};
  for (const id of LENS_IDS) newest[id] = 0;
  for (const i of Array.isArray(items) ? items : []) {
    if (i && newest[i.lens] !== undefined && i.first_seen > newest[i.lens]) newest[i.lens] = i.first_seen;
  }
  const eligible = LENS_IDS.filter((id) => !skip.includes(id));
  const pool = eligible.length ? eligible : LENS_IDS;
  return pool.reduce((best, id) => (newest[id] < newest[best] ? id : best), pool[0]);
}

// ---------------------------------------------------------------------------
// Rendering (text) — the loop-consumable view, shared by ?format=text and the
// scan script's console output so the operator reads the same thing either way.
// ---------------------------------------------------------------------------

/**
 * @param {FeedItem[]} items
 * @param {{ title?: string, now?: number }} [opts]
 * @returns {string}
 */
export function formatFeedText(items, { title = "OUTROSPECTION FEED (newest first)", now = Date.now() } = {}) {
  const list = Array.isArray(items) ? items : [];
  const tally = lensTally(list);
  const lines = [title, ""];
  for (const lens of OUTROSPECT_LENSES) {
    const t = tally[lens.id];
    lines.push(`${lens.id.padEnd(18)} ${String(t.total).padStart(3)} items${t.fresh ? `  (${t.fresh} new)` : ""}`);
  }
  lines.push("");
  for (const i of list) {
    const when = new Date(i.first_seen).toISOString().slice(0, 10);
    lines.push(`${i.fresh ? "NEW " : "    "}${when} [${i.lens}] ${i.title}`);
    lines.push(`        ${i.url}`);
    if (i.teaser) lines.push(`        ${i.teaser.slice(0, 240)}`);
  }
  if (!list.length) lines.push("(no items yet — run scripts/outrospect-scan.mjs or refresh from the view)");
  lines.push("", `generated ${new Date(now).toISOString()}`);
  return lines.join("\n") + "\n";
}

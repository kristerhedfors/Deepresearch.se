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
// A headline is not enough to QUOTE an article, so the second half of this
// module (see "QUOTATION" below) owns the other side of the same coin: how a
// stored article body is cut into passages and which of them answer a given
// question. Still no model, still no dependency — a scored lexical scan.
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

// ---------------------------------------------------------------------------
// OUTROSPECTION MODE — answering a question from the outward feed
//
// The fifth chat mode (owner directive, 2026-07-25) is this feed turned into
// an answering surface, and it is introspection's mirror in mechanism as well
// as in name. Introspection retrieves from a committed snapshot of our OWN
// source and answers from that; outrospection retrieves from the feed of what
// everyone ELSE shipped and answers from that. Same shape — deterministic
// retrieval, one context block, one streamed answer — pointed outward.
//
// No model picks what to retrieve: `lensMatch` is the same deterministic
// EN+SV gate the strategy lane uses, so a question routes to a standing lens
// by its own words or to nothing at all. That keeps invariant 1 intact (no
// function calling anywhere in the path) and keeps the mode honest — it can
// only answer with articles the feed actually holds.
// ---------------------------------------------------------------------------

/** Caps for the answer context block — a block of headlines, never documents. */
export const OUTROSPECT_BLOCK_CAPS = { items: 24, teaser: 320, chars: 12000 };

// ---------------------------------------------------------------------------
// QUOTATION — the indexed article text, and how a passage gets chosen
//
// A feed item is a headline and a teaser. That is enough to LIST what other
// people shipped and nowhere near enough to QUOTE it, which is what the owner
// asked for (feedback #28, 2026-07-26): "web fetch those and RAG index … to
// allow search and quotations plus links to the source". So the server stores
// the article text (src/outrospect.js `indexFeedTexts`, D1 `outrospect_texts`)
// and this half decides which PASSAGES of it a given question should see.
//
// The selection is deliberately lexical, pure and dependency-free:
//
//   * NO MODEL CHOOSES (invariant 1). The retrieval is a scored scan, exactly
//     as `lensMatch` is a scored scan — nothing between the question and the
//     answer decides anything by calling out.
//   * NO EMBEDDINGS in this path (invariant 5, and the refresh runs inside
//     someone's page load). A vector index over the same rows is a fine LATER
//     addition — `outrospect_texts` is the seam a parallel arXiv-indexing
//     branch can write into unchanged — but it must not become a dependency of
//     answering.
//   * NOTHING LEAVES (invariant 4). The question is matched against text that
//     is ALREADY stored; no part of what the reader typed is sent anywhere to
//     do it.
//   * NEVER FABRICATE. A quote is a verbatim slice of a stored document that
//     carries its own URL, or there is no quote. `selectQuotes` returning []
//     is a valid, honest outcome and the prompt says so.
// ---------------------------------------------------------------------------

/** Caps for the quotation half. A block of passages, never whole articles. */
export const OUTROSPECT_QUOTE_CAPS = {
  quotes: 6, // passages in one answer's context
  perSource: 2, // …and at most this many from any one article
  passage: 420, // chars per quoted passage
  minPassage: 90, // shorter fragments are navigation chrome, not prose
  passagesPerDoc: 80, // bounds the scan of one long document
  chars: 5200, // total chars the quote section may spend
  text: 6000, // max stored text per article (matches exa.js's /contents cap)
  terms: 24, // question terms scored against (the rest is noise)
};

// The words a question is NOT about. Both languages, because the scorer is a
// deterministic routing gate like every other one here (invariant 6) — an
// English-only stop list would let Swedish function words ("och", "vilken",
// "hur") dominate the score and pull the wrong passage. The parity test in
// public/js/outrospect-core.test.js fails if the Swedish set gets thinner.
export const QUOTE_STOPWORDS_EN = [
  "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those", "the",
  "of", "in", "on", "at", "to", "for", "from", "by", "with", "without", "about", "into", "over", "under",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "has", "have", "had",
  "how", "what", "which", "who", "whom", "why", "when", "where",
  "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "not", "no", "yes", "it", "its", "as", "so", "such", "there", "here",
  "we", "you", "they", "he", "she", "our", "your", "their", "them", "us", "my", "me",
  "any", "all", "some", "more", "most", "other", "also", "just", "very", "own", "out", "up",
];
export const QUOTE_STOPWORDS_SV = [
  "en", "ett", "och", "eller", "men", "om", "att", "som", "det", "den", "de", "dem", "denna", "detta", "dessa",
  "av", "i", "på", "till", "från", "för", "med", "utan", "in", "över", "under", "vid", "hos", "mot", "efter",
  "är", "var", "vara", "varit", "blir", "blev", "bli", "har", "hade", "haft", "göra", "gör", "gjorde",
  "hur", "vad", "vilken", "vilket", "vilka", "vem", "varför", "när", "vart", "vars",
  "kan", "kunde", "ska", "skall", "skulle", "kommer", "får", "fick", "måste", "bör",
  "inte", "icke", "ingen", "inget", "inga", "ja", "nej", "ju", "då", "än",
  "jag", "du", "vi", "ni", "han", "hon", "hen", "min", "mitt", "mina", "vår", "vårt", "våra", "deras", "sin", "sitt", "sina",
  "några", "någon", "något", "alla", "allt", "mer", "mest", "andra", "också", "bara", "ny", "nytt", "nya",
  "här", "där", "så", "sådan", "finns", "man", "eget", "egen", "ut", "upp",
];

/** Every stop word, both languages, one set. */
const QUOTE_STOPWORDS = new Set([...QUOTE_STOPWORDS_EN, ...QUOTE_STOPWORDS_SV]);

/**
 * The words of a question worth scoring a passage against: lowercased, stripped
 * of punctuation, stop words dropped in BOTH languages, deduped, capped. Two
 * letters is the floor rather than three, so "ai", "ml" and "e2e" survive.
 * @param {unknown} question
 * @param {{ max?: number }} [opts]
 * @returns {string[]}
 */
export function quoteTerms(question, { max = OUTROSPECT_QUOTE_CAPS.terms } = {}) {
  const t = typeof question === "string" ? question : "";
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const word of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || QUOTE_STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Cut one stored article into quotable passages: paragraphs first (the
 * author's own unit), then sentence-windowed where a paragraph runs past the
 * cap, then hard-sliced where a single "sentence" does. Whitespace is collapsed
 * so a quote pastes cleanly into an answer, but no word is ever altered — a
 * passage is a verbatim slice.
 * @param {unknown} text
 * @param {{ max?: number, min?: number, limit?: number }} [opts]
 * @returns {string[]}
 */
export function splitPassages(text, opts = {}) {
  const max = Math.max(80, opts.max ?? OUTROSPECT_QUOTE_CAPS.passage);
  const min = Math.max(0, opts.min ?? OUTROSPECT_QUOTE_CAPS.minPassage);
  const limit = Math.max(1, opts.limit ?? OUTROSPECT_QUOTE_CAPS.passagesPerDoc);
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return [];
  /** @type {string[]} */
  const chunks = [];
  /** @param {string} s */
  const add = (s) => {
    const v = s.trim();
    if (v) chunks.push(v.length > max ? v.slice(0, max) : v);
  };
  for (const para of raw.split(/\n\s*\n+/)) {
    const clean = para.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    if (clean.length <= max) {
      add(clean);
      continue;
    }
    // Sentence-ish windows. No lookbehind: a plain match keeps this readable
    // and portable across the three runtimes that import this module.
    const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean];
    let cur = "";
    for (const s of sentences) {
      const piece = s.trim();
      if (!piece) continue;
      if (piece.length > max) {
        if (cur) {
          add(cur);
          cur = "";
        }
        for (let i = 0; i < piece.length; i += max) add(piece.slice(i, i + max));
        continue;
      }
      if (!cur) cur = piece;
      else if (cur.length + 1 + piece.length <= max) cur += ` ${piece}`;
      else {
        add(cur);
        cur = piece;
      }
    }
    if (cur) add(cur);
    if (chunks.length >= limit) break;
  }
  const long = chunks.filter((c) => c.length >= min);
  // A page of nothing but short lines still deserves its best line rather than
  // silently contributing nothing.
  const kept = long.length ? long : chunks.slice().sort((a, b) => b.length - a.length).slice(0, 1);
  return kept.slice(0, limit);
}

/** @param {string} term @returns {RegExp} */
function quoteTermRe(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * How well one passage answers a question: how many DISTINCT question terms it
 * contains, plus a small, capped bonus for repeating them. Distinct coverage
 * dominates on purpose — a passage mentioning three of the question's ideas
 * once beats one that says the same word six times.
 * @param {unknown} passage
 * @param {string[]} terms
 * @returns {number} 0 when nothing matched (a valid, honest outcome)
 */
export function scorePassage(passage, terms) {
  const hay = typeof passage === "string" ? passage.toLowerCase() : "";
  const list = Array.isArray(terms) ? terms : [];
  if (!hay || !list.length) return 0;
  let distinct = 0;
  let extra = 0;
  for (const term of list) {
    const n = (hay.match(quoteTermRe(term)) || []).length;
    if (n) {
      distinct++;
      extra += n - 1;
    }
  }
  return distinct ? distinct + Math.min(extra, 4) * 0.25 : 0;
}

/**
 * One quotable passage, ready for the context block.
 * @typedef {object} Quote
 * @property {number} n 1-based number the answer cites it by
 * @property {string} url the source link the answer must carry
 * @property {string} title the article's headline
 * @property {string} source display host
 * @property {string} lens
 * @property {string} text the verbatim passage
 * @property {number} score
 */

/**
 * The passages of the stored articles that best answer this question. Pure,
 * deterministic and total: same question + same documents ⇒ same quotes, and
 * an empty result when nothing in the stored text is relevant (which the prompt
 * then reports honestly rather than papering over).
 *
 * `texts` is what src/outrospect.js's `loadTexts` returns — one entry per
 * INDEXED article: `{ url, title, source, lens, text }`. Documents arrive in
 * feed order (newest first) and that order breaks score ties, so the newest
 * relevant thing leads.
 * @param {unknown} question
 * @param {Array<{ url?: string, title?: string, source?: string, lens?: string, text?: string }>} texts
 * @param {{ quotes?: number, perSource?: number, passage?: number, chars?: number }} [opts]
 * @returns {Quote[]}
 */
export function selectQuotes(question, texts, opts = {}) {
  const docs = Array.isArray(texts) ? texts : [];
  const maxQuotes = Math.max(1, Math.min(24, opts.quotes ?? OUTROSPECT_QUOTE_CAPS.quotes));
  const perSource = Math.max(1, opts.perSource ?? OUTROSPECT_QUOTE_CAPS.perSource);
  const passageCap = Math.max(80, opts.passage ?? OUTROSPECT_QUOTE_CAPS.passage);
  const charCap = Math.max(200, opts.chars ?? OUTROSPECT_QUOTE_CAPS.chars);
  const terms = quoteTerms(question);

  /** @type {(Quote & { docIndex: number, index: number })[]} */
  const candidates = [];
  docs.forEach((doc, docIndex) => {
    const url = normalizeItemUrl(doc?.url);
    if (!url) return;
    const passages = splitPassages(doc?.text, { max: passageCap });
    if (!passages.length) return;
    const scored = passages.map((passage, index) => ({ passage, index, score: scorePassage(passage, terms) }));
    let picked = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, perSource);
    // A question made entirely of stop words ("what's new out there?") has
    // nothing to score with. Lead with each article's opening passage rather
    // than returning nothing — it is still real, attributable text.
    if (!picked.length && !terms.length) picked = [scored[0]];
    for (const s of picked) {
      candidates.push({
        n: 0,
        url,
        title: clamp(doc?.title, OUTROSPECT_CAPS.title) || url,
        source: clamp(doc?.source, OUTROSPECT_CAPS.source) || itemSource(url),
        lens: normalizeLens(doc?.lens),
        text: s.passage,
        score: s.score,
        docIndex,
        index: s.index,
      });
    }
  });

  candidates.sort((a, b) => b.score - a.score || a.docIndex - b.docIndex || a.index - b.index);
  /** @type {Quote[]} */
  const out = [];
  let used = 0;
  for (const c of candidates) {
    if (out.length >= maxQuotes) break;
    if (out.length && used + c.text.length > charCap) break;
    used += c.text.length;
    out.push({ n: out.length + 1, url: c.url, title: c.title, source: c.source, lens: c.lens, text: c.text, score: c.score });
  }
  return out;
}

/**
 * The quotable-passage section of the answer context. Every passage carries its
 * own URL on its own line, because the whole point is that the answer can put a
 * real link next to a real quote.
 * @param {Quote[]} quotes
 * @param {{ swedish?: boolean }} [opts]
 * @returns {string} "" when there is nothing to quote
 */
export function outrospectionQuoteBlock(quotes, { swedish = false } = {}) {
  const list = Array.isArray(quotes) ? quotes.filter((q) => q && q.text && q.url) : [];
  if (!list.length) return "";
  const head =
    swedish ?
      `CITERBARA STYCKEN — ordagrann text hämtad från artiklarna ovan (${list.length} st). Citera ENBART härifrån, och sätt källänken intill citatet:`
    : `QUOTABLE PASSAGES — verbatim text fetched from the articles above (${list.length}). Quote ONLY from here, and put the source link next to the quote:`;
  const rows = list.map(
    (q) =>
      `[Q${q.n}] "${q.text}"\n     — ${q.title}${q.source ? ` · ${q.source}` : ""}\n     url: ${q.url}`,
  );
  return `${head}\n\n${rows.join("\n\n")}`;
}

/**
 * The lens registry, rendered for the answer context. This is ALWAYS in the
 * block, including when the feed is empty — the empty-feed prompt instructs
 * the model to "name the lenses that exist", and before this existed there was
 * nothing in context to name them from. The model then half-remembered three
 * of the seven off the introspection source block and admitted it did not have
 * the rest ("plus fyra till — jag har inte den fullständiga listan", feedback
 * #25, 2026-07-26). A prompt may not order what the context cannot supply.
 * @param {boolean} [swedish]
 * @returns {string}
 */
export function outrospectionLensCatalog(swedish = false) {
  const head =
    swedish ?
      `DE SJU LINSERNA — outrospektionens stående frågor (${OUTROSPECT_LENSES.length} st):`
    : `THE LENSES — outrospection's standing questions (${OUTROSPECT_LENSES.length}):`;
  const rows = OUTROSPECT_LENSES.map(
    (l) => `- ${swedish ? l.titleSv : l.title} (${l.id}): ${swedish ? l.questionSv : l.question}`,
  );
  return `${head}\n${rows.join("\n")}`;
}

/**
 * Build the numbered context block an outrospection answer cites from. Items
 * arrive newest-first (mergeFeed's order) and are numbered in that order, so
 * "[1]" is always the most recent thing the feed knows.
 *
 * The lens catalog is always present; the ITEMS section appears only when the
 * feed has something. So an empty feed still yields a block — callers must
 * decide "grounded vs empty" from the item count, not from whether this
 * returned a string.
 *
 * `quotes` (from `selectQuotes` over the indexed article text) adds the third
 * section: verbatim passages, each with its own URL, so an answer can quote a
 * real sentence and link the page it came from (feedback #28). It is optional
 * everywhere — an un-indexed feed still produces headlines-only context.
 * @param {FeedItem[]} items
 * @param {{ limit?: number, teaser?: number, chars?: number, swedish?: boolean, quotes?: Quote[] }} [opts]
 * @returns {string} never "" — at minimum the lens catalog
 */
export function outrospectionBlock(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const catalog = outrospectionLensCatalog(!!opts.swedish);
  const quoteBlock = outrospectionQuoteBlock(opts.quotes || [], { swedish: !!opts.swedish });
  if (!list.length) return quoteBlock ? `${catalog}\n\n${quoteBlock}` : catalog;
  const limit = Math.max(1, Math.min(OUTROSPECT_BLOCK_CAPS.items, opts.limit ?? OUTROSPECT_BLOCK_CAPS.items));
  const teaserCap = Math.max(40, opts.teaser ?? OUTROSPECT_BLOCK_CAPS.teaser);
  const charCap = Math.max(500, opts.chars ?? OUTROSPECT_BLOCK_CAPS.chars);
  const lines = [];
  let used = 0;
  let n = 0;
  for (const i of list.slice(0, limit)) {
    const lens = lensById(i.lens);
    const when = Number.isFinite(i.first_seen) ? new Date(i.first_seen).toISOString().slice(0, 10) : "";
    const entry = [
      `[${n + 1}] ${i.title}`,
      `    source: ${i.source || itemSource(i.url)}${when ? ` · first seen ${when}` : ""}${i.fresh ? " · NEW" : ""}`,
      `    lens: ${lens ? lens.title : i.lens}`,
      `    url: ${i.url}`,
      i.teaser ? `    ${i.teaser.slice(0, teaserCap)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (used + entry.length > charCap) break;
    lines.push(entry);
    used += entry.length;
    n++;
  }
  if (!n) return quoteBlock ? `${catalog}\n\n${quoteBlock}` : catalog;
  return (
    `${catalog}\n\n` +
    `OUTWARD FEED — what other people shipped (${n} item${n === 1 ? "" : "s"}, newest first):\n\n${lines.join("\n\n")}` +
    (quoteBlock ? `\n\n${quoteBlock}` : "")
  );
}

/**
 * The outrospection answer prompt. Mirrors the introspection prompt's contract
 * — answer from the retrieved material, say so plainly when it does not cover
 * the question — but the material is other people's work, so the standing
 * instruction is comparative: what does this mean for THIS project.
 *
 * Swedish parity (invariant 6): the Swedish leg is a full instruction, not a
 * translated tail, exactly as the orchestrator plan prompt does it.
 *
 * `hasQuotes` switches the quotation rule between its two honest halves. With
 * indexed passages in context the model may quote — verbatim, from that
 * section only, link attached. Without them it may NOT: an unindexed feed is
 * exactly where a model would otherwise invent a plausible sentence and
 * attribute it, which is the same fabrication the "never invent an item" rule
 * forbids one level up.
 * @param {{ lens?: Lens | null, hasItems?: boolean, hasQuotes?: boolean, swedish?: boolean }} [opts]
 * @returns {string}
 */
export function outrospectionAnswerPrompt(opts = {}) {
  const { lens = null, hasItems = false, hasQuotes = false, swedish = false } = opts;
  const question = lens ? (swedish ? lens.questionSv : lens.question) : "";
  const lensLine =
    lens ?
      swedish ?
        `\n\nFrågan lyser genom linsen "${swedish ? lens.titleSv : lens.title}", vars stående fråga är: ${question}`
      : `\n\nThe question falls under the "${lens.title}" lens, whose standing question is: ${question}`
    : "";
  const empty =
    swedish ?
      "Flödet innehåller inget om detta ännu. Säg det rakt ut, gissa inte, och hitta ALDRIG på artiklar, rubriker eller länkar. Berätta vilka linser som finns och föreslå att användaren uppdaterar flödet på /outrospect/."
    : "The feed holds nothing on this yet. Say so plainly, do not guess, and NEVER invent articles, headlines or links. Name the lenses that exist and suggest refreshing the feed at /outrospect/.";
  const grounded =
    swedish ?
      "Svara ENBART utifrån flödesposterna ovan. Citera dem som [1], [2] … precis som forskningssvaren gör. Om posterna inte täcker frågan, säg vad de faktiskt visar och vad som saknas — hitta aldrig på en post."
    : "Answer ONLY from the feed items above. Cite them as [1], [2] … exactly as the research answers do. If the items do not cover the question, say what they DO show and what is missing — never invent an item.";
  const quoting =
    hasQuotes ?
      swedish ?
        "Avsnittet CITERBARA STYCKEN innehåller ordagrann text som hämtats från artiklarna. Citera ORDAGRANT därifrån inom citattecken och sätt källänken (dess url) direkt intill citatet. Citera inget som inte står där, och hitta ALDRIG på ett citat."
      : "The QUOTABLE PASSAGES section holds verbatim text fetched from those articles. Quote WORD FOR WORD from there, in quotation marks, with the source link (its url) right next to the quote. Quote nothing that is not in that section, and NEVER invent a quotation."
    : swedish ?
      "Ingen artikeltext har hämtats för de här posterna ännu, så citera INGENTING ordagrant — sammanfatta och hänvisa till [1], [2] … med deras länkar i stället. Hitta aldrig på ett citat."
    : "No article text has been fetched for these items yet, so do NOT quote verbatim — summarise and refer to [1], [2] … with their links instead. Never invent a quotation.";
  const head =
    swedish ?
      "Du är utrospektionsläget för DeepResearch.se: introspektionens spegelbild. Introspektion svarar utifrån den här sajtens egen källkod; du svarar utifrån vad ALLA ANDRA bygger."
    : "You are DeepResearch.se's outrospection mode: introspection's mirror image. Introspection answers from this site's own source; you answer from what EVERYONE ELSE is building.";
  const compare =
    swedish ?
      "Avsluta alltid med vad det betyder för DET HÄR projektet — bekräftar det ett antagande, motsäger det ett, eller pekar det på något vi borde ompröva? Var konkret och kort; inga artighetsfraser."
    : "Always close with what it means for THIS project — does it confirm an assumption, contradict one, or point at something worth reconsidering? Be concrete and short; no pleasantries.";
  // Language parity follows the orchestrator plan-prompt convention: the
  // default instruction is bilingual, so a Swedish question gets a Swedish
  // answer without this module having to own a second language detector.
  const language =
    swedish ?
      "Svara på svenska."
    : "Answer in the language the user wrote in (svara på svenska om användaren skriver svenska).";
  return `${head}${lensLine}\n\n${hasItems ? `${grounded}\n\n${quoting}` : empty}\n\n${compare}\n\n${language}`;
}

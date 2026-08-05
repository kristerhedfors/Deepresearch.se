// @ts-check
// The LITERATURE tool family — the two hosted scientific corpora (arXiv and
// PubMed) exposed over MCP as directly searchable knowledge bases.
//
// WHY THIS EXISTS BESIDE deep_research. The MCP surface already offers the
// whole pipeline as one tool: ask a question, wait a minute or two, get a
// cited answer. That is the right shape for a client that wants an ANSWER. It
// is the wrong shape for an agent doing its own research over a corpus, which
// wants to issue several angles at once, read the records, decide what to read
// next, and follow citations — in seconds, not minutes, with the raw fields
// intact rather than flattened into prose. The two indexes already exist
// (docs/ARXIV-RAG.md, docs/PUBMED-RAG.md); until now nothing outside the
// pipeline's own search wave could reach them.
//
// FOUR TOOLS, each a distinct capability rather than a knob on the others:
//   literature_search   — semantic search, MANY angles in one call, both corpora
//   literature_fetch    — exact records by arXiv id / PMID (following a citation)
//   literature_similar  — more-like-this from a known paper (related-work sweep)
//   literature_corpora  — what is actually indexed, so an agent can tell a real
//                         miss from a corpus that never held the answer
//
// THIS MODULE IS PURE — it imports nothing. Everything here is schema,
// argument parsing, record mapping, filtering and formatting; every call that
// touches the network, a Vectorize binding or the embedder lives in
// src/literature-run.js, which src/mcp.js loads behind a dynamic import. That
// split is what keeps src/mcp.test.js's "loads without the pipeline" guarantee
// intact (the file-layout rule at the top of src/mcp.js), and it is why the
// mapping and filtering below are unit-testable with plain objects.
//
// ---- what the caller must be told, and why ---------------------------------
//
// Neither index carries a Vectorize metadata index, so there is NO server-side
// filter: a date or category bound is applied to the reranked candidate pool
// AFTER retrieval, never pushed into the query. That is a real and
// consequential difference — a narrow filter over 50 candidates can return
// nothing while the corpus holds hundreds of matches — so every filtered
// response says so in `notes` rather than letting the caller assume otherwise.
// The same honesty applies to the corpus windows: arXiv starts at submission
// month 2310 and PubMed is a PMID/load-order slice, not "recent PubMed".

/**
 * One retrieved record, corpus-independent in its common fields.
 * @typedef {Object} LiteratureRecord
 * @property {"arxiv"|"pubmed"} corpus
 * @property {string} id the corpus id (arXiv id, or the bare PMID)
 * @property {string} url
 * @property {string} title
 * @property {string[]} authors
 * @property {string} date best available date, `YYYY-MM` or `YYYY-MM-DD`
 * @property {string} abstract as stored — see `abstract_cut`
 * @property {boolean} abstract_cut true when the indexer's 900-char cut bit
 * @property {number} [score] cross-encoder relevance, when the reranker ran
 * @property {string} [primary_category] arXiv only
 * @property {string} [revised] arXiv only — last revision, distinct from `date`
 * @property {string} [journal] PubMed only
 */

// ---------------------------------------------------------------------------
// Bounds. Every one of these is about the CALLER'S context window, not about
// what the index can serve: `topK` is fixed at 50 inside the dense tier, so a
// bigger `limit` costs nothing extra to retrieve and everything to read.
// ---------------------------------------------------------------------------

/** Angles per call. Six is the point where one batched embedding call still
 * fits comfortably inside the tier's 12 s budget. */
export const MAX_QUERIES = 6;
/** Per query, per corpus. */
export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 25;
/** Across the whole response, after merging. A hard stop so no combination of
 * queries × corpora × limit can flood the caller. */
export const MAX_TOTAL_RECORDS = 60;
/** Ids per literature_fetch call. */
export const MAX_FETCH_IDS = 20;
/** Author names per literature_search call. More than a few is a different
 * question, and each name costs two live API round trips. */
export const MAX_AUTHORS = 3;
/** The indexer's abstract cut (scripts/*-vectorize.mjs store 900 chars), so a
 * stored abstract at this length was almost certainly truncated at ingest. */
export const STORED_ABSTRACT_CHARS = 900;

/** The corpora this family serves, in the order responses list them. */
export const CORPUS_IDS = /** @type {const} */ (["arxiv", "pubmed"]);

/**
 * What each corpus IS — the standing facts an agent needs to read a miss
 * correctly. Counts are the measured fill figures from the corpus docs; the
 * live vector count is read from the binding at call time when available
 * (src/literature-run.js), and these are the fallback plus the parts a
 * `describe()` call cannot tell you.
 */
export const CORPUS_FACTS = {
  arxiv: {
    id: "arxiv",
    name: "arXiv",
    binding: "ARXIV_INDEX",
    doc: "docs/ARXIV-RAG.md",
    covers:
      "Preprints in physics, mathematics, computer science, quantitative biology, " +
      "statistics, economics and quantitative finance.",
    window:
      "Submission months 2310–2607 (October 2023 onwards). Anything submitted before " +
      "October 2023 is NOT in this index — that is a window, not a retrieval failure.",
    vectors_at_fill: 772658,
    id_format: "arXiv id, e.g. 2401.12345 (accepted with or without an `arxiv:` prefix)",
    fields: ["title", "abstract", "authors", "primary_category", "submitted", "revised"],
    live_fallback: "the arXiv API (keyword AND over abstracts), used by the research pipeline",
  },
  pubmed: {
    id: "pubmed",
    name: "PubMed",
    binding: "PUBMED_INDEX",
    doc: "docs/PUBMED-RAG.md",
    covers: "Biomedical and life-science literature — MEDLINE journals, plus bioRxiv/medRxiv records.",
    window:
      "A PMID / load-order slice: the daily update files above the 2026 baseline, NOT " +
      "'the last six months of PubMed'. It contains 2026 publications heavily, earlier " +
      "years thinly (a 1990s paper revised in 2026 is in; an untouched 2015 paper is not), " +
      "and is roughly 5.6% of abstract-bearing PubMed. Treat a miss as likely-out-of-window.",
    vectors_at_fill: 1638756,
    id_format: "PMID, e.g. 41610285 (accepted with or without a `pmid:` prefix)",
    fields: ["title", "abstract", "authors", "journal", "date"],
    live_fallback: "Europe PMC (keyword AND, current to the hour), used by the research pipeline",
  },
};

// The caveat that has to travel with every result set, because it changes what
// an empty result MEANS. Stated once here and attached by the runner.
export const RETRIEVAL_NOTE =
  "Dense retrieval (multilingual-e5-large) over the hosted corpus, reranked by a " +
  "cross-encoder; results below the relevance floor are dropped, so an empty result " +
  "means 'nothing in this corpus is relevant', not 'the search failed'. Abstracts are " +
  "stored cut to 900 characters — `abstract_cut: true` means the rest of the abstract " +
  "exists only at the source URL.";

export const FILTER_NOTE =
  "Filters (since/until/categories/journals) are applied AFTER retrieval, to the top-50 " +
  "reranked candidates per query per corpus — neither index carries a Vectorize metadata " +
  "index, so a bound cannot be pushed into the query. A narrow filter can therefore return " +
  "few or no rows while the corpus holds many matches; widen the query or drop the filter " +
  "rather than concluding the corpus is empty. `min_score` is the exception: it REPLACES " +
  "the relevance floor during retrieval, so a strict score bound returns a full result set " +
  "of strong matches rather than the survivors of a list already cut at the default floor.";

// ---------------------------------------------------------------------------
// Tool definitions. Written in Anthropic's `input_schema` key like SDK_TOOLS
// as the SDK family does, so src/mcp.js renames it to MCP's `inputSchema` in one
// place. Descriptions are what the CALLING model reads — they carry the
// operating advice (batch your angles; a miss may be a window, not a failure)
// that no amount of documentation elsewhere will reach it.
// ---------------------------------------------------------------------------

const CORPUS_ARG = {
  type: "string",
  enum: ["arxiv", "pubmed", "both"],
  description:
    "Which knowledge base to search. 'arxiv' for physics/maths/CS/stats preprints, " +
    "'pubmed' for biomedical and life-science literature, 'both' (default) to search " +
    "them in parallel — same latency as one, so prefer it unless you know the field.",
  default: "both",
};

/** @type {{ name: string, description: string, input_schema: any }[]} */
export const LITERATURE_TOOLS = [
  {
    name: "literature_search",
    description:
      "Semantic search over DeepResearch.se's hosted scientific corpora — arXiv preprints " +
      "and PubMed biomedical literature — returning structured paper records (title, " +
      "authors, date, abstract, ids, relevance score) rather than prose. " +
      "SEND SEVERAL ANGLES AT ONCE: `queries` takes up to 6 distinct phrasings and they " +
      "run fully in parallel against both corpora in a single round trip, which is the " +
      "fast way to cover a topic — six separate calls cost six times the latency for the " +
      "same work. Ask in natural language, not keywords: retrieval is by meaning, and " +
      "stripping a question to search terms throws away the signal the embedder uses. " +
      "TO LIST A NAMED RESEARCHER'S WORK, PASS `authors` — semantic search cannot answer an " +
      "authorship question (a name embeds as a topic, so 'X's papers' returns papers about " +
      "X's subject by other people), so `authors` runs a real author-field lookup instead. " +
      "Use this to READ the literature yourself; use deep_research instead when you want " +
      "the site to plan, search the open web and write a cited answer for you.",
    input_schema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description:
            `Up to ${MAX_QUERIES} natural-language questions or topic statements, run in ` +
            "parallel. Distinct angles on one topic beat near-duplicates.",
          maxItems: MAX_QUERIES,
        },
        query: {
          type: "string",
          description: "A single question — convenience shorthand for a one-element `queries`.",
        },
        authors: {
          type: "array",
          items: { type: "string" },
          description:
            "Researcher names whose papers to list — the way to answer 'what has X published', " +
            "'X's body of work', or a bibliography request. Write the name as it is published " +
            "('Love Dalén', 'M. Dehasque'); both the full form and the indexed 'Surname I' form " +
            "are tried. This leg queries the LIVE Europe PMC and arXiv author fields rather than " +
            "the hosted indexes, so it covers the full archive rather than the corpus windows — " +
            "and it is valid on its own, with no `queries` at all. Names are NOT disambiguated: " +
            "pass `queries` alongside and the subject terms are ANDed onto the author query, " +
            "which is what separates two researchers who share a surname.",
          maxItems: MAX_AUTHORS,
        },
        corpus: CORPUS_ARG,
        limit: {
          type: "number",
          description:
            `Records per query per corpus (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). The ` +
            `whole response is capped at ${MAX_TOTAL_RECORDS} records after merging.`,
          default: DEFAULT_LIMIT,
          minimum: 1,
          maximum: MAX_LIMIT,
        },
        since: {
          type: "string",
          description:
            "Keep only records dated on or after this (YYYY, YYYY-MM or YYYY-MM-DD). Applied " +
            "after retrieval to the candidate pool — see the response's notes.",
        },
        until: {
          type: "string",
          description: "Keep only records dated on or before this (YYYY, YYYY-MM or YYYY-MM-DD).",
        },
        categories: {
          type: "array",
          items: { type: "string" },
          description:
            "arXiv only: keep records whose primary category matches one of these, by prefix — " +
            "'cs' matches cs.CL and cs.LG, 'cs.CL' matches only cs.CL.",
        },
        journals: {
          type: "array",
          items: { type: "string" },
          description: "PubMed only: keep records whose journal name contains one of these (case-insensitive).",
        },
        min_score: {
          type: "number",
          description:
            "Drop records whose cross-encoder relevance score is below this. The tier already " +
            "applies a floor of 0.01; raise it (0.1–0.5) when you want only strong matches.",
        },
        abstract: {
          type: "string",
          enum: ["full", "short", "none"],
          description:
            "How much abstract to return: 'full' (default, as stored — up to 900 chars), " +
            "'short' (first 300 chars, for wide sweeps you will narrow later), or 'none' " +
            "(titles and metadata only, cheapest to read).",
          default: "full",
        },
      },
      required: [],
    },
  },
  {
    name: "literature_fetch",
    description:
      "Fetch exact records from the hosted corpora by identifier — arXiv ids and/or PMIDs, " +
      "mixed freely in one call. This is how you follow a citation: a paper referenced " +
      "anywhere (an answer, another abstract, a user's message) becomes its title, authors, " +
      "date and abstract without a search. Ids not present in an index are reported as " +
      "misses with the corpus window that explains why, never silently dropped.",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description:
            `Up to ${MAX_FETCH_IDS} identifiers. arXiv: '2401.12345' or 'arxiv:2401.12345' or ` +
            "an arxiv.org URL. PubMed: '41610285' or 'pmid:41610285' or a pubmed.ncbi.nlm.nih.gov " +
            "URL. A bare number with a dot is read as arXiv, a bare all-digit number as a PMID.",
          maxItems: MAX_FETCH_IDS,
        },
        abstract: {
          type: "string",
          enum: ["full", "short", "none"],
          description: "How much abstract to return (default 'full').",
          default: "full",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "literature_similar",
    description:
      "Find papers similar to one you already have, by identifier — a related-work sweep that " +
      "needs no query at all. Retrieves the known paper's own embedding and searches its " +
      "neighbourhood, so it surfaces work using different vocabulary for the same idea, which " +
      "a keyword or even a paraphrased query would miss. Search across both corpora to cross " +
      "the preprint/journal divide (an arXiv method paper's biomedical applications, say).",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The seed paper: an arXiv id, a PMID, or a URL to either — same forms literature_fetch accepts.",
        },
        corpus: CORPUS_ARG,
        limit: {
          type: "number",
          description: `Records per corpus (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          default: DEFAULT_LIMIT,
          minimum: 1,
          maximum: MAX_LIMIT,
        },
        since: { type: "string", description: "Keep only records dated on or after this (YYYY, YYYY-MM, YYYY-MM-DD)." },
        until: { type: "string", description: "Keep only records dated on or before this." },
        abstract: {
          type: "string",
          enum: ["full", "short", "none"],
          description: "How much abstract to return (default 'full').",
          default: "full",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "literature_corpora",
    description:
      "Describe what the hosted corpora actually contain — live vector counts, the coverage " +
      "window of each, the fields stored, and how retrieval behaves. Call this BEFORE " +
      "concluding that a corpus has nothing on a topic: both indexes are windows onto their " +
      "sources, not complete copies, and a miss inside the window means something different " +
      "from a miss outside it. Contacts no third party.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

/** Every literature tool name, for src/mcp.js's dispatch. */
export const LITERATURE_TOOL_NAMES = new Set(LITERATURE_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// The two ADAPTER tools ChatGPT requires by name (docs/MCP-CONNECTOR.md §2a).
//
// Without developer mode, ChatGPT REFUSES to connect to an MCP server that does
// not expose tools literally named `search` and `fetch`, with a fixed
// contract — one query string in, `{ results: [{ id, title, url }] }` out; one
// document id in, `{ id, title, text, url, metadata? }` out — returned TWICE,
// as `structuredContent` and as JSON-encoded text in the content array. That is
// not a preference we can negotiate with a better schema: the names and the
// shapes are the price of being addable at all, and developer mode is web-only,
// paid-tier and labelled dangerous, so requiring it is not an answer.
//
// They front THE TWO HOSTED CORPORA (owner decision), projecting what
// literature_search and literature_fetch already return. Nothing new retrieves:
// `search` is one angle through the same dense tier and `fetch` is the same
// getByIds key read, so this is a rename and a projection rather than a second
// search stack. The literature tools stay the better ones for a client that can
// name them — six angles at once, authors, dates, scores, filters — and their
// descriptions say so, because a Claude-side model reading a nine-tool list
// should not pick the flattest one on the strength of the shortest name.
// ---------------------------------------------------------------------------

/** Records per corpus retrieved for one `search` call, before merging. */
export const OPENAI_SEARCH_LIMIT = 10;
/** Results in a `search` response. Small on purpose: the shape carries no
 * abstract, so every result is a `fetch` the caller may decide to make. */
export const OPENAI_MAX_RESULTS = 12;

/** @type {{ name: string, description: string, input_schema: any, output_schema: any }[]} */
export const OPENAI_ADAPTER_TOOLS = [
  {
    name: "search",
    description:
      "Search DeepResearch.se's hosted scientific corpora — arXiv preprints and PubMed " +
      "biomedical literature — and return the matching papers as {id, title, url}. " +
      "Retrieval is semantic: ask in natural language, because stripping a question to " +
      "keywords throws away the signal the embedder uses. The results carry no abstract by " +
      "design — pass an `id` to `fetch` to read one. " +
      "If you can call `literature_search`, prefer it: same retrieval, but up to six angles " +
      "in one round trip and records with authors, dates, categories, relevance scores and " +
      "abstracts. This tool exists because some clients require a tool named `search`.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The question or topic to search for, in natural language.",
        },
      },
      required: ["query"],
    },
    output_schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          description: "Matching papers, most relevant first.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Pass this to `fetch` verbatim." },
              title: { type: "string" },
              url: { type: "string" },
            },
            required: ["id", "title", "url"],
          },
        },
      },
      required: ["results"],
    },
  },
  {
    name: "fetch",
    description:
      "Retrieve one paper from the hosted scientific corpora by the `id` a `search` result " +
      "carried. Bare arXiv ids ('2401.12345'), PMIDs ('41610285') and URLs to either site " +
      "work too, so a citation seen anywhere can be resolved here. " +
      "`text` IS THE STORED ABSTRACT, NOT FULL TEXT: the indexes hold abstracts cut to 900 " +
      "characters and no body text at all, so treat it as a summary and follow `url` for the " +
      "paper itself. An id outside a corpus's coverage window comes back named, with the " +
      "window that explains it, rather than as a silent miss.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The document id — 'arxiv:2401.12345' or 'pmid:41610285' as returned by `search`, " +
            "or a bare id or source URL.",
        },
      },
      required: ["id"],
    },
    output_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        text: { type: "string", description: "The stored abstract (up to 900 characters). Never full text." },
        url: { type: "string" },
        metadata: { type: "object", description: "Corpus, authors, date, and what `text` actually is." },
      },
      required: ["id", "title", "text", "url"],
    },
  },
];

/** The adapter tool names, for src/mcp.js's dispatch and the quota decision. */
export const OPENAI_ADAPTER_TOOL_NAMES = new Set(OPENAI_ADAPTER_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Argument parsing. Every one of these DEGRADES rather than throws: a tool
// that errors on a slightly wrong argument is a model that retries the same
// call forever. What cannot be
// understood becomes the documented default, and the response says what was
// used.
// ---------------------------------------------------------------------------

/**
 * Normalize the `queries` / `query` pair into a de-duplicated list.
 * @param {any} args
 * @returns {string[]}
 */
export function normalizeQueries(args) {
  const raw = [];
  if (args && Array.isArray(args.queries)) raw.push(...args.queries);
  if (args && typeof args.query === "string") raw.push(args.query);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const text = String(entry ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/**
 * Which corpora a call addresses. Anything unrecognized means both — the
 * default that answers the question rather than the one that refuses it.
 * @param {any} value
 * @returns {("arxiv"|"pubmed")[]}
 */
export function normalizeCorpora(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "arxiv") return ["arxiv"];
  if (text === "pubmed") return ["pubmed"];
  return [...CORPUS_IDS];
}

/**
 * @param {any} value
 * @returns {number}
 */
export function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.round(n)));
}

/**
 * @param {any} value
 * @returns {"full"|"short"|"none"}
 */
export function normalizeAbstractMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "short" || text === "none" ? text : "full";
}

/**
 * A date bound → a comparable `YYYY-MM-DD` string, padded at the END the bound
 * points to: `since: "2024"` means from 2024-01-01, `until: "2024"` means
 * through 2024-12-31. Padding both the same way would silently exclude eleven
 * months of an `until` year.
 * @param {any} value
 * @param {"since"|"until"} edge
 * @returns {string} "" when unparseable — an unusable bound is dropped, not enforced
 */
export function normalizeDateBound(value, edge) {
  const text = String(value ?? "").trim();
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text);
  if (!m) return "";
  const year = m[1];
  const hasMonth = m[2] !== undefined;
  const hasDay = m[3] !== undefined;
  const month = hasMonth ? String(Math.min(12, Math.max(1, Number(m[2])))).padStart(2, "0") : edge === "since" ? "01" : "12";
  const day = hasDay
    ? String(Math.min(31, Math.max(1, Number(m[3])))).padStart(2, "0")
    : edge === "since"
      ? "01"
      : "31";
  return `${year}-${month}-${day}`;
}

/**
 * A record's date → the same comparable form. Records carry `YYYY-MM` (arXiv,
 * derived from the id) or `YYYY-MM-DD` / `YYYY` (PubMed, as published), so a
 * bare string comparison would put "2024-03" before "2024-03-01" and drop a
 * whole month at a `since` boundary.
 * @param {string} date
 * @returns {string}
 */
export function comparableDate(date) {
  const text = String(date || "").trim();
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(text);
  if (!m) return "";
  return `${m[1]}-${m[2] || "01"}-${m[3] || "01"}`;
}

/**
 * The filter set a call asked for, with the unparseable parts dropped.
 * @param {any} args
 * @returns {{ since: string, until: string, categories: string[], journals: string[], minScore: number|null }}
 */
export function parseFilters(args) {
  const given = args && typeof args === "object" ? args : {};
  const list = (/** @type {any} */ v) =>
    (Array.isArray(v) ? v : typeof v === "string" ? [v] : [])
      .map((x) => String(x ?? "").trim())
      .filter(Boolean);
  const minScoreRaw = Number(given.min_score);
  return {
    since: normalizeDateBound(given.since, "since"),
    until: normalizeDateBound(given.until, "until"),
    categories: list(given.categories).map((c) => c.toLowerCase()),
    journals: list(given.journals).map((j) => j.toLowerCase()),
    minScore: Number.isFinite(minScoreRaw) ? minScoreRaw : null,
  };
}

/** Whether any filter is actually in force — drives the `notes` line. */
/** @param {ReturnType<typeof parseFilters>} filters */
export function filtersActive(filters) {
  return Boolean(
    filters.since || filters.until || filters.categories.length || filters.journals.length || filters.minScore !== null,
  );
}

/**
 * Apply the post-retrieval filters to one corpus's records. Corpus-specific
 * filters only bind on their own corpus: `categories` cannot silently empty a
 * PubMed result set, and `journals` cannot empty an arXiv one.
 * @param {LiteratureRecord[]} records
 * @param {ReturnType<typeof parseFilters>} filters
 * @returns {LiteratureRecord[]}
 */
export function applyFilters(records, filters) {
  return records.filter((rec) => {
    if (filters.minScore !== null && (rec.score ?? 0) < filters.minScore) return false;
    if (filters.since || filters.until) {
      const d = comparableDate(rec.date);
      // A record with no usable date survives a bound rather than being
      // dropped by it — dropping on absent data would quietly bias a result
      // set toward whatever happens to be well-dated.
      if (d) {
        if (filters.since && d < filters.since) return false;
        if (filters.until && d > filters.until) return false;
      }
    }
    if (filters.categories.length && rec.corpus === "arxiv") {
      const cat = String(rec.primary_category || "").toLowerCase();
      const hit = filters.categories.some((c) => cat === c || cat.startsWith(`${c}.`));
      if (!hit) return false;
    }
    if (filters.journals.length && rec.corpus === "pubmed") {
      const journal = String(rec.journal || "").toLowerCase();
      const hit = filters.journals.some((j) => journal.includes(j));
      if (!hit) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Identifier parsing. One id space for the caller, two corpora underneath.
// ---------------------------------------------------------------------------

/**
 * Read one caller-supplied identifier. Accepts the prefixed form, the bare
 * form, and a URL to either site, because all three are what an id looks like
 * when it arrives from a citation rather than from a form field.
 * @param {any} raw
 * @returns {{ corpus: "arxiv"|"pubmed", id: string, vectorId: string } | null}
 */
export function parseLiteratureId(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // URLs first — a URL contains its own corpus, so it never has to be guessed.
  const arxivUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i.exec(text);
  if (arxivUrl) return arxivRef(arxivUrl[1].replace(/v\d+$/i, "").replace(/\.pdf$/i, ""));
  const pubmedUrl = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(text);
  if (pubmedUrl) return pubmedRef(pubmedUrl[1]);

  const prefixed = /^(arxiv|pmid|pubmed)\s*:\s*(.+)$/i.exec(text);
  if (prefixed) {
    const body = prefixed[2].trim();
    return prefixed[1].toLowerCase() === "arxiv" ? arxivRef(body) : pubmedRef(body);
  }

  // Bare forms. An arXiv id always carries the `YYMM.NNNNN` dot (the new-style
  // scheme this corpus is built on); a PMID never does.
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(text)) return arxivRef(text);
  // Old-style arXiv ids (math/0211159) are outside this corpus's window
  // entirely, but reading them as arXiv gives an honest miss rather than a
  // nonsense PMID lookup.
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(text)) return arxivRef(text);
  if (/^\d{1,9}$/.test(text)) return pubmedRef(text);
  return null;
}

/** @param {string} body */
function arxivRef(body) {
  const id = body.trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "");
  if (!id) return null;
  return /** @type {const} */ ({ corpus: "arxiv", id, vectorId: id });
}

/** @param {string} body */
function pubmedRef(body) {
  const id = (body.trim().match(/(\d{1,9})/) || [])[1] || "";
  if (!id) return null;
  return /** @type {const} */ ({ corpus: "pubmed", id, vectorId: `pmid:${id}` });
}

/**
 * Parse a whole `ids` argument, keeping the unreadable entries so the caller
 * is told which of its ids were never looked up rather than left to infer it
 * from a short result list.
 * @param {any} value
 * @returns {{ refs: { corpus: "arxiv"|"pubmed", id: string, vectorId: string }[], unreadable: string[] }}
 */
export function parseLiteratureIds(value) {
  const raw = (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).slice(0, MAX_FETCH_IDS);
  const refs = [];
  const unreadable = [];
  const seen = new Set();
  for (const entry of raw) {
    const ref = parseLiteratureId(entry);
    if (!ref) {
      const text = String(entry ?? "").trim();
      if (text) unreadable.push(text);
      continue;
    }
    if (seen.has(ref.vectorId)) continue;
    seen.add(ref.vectorId);
    refs.push(ref);
  }
  return { refs, unreadable };
}

// ---------------------------------------------------------------------------
// Vectorize match → structured record. The presentation mappers in
// src/arxiv-rag.js and src/pubmed-rag.js flatten these same fields into one
// `highlights` string because their consumer is a numbered source list. An
// agent's consumer is its own reasoning, so nothing is flattened here.
// ---------------------------------------------------------------------------

/**
 * Split the stored `au` metadata ("A; B; C", first 8, cut at 300 chars).
 * @param {any} value
 * @returns {string[]}
 */
export function splitAuthors(value) {
  return String(value ?? "")
    .split(";")
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Submission month from an arXiv id ("2310.01234" → "2023-10"). Duplicated
 * from src/arxiv-rag.js's arxivSubmitted deliberately: importing it would pull
 * this pure module into src/dense-rag.js's import graph and through it
 * src/berget.js, which is exactly the weight src/mcp.js's file-layout rule
 * keeps out of the static side. Four lines, pinned by a test in both places.
 * @param {string} id
 */
export function arxivSubmittedMonth(id) {
  const m = /^(\d{2})(\d{2})\./.exec(String(id || "").trim());
  return m ? `20${m[1]}-${m[2]}` : "";
}

/**
 * The id this surface HANDS OUT, and the one it expects back: `arxiv:2401.12345`
 * / `pmid:41610285`. parseLiteratureId reads the bare forms too, but a bare id
 * only says which corpus it belongs to by accident of shape — an arXiv id has a
 * dot, a PMID does not — so anything that has to survive a round trip through a
 * client carries the prefix that says it outright.
 * @param {"arxiv"|"pubmed"} corpus
 * @param {string} id
 * @returns {string}
 */
export function canonicalRefId(corpus, id) {
  return `${corpus === "arxiv" ? "arxiv" : "pmid"}:${id}`;
}

/**
 * Where a record lives at its source. Known from the corpus and the id alone,
 * which is what lets a MISS still be answered with a usable link: the corpora
 * are windows, so "not in this index" routinely means "published, just outside
 * the window".
 * @param {"arxiv"|"pubmed"} corpus
 * @param {string} id
 * @returns {string}
 */
export function sourceUrlFor(corpus, id) {
  return corpus === "arxiv" ? `https://arxiv.org/abs/${id}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
}

/**
 * One arXiv Vectorize match → a record.
 * @param {any} match
 * @returns {LiteratureRecord | null}
 */
export function arxivRecord(match) {
  const m = match?.metadata;
  if (!m) return null;
  const id = String(match.id || "").trim();
  const title = String(m.t || "").replace(/\s+/g, " ").trim();
  if (!id || !title) return null;
  const abstract = String(m.a || "").trim();
  const revised = String(m.d || "").slice(0, 10);
  /** @type {LiteratureRecord} */
  const rec = {
    corpus: "arxiv",
    id,
    url: sourceUrlFor("arxiv", id),
    title,
    authors: splitAuthors(m.au),
    // The id's month is the true SUBMISSION date; `d` is the last revision.
    // src/arxiv-rag.js records why they must not be conflated.
    date: arxivSubmittedMonth(id) || revised,
    abstract,
    abstract_cut: abstract.length >= STORED_ABSTRACT_CHARS,
  };
  const category = String(m.c || "").trim();
  if (category) rec.primary_category = category;
  if (revised) rec.revised = revised;
  if (Number.isFinite(match?.rerankScore)) rec.score = round4(match.rerankScore);
  return rec;
}

/**
 * One PubMed Vectorize match → a record.
 * @param {any} match
 * @returns {LiteratureRecord | null}
 */
export function pubmedRecord(match) {
  const m = match?.metadata;
  if (!m) return null;
  const pmid = (String(match?.id || "").trim().match(/^pmid:(\d+)$/) || [])[1] || "";
  const title = String(m.t || "").replace(/\s+/g, " ").trim();
  if (!pmid || !title) return null;
  const abstract = String(m.a || "").trim();
  /** @type {LiteratureRecord} */
  const rec = {
    corpus: "pubmed",
    id: pmid,
    url: sourceUrlFor("pubmed", pmid),
    title,
    authors: splitAuthors(m.au),
    date: String(m.d || "").slice(0, 10),
    abstract,
    abstract_cut: abstract.length >= STORED_ABSTRACT_CHARS,
  };
  const journal = String(m.j || "").trim();
  if (journal) rec.journal = journal;
  if (Number.isFinite(match?.rerankScore)) rec.score = round4(match.rerankScore);
  return rec;
}

/** The mapper for one corpus, by id. */
export const RECORD_MAPPERS = { arxiv: arxivRecord, pubmed: pubmedRecord };

/** @param {number} n */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Apply the abstract mode to a record set, non-destructively.
 * @param {LiteratureRecord[]} records
 * @param {"full"|"short"|"none"} mode
 * @returns {LiteratureRecord[]}
 */
export function shapeAbstracts(records, mode) {
  if (mode === "full") return records;
  return records.map((rec) => {
    const copy = { ...rec };
    if (mode === "none") {
      delete (/** @type {any} */ (copy).abstract);
      delete (/** @type {any} */ (copy).abstract_cut);
      return copy;
    }
    const abstract = String(rec.abstract || "");
    if (abstract.length > 300) {
      copy.abstract = `${abstract.slice(0, 300).trimEnd()}…`;
      copy.abstract_cut = true;
    }
    return copy;
  });
}

/**
 * Merge the per-query result sets into one ranked list: a paper found by three
 * angles is one record carrying its BEST score and the angles that found it.
 * That is the list an agent synthesizes from, and building it here rather than
 * leaving it to the caller is most of the value of batching the angles.
 * @param {{ query: string, records: LiteratureRecord[] }[]} groups
 * @param {number} [cap]
 * @returns {(LiteratureRecord & { found_by: number[] })[]}
 */
export function mergeRanked(groups, cap = MAX_TOTAL_RECORDS) {
  /** @type {Map<string, LiteratureRecord & { found_by: number[] }>} */
  const byId = new Map();
  groups.forEach((group, qi) => {
    for (const rec of group.records) {
      const key = `${rec.corpus}:${rec.id}`;
      const seen = byId.get(key);
      if (!seen) {
        byId.set(key, { ...rec, found_by: [qi] });
        continue;
      }
      if (!seen.found_by.includes(qi)) seen.found_by.push(qi);
      if ((rec.score ?? 0) > (seen.score ?? 0)) seen.score = rec.score;
    }
  });
  return [...byId.values()]
    .sort((a, b) => {
      // Corroboration first: a paper two angles agreed on outranks a slightly
      // better-scoring paper only one angle saw.
      if (b.found_by.length !== a.found_by.length) return b.found_by.length - a.found_by.length;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, cap);
}

/**
 * Trim per-query groups so the whole response stays under the record cap,
 * taking evenly from each group rather than starving the last query.
 * @param {{ query: string, records: LiteratureRecord[] }[]} groups
 * @param {number} [cap]
 */
export function capGroups(groups, cap = MAX_TOTAL_RECORDS) {
  const total = groups.reduce((n, g) => n + g.records.length, 0);
  if (total <= cap) return groups;
  const per = Math.max(1, Math.floor(cap / Math.max(1, groups.length)));
  return groups.map((g) => ({ ...g, records: g.records.slice(0, per) }));
}

/**
 * The MCP text payload: JSON, because the consumer is a model that will parse
 * fields out of it, and prose would make it guess. Compact but not minified —
 * two-space indent costs a few percent and makes a truncated response readable.
 * @param {any} payload
 * @returns {string}
 */
export function formatLiteratureResult(payload) {
  return JSON.stringify(payload, null, 2);
}

// ---------------------------------------------------------------------------
// The adapter projections. Pure, so the exact field names ChatGPT reads are
// pinned by a unit test with no binding in sight — and a wrong field name here
// is invisible until a connector fails to parse, which is the worst place to
// find it.
// ---------------------------------------------------------------------------

/**
 * The single query out of whatever a client sent. `query` is the argument the
 * schema declares, but the family's discipline is to degrade rather than throw
 * (a tool that errors on a near-miss argument is a model that retries the same
 * call forever), so the shorthands a caller might reach for are read too.
 * @param {any} args
 * @returns {string}
 */
export function openAiQuery(args) {
  const standard = normalizeQueries(args);
  if (standard.length) return standard[0];
  const given = args && typeof args === "object" ? args : {};
  for (const key of ["q", "search_query", "text", "input"]) {
    const text = String(given[key] ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

/**
 * The single document id out of whatever a client sent — same tolerance, same
 * reason. `ids` is read as well because a caller that has just used
 * literature_fetch may reach for its argument name.
 * @param {any} args
 * @returns {string}
 */
export function openAiFetchId(args) {
  const given = args && typeof args === "object" ? args : {};
  const first = Array.isArray(given.ids) ? given.ids[0] : null;
  for (const value of [given.id, first, given.document_id, given.doc_id, given.url]) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Records → ChatGPT's `results`. EXACTLY three keys per row, no more: the
 * contract names id/title/url, and an unrequested field on a shape a closed
 * client parses is a gamble with no upside — the abstract it would carry is one
 * `fetch` away.
 * @param {LiteratureRecord[]} records
 * @param {number} [cap]
 * @returns {{ id: string, title: string, url: string }[]}
 */
export function openAiSearchResults(records, cap = OPENAI_MAX_RESULTS) {
  /** @type {{ id: string, title: string, url: string }[]} */
  const out = [];
  const seen = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const corpus = rec?.corpus;
    const id = String(rec?.id ?? "").trim();
    if ((corpus !== "arxiv" && corpus !== "pubmed") || !id) continue;
    const key = `${corpus}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: canonicalRefId(corpus, id),
      title: String(rec.title || "").trim(),
      url: rec.url || sourceUrlFor(corpus, id),
    });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * One record → ChatGPT's document shape.
 *
 * `text` is the stored ABSTRACT and nothing else. Neither index holds body
 * text, and there is no runtime path that could fetch it, so the honest move is
 * to return what exists and say what it is — in the tool description, in this
 * `metadata.text_is`, and in `metadata.abstract_cut` when the indexer's 900-char
 * cut bit. A `text` field silently carrying a truncated abstract is how a
 * caller ends up asserting a paper does not mention something it discusses in
 * its results section.
 * @param {LiteratureRecord} record
 * @returns {{ id: string, title: string, text: string, url: string, metadata: Record<string, string> }}
 */
export function openAiDocument(record) {
  const corpus = record.corpus === "pubmed" ? "pubmed" : "arxiv";
  const id = String(record.id || "").trim();
  const abstract = String(record.abstract || "").trim();
  /** @type {Record<string, string>} */
  const metadata = {
    corpus,
    source: CORPUS_FACTS[corpus].name,
    text_is: abstract
      ? "the abstract as stored (up to 900 characters); this index holds no full text"
      : "no abstract is stored for this record",
    abstract_cut: String(Boolean(record.abstract_cut)),
  };
  if (record.authors?.length) metadata.authors = record.authors.join("; ");
  if (record.date) metadata.date = record.date;
  if (record.journal) metadata.journal = record.journal;
  if (record.primary_category) metadata.primary_category = record.primary_category;
  if (record.revised) metadata.revised = record.revised;
  if (Number.isFinite(record.score)) metadata.relevance_score = String(record.score);
  return {
    id: canonicalRefId(corpus, id),
    title: String(record.title || "").trim(),
    // Bracketed rather than empty: an empty `text` reads as "this paper says
    // nothing", which is a different claim from "we stored nothing".
    text: abstract || `[No abstract is stored for ${canonicalRefId(corpus, id)} in the hosted index.]`,
    url: record.url || sourceUrlFor(corpus, id),
    metadata,
  };
}

/**
 * The same shape for an id that did not come back — because the contract has no
 * "not found" branch, and a client that gets an error string where it expects a
 * document will report a broken server rather than a missing paper. The window
 * travels with it (the corpora are windows onto their sources, so most misses
 * are "published, outside the window"), and `url` still points at the source,
 * where the paper does exist.
 * @param {{ corpus: "arxiv"|"pubmed", id: string }} ref
 * @param {string} reason
 */
export function openAiMissDocument(ref, reason) {
  const facts = CORPUS_FACTS[ref.corpus];
  return {
    id: canonicalRefId(ref.corpus, ref.id),
    title: "",
    text:
      `Not in the hosted ${facts.name} index: ${reason} ${facts.window} ` +
      "The paper itself may well exist — follow `url` rather than concluding it does not.",
    url: sourceUrlFor(ref.corpus, ref.id),
    metadata: { corpus: ref.corpus, found: "false", coverage_window: facts.window },
  };
}

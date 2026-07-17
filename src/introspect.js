// @ts-check
// The introspection enrichment (developer mode): whenever the caller's
// developer_mode knob is on, this appends the site's OWN source to the
// conversation so every phase (triage, synthesis, validation) answers
// implementation questions — and code-example requests — from the real code
// instead of denying it has any. Two parts:
//
//   1. RETRIEVAL (RAG): the source chunks most relevant to the question,
//      pulled from a committed DENSE index (public/introspect/source-rag.json,
//      scripts/bundle-source-rag.mjs — int8 embeddings per source chunk). The
//      query is embedded server-side (Berget e5, the same model the index was
//      built with) and cosine-ranked against the index. This is what makes the
//      mode work for ANY phrasing ("code examples from the site") — no brittle
//      intent regex deciding whether to engage. NO Linux VM required.
//   2. ORIENTATION: a CLAUDE.md architecture excerpt, the full file index for
//      strong "how are you built" asks, and the full text of any repo file the
//      message names by path.
//
// Both the snapshot and the RAG index are committed artifacts served by THIS
// deploy's static assets and read back through the ASSETS binding — so what is
// injected is by construction the exact source this Worker runs. All shared,
// I/O-free logic (chunker, int8 codec, retrieval, block builder) lives in the
// pure core public/js/introspect-core.js (the bash-core.js pattern).
//
// Standing enrichment contract (src/enrichment.js): fail-soft in every branch.
// Retrieval or index failures degrade to a snapshot-only (orientation) block —
// and a missing snapshot to an unchanged conversation — never an error. The
// enrichment only RUNS when developer mode is on (registry gate in
// enrichment.js), so "always inject" here means "always inject in dev mode".

import {
  DOCS_CORPUS_PATH,
  DOCS_RAG_PATH,
  OWASP_CORPUS_PATH,
  OWASP_RAG_PATH,
  RAG_PATH,
  SNAPSHOT_PATH,
  buildHelpDocsBlock,
  buildIntrospectionBlock,
  buildOwaspReferenceBlock,
  diversifyByCategory,
  docsCorpusMeta,
  helpIntent,
  introspectionActive,
  lexicalRetrieveCorpus,
  mentionedSnapshotPaths,
  retrieveSourceChunks,
  securityAssessmentIntent,
  validateRagIndex,
  validateSnapshot,
} from "../public/js/introspect-core.js";
import { embedTexts } from "./berget.js";
import { textOf, withAppendedText } from "./conversation.js";

const QUERY_PREFIX = "query: "; // e5 asymmetric prefix — mirrors src/rag.js
const RETRIEVE_K = 6;
// OWASP paragraphs retrieved for a security assessment. Wider than the source
// K and capped per category (diversifyByCategory) so the block spans SEVERAL
// vulnerabilities the model can quote, not the single closest one.
const OWASP_RETRIEVE_K = 8;
const OWASP_PER_CATEGORY = 2;
// Documentation passages retrieved for the HELP layer (always on in dev mode —
// the same no-brittle-gate lesson as the source injection). A help-shaped ask
// (helpIntent) widens the retrieval; per-doc cap keeps the passages spanning
// several docs rather than k near-duplicates from the closest one.
const HELP_RETRIEVE_K = 8;
const HELP_RETRIEVE_K_BASE = 4;
const HELP_PER_DOC = 2;

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').RequestState} RequestState */
/** @typedef {import('../public/js/introspect-core.js').Snapshot} Snapshot */

/**
 * Every user message's text, oldest first — introspection is a MODE: one
 * engaging message keeps it on for the conversation's follow-ups.
 * @param {Conversation} conversation
 * @returns {string[]}
 */
function userTexts(conversation) {
  return conversation.filter((m) => m.role === "user").map((m) => textOf(m.content));
}

/**
 * Fetch + validate the deployed source snapshot through the ASSETS binding.
 * Null (never a throw) when the artifact is missing or unreadable.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<Snapshot | null>}
 */
export async function loadSourceSnapshot(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    // The binding routes by path; the host is a placeholder.
    const res = await assets.fetch(new Request("https://assets.internal" + SNAPSHOT_PATH));
    if (!res.ok) {
      log.warn("introspect.snapshot_missing", { status: res.status });
      return null;
    }
    const snapshot = validateSnapshot(await res.json());
    if (!snapshot) log.warn("introspect.snapshot_invalid", {});
    return snapshot;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.snapshot_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed dense RAG index through the ASSETS binding.
 * Null (never a throw) when it's missing/unreadable — retrieval degrades to
 * the orientation-only block.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<import('../public/js/introspect-core.js').RagIndex | null>}
 */
export async function loadSourceRag(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + RAG_PATH));
    if (!res.ok) {
      log.warn("introspect.rag_missing", { status: res.status });
      return null;
    }
    const index = validateRagIndex(await res.json());
    if (!index) log.warn("introspect.rag_invalid", {});
    return index;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.rag_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed OWASP corpus (snapshot-shaped) AND its parallel
 * per-doc citation metadata (`sources`) through the ASSETS binding. Null on any
 * failure — a security assessment then simply proceeds without the OWASP block.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<{ snapshot: Snapshot, sources: Record<string, any> } | null>}
 */
export async function loadOwaspCorpus(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + OWASP_CORPUS_PATH));
    if (!res.ok) {
      log.warn("introspect.owasp_corpus_missing", { status: res.status });
      return null;
    }
    const raw = await res.json();
    const snapshot = validateSnapshot(raw);
    if (!snapshot) {
      log.warn("introspect.owasp_corpus_invalid", {});
      return null;
    }
    const sources = raw && typeof raw.sources === "object" && !Array.isArray(raw.sources) ? raw.sources : {};
    return { snapshot, sources };
  } catch (/** @type {any} */ err) {
    log.warn("introspect.owasp_corpus_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed OWASP RAG index through the ASSETS binding.
 * Null (never a throw) on any failure.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<import('../public/js/introspect-core.js').RagIndex | null>}
 */
export async function loadOwaspRag(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + OWASP_RAG_PATH));
    if (!res.ok) {
      log.warn("introspect.owasp_rag_missing", { status: res.status });
      return null;
    }
    const index = validateRagIndex(await res.json());
    if (!index) log.warn("introspect.owasp_rag_invalid", {});
    return index;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.owasp_rag_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed HELP docs corpus (snapshot-shaped) AND its
 * help metadata (per-doc titles, resolved symbol references, the repo link
 * base) through the ASSETS binding. Null on any failure — the conversation
 * then simply proceeds without the documentation block.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<{ snapshot: Snapshot, meta: ReturnType<typeof docsCorpusMeta> } | null>}
 */
export async function loadDocsCorpus(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + DOCS_CORPUS_PATH));
    if (!res.ok) {
      log.warn("introspect.docs_corpus_missing", { status: res.status });
      return null;
    }
    const raw = await res.json();
    const snapshot = validateSnapshot(raw);
    if (!snapshot) {
      log.warn("introspect.docs_corpus_invalid", {});
      return null;
    }
    return { snapshot, meta: docsCorpusMeta(raw) };
  } catch (/** @type {any} */ err) {
    log.warn("introspect.docs_corpus_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed docs RAG index through the ASSETS binding.
 * Null (never a throw) on any failure — retrieval degrades to the lexical path.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<import('../public/js/introspect-core.js').RagIndex | null>}
 */
export async function loadDocsRag(env, log) {
  try {
    const assets = /** @type {any} */ (env).ASSETS;
    if (!assets?.fetch) return null;
    const res = await assets.fetch(new Request("https://assets.internal" + DOCS_RAG_PATH));
    if (!res.ok) {
      log.warn("introspect.docs_rag_missing", { status: res.status });
      return null;
    }
    const index = validateRagIndex(await res.json());
    if (!index) log.warn("introspect.docs_rag_invalid", {});
    return index;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.docs_rag_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Retrieve the documentation passages relevant to the question for the HELP
 * layer, spread across several docs (the per-doc cap). Dense retrieval (the
 * committed e5 index) when the query embed is available, else the embedding-
 * free lexical path — so the help layer works self-contained, exactly like the
 * OWASP grounding. Empty on any failure. `mode` reports which path ran.
 * @param {Env} env
 * @param {Logger} log
 * @param {Float32Array | null} qvec
 * @param {string} query
 * @param {boolean} helpAsk widen retrieval for a help-shaped question
 * @returns {Promise<{ retrieved: Array<{ p: string, text: string, score: number }>, meta: ReturnType<typeof docsCorpusMeta>, mode: string }>}
 */
async function retrieveHelpDocs(env, log, qvec, query, helpAsk) {
  const empty = { retrieved: [], meta: docsCorpusMeta(null), mode: "none" };
  try {
    const corpus = await loadDocsCorpus(env, log);
    if (!corpus) return empty;
    const k = helpAsk ? HELP_RETRIEVE_K : HELP_RETRIEVE_K_BASE;
    if (qvec) {
      const index = await loadDocsRag(env, log);
      if (index) {
        const all = retrieveSourceChunks(index, corpus.snapshot, qvec, index.vectors.length);
        const retrieved = diversifyByCategory(all, k, HELP_PER_DOC);
        if (retrieved.length) return { retrieved, meta: corpus.meta, mode: "dense" };
      }
    }
    const retrieved = lexicalRetrieveCorpus(corpus.snapshot, query, { k, perCat: HELP_PER_DOC });
    return { retrieved, meta: corpus.meta, mode: retrieved.length ? "lexical" : "none" };
  } catch (/** @type {any} */ err) {
    log.warn("introspect.docs_retrieve_failed", { error: err?.message || String(err) });
    return empty;
  }
}

/**
 * Embed the query once (e5 asymmetric query prefix), so BOTH the source
 * retrieval and the OWASP retrieval reuse one embedding call. Null (never a
 * throw) on empty input or any failure — retrieval then degrades to [].
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query
 * @returns {Promise<Float32Array | null>}
 */
async function embedQuery(env, log, query) {
  try {
    if (!query.trim()) return null;
    const { vectors } = await embedTexts(env, [QUERY_PREFIX + query.slice(0, 2000)]);
    const qvec = vectors && vectors[0];
    return qvec && qvec.length ? qvec : null;
  } catch (/** @type {any} */ err) {
    log.warn("introspect.embed_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Cosine-rank the source-RAG index for a pre-embedded query. [] on any failure —
 * the caller still injects the orientation block, so retrieval failing only
 * costs relevance, never the mode.
 * @param {Env} env
 * @param {Logger} log
 * @param {Float32Array | null} qvec
 * @param {Snapshot} snapshot
 * @returns {Promise<Array<{ p: string, text: string, score: number }>>}
 */
async function retrieveSource(env, log, qvec, snapshot) {
  try {
    if (!qvec) return [];
    const index = await loadSourceRag(env, log);
    if (!index) return [];
    return retrieveSourceChunks(index, snapshot, qvec, RETRIEVE_K);
  } catch (/** @type {any} */ err) {
    log.warn("introspect.retrieve_failed", { error: err?.message || String(err) });
    return [];
  }
}

/**
 * Retrieve the OWASP paragraphs relevant to a security-assessment query, spread
 * across SEVERAL categories (diversifyByCategory). Prefers dense retrieval (the
 * committed e5 index) when the query embed is available; falls back to the
 * embedding-FREE lexical path over the corpus when it isn't — so the OWASP
 * grounding works even with no embedder (the same path DRC uses). Returns the
 * chunks plus the per-doc citation metadata, or empty on any failure. `mode`
 * reports which path ran, for observability.
 * @param {Env} env
 * @param {Logger} log
 * @param {Float32Array | null} qvec
 * @param {string} query
 * @returns {Promise<{ retrieved: Array<{ p: string, text: string, score: number }>, sources: Record<string, any>, mode: string }>}
 */
async function retrieveOwasp(env, log, qvec, query) {
  const empty = { retrieved: [], sources: {}, mode: "none" };
  try {
    const corpus = await loadOwaspCorpus(env, log);
    if (!corpus) return empty;
    // Dense path: rank the whole index, then cap per category for breadth.
    if (qvec) {
      const index = await loadOwaspRag(env, log);
      if (index) {
        const all = retrieveSourceChunks(index, corpus.snapshot, qvec, index.vectors.length);
        const retrieved = diversifyByCategory(all, OWASP_RETRIEVE_K, OWASP_PER_CATEGORY);
        if (retrieved.length) return { retrieved, sources: corpus.sources, mode: "dense" };
      }
    }
    // Offline fallback: lexical TF-IDF over the corpus, no embedder needed.
    const retrieved = lexicalRetrieveCorpus(corpus.snapshot, query, { k: OWASP_RETRIEVE_K, perCat: OWASP_PER_CATEGORY });
    return { retrieved, sources: corpus.sources, mode: retrieved.length ? "lexical" : "none" };
  } catch (/** @type {any} */ err) {
    log.warn("introspect.owasp_retrieve_failed", { error: err?.message || String(err) });
    return empty;
  }
}

/**
 * The enrichment runner (registered in src/enrichment.js; enabled =
 * state.introspection = developer mode on). Always injects the source in dev
 * mode — retrieval finds the relevant code for the question, plus orientation.
 * @param {Env} env
 * @param {Logger} log
 * @param {(id: string, label: string) => void} step
 * @param {(id: string, label: string, details?: string[]) => void} stepDone
 * @param {Conversation} conversation
 * @param {RequestState} state
 * @returns {Promise<Conversation>}
 */
export async function runIntrospectionEnrichment(env, log, step, stepDone, conversation, state) {
  const texts = userTexts(conversation);
  if (!texts.length) return conversation;
  const latestText = texts[texts.length - 1] || "";

  step("introspect", "Reading the site's own source…");
  const snapshot = await loadSourceSnapshot(env, log);
  if (!snapshot) {
    stepDone("introspect", "Source snapshot unavailable — continuing without it");
    return conversation;
  }
  // Stash the loaded snapshot so the pipeline's source-research phase can READ
  // files from it (the agentic read loop) without a second ASSETS fetch. The
  // enrichment still injects retrieved excerpts + orientation below; the read
  // loop uses this to go deeper into whichever files the model actually needs.
  /** @type {any} */ (state).sourceSnapshot = snapshot;

  // Dense retrieval for THIS question (fail-soft to []). This is the part that
  // makes the mode phrasing-agnostic. Embed the query ONCE and reuse it for
  // both the source retrieval and (for a security assessment) the OWASP one.
  const qvec = await embedQuery(env, log, latestText);
  const retrieved = await retrieveSource(env, log, qvec, snapshot);

  // The full file index is only worth its ~tokens for strong "how are you
  // built / list the files" asks; ordinary code questions ride on retrieval +
  // orientation. Named-file inlining always applies (mentionedSnapshotPaths).
  const strongIntent = introspectionActive(texts, snapshot);
  const block = buildIntrospectionBlock(snapshot, {
    latestText,
    retrieved,
    includeIndex: strongIntent,
    // The sandbox knob being on is the mount signal: with dev mode on, EVERY
    // sandbox boot mounts the tree at /src (stream.js pre-warm + provider), so
    // the pointer is truthful whether or not a shell ran this message. The
    // shell-transcript fallback covers a client that attached a transcript
    // without the server seeing the knob (defensive; costs one true line).
    sandboxMounted:
      /** @type {any} */ (state).sandboxEnabled === true ||
      (/** @type {any} */ (state).shellTranscript || []).length > 0,
  });
  state.introspectionCount = 1;
  const inlined = mentionedSnapshotPaths(latestText, snapshot).slice(0, 6);
  const topScore = retrieved.length ? retrieved[0].score : 0;

  // Same convention as the Shodan block: appended so every phase sees it.
  let convo = /** @type {Conversation} */ (withAppendedText(conversation, block));

  // HELP layer (always on in dev mode, like the source itself): the
  // documentation passages relevant to this question, quoted verbatim with
  // resolved symbol references — the first layer of the one help interface; the
  // source above is the deeper level a follow-up escalates into. A help-shaped
  // ask (helpIntent, sticky over the conversation) widens the retrieval.
  // Stashed in state too: the native-tool source-research path reads the CLEAN
  // pre-enrichment conversation, so it injects state.helpBlock explicitly
  // (the owaspBlock pattern); every other phase rides the appended copy.
  const helpAsk = texts.some((t) => helpIntent(t));
  const { retrieved: helpDocs, meta: docsMeta, mode: helpMode } = await retrieveHelpDocs(env, log, qvec, latestText, helpAsk);
  const helpBlock = buildHelpDocsBlock(helpDocs, {
    sources: docsMeta.sources,
    symbols: docsMeta.symbols,
    repo: docsMeta.repo,
    helpAsk,
  });
  if (helpBlock) {
    /** @type {any} */ (state).helpBlock = helpBlock;
    convo = /** @type {Conversation} */ (withAppendedText(convo, helpBlock));
  }

  // Security assessment: ALSO inject the OWASP Top 10 reference block (the
  // retrieved OWASP paragraphs) so findings are classified against — and quote —
  // the actual OWASP text. Sticky like the mode itself (any user message in the
  // conversation asking for an assessment engages it). Stashed in state as well:
  // the native-tool source-research path (src/pipeline.js runSourceResearchTools)
  // reads the CLEAN pre-enrichment conversation, so it injects state.owaspBlock
  // explicitly; the deterministic read-loop synthesis rides the appended copy.
  /** @type {Array<{ p: string, text: string, score: number }>} */
  let owaspRetrieved = [];
  let owaspMode = "none";
  if (texts.some((t) => securityAssessmentIntent(t))) {
    const { retrieved: hits, sources, mode } = await retrieveOwasp(env, log, qvec, latestText);
    owaspMode = mode;
    const owaspBlock = buildOwaspReferenceBlock(hits, sources);
    if (owaspBlock) {
      owaspRetrieved = hits;
      /** @type {any} */ (state).owaspBlock = owaspBlock;
      convo = /** @type {Conversation} */ (withAppendedText(convo, owaspBlock));
    }
  }
  const owaspCats = owaspRetrieved.map((r) => r.p.split(" ")[0]);

  stepDone(
    "introspect",
    retrieved.length
      ? `Introspection: ${retrieved.length} relevant source excerpt${retrieved.length === 1 ? "" : "s"} + orientation`
      : `Introspection: source in context (${snapshot.count} files)`,
    [
      `top matches: ${retrieved.map((r) => r.p).slice(0, 4).join(", ") || "(orientation only)"}`,
      ...(inlined.length ? [`inlined: ${inlined.join(", ")}`] : []),
      ...(helpDocs.length
        ? [`documentation${helpAsk ? " (help)" : ""}: ${[...new Set(helpDocs.map((r) => r.p))].slice(0, 4).join(", ")}`]
        : []),
      ...(owaspCats.length ? [`OWASP Top 10 reference: ${[...new Set(owaspCats)].join(", ")}`] : []),
    ],
  );

  log.info("introspect.applied", {
    files: snapshot.count,
    retrieved: retrieved.length,
    top_score: Number(topScore.toFixed(3)),
    top_files: retrieved.map((r) => r.p).slice(0, 6),
    inlined: inlined.length,
    include_index: strongIntent,
    block_chars: block.length,
    help_ask: helpAsk,
    help_docs: helpDocs.length,
    help_mode: helpMode,
    help_top: [...new Set(helpDocs.map((r) => r.p))].slice(0, 4),
    owasp: owaspRetrieved.length,
    owasp_mode: owaspMode,
    owasp_cats: [...new Set(owaspCats)].slice(0, 8),
  });
  return convo;
}

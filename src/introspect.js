// @ts-check
// The introspection enrichment: whenever the caller's chat mode carries the
// source (chat-mode-core.js modeCarriesSource — every non-normal mode), this
// appends the site's OWN source to the
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
// enrichment only RUNS in a source-carrying mode (registry gate in
// enrichment.js), so "always inject" here means "always inject in those modes".
//
// The OWASP Top 10 reference block used to be retrieved HERE, as a branch at
// the end of this runner. It moved to src/owasp-context.js on 2026-08-13 and is
// now its own registry row, gated on the agent's declared `owasp` context block
// rather than on this mode: the Cyber agent runs the plain research phase and
// must be able to reach the standard without paying for a multi-megabyte source
// snapshot it has no use for. Nothing about the behaviour of a source-carrying
// mode changed — `introspection` declares `owasp` too, so a security assessment
// of THIS platform still gets both blocks, and this runner still stashes the
// query embed the OWASP row reuses so the turn pays for one embedding call.

import {
  DOCS_CORPUS_PATH,
  DOCS_RAG_PATH,
  RAG_PATH,
  SNAPSHOT_PATH,
  buildHelpDocsBlock,
  buildIntrospectionBlock,
  diversifyByCategory,
  docsCorpusMeta,
  helpIntent,
  introspectionActive,
  lexicalRetrieveCorpus,
  mentionedSnapshotPaths,
  retrievalQuery,
  retrieveSourceChunks,
  validateRagIndex,
  validateSnapshot,
} from "../public/js/introspect-core.js";
import { embedTexts } from "./berget.js";
import { textOf, withAppendedText } from "./conversation.js";

const QUERY_PREFIX = "query: "; // e5 asymmetric prefix — mirrors src/rag.js
const RETRIEVE_K = 6;
// Documentation passages retrieved for the HELP layer (always on in a source mode —
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
 * Embed the query once (e5 asymmetric query prefix). The vector is stashed on
 * the request state by the runner below, so the OWASP row that runs after this
 * one (src/owasp-context.js) reuses it instead of embedding the same text
 * again. Null (never a throw) on empty input or any failure — retrieval then
 * degrades to [].
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
 * Source-grounded context for ONE standalone query — the Orchestrator mode's
 * introspection sub-agents (src/orchestrator.js) use this to give a node its
 * own retrieved-excerpt block without re-running the whole conversation
 * enrichment. Composes the same embed + retrieve + block pipeline the
 * enrichment uses. Null (never a throw) when no snapshot is available — the
 * caller degrades the node rather than failing the request.
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query the sub-agent's task
 * @param {Snapshot | null} [snapshot] an already-loaded snapshot (state.sourceSnapshot), else fetched here
 * @returns {Promise<string | null>}
 */
export async function retrieveSourceBlockFor(env, log, query, snapshot = null) {
  const snap = snapshot || (await loadSourceSnapshot(env, log));
  if (!snap) return null;
  const qvec = await embedQuery(env, log, query);
  const retrieved = await retrieveSource(env, log, qvec, snap);
  return buildIntrospectionBlock(snap, { latestText: query, retrieved, includeIndex: false });
}

/**
 * The enrichment runner (registered in src/enrichment.js; enabled =
 * state.introspection = a source-carrying mode). Always injects the source in that
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
  // What to RETRIEVE for. Usually the latest message, but a bare back-reference
  // ("try again", "gör om det") names no subject, so it resolves to the
  // question it points back at — otherwise the excerpts describe nothing and
  // the answer is built on them anyway (feedback #45). Named-file inlining and
  // the block's own latestText stay on the literal message: a retry must not
  // re-inline files the earlier turn happened to name.
  const queryText = retrievalQuery(texts);

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
  // makes the mode phrasing-agnostic. The query is embedded ONCE and the vector
  // stashed with the text it was computed for: the source retrieval, the help
  // retrieval and — since the split of 2026-08-13 — the OWASP row that runs
  // after this one all reuse it, so a security assessment in a source-carrying
  // mode still pays for exactly one embedding call. The stash is keyed by the
  // query text so a reader that retrieves for something else falls through to
  // its own embed rather than silently ranking against the wrong vector.
  const qvec = await embedQuery(env, log, queryText);
  // THE TURN'S RETRIEVAL CONTEXT, stashed for the enrichments that retrieve
  // after this one (today: src/owasp-context.js). It carries the user texts and
  // the query as this runner SAW them — before any block was appended — and the
  // vector they were embedded into.
  //
  // Both halves matter, and the second one is the subtle half. Every enrichment
  // appends to the last user message, so a runner that recomputes its own query
  // from the conversation it is handed reads the PREVIOUS runner's block as
  // part of the user's question: retrieval would rank against a source excerpt,
  // and an intent gate would fire on vocabulary the site injected rather than
  // on anything the user typed (`securityAssessmentIntent` matches a bare
  // "owasp", which the injected source can easily contain). Whichever
  // retrieval-using enrichment runs FIRST therefore owns the turn's query, and
  // the rest read it from here.
  try {
    const s = /** @type {any} */ (state);
    if (!s.retrieval) s.retrieval = { texts, query: queryText, qvec };
  } catch {
    // A frozen state costs one extra embedding call downstream, nothing else.
  }
  const retrieved = await retrieveSource(env, log, qvec, snapshot);

  // The full file index is only worth its ~tokens for strong "how are you
  // built / list the files" asks; ordinary code questions ride on retrieval +
  // orientation. Named-file inlining always applies (mentionedSnapshotPaths).
  const strongIntent = introspectionActive(texts, snapshot);
  const block = buildIntrospectionBlock(snapshot, {
    latestText,
    retrieved,
    includeIndex: strongIntent,
    // The sandbox knob being on is the mount signal: in a source mode, EVERY
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

  // HELP layer (always on in a source mode, like the source itself): the
  // documentation passages relevant to this question, quoted verbatim with
  // resolved symbol references — the first layer of the one help interface; the
  // source above is the deeper level a follow-up escalates into. A help-shaped
  // ask (helpIntent, sticky over the conversation) widens the retrieval.
  // Stashed in state too: the native-tool source-research path reads the CLEAN
  // pre-enrichment conversation, so it injects state.helpBlock explicitly
  // (the owaspBlock pattern); every other phase rides the appended copy.
  const helpAsk = texts.some((t) => helpIntent(t));
  const { retrieved: helpDocs, meta: docsMeta, mode: helpMode } = await retrieveHelpDocs(env, log, qvec, queryText, helpAsk);
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

  // The OWASP Top 10 reference block is NOT built here any more: it is its own
  // registry row (src/owasp-context.js), gated on the agent's declared `owasp`
  // context block and running immediately after this one, so a security
  // assessment in a source-carrying mode still lands both blocks on the same
  // message in the same order it always did.

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
  });
  return convo;
}

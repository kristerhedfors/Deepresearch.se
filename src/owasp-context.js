// @ts-check
// THE OWASP REFERENCE CONTEXT — the retrieved OWASP Top 10 paragraphs a
// security-assessment turn is grounded in.
//
// ---- why this is its own module (2026-08-13) --------------------------------
//
// It used to live INSIDE runIntrospectionEnrichment (src/introspect.js), as a
// branch at the end of the source injection. That put the OWASP corpus behind
// `state.introspection` — `modeCarriesSource(chatMode)` — so five modes reached
// it as a side effect of carrying the source snapshot, and exactly one agent
// (`introspection`) DECLARED it. The declaration and the reach had nothing to
// do with each other.
//
// The owner directive of 2026-08-13 gives everything cybersecurity and OSINT to
// the new `cyber` agent, and that agent runs the plain `research` answer phase:
// it does NOT carry the source snapshot. Reaching OWASP through the
// introspection enrichment would have meant loading a multi-megabyte snapshot
// of this repository to get at twenty pages of a public web standard. So the
// retrieval moved out to its own registry row, gated on the resolved agent's
// DECLARED context block (`owasp`) rather than on a mode flag — the same seam
// the ancient-sample corpus and the Scholar metrics leg already use.
//
// Two agents declare `owasp` today and both are right: `cyber` (a security
// assessment of somebody else's system) and `introspection` (a security
// assessment OF THIS PLATFORM, which is what introspection is for). The overlap
// is deliberate; what is gone is the five modes that got it by accident.
//
// ---- what is NOT here -------------------------------------------------------
//
// The corpus itself, its build (scripts/fetch-owasp.mjs), its dense index
// (scripts/bundle-owasp-rag.mjs) and its public serving (src/assets.js) are all
// capability-NEUTRAL and stayed exactly where they were: they are a committed
// artifact of this deployment, like the source snapshot. Se/cure has its own
// client-side path (public/cure/drc.js owaspBlockFor) which is unchanged and
// UNGATED — there is no capability object in that tier at all, because there is
// no server to resolve an agent registry against. That asymmetry is expected,
// not an oversight: Se/cure's whole posture is that the browser decides.
//
// ---- the contract (src/enrichment.js) ---------------------------------------
//
// Fail-soft in every branch (invariant 2). A missing corpus, a missing index, a
// dead embedder, a malformed conversation — every one of them degrades to the
// conversation unchanged and no block, never an error. The security-assessment
// DEFAULT in the answer prompt (src/prompts.js OWASP_ASSESSMENT_NOTE) is gated
// on the same capability, so an agent that cannot retrieve the corpus is not
// told to organise its findings around text it will never see.

import {
  OWASP_CORPUS_PATH,
  OWASP_RAG_PATH,
  buildOwaspReferenceBlock,
  diversifyByCategory,
  lexicalRetrieveCorpus,
  retrievalQuery,
  retrieveSourceChunks,
  securityAssessmentIntent,
  validateRagIndex,
  validateSnapshot,
} from "../public/js/introspect-core.js";
import { embedTexts } from "./berget.js";
import { textOf, withAppendedText } from "./conversation.js";

/** The enrichment/step/log slug, and the CONTEXT_BLOCKS id it is gated on. */
export const OWASP_CONTEXT_ID = "owasp";

// OWASP paragraphs retrieved for a security assessment. Wider than the source
// retrieval's K and capped per category (diversifyByCategory) so the block
// spans SEVERAL vulnerabilities the model can quote, not the single closest one.
const OWASP_RETRIEVE_K = 8;
const OWASP_PER_CATEGORY = 2;

const QUERY_PREFIX = "query: "; // e5 asymmetric prefix — mirrors src/rag.js

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */
/** @typedef {import('../public/js/introspect-core.js').Snapshot} Snapshot */

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
      log.warn("owasp.corpus_missing", { status: res.status });
      return null;
    }
    const raw = await res.json();
    const snapshot = validateSnapshot(raw);
    if (!snapshot) {
      log.warn("owasp.corpus_invalid", {});
      return null;
    }
    const sources = raw && typeof raw.sources === "object" && !Array.isArray(raw.sources) ? raw.sources : {};
    return { snapshot, sources };
  } catch (/** @type {any} */ err) {
    log.warn("owasp.corpus_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Fetch + validate the committed OWASP RAG index through the ASSETS binding.
 * Null (never a throw) on any failure — retrieval degrades to the lexical path.
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
      log.warn("owasp.rag_missing", { status: res.status });
      return null;
    }
    const index = validateRagIndex(await res.json());
    if (!index) log.warn("owasp.rag_invalid", {});
    return index;
  } catch (/** @type {any} */ err) {
    log.warn("owasp.rag_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Retrieve the OWASP paragraphs relevant to a security-assessment query, spread
 * across SEVERAL categories (diversifyByCategory). Prefers dense retrieval (the
 * committed e5 index) when the query embed is available; falls back to the
 * embedding-FREE lexical path over the corpus when it isn't — so the OWASP
 * grounding works even with no embedder (the same path Se/cure uses). Returns
 * the chunks plus the per-doc citation metadata, or empty on any failure.
 * `mode` reports which path ran, for observability.
 * @param {Env} env
 * @param {Logger} log
 * @param {Float32Array | null} qvec
 * @param {string} query
 * @returns {Promise<{ retrieved: Array<{ p: string, text: string, score: number }>, sources: Record<string, any>, mode: string }>}
 */
export async function retrieveOwasp(env, log, qvec, query) {
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
    log.warn("owasp.retrieve_failed", { error: err?.message || String(err) });
    return empty;
  }
}

/**
 * Embed the query (e5 asymmetric prefix). Null (never a throw) on empty input
 * or any failure; retrieval then takes the lexical path, which needs no
 * embedder at all.
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
    log.warn("owasp.embed_failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Every user message's text, oldest first. The ask is STICKY over the
 * conversation the way the mode used to be: one message asking for an
 * assessment keeps the reference in context for the follow-ups that discuss it.
 * @param {Conversation} conversation
 * @returns {string[]}
 */
function userTexts(conversation) {
  return conversation.filter((m) => m.role === "user").map((m) => textOf(m.content));
}

/**
 * THE TURN'S RETRIEVAL CONTEXT — the user texts, the query derived from them,
 * and the vector it was embedded into, computed ONCE per request by whichever
 * retrieval-using enrichment runs first (src/introspect.js when a mode carries
 * the source; this runner otherwise).
 *
 * This exists because every enrichment appends its block to the last user
 * message. A runner that recomputes its own query from the conversation it is
 * handed therefore reads the PREVIOUS runner's block as part of the user's
 * question — which here would be doubly wrong: the retrieval would rank OWASP
 * paragraphs against an excerpt of this repository's own source, and the
 * security-assessment gate would fire on a bare "owasp" the source injected
 * rather than on anything the user typed.
 *
 * Fail-soft in both directions: no stash (this row ran first, or a frozen
 * state) means compute it here, which is exactly the behaviour before the stash
 * existed; a stash that is present is trusted only for the fields it actually
 * carries.
 * @param {any} state
 * @param {Conversation} conversation
 * @returns {{ texts: string[], query: string, qvec: Float32Array | null }}
 */
function retrievalContext(state, conversation) {
  const stash = /** @type {any} */ (state)?.retrieval;
  const texts = Array.isArray(stash?.texts) && stash.texts.length ? stash.texts : userTexts(conversation);
  const query = typeof stash?.query === "string" && stash.query ? stash.query : retrievalQuery(texts);
  const qvec = stash?.qvec && stash.query === query ? stash.qvec : null;
  return { texts, query, qvec };
}

/**
 * The enrichment runner (registered in src/enrichment.js; enabled =
 * capHasContext(state.capability, "owasp")). Silent — no step, no state, no
 * conversation change — on every turn that is not a security assessment, which
 * is almost all of them even inside an agent that declares the block.
 *
 * `state.owaspBlock` is still set, and that is a contract rather than a detail:
 * src/pipeline.js's native-tool source-research path reads the CLEAN
 * pre-enrichment conversation and injects the block explicitly, so it has to
 * find it there.
 *
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runOwaspContextEnrichment(c) {
  const conversation = /** @type {any} */ (c?.conversation);
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return /** @type {any} */ (conversation || []);
  }

  // The texts and the query come from the turn's retrieval context (above), not
  // from a fresh read of the conversation this runner was handed — see its
  // header for why that distinction is load-bearing. `query` carries the same
  // back-reference resolution the source retrieval uses: a bare "try again"
  // names no subject, so it retrieves for the question it points back at.
  /** @type {{ texts: string[], query: string, qvec: Float32Array | null }} */
  let ctx;
  try {
    ctx = retrievalContext(c.state, conversation);
  } catch {
    return conversation;
  }
  if (!ctx.texts.length) return conversation;
  if (!ctx.texts.some((t) => securityAssessmentIntent(t))) return conversation;

  const env = /** @type {any} */ (c.env) || {};
  const log = c.log || { info() {}, warn() {}, error() {}, debug() {} };
  const queryText = ctx.query;

  c.step?.(OWASP_CONTEXT_ID, "Retrieving the OWASP Top 10 reference…");

  const qvec = ctx.qvec || (await embedQuery(env, log, queryText));
  // Stash it for anything that retrieves after this row — on a Cyber turn there
  // is no source enrichment ahead of it, so this row is the one that owns the
  // turn's query.
  try {
    const s = /** @type {any} */ (c.state);
    if (s && !s.retrieval) s.retrieval = { texts: ctx.texts, query: queryText, qvec };
  } catch { /* a frozen state costs one extra embed downstream, nothing else */ }

  const { retrieved, sources, mode } = await retrieveOwasp(env, log, qvec, queryText);
  const block = buildOwaspReferenceBlock(retrieved, sources);
  const cats = [...new Set(retrieved.map((r) => String(r.p).split(" ")[0]))];

  if (!block) {
    // An honest empty step rather than a silent one: the ask DID engage the
    // capability, the corpus simply was not there. Same shape as the source
    // snapshot's "unavailable — continuing without it".
    c.stepDone?.(OWASP_CONTEXT_ID, "OWASP reference unavailable — continuing without it");
    log.info?.(OWASP_CONTEXT_ID + ".applied", { owasp: 0, owasp_mode: mode, owasp_cats: [] });
    return conversation;
  }

  try {
    /** @type {any} */ (c.state).owaspBlock = block;
  } catch {
    // A frozen state still gets the appended copy; only the tool path's
    // explicit injection is lost, which costs relevance and nothing else.
  }

  c.stepDone?.(OWASP_CONTEXT_ID, `OWASP Top 10 reference: ${retrieved.length} passage${retrieved.length === 1 ? "" : "s"}`, [
    `OWASP Top 10 reference: ${cats.join(", ")}`,
  ]);
  log.info?.(OWASP_CONTEXT_ID + ".applied", {
    owasp: retrieved.length,
    owasp_mode: mode,
    owasp_cats: cats.slice(0, 8),
    block_chars: block.length,
  });

  return /** @type {Conversation} */ (withAppendedText(conversation, block));
}

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
  RAG_PATH,
  SNAPSHOT_PATH,
  buildIntrospectionBlock,
  introspectionActive,
  mentionedSnapshotPaths,
  retrieveSourceChunks,
  validateRagIndex,
  validateSnapshot,
} from "../public/js/introspect-core.js";
import { embedTexts } from "./berget.js";
import { textOf, withAppendedText } from "./conversation.js";

const QUERY_PREFIX = "query: "; // e5 asymmetric prefix — mirrors src/rag.js
const RETRIEVE_K = 6;

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
 * Embed the query and cosine-rank the source-RAG index. Returns the top-k
 * chunks (text resolved from the CURRENT snapshot) or [] on any failure —
 * the caller still injects the orientation block, so retrieval failing only
 * costs relevance, never the mode.
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query
 * @param {Snapshot} snapshot
 * @returns {Promise<Array<{ p: string, text: string, score: number }>>}
 */
async function retrieveForQuery(env, log, query, snapshot) {
  try {
    if (!query.trim()) return [];
    const index = await loadSourceRag(env, log);
    if (!index) return [];
    const { vectors } = await embedTexts(env, [QUERY_PREFIX + query.slice(0, 2000)]);
    const qvec = vectors && vectors[0];
    if (!qvec || !qvec.length) return [];
    return retrieveSourceChunks(index, snapshot, qvec, RETRIEVE_K);
  } catch (/** @type {any} */ err) {
    log.warn("introspect.retrieve_failed", { error: err?.message || String(err) });
    return [];
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
  // makes the mode phrasing-agnostic.
  const retrieved = await retrieveForQuery(env, log, latestText, snapshot);

  // The full file index is only worth its ~tokens for strong "how are you
  // built / list the files" asks; ordinary code questions ride on retrieval +
  // orientation. Named-file inlining always applies (mentionedSnapshotPaths).
  const strongIntent = introspectionActive(texts, snapshot);
  const block = buildIntrospectionBlock(snapshot, {
    latestText,
    retrieved,
    includeIndex: strongIntent,
    // A shell transcript means the client ran the sandbox loop this message —
    // with dev mode on its provider mounts the tree at /src (stream.js).
    sandboxMounted: (/** @type {any} */ (state).shellTranscript || []).length > 0,
  });
  state.introspectionCount = 1;
  const inlined = mentionedSnapshotPaths(latestText, snapshot).slice(0, 6);
  const topScore = retrieved.length ? retrieved[0].score : 0;
  stepDone(
    "introspect",
    retrieved.length
      ? `Introspection: ${retrieved.length} relevant source excerpt${retrieved.length === 1 ? "" : "s"} + orientation`
      : `Introspection: source in context (${snapshot.count} files)`,
    [
      `top matches: ${retrieved.map((r) => r.p).slice(0, 4).join(", ") || "(orientation only)"}`,
      ...(inlined.length ? [`inlined: ${inlined.join(", ")}`] : []),
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
  });
  // Same convention as the Shodan block: appended so every phase sees it.
  return /** @type {Conversation} */ (withAppendedText(conversation, block));
}

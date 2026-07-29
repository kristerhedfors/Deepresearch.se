// @ts-check
// THE ANCIENT-SAMPLE ENRICHMENT — the Worker façade over public/js/aadr-core.js
// and the structured half of the palaeogenomics agent.
//
// It does three things and nothing else: load the committed sample artifact
// through the ASSETS binding, cache it for the isolate, and — when the latest
// message asks a sample question — fold the query result into the conversation
// as a labeled context block before any model call.
//
// ---- why this is an ENRICHMENT and not a search source ----------------------
//
// The other half of this work (src/europepmc.js) is a search source, because it
// produces CITABLE URLS: every hit is a paper with a DOI a reader can open.
// This half produces neither. A row is an individual in a published dataset —
// `vbj004.SG`, Gotland, 2738 BCE, 14.45× coverage — and the honest citation for
// it is the dataset plus the study key, not a URL. Registering it as a search
// source would mean minting a plausible-looking link per row, and the whole
// point of answering from a table is that nothing is invented. So it enters the
// turn the way introspection's source snapshot and the Models agent's catalog
// do: as context, through src/enrichment.js.
//
// ---- how it is switched on: by the AGENT SPEC, not by a knob ----------------
//
// The enrichment is enabled when the resolved agent's capability declares the
// `ancient-samples` context block (public/js/agent-spec-core.js CONTEXT_BLOCKS,
// read through capHasContext). That is deliberate and is what keeps this
// feature OUT of the platform's other surfaces: there is no chat mode, no
// settings toggle, no request flag and no CSS. An agent that does not declare
// the block cannot reach this code, and deleting the agent from
// sdk/AGENTS.json removes the whole capability without touching a line of the
// pipeline.
//
// ---- Se/rver only, and honestly so -----------------------------------------
//
// The artifact is served from this deployment and read through this Worker's
// ASSETS binding, so the query runs on the server. That is admissible on
// Se/rver, where the server is inside the trust boundary (owner directive,
// 2026-07-24). It is not a Se/cure feature and does not pretend to be — the
// block is marked serverOnly in the capability vocabulary, which is what stops
// a client-tier agent from declaring it (invariant 4's rule, enforced by
// validateCapability rather than by convention).
//
// What it does NOT do, on either tier: reach a third party. There is no
// outbound request in this module at all. A structured sample query — including
// its geography, which would otherwise be a geocoder call — is answered
// entirely from the deployment's own bytes, so no upstream learns the shape of
// anyone's research. That is the same property the arXiv RAG tier was built for
// (src/arxiv-rag.js) and the reason the corpus is a build artifact rather than
// a live API call (scripts/aadr-build.mjs).

import {
  BLOCK_ROWS,
  SAMPLES_PATH,
  ancientSampleIntent,
  parseSampleQuery,
  parseSamples,
  querySamples,
  sampleBlock,
} from "../public/js/aadr-core.js";
// The last-user-text reading and the multipart-safe block append are shared
// with the other pre-pipeline enrichments (src/conversation.js).
import { appendToLast, lastUserText } from "./conversation.js";

export {
  SAMPLES_PATH,
  ancientSampleIntent,
  ancientSampleLeadIntent,
  parseSampleQuery,
  parseSamples,
  querySamples,
  sampleBlock,
} from "../public/js/aadr-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

// Keyed on the ASSETS BINDING rather than held in a bare module variable, for
// the reason src/agent-registry.js documents: a Worker isolate has exactly one
// binding, so this is still "parse once per isolate", but a caller with a
// different binding can never be served another environment's corpus.
/** @type {WeakMap<object, any>} */
const cache = new WeakMap();

/**
 * The parsed sample corpus, or null — never a throw — when the artifact is
 * missing, unreadable or built at a layout this deploy's core does not know
 * (invariant 2). A successful parse is cached; a failure is NOT, so a transient
 * asset error retries on the next request rather than poisoning the isolate.
 * @param {Env} env
 * @returns {Promise<import('../public/js/aadr-core.js').SampleDataset | null>}
 */
export async function loadSamples(env) {
  const assets = /** @type {any} */ (env)?.ASSETS;
  if (!assets?.fetch) return null;
  if (cache.has(assets)) return cache.get(assets);
  try {
    const res = await assets.fetch(new Request("https://assets.internal" + SAMPLES_PATH));
    if (!res.ok) return null;
    const parsed = parseSamples(await res.json());
    if (parsed) cache.set(assets, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The enrichment runner (src/enrichment.js). Silent — no step, no event, no
 * conversation change — on every turn whose message is not a sample question,
 * which is most of them even inside this agent: "how does aDNA degrade" is a
 * literature question and belongs to the Europe PMC leg.
 *
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runAncientSampleEnrichment(c) {
  const { env, log, state, conversation } = c;
  const asked = lastUserText(conversation);
  if (!ancientSampleIntent(asked)) return conversation;

  c.step("aadr", "Querying the ancient-sample database…");
  const d = await loadSamples(env);
  if (!d) {
    // Fail soft and VISIBLY: the step already told the user a lookup was
    // starting, so silence here would read as a result rather than an outage.
    c.stepDone("aadr", "The ancient-sample database is unavailable");
    log?.warn?.("aadr.unavailable", {});
    return conversation;
  }

  const query = parseSampleQuery(d, asked);
  const res = querySamples(d, query, { limit: BLOCK_ROWS });

  // The counters a chat_logs reader needs to tell "the query was wrong" from
  // "the corpus has nothing" — the two failures that look identical in an
  // answer and are fixed in completely different places.
  /** @type {any} */ (state).aadr = {
    matched: res.total,
    shown: res.rows.length,
    filters: query.notes.length,
    geo: !!query.near,
    dated: !!query.when,
    haplo: !!(query.haplo.y || query.haplo.mt || query.haplo.either),
    ignored_skipped: res.ignoredSkipped,
  };

  const details = [];
  if (query.notes.length) details.push(query.notes.join("; "));
  if (res.ignoredSkipped) details.push(`${res.ignoredSkipped} Ignore_-flagged individuals excluded`);
  c.stepDone(
    "aadr",
    res.total
      ? `${res.total} individual${res.total === 1 ? "" : "s"} of ${d.n}`
      : `No match among ${d.n} individuals`,
    details,
  );
  log?.info?.("aadr.query", {
    matched: res.total,
    corpus: d.n,
    filters: query.notes.length,
    // The FILTER SHAPE, never the question: a chat_logs reader debugging a bad
    // answer needs to know a radius was applied, not what was asked.
    shape: [query.near && "geo", query.when && "date", query.group && "group",
      (query.haplo.y || query.haplo.mt || query.haplo.either) && "haplo",
      query.minCoverage !== null && "coverage", query.sex && "sex"].filter(Boolean).join("+") || "none",
  });

  // A block is appended even for zero matches, and that is the point: it says
  // NO ROWS MATCHED in words, which is what stops the answer reaching for
  // remembered sample ids instead.
  const block = sampleBlock(d, query, res);
  return [...conversation.slice(0, -1), appendToLast(conversation[conversation.length - 1], block)];
}

// @ts-check
// The pre-pipeline enrichment RUNNER — core, and deliberately ignorant of
// which services exist.
//
// An enrichment resolves something the latest message NAMES (a host/IP, a
// street address, an attached photo's GPS, a path in this site's own source)
// into a labeled context block appended to the conversation before any model
// call — so triage, search, and synthesis all see the data. This module owns
// the CONTRACT and the ordering, nothing else: every runner is silent (no
// step, no conversation change) when the message names nothing to look up,
// emits a visible activity step naming the service when it does, and is
// fail-soft in every branch — the conversation comes back unchanged rather
// than ever blocking a chat.
//
// The third-party example integrations (Google Maps, Shodan) are NOT named
// here. They register themselves in src/extensions.js and arrive through
// extensionEnrichments(); this file could not tell you which ones exist, and
// with an empty registry the pipeline behaves exactly as it does today with
// every knob off. What stays in CORE_ENRICHMENTS below is the site's own
// capability — introspection reads THIS repo's committed source snapshot, so
// there is no third party, no secret, and no external connection involved.

import { extensionEnrichments } from "./extensions.js";
import { runIntrospectionEnrichment } from "./introspect.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').RequestState} RequestState */

/**
 * The bundle handed to each enrichment's `run` — the same emit/step
 * helpers pipeline.js's ctx carries, before that ctx exists.
 * @typedef {{
 *   env: Env,
 *   log: Logger,
 *   emit: (event: object) => void,
 *   step: (id: string, label: string) => void,
 *   stepDone: (id: string, label: string, details?: string[]) => void,
 *   conversation: Conversation,
 *   state: RequestState,
 * }} EnrichmentCtx
 */

/**
 * One registry entry: `id` is the log/step slug, `enabled` the per-request
 * gate (a knob resolved in chat.js, or an extension's own slice of
 * `state.ext`), and `run` returns the (possibly augmented) conversation.
 * @typedef {{
 *   id: string,
 *   enabled: (state: RequestState) => boolean,
 *   run: (ctx: EnrichmentCtx) => Promise<Conversation>,
 * }} Enrichment
 */

// Core enrichments: the ones that reach nothing outside this deployment.
/** @type {Enrichment[]} */
const CORE_ENRICHMENTS = [
  {
    // Introspection (developer mode): a conversation asking about THIS
    // SITE's own implementation gets the deployed source snapshot appended
    // as context (src/introspect.js). Silent unless the conversation
    // engages the mode (EN+SV gate / a named repo path — introspect-core.js).
    id: "introspect",
    enabled: (state) => !!state.introspection,
    run: (c) => runIntrospectionEnrichment(c.env, c.log, c.step, c.stepDone, c.conversation, c.state),
  },
];

// The effective registry — the pre-pipeline counterpart of the search-source
// registry (src/search-sources.js), and for the same parallel-work reason:
// pipeline.js calls runEnrichments() once and never names an individual
// enrichment. Order matters and is deliberate: each runner sees the
// conversation as left by the previous one, and the extensions run BEFORE
// the core ones so an appended source snapshot is the last thing added.
/** @type {Enrichment[]} */
const ENRICHMENTS = [...extensionEnrichments(), ...CORE_ENRICHMENTS];

// Runs every enabled enrichment in registry order. A throwing runner is
// contained here (the conversation passes through unchanged) so a buggy
// enrichment — and an extension above all — can never take down the chat;
// same fail-soft rule its internals already follow.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {EnrichmentCtx['emit']} emit
 * @param {EnrichmentCtx['step']} step
 * @param {EnrichmentCtx['stepDone']} stepDone
 * @param {Conversation} conversation
 * @param {RequestState} state
 * @returns {Promise<Conversation>}
 */
export async function runEnrichments(env, log, emit, step, stepDone, conversation, state) {
  let convo = conversation;
  for (const e of ENRICHMENTS) {
    if (!e.enabled(state)) continue;
    try {
      convo = await e.run({ env, log, emit, step, stepDone, conversation: convo, state });
    } catch (/** @type {any} */ err) {
      log.warn(`${e.id}.enrichment_failed`, { error: err?.message || String(err) });
    }
  }
  return convo;
}

// @ts-check
// Pre-pipeline context enrichments: the opt-in Shodan and Google Maps
// phases that resolve things the latest message NAMES (a host/IP, a street
// address, an attached photo's GPS) into labeled context blocks appended to
// the conversation before any model call — so triage, search, and synthesis
// all see the data. Extracted from pipeline.js so the phase orchestrator
// stays about the research flow itself; both enrichments follow the same
// contract: silent (no step, no conversation change) when the message names
// nothing to look up, a visible activity step naming the external service
// when it does, and fail-soft in every branch — the conversation comes back
// unchanged rather than ever blocking a chat. The Google Maps runners
// live in src/maps-enrichment.js (split 2026-07-09 with the maps
// subsystem refactor); this module owns the registry and Shodan.

import { lastUserMessage, textOf, withAppendedText } from "./conversation.js";
import { runIntrospectionEnrichment } from "./introspect.js";
import { runGoogleMapsEnrichment } from "./maps-enrichment.js";
import { extractTargets, runShodanLookup } from "./shodan.js";

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
 * One registry entry: `id` is the log/step slug, `enabled` the per-user
 * knob gate (resolved onto the state in chat.js), and `run` returns the
 * (possibly augmented) conversation.
 * @typedef {{
 *   id: string,
 *   enabled: (state: RequestState) => boolean,
 *   run: (ctx: EnrichmentCtx) => Promise<Conversation>,
 * }} Enrichment
 */

// The enrichment registry — the pre-pipeline counterpart of the
// search-source registry (src/search-sources.js), and for the same
// parallel-work reason: a new enrichment is ONE runner in this file plus
// ONE entry here; pipeline.js calls runEnrichments() once and never names
// an individual enrichment. Order matters and is deliberate: each runner
// sees the conversation as left by the previous one. Every runner must
// keep the standing contract: silent when the message names nothing to
// look up, a visible step naming the external service when it does,
// fail-soft in every branch.
/** @type {Enrichment[]} */
const ENRICHMENTS = [
  {
    id: "shodan",
    enabled: (state) => !!state.shodan,
    run: (c) => runShodanEnrichment(c.env, c.log, c.step, c.stepDone, c.conversation, c.state),
  },
  {
    id: "maps",
    enabled: (state) => !!state.googleMaps,
    // Casts: the maps runner reads its own state extension (mapView,
    // userLocation — set by chat.js when the knob is on) that this
    // enrichment-agnostic registry deliberately doesn't model, and hands
    // back conversation.js's looser Msg shape (appending blocks/images
    // can't loosen the roles the Conversation arrived with).
    run: (c) =>
      /** @type {Promise<Conversation>} */ (
        runGoogleMapsEnrichment(c.env, c.log, c.emit, c.step, c.stepDone, c.conversation,
          /** @type {import('./maps-enrichment.js').MapsState} */ (c.state))
      ),
  },
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

// Runs every knob-enabled enrichment in registry order. A throwing runner
// is contained here (the conversation passes through unchanged) so a buggy
// enrichment can never take down the chat — same fail-soft rule its
// internals already follow.
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

// Shodan enrichment: resolve any host/IP the latest message names into
// live infrastructure data and append it as a labeled context block —
// an ordinary question with the knob left on costs nothing and shows no
// spurious step. Otherwise it emits a visible activity step whose
// expandable details list each host, and returns the augmented
// conversation.
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {EnrichmentCtx['step']} step
 * @param {EnrichmentCtx['stepDone']} stepDone
 * @param {Conversation} conversation
 * @param {RequestState} state
 * @returns {Promise<Conversation>}
 */
export async function runShodanEnrichment(env, log, step, stepDone, conversation, state) {
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const { ips, hostnames } = extractTargets(lastUser);
  if (!ips.length && !hostnames.length) return conversation;

  step("shodan", "Querying Shodan…");
  let result = null;
  try {
    result = await runShodanLookup(env, log, conversation);
  } catch (/** @type {any} */ err) {
    log.warn("shodan.phase_failed", { error: err?.message || String(err) });
  }
  if (!result) {
    stepDone("shodan", "Shodan lookup unavailable — continuing without it");
    return conversation;
  }
  state.shodanCount = result.count;
  const label = result.count
    ? `Shodan: ${result.count} host${result.count === 1 ? "" : "s"} found`
    : "Shodan: no records for the host(s) named";
  stepDone("shodan", label, result.details);
  // Cast: conversation.js works on its looser local Msg shape; appending a
  // text block can't loosen the roles this Conversation arrived with.
  return /** @type {Conversation} */ (withAppendedText(conversation, result.block));
}

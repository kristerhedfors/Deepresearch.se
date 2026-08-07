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

import { runAncientSampleEnrichment } from "./aadr.js";
import { capHasContext } from "./agent-spec.js";
import { runEntityResearchEnrichment } from "./entity-research.js";
import { extensionEnrichments } from "./extensions.js";
import { runImageReadEnrichment } from "./image-read.js";
import { runIntrospectionEnrichment } from "./introspect.js";
import { runModelsAgentEnrichment } from "./models-agent.js";
import { runPersonResearchEnrichment } from "./person-research.js";
import { runScholarMetricsEnrichment } from "./scholar-metrics.js";

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
 *   stepDone: (id: string, label: string, details?: string[], extra?: Record<string, unknown>) => void,
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
    // PHASE 0 — the image read (src/image-read.js), and FIRST for a reason:
    // an attached picture is opaque to everything that reads the conversation
    // afterwards (textOf flattens it to "[N image(s) attached]"), so the
    // transcription has to exist before any other enrichment or phase looks.
    // One vision call on the ANSWER model turns the attachment into text, and
    // triage gets a name to plan against instead of "this founder"
    // (chat_logs #1305 / feedback #60).
    //
    // The gate is `state.vision` — the cheap, state-only fact that the chosen
    // answer model can receive images — and NOT "does this turn carry an
    // image", because `enabled` receives only the state and the image parts
    // live in the conversation. The runner does that check itself and is
    // silent when there is nothing to read, which the contract above
    // explicitly allows. Gating this way is also exactly right: with a
    // non-vision model there is nothing this phase could do, and validation
    // (src/validation.js) has already rejected any image-bearing request that
    // picked one.
    id: "image_read",
    enabled: (state) => !!state.vision,
    run: (c) => runImageReadEnrichment(c),
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
  {
    // The Models agent (src/models-agent.js): its mode forces hub search on for
    // the turn, and a message about choosing/pricing/evaluating/starting a
    // model gets the live CROSS-PROVIDER catalog folded in with real per-token
    // rates and real verification state. Core, not an extension: the model
    // landscape is this platform's own subject matter — which models it can
    // reach, what they cost, what has been verified — not an optional
    // third-party lookup bolted onto a message. Silent on every turn that isn't
    // about models.
    id: "models",
    enabled: (state) => !!(/** @type {any} */ (state).modelsMode),
    run: (c) => runModelsAgentEnrichment(c),
  },
  {
    // The ancient-sample corpus (src/aadr.js): a message asking a STRUCTURED
    // question about published ancient-DNA individuals — a region, a date
    // window, a haplogroup, a coverage floor — gets the query's exact rows and
    // counts folded in. Core, not an extension: the corpus is a build artifact
    // in this deployment, so there is no third party, no secret and no outbound
    // connection, exactly like the source snapshot above it.
    //
    // Gated on the resolved agent's DECLARED CONTEXT BLOCK rather than on a
    // mode flag or a knob — the first enrichment to be enabled by an agent
    // spec alone. That is what keeps this domain capability from spreading
    // into the platform: no chat mode, no settings toggle, no request field,
    // and removing the agent from sdk/AGENTS.json turns it off entirely. A
    // request that never consulted the registry has a null capability and is
    // therefore never enabled, which is every ordinary Deep Research turn.
    id: "aadr",
    enabled: (state) => capHasContext(/** @type {any} */ (state).capability, "ancient-samples"),
    run: (c) => runAncientSampleEnrichment(c),
  },
  {
    // The Google Scholar metrics leg (src/scholar-metrics.js), and the switch
    // that restricts the Deep Science agent to its peer-reviewed source. It is
    // NOT silent on an ordinary turn the way its neighbours are — it always
    // sets the turn's source restriction — but everything it can APPEND is
    // gated: a profile block only when the message carries a Scholar profile
    // link, a venue-metrics block only when the message asks where a field
    // publishes.
    //
    // Core rather than an extension, on the same footing as the model catalog
    // above: no knob, no secret, no per-user configuration. The venue table it
    // reads is a build artifact in this deployment, and the one outbound call
    // it can make goes to a page Google's robots.txt explicitly allows —
    // src/scholar.js's header documents the whole posture.
    //
    // Gated on the resolved agent's declared context block, so there is no
    // chat mode and no request flag: removing the agent from sdk/AGENTS.json
    // turns the capability off entirely.
    id: "scholar",
    enabled: (state) => capHasContext(/** @type {any} */ (state).capability, "scholar-metrics"),
    run: (c) => runScholarMetricsEnrichment(c),
  },
  {
    // The person-research METHOD (src/person-research.js): a message asking for
    // research on a named person's public professional record gets the protocol
    // appended — resolve identity before collecting, which sources outrank
    // which, what raises a claim to verified, what is off-limits, and how the
    // writeup is structured. Silent on every other turn.
    //
    // The odd one out in this registry, and deliberately so: it resolves
    // NOTHING. Every enrichment above turns something the message names into
    // data — a snapshot, a catalog, a corpus row, a metrics table. This one
    // appends method and no facts at all, because the gap feedback #60 exposed
    // was not missing data. The pipeline had the name, and still answered a
    // person question the way it answers a topic question: no identity
    // resolution, no source hierarchy, no separation of what the subject
    // asserts from what a registry records. That is a procedure, so a constant
    // block is the honest implementation — a phase that researched how to
    // research would spend a model call on advice that never varies.
    //
    // It reaches no third party (invariant 7 has no service to name here): the
    // block MENTIONS registries and archives the way a checklist does, and
    // actually reaching any of them stays the ordinary search pipeline's job.
    // Its GUARDRAILS section is the substantive work — it is what bounds "find
    // everything about this person" to the public professional record.
    id: "person_research",
    enabled: () => true, // intent decides; the runner is silent on a non-person turn
    run: (c) => runPersonResearchEnrichment(c),
  },
  {
    // The entity-research METHOD (src/entity-research.js) — the sibling of the
    // one above and, like it, method rather than data. Where person-research
    // asks whether the SUBJECT is a person, this one reads the request SHAPE:
    // "osint on …", "due diligence on …", "bakgrundskoll på …". That is the
    // difference feedback #64 turned on. "Osint on revsec" names no role, no
    // company suffix and no pronoun, so no referent test can classify it — and
    // the name belonged to four unrelated organisations, which the report
    // handled by profiling all of them at once.
    //
    // It appends two rules: resolve the subject before profiling it (and ASK,
    // once, when the retrieved sources show more than one), and size the report
    // to the research time the user bought — the deepest tier shaped like a
    // TIBER-EU targeted threat intelligence report, the shallowest a short
    // profile. The tier comes from `state.plan.reportTier`, which is why this
    // runner reads state at all where person-research does not.
    //
    // LAST in the registry, after person_research, so on an OSINT question
    // about a named individual the two blocks read in that order: the method
    // and its guardrails first, then how to resolve the subject and how big the
    // answer should be. Both firing on one turn is correct, not a double-fire.
    id: "entity_research",
    enabled: () => true, // intent decides; the runner is silent on every other turn
    run: (c) => runEntityResearchEnrichment(c),
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
      const next = await e.run({ env, log, emit, step, stepDone, conversation: convo, state });
      // Only an actual conversation replaces the one we hold. A runner that
      // slips and resolves to null/undefined used to have that nullish value
      // flow straight into the NEXT runner's ctx and out of here — and since
      // the last runner in the registry defensively returns what it was handed,
      // the request would then proceed with an EMPTY conversation: the user's
      // question silently deleted rather than the turn failing. Containment
      // here is the same promise the catch below makes (invariant 2).
      if (Array.isArray(next)) convo = next;
      else log.warn(`${e.id}.enrichment_dropped`, { returned: next === null ? "null" : typeof next });
    } catch (/** @type {any} */ err) {
      log.warn(`${e.id}.enrichment_failed`, { error: err?.message || String(err) });
    }
  }
  return convo;
}

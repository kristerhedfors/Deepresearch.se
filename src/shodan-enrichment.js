// @ts-check
// The Shodan context enrichment — an EXTENSION, not core (see
// src/extensions.js). Split out of src/enrichment.js on 2026-07-25 so the
// core enrichment runner is about the enrichment CONTRACT and nothing else;
// this module mirrors src/maps-enrichment.js, which was split out of the
// same file for the same reason on 2026-07-09.
//
// What it does: resolve any host/IP the latest message NAMES into live
// infrastructure data (src/shodan.js) and append it as a labeled context
// block before any model call, so triage, search and synthesis all see it.
// It keeps the standing enrichment contract: silent (no step, no
// conversation change) when the message names nothing to look up, a visible
// activity step naming the external service when it does, and fail-soft in
// every branch — the conversation comes back unchanged rather than ever
// blocking a chat.

import { lastUserMessage, textOf, withAppendedText } from "./conversation.js";
import { extractTargets, runShodanLookup } from "./shodan.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {(id: string, label: string) => void} StepFn */
/** @typedef {(id: string, label: string, details?: string[]) => void} StepDoneFn */

/**
 * This extension's own slice of the per-request state bag (`state.ext.shodan`
 * — see src/extensions.js). The core RequestState deliberately does not model
 * it: every field here is Shodan vocabulary.
 * @typedef {{ on: boolean, count: number }} ShodanState
 */

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {StepFn} step
 * @param {StepDoneFn} stepDone
 * @param {Conversation} conversation
 * @param {ShodanState} slice this extension's state slice (state.ext.shodan)
 * @returns {Promise<Conversation>}
 */
export async function runShodanEnrichment(env, log, step, stepDone, conversation, slice) {
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
  slice.count = result.count;
  const label = result.count
    ? `Shodan: ${result.count} host${result.count === 1 ? "" : "s"} found`
    : "Shodan: no records for the host(s) named";
  stepDone("shodan", label, result.details);
  // Cast: conversation.js works on its looser local Msg shape; appending a
  // text block can't loosen the roles this Conversation arrived with.
  return /** @type {Conversation} */ (withAppendedText(conversation, result.block));
}

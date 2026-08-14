// @ts-check
// The Shodan context enrichment — an EXTENSION, not core (see
// src/extensions.js). Split out of src/enrichment.js on 2026-07-25 so the
// core enrichment runner is about the enrichment CONTRACT and nothing else;
// this module mirrors src/maps-enrichment.js, which was split out of the
// same file for the same reason on 2026-07-09.
//
// What it does: resolve what the turn is actually asking about (the matcher
// registry in src/shodan-text.js) into live infrastructure data — either a
// per-host lookup or a Shodan search — and append it as a labeled context
// block before any model call, so triage, search and synthesis all see it.
// It keeps the standing enrichment contract: silent (no step, no
// conversation change) when the turn asks for nothing lookupable, a visible
// activity step naming the external service when it does, and fail-soft in
// every branch — the conversation comes back unchanged rather than ever
// blocking a chat.
//
// Routing moved out of here on 2026-08-07. Until then this module read the
// latest user message directly and fired if and only if that message
// contained a literal host, which meant there was no way to ASK for host
// intelligence: "Shodan" and "Run through shodan to answer!" (chat_logs
// #1671, #1672) could not fire, and a follow-up naming no host could not
// either. src/shodan-text.js now owns that decision across four routes and
// hands back what to do; the header there explains each one.
//
// The `intent` write-back is the other half of that incident. `shodan_hosts:
// 0` alone could not distinguish "the knob was off" from "we looked and found
// nothing", so a production miss (chat_logs #1670) left no way to tell what
// had happened. The slice now carries the deciding matcher's name — "none"
// when the runner ran and matched nothing — exactly as maps_intent does, and
// the registry reports it as `shodan_intent`.

import { withAppendedText } from "./conversation.js";
import { pickShodanTarget, shodanNamedInLatest } from "./shodan-text.js";
import { runShodanLookup, runShodanSearch } from "./shodan.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {(id: string, label: string) => void} StepFn */
/** @typedef {(id: string, label: string, details?: string[]) => void} StepDoneFn */

/**
 * This extension's own slice of the per-request state bag (`state.ext.shodan`
 * — see src/extensions.js). The core RequestState deliberately does not model
 * it: every field here is Shodan vocabulary. `intent` is the deciding
 * matcher's name (or "none"), left undefined while the runner has not run so
 * JSON.stringify drops the key from the log meta.
 * @typedef {{ on: boolean, count: number, intent?: string }} ShodanState
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
  const target = pickShodanTarget(conversation);
  if (!target) {
    if (shodanNamedInLatest(conversation)) {
      // The user asked for Shodan BY NAME and nothing in the conversation
      // could be turned into a host, IP or company. Staying silent here is
      // what produced feedback #68: the answer had no way to know the service
      // was never called, and narrated a shodan.io search page that the WEB
      // search had returned as though it were Shodan output. A step costs one
      // line and makes the miss visible in the research trail.
      slice.intent = "named-unresolved";
      step("shodan", "Querying Shodan…");
      stepDone("shodan", "Shodan: nothing to look up — name a host, an IP or a company");
      return conversation;
    }
    // Ran, matched nothing. Recorded so the chat_logs meta says so rather
    // than looking identical to a turn where the knob was off.
    slice.intent = "none";
    return conversation;
  }
  slice.intent = target.intent;

  step("shodan", "Querying Shodan…");
  let result = null;
  try {
    result =
      target.kind === "search"
        ? await runShodanSearch(env, log, target.query)
        : await runShodanLookup(env, log, conversation, { ips: target.ips, hostnames: target.hostnames });
  } catch (/** @type {any} */ err) {
    log.warn("shodan.phase_failed", { error: err?.message || String(err), intent: target.intent });
  }
  if (!result) {
    stepDone("shodan", "Shodan lookup unavailable — continuing without it");
    return conversation;
  }
  slice.count = result.count;
  stepDone("shodan", stepLabel(target, result.count), result.details);
  // Cast: conversation.js works on its looser local Msg shape; appending a
  // text block can't loosen the roles this Conversation arrived with.
  return /** @type {Conversation} */ (withAppendedText(conversation, result.block));
}

/**
 * The activity step's finished label. Names the route when it reached past
 * the message in front of the user, so a walked-back or searched result
 * never looks like something they typed.
 * @param {import('./shodan-text.js').ShodanTarget} target
 * @param {number} count
 */
function stepLabel(target, count) {
  const plural = count === 1 ? "" : "s";
  if (target.kind === "search") {
    // The provenance tail matters most here: an org resolved by walking the
    // conversation back was never typed in the message the user is looking at.
    const from = target.followUp ? " (from an earlier message)" : "";
    return count
      ? `Shodan: ${count} host${plural} matching ${target.query}${from}`
      : `Shodan: no hosts match ${target.query}${from}`;
  }
  if (!count) return "Shodan: no records for the host(s) named";
  const named = [...target.ips, ...target.hostnames][0] || "";
  return target.followUp
    ? `Shodan: ${count} host${plural} found for ${named} (from an earlier message)`
    : `Shodan: ${count} host${plural} found`;
}

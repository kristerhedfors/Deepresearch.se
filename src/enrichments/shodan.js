// Shodan enrichment descriptor for the enrichment registry
// (src/enrichments/index.js). A THIN wrapper around the existing Shodan
// client (src/shodan.js) — it does NOT re-implement target extraction or the
// REST lookup, only adapts them to the registry's
// detect → run → {block, details, count, doneLabel} contract. The registry
// handles the step_start/step_done emission, the block append, and the
// fail-soft net around run(); this descriptor just decides "is there a host
// to look up?" (detect) and "what did Shodan return?" (run), preserving the
// exact behavior the hand-wired runShodanEnrichment used to have.

import { textOf, lastUserMessage } from "../conversation.js";
import { extractTargets, runShodanLookup } from "../shodan.js";
import { shodanEnabled } from "../settings.js";

export const shodanEnrichment = {
  id: "shodan",
  settingsKey: "shodan_mcp",
  stateFlag: "shodan", // chat.js pre-resolves the knob into this state flag
  countKey: "shodanCount",
  startLabel: "Querying Shodan…",
  // The registry emits this when run() returns null or throws — matching the
  // original "Shodan lookup unavailable — continuing without it" fail-soft.
  unavailableLabel: "Shodan lookup unavailable — continuing without it",
  failEvent: "shodan.phase_failed",

  // Effective knob state for a caller that has the identity (the settings
  // module gate). The pipeline instead gates on the pre-resolved state flag,
  // so this is only consulted when runEnrichments is given an identity.
  enabled(env, identity) {
    return shodanEnabled(env, identity);
  },

  // Silent when the latest message names no host — same early-out the
  // hand-wired version did before emitting any step.
  detect(conversation) {
    const lastUser = textOf(lastUserMessage(conversation)?.content);
    const { ips, hostnames } = extractTargets(lastUser);
    if (!ips.length && !hostnames.length) return null;
    return { ips, hostnames };
  },

  // Runs the lookup and shapes the result. A throw propagates to the registry
  // (→ unavailable step, conversation unchanged); a null lookup (nothing
  // resolved / no records reachable) is likewise "unavailable".
  async run(ctx) {
    const result = await runShodanLookup(ctx.env, ctx.log, ctx.conversation);
    if (!result) return null;
    const label = result.count
      ? `Shodan: ${result.count} host${result.count === 1 ? "" : "s"} found`
      : "Shodan: no records for the host(s) named";
    return { block: result.block, details: result.details, count: result.count, doneLabel: label };
  },
};

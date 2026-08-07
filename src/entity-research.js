// @ts-check
// THE ENTITY-RESEARCH ENRICHMENT — the Worker façade over
// public/js/entity-research-core.js.
//
// When the latest message asks for an OSINT-class dossier on a named subject,
// this appends two rules to the conversation before any model call: resolve the
// subject before profiling it, and size the report to the research time the
// user actually bought.
//
// ---- the sibling of person-research, not a replacement ----------------------
//
// src/person-research.js fires on a request about a named INDIVIDUAL and
// supplies the method and the privacy guardrails that request needs. This one
// fires on the request SHAPE — "osint on …", "due diligence on …",
// "bakgrundskoll på …" — whatever the subject turns out to be, which is the
// case feedback #64 was filed about: "revsec" names no role, no company suffix
// and no pronoun, so no referent test can classify it, and it resolved to four
// unrelated organisations. Both may fire on one turn and that is correct: an
// OSINT question about a founder wants the person method AND the resolution
// rule. This runner is registered AFTER person-research so the blocks read in
// that order.
//
// ---- as cheap as the enrichment it sits beside ------------------------------
//
// No outbound request, no model call, no asset read, no cache: the gate is a
// regex pair and the block is a constant per report tier. The only failure it
// has is not firing, which costs a less careful report. It is still written
// defensively — a malformed conversation returns unchanged rather than throwing
// — because a throw inside runEnrichments is a warning in the log, not an
// excuse (invariant 2).
//
// ---- why the tier is read here rather than in the core ----------------------
//
// `state.plan.reportTier` is derived from the user's research-time slider
// (src/budget.js reportTierFor), and the plan exists before enrichments run
// (chat.js builds it into the request state). The pure core stays a function of
// the tier so both tiers and the tests can call it with any value; picking
// WHICH tier is this façade's job, and an absent or unknown plan falls back to
// "standard" the same way every other reportTier consumer does.
//
// ---- privacy ----------------------------------------------------------------
//
// Nothing about the subject is logged. The counters record that the rule was
// applied, at which tier, and how large the block was — never the name, never
// the message.

import {
  ENTITY_RESEARCH_ID,
  entityResearchBlock,
  entityResearchBlockWords,
  entityResearchIntent,
} from "../public/js/entity-research-core.js";
// Shared with the other pre-pipeline enrichments (src/conversation.js). The
// append adds a NEW text part, so an attached screenshot survives it.
import { appendToLast, lastUserText } from "./conversation.js";

export {
  ENTITY_RESEARCH_ID,
  entityResearchBlock,
  entityResearchBlockWords,
  entityResearchIntent,
};

/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

/**
 * Append the entity-research rules when the latest message asks for a dossier.
 * Silent on every other turn — the conversation is returned by reference so a
 * non-matching turn is byte-identical to the pre-feature pipeline.
 * @param {EnrichmentCtx} c
 * @returns {Promise<import('./types.js').Conversation>}
 */
export async function runEntityResearchEnrichment(c) {
  const conversation = /** @type {any} */ (c?.conversation);
  if (!Array.isArray(conversation) || !conversation.length) return conversation;

  let asked = "";
  try {
    asked = lastUserText(conversation);
  } catch {
    return conversation;
  }
  if (!entityResearchIntent(asked)) return conversation;

  // The tier the user's research-time slider bought. Unknown/absent plan →
  // "standard", the same fallback every other reportTier consumer uses.
  const tier = /** @type {any} */ (c?.state)?.plan?.reportTier || "standard";
  const block = entityResearchBlock(tier);

  c.step?.(ENTITY_RESEARCH_ID, "Applying the entity-research method…");
  c.stepDone?.(ENTITY_RESEARCH_ID, "Entity-research method applied", [
    "Resolve the subject before profiling it; ask which entity when the name carries more than one",
    `Report depth: ${tier}`,
  ]);

  try {
    /** @type {any} */ (c.state).entityResearch = { applied: true, tier, words: entityResearchBlockWords(tier) };
  } catch {
    // A state bag that cannot be written is not a reason to drop the block.
  }
  c.log?.info?.(ENTITY_RESEARCH_ID + ".applied", { tier, words: entityResearchBlockWords(tier) });

  const last = conversation[conversation.length - 1];
  return [...conversation.slice(0, -1), appendToLast(last, block)];
}

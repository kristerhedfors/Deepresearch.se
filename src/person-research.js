// @ts-check
// THE PERSON-RESEARCH ENRICHMENT — the Worker façade over
// public/js/person-research-core.js.
//
// When the latest message asks for research on a NAMED PERSON's public
// professional record, this appends the methodology block to the conversation
// before any model call, so triage plans against it, the search waves inherit
// its source ladder, and synthesis writes to its output structure.
//
// ---- the cheapest enrichment in the registry --------------------------------
//
// There is NO outbound request here, no model call, no asset read, no cache and
// no state to load: the gate is a regex pair and the block is a constant. The
// only failure it can have is not firing, which costs a less careful report and
// nothing else — so the fail-soft discipline invariant 2 demands of the search
// and lookup enrichments is satisfied by construction rather than by branches.
// It is still written defensively (a malformed conversation returns unchanged
// rather than throwing) because runEnrichments containing a throw is a warning
// in the log, not an excuse.
//
// ---- why it is core, and reaches nothing -----------------------------------
//
// Same footing as introspection's source snapshot and the ancient-sample
// corpus: no third party, no secret, no per-account configuration, nothing
// leaving this deployment. Invariant 7's boundary does not apply because there
// is no service to name — the block MENTIONS registries and archives the way a
// checklist does, and reaching any of them is the ordinary search pipeline's
// job, under whatever web-search backend the tier already uses.
//
// ---- privacy ---------------------------------------------------------------
//
// Nothing about the subject is logged. The counters below record that the
// method was applied and how large the block was — never the name, never the
// message. The block's own GUARDRAILS section is the substantive privacy work:
// it is what turns "find everything about this person" into a bounded,
// professional-record-only report, and it is the reason this enrichment exists
// rather than being left to the answer model's instincts.
//
// ---- feedback #60 ----------------------------------------------------------
//
// A LinkedIn screenshot plus "Write a report about what you can find on this
// founder" returned a restatement of the screenshot. The sibling half of that
// fix is src/image-read.js, which turns the picture into text so there is a
// name to plan against; this half supplies the method that name deserves.

import {
  PERSON_RESEARCH_ID,
  personResearchBlock,
  personResearchBlockWords,
  personResearchIntent,
} from "../public/js/person-research-core.js";
// The last-user-text reading and the multipart-safe block append are shared
// with the other pre-pipeline enrichments (src/conversation.js). The append
// adds a NEW text part, so an attached profile screenshot survives it.
import { appendToLast, lastUserText } from "./conversation.js";

export {
  PERSON_RESEARCH_ID,
  personReferent,
  personResearchBlock,
  personResearchBlockWords,
  personResearchIntent,
  personResearchShape,
} from "../public/js/person-research-core.js";

/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

/**
 * The enrichment runner (src/enrichment.js). Silent — no step, no event, no
 * conversation change — on every turn that is not a person question, which is
 * almost all of them.
 *
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runPersonResearchEnrichment(c) {
  const conversation = /** @type {any} */ (c?.conversation);
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return /** @type {any} */ (conversation || []);
  }

  let asked = "";
  try {
    asked = lastUserText(conversation);
  } catch {
    return conversation;
  }
  if (!personResearchIntent(asked)) return conversation;

  // Visible, because the method changes what the answer does: a user who sees
  // "Applying the person-research method" and then reads a report full of
  // "self-reported only" rows knows why, and a user who wanted a plain summary
  // knows what to complain about.
  c.step?.(PERSON_RESEARCH_ID, "Applying the person-research method…");
  c.stepDone?.(PERSON_RESEARCH_ID, "Person-research method applied", [
    "Source ladder, verification rules and the public-professional-information limits",
  ]);

  const block = personResearchBlock();
  // Counters only — never the subject, never the question. `words` is here so a
  // chat_logs reader can tell a truncated context from a missing block.
  try {
    /** @type {any} */ (c.state).personResearch = { applied: true, words: personResearchBlockWords() };
  } catch {
    // A caller without a state bag still gets the block.
  }
  c.log?.info?.(PERSON_RESEARCH_ID + ".applied", { words: personResearchBlockWords() });

  const last = conversation[conversation.length - 1];
  return [...conversation.slice(0, -1), appendToLast(last, block)];
}

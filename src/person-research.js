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
// ---- the rail is unconditional; the tradecraft is declared (2026-08-13) -----
//
// The roster change of 2026-08-13 gives OSINT to the Cyber agent, and this
// runner is where that lands for person questions. It appends ONE of two
// blocks, chosen by the resolved agent's declared context:
//
//   `person-method` declared  → personResearchBlock(), the full protocol,
//                               byte-identical to what shipped before.
//   not declared              → personGuardrailsBlock(), the privacy rail alone.
//
// The rail is deliberately NOT behind the declaration. personResearchIntent
// fires on any agent — "who is this founder" reaches Deep Science and
// Introspection as readily as it reaches Cyber — and an agent that has lost the
// limits on reporting a private individual's health, ethnicity, personnummer or
// home address is worse off than one that never had the method. Invariant 4
// makes privacy load-bearing here, so the capability gate narrows the
// tradecraft and never the rail. The full reasoning is in the core's header.
//
// A request that never consulted the agent registry has no capability at all
// (`null`), which resolves to the rail — the fail-soft direction, and since
// public/js/chat-mode-core.js's routingNeedsRegistry became unconditional that
// is only the non-chat channels (MCP, an orchestrator sub-agent) rather than an
// ordinary turn.
//
// ---- feedback #60 ----------------------------------------------------------
//
// A LinkedIn screenshot plus "Write a report about what you can find on this
// founder" returned a restatement of the screenshot. The sibling half of that
// fix is src/image-read.js, which turns the picture into text so there is a
// name to plan against; this half supplies the method that name deserves.

import {
  PERSON_RESEARCH_ID,
  personGuardrailsBlock,
  personGuardrailsBlockWords,
  personResearchBlock,
  personResearchBlockWords,
  personResearchIntent,
} from "../public/js/person-research-core.js";
import { capHasContext } from "./agent-spec.js";
// The last-user-text reading and the multipart-safe block append are shared
// with the other pre-pipeline enrichments (src/conversation.js). The append
// adds a NEW text part, so an attached profile screenshot survives it.
import { appendToLast, lastUserText } from "./conversation.js";

export {
  PERSON_RESEARCH_ID,
  personGuardrailsBlock,
  personGuardrailsBlockWords,
  personReferent,
  personResearchBlock,
  personResearchBlockWords,
  personResearchIntent,
  personResearchShape,
} from "../public/js/person-research-core.js";

/** The context block the METHOD half is declared by (public/js/agent-spec-core.js
 * CONTEXT_BLOCKS). The rail below it is declared by nothing — that is the point. */
export const PERSON_METHOD_CONTEXT = "person-method";

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

  // Which half the resolved agent gets. Reading the capability defensively (an
  // absent state bag is one of this runner's pinned fail-soft cases) and in the
  // narrowing direction: anything that is not an explicit declaration resolves
  // to the rail.
  const hasMethod = capHasContext(/** @type {any} */ (c?.state)?.capability, PERSON_METHOD_CONTEXT);
  const block = hasMethod ? personResearchBlock() : personGuardrailsBlock();
  const words = hasMethod ? personResearchBlockWords() : personGuardrailsBlockWords();

  // Visible, because the block changes what the answer does: a user who sees
  // "Applying the person-research method" and then reads a report full of
  // "self-reported only" rows knows why, and a user who wanted a plain summary
  // knows what to complain about. The two labels differ so the activity trail
  // says which half applied — a report written without the source ladder is a
  // different artefact, and the step is the only place that is visible.
  c.step?.(
    PERSON_RESEARCH_ID,
    hasMethod ? "Applying the person-research method…" : "Applying the person-research limits…",
  );
  c.stepDone?.(
    PERSON_RESEARCH_ID,
    hasMethod ? "Person-research method applied" : "Person-research limits applied",
    [
      hasMethod
        ? "Source ladder, verification rules and the public-professional-information limits"
        : "Public-professional-information limits only — the source ladder and write-up are the Cyber agent's",
    ],
  );

  // Counters only — never the subject, never the question. `words` is here so a
  // chat_logs reader can tell a truncated context from a missing block, and
  // `method` so the same reader can tell the two halves apart at a glance.
  try {
    /** @type {any} */ (c.state).personResearch = { applied: true, method: hasMethod, words };
  } catch {
    // A caller without a state bag still gets the block.
  }
  c.log?.info?.(PERSON_RESEARCH_ID + ".applied", { method: hasMethod, words });

  const last = conversation[conversation.length - 1];
  return [...conversation.slice(0, -1), appendToLast(last, block)];
}

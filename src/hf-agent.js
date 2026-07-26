// @ts-check
// THE HUGGING FACE AGENT — the sixth chat mode, and the one whose defining
// property is that its model catalog is OPEN.
//
// Every other agent answers on a model somebody at this site put in the
// dropdown. This one hands you the whole Hugging Face router catalog: browse it
// in the conversation, see what each model costs before you start it, and
// accept the one you want. Accepting is the pipeline that connects this mode to
// the rest of the app — an accepted model joins this account's catalog
// (src/user-models.js → src/providers.js → /api/models), so it is then
// selectable in Deep Research, Introspection, Agent Studio and Orchestrator
// too. The allowance that bounds what may be accepted starts small and is
// raised in the site config (src/hf-inference.js hfAllowance); "start here,
// extend later" is a config edit, not a code change.
//
// It is NOT a new executor. The mode's answer phase is the ordinary `research`
// one — the whole point is a deep-research agent that happens to know the model
// ecosystem cold — so what this module contributes is a pre-pipeline enrichment
// (src/enrichment.js) and one forced search source:
//
//   1. Hub search is FORCED on for every turn (state.forceAux), so the agent
//      always has huggingface.co model cards, datasets and papers in front of
//      it instead of waiting for hfIntent to notice a hub question.
//   2. When the message is about CHOOSING or RUNNING a model (hfModelIntent —
//      English and Swedish alike, invariant 6), the live router catalog is
//      ranked against it and folded into the conversation as a priced context
//      block, so the answer quotes real current rates rather than remembered
//      ones. The same rows ride out as an `hf_models` SSE event, which is what
//      the composer renders as pickable cost cards.
//
// Both halves are fail-soft (invariant 2): an unreachable router leaves the
// conversation untouched and the turn is an ordinary hub-flavoured research
// answer. And no model decides any of it — the intent gate is a regex and the
// ranking is a lexical scan (invariant 1).
//
// Privacy (invariant 4): the ranking happens in the isolate against a catalog
// this Worker fetched unauthenticated. The user's message is never forwarded to
// Hugging Face to do it — only the Hub SEARCH leg sends anything outward, and
// that sends AI-derived search terms, exactly as src/hf.js already documents.

import { getConfig } from "./config.js";
import {
  hfAllowance,
  hfBrowseItem,
  hfInferenceConfigured,
  hfRankModels,
  hfRouterModels,
} from "./hf-inference.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

/** How many priced rows ride out on the event / into the context block. The
 * cards are a picker, not a catalog dump, and every row spends answer-context
 * tokens the research itself needs. */
const SHOWN = 8;
/** Rows folded into the model's context. Fewer than SHOWN: the UI can afford a
 * scroll list, a synthesis prompt cannot. */
const IN_CONTEXT = 6;

// Model-shopping intent. English and Swedish get the SAME breadth (invariant
// 6): definite forms ("modellen", "modeller"), the cost vocabulary people
// actually type ("vad kostar", "billigaste", "prislapp"), and the run verbs
// ("kör", "starta", "aktivera", "sätt igång"). Deliberately requires a MODEL
// word next to an intent word rather than firing on either alone — in this mode
// half the questions mention models without asking to pick one, and a priced
// catalog block on every turn would crowd out the research.
const MODEL_WORD = /\b(model|models|llm|llms|checkpoint|modell|modeller|modellen|modellerna|språkmodell|spr[åa]kmodeller)\b/i;
const SHOP_WORD =
  /\b(cheap|cheapest|cost|costs|costly|price|pricing|priced|expensive|budget|afford|per\s+token|rate|rates|compare|comparison|which|recommend|pick|choose|choice|select|enable|use|run|start|spin\s+up|switch|try|available|catalog|catalogue|context\s+window|billig|billigast|billigaste|kostar|kostnad|pris|priser|prislapp|prisv[äa]rd|dyr|dyrast|dyraste|j[äa]mf[öo]r|j[äa]mf[öo]relse|vilken|vilka|rekommendera|rekommenderar|v[äa]lj|v[äa]lja|aktivera|anv[äa]nd|anv[äa]nda|k[öo]r|k[öo]ra|starta|s[äa]tt\s+ig[åa]ng|byt|byta|prova|tillg[äa]nglig|tillg[äa]ngliga|katalog|kontextf[öo]nster)\b/i;

/**
 * Whether this message is about choosing, pricing or starting a model — the
 * gate on the priced catalog block. Pure, no model call.
 * @param {unknown} text
 * @returns {boolean}
 */
export function hfModelIntent(text) {
  if (typeof text !== "string" || !text) return false;
  return MODEL_WORD.test(text) && SHOP_WORD.test(text);
}

/**
 * The search terms to rank the catalog against: the message with the shopping
 * vocabulary stripped out, so "which cheap swedish model should I use" ranks on
 * "swedish" rather than on "cheap" and "use". Same noise-stripping idea as
 * src/hf.js hfTerms, kept separate because that one feeds a hub API and this
 * one feeds a local scan.
 * @param {string} text
 * @returns {string}
 */
export function hfModelQuery(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.+-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !MODEL_WORD.test(w) && !SHOP_WORD.test(w) && !STOP.has(w))
    .slice(0, 8)
    .join(" ");
}

// Ordinary question words that would otherwise dominate a lexical scan. EN+SV
// in the same set, same rule as every other gate here.
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "what", "how", "can", "you", "are", "any",
  "should", "would", "could", "does", "have", "has", "want", "need", "there", "best", "good",
  "och", "att", "det", "den", "som", "för", "med", "har", "kan", "ska", "skall", "vill",
  "behöver", "finns", "bäst", "bästa", "bra", "jag", "vad", "hur", "till", "från", "eller",
]);

/**
 * The priced catalog block folded into the conversation. Rows are compact and
 * uniform on purpose — the model is being asked to REASON over prices, so the
 * numbers must be unambiguous and in one currency each.
 * @param {import('./hf-inference.js').HfBrowseItem[]} rows
 * @param {import('./user-models.js').AcceptedModel[]} accepted
 * @param {import('./hf-inference.js').HfAllowance} allowance
 * @returns {string}
 */
export function hfCatalogBlock(rows, accepted, allowance) {
  if (!rows.length) return "";
  const lines = rows.slice(0, IN_CONTEXT).map((r) => {
    const price = r.usd_out === null
      ? "no published price"
      : `$${r.usd_in ?? "?"} in / $${r.usd_out} out per 1M tokens (≈ €${(r.turn_eur || 0).toFixed(4)} per research turn)`;
    const ctx = r.context ? `, ${Math.round(r.context / 1000)}k context` : "";
    const flags = [r.vision ? "vision" : "", r.tools ? "tools" : "", r.accepted ? "ALREADY ENABLED" : ""]
      .filter(Boolean)
      .join(", ");
    return `- ${r.hfId} — served by ${r.provider || "?"}${ctx} — ${price}${flags ? ` [${flags}]` : ""}${r.allowed ? "" : ` [NOT ENABLEABLE: ${r.reason}]`}`;
  });
  const enabled = accepted.length
    ? accepted.map((m) => m.hfId).join(", ")
    : "none yet";
  return [
    "HUGGING FACE MODEL CATALOG (live, fetched this turn from the Hugging Face router):",
    ...lines,
    "",
    `Already enabled for this account: ${enabled}.`,
    `Model allowance: up to $${allowance.maxOutputUsd} per 1M output tokens, ${allowance.maxAccepted} models enabled at once.`,
    "",
    "Use these numbers verbatim when discussing cost — they are current and the user's own allowance is the one quoted. " +
      "Enabling a model is the user's action, not yours: tell them to press Enable on the model card, and say plainly that " +
      "an enabled model becomes selectable in every chat mode, not just this one.",
  ].join("\n");
}

/**
 * The enrichment (registered in src/enrichment.js, gated on state.hfMode).
 * Forces hub search for the turn, and — when the message is model-shopping —
 * emits the priced rows and folds them into the conversation.
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runHfAgentEnrichment(c) {
  const { env, log, state, conversation } = c;
  // Hub search runs every turn in this mode, whatever the message looks like:
  // being the agent that knows the open-model ecosystem is the mode's whole
  // identity, and hfIntent exists to keep the hub OUT of unrelated turns in the
  // other modes. Core reads this generically (pipeline.js runAuxSearch), so
  // nothing about the pipeline learns which source it is.
  /** @type {any} */ (state).forceAux = ["hf"];

  const lastUser = lastUserText(conversation);
  if (!hfModelIntent(lastUser)) return conversation;
  if (!hfInferenceConfigured(env)) {
    // The mode still works — it is a research agent — but say so once rather
    // than silently answering model-shopping questions with no catalog.
    c.stepDone("hf_models", "Hugging Face inference is not configured on this server");
    return conversation;
  }

  c.step("hf_models", "Reading the Hugging Face model catalog…");
  const [config, catalog] = await Promise.all([getConfig(env), hfRouterModels(env, log)]);
  const allowance = hfAllowance(config);
  // The account's accepted models ride on the state (chat.js resolved them
  // alongside the catalog); the enrichment ctx carries no identity by design.
  const accepted = /** @type {import('./user-models.js').AcceptedModel[]} */ (
    /** @type {any} */ (state).hfAccepted || []
  );
  const acceptedIds = new Set(accepted.map((m) => m.hfId));
  const query = hfModelQuery(lastUser);
  const rows = hfRankModels(catalog, query)
    .slice(0, SHOWN)
    .map((m) => hfBrowseItem(m, { allowance, acceptedIds, acceptedCount: accepted.length }));

  if (!rows.length) {
    c.stepDone("hf_models", catalog.length ? "No matching models" : "The model catalog is unavailable");
    return conversation;
  }
  c.stepDone("hf_models", `${rows.length} model${rows.length === 1 ? "" : "s"}${query ? ` for “${query}”` : " (cheapest first)"}`, [
    `${catalog.length} models servable through Hugging Face providers`,
    `${accepted.length}/${allowance.maxAccepted} enabled for this account`,
  ]);
  // The event the composer turns into pickable cost cards. A client that
  // doesn't know the type ignores it (the SSE forward-compatibility rule), so
  // the mode degrades to a plain priced answer on an old bundle.
  c.emit({
    status: {
      type: "hf_models",
      query,
      models: rows,
      accepted,
      allowance: { max_output_usd: allowance.maxOutputUsd, max_accepted: allowance.maxAccepted, used: accepted.length },
      total: catalog.length,
    },
  });
  /** @type {any} */ (state).hfModels = { shown: rows.length, total: catalog.length, query };

  const block = hfCatalogBlock(rows, accepted, allowance);
  if (!block) return conversation;
  return [...conversation.slice(0, -1), appendToLast(conversation[conversation.length - 1], block)];
}

/**
 * The latest user message's text (the enrichment runs before pipeline.js builds
 * its ctx, so it reads the conversation directly — same as the introspection
 * enrichment does).
 * @param {Conversation} conversation
 * @returns {string}
 */
function lastUserText(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const m = conversation[i];
    if (m?.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((p) => p?.type === "text").map((p) => p.text || "").join(" ");
    }
    return "";
  }
  return "";
}

/**
 * Append a context block to a message, preserving multipart content (an
 * attached image must survive the append).
 * @param {any} message
 * @param {string} block
 * @returns {any}
 */
function appendToLast(message, block) {
  if (!message) return message;
  if (typeof message.content === "string") {
    return { ...message, content: `${message.content}\n\n${block}` };
  }
  if (Array.isArray(message.content)) {
    return { ...message, content: [...message.content, { type: "text", text: block }] };
  }
  return message;
}

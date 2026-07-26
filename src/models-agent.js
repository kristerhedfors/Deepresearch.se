// @ts-check
// THE MODELS AGENT — the sixth chat mode, and the one whose subject is the
// models themselves.
//
// Every other agent answers ON a model. This one answers ABOUT them: which
// exist, across every provider this deployment can reach; what each costs; what
// has actually been verified about it; and what it would take to put it in
// everyone else's dropdown. It is where a model's whole life happens —
// discovered in some provider's catalog, evaluated against the established
// checks, enabled for the rest of the platform (src/model-catalog.js for the
// lifecycle, src/model-checks.js for the evidence, src/models-api.js for the
// actions).
//
// Hugging Face is one provider here, not the point. It happens to be the only
// one with an OPEN catalog today, which is why it is the only one that can
// produce a `discovered` model — but the agent's copy, its context block and
// its gate all speak about providers generically, and a second marketplace
// would need no change here at all.
//
// It is NOT a new executor. The mode's answer phase is the ordinary `research`
// one — the whole point is a deep-research agent that happens to know the model
// landscape cold — so what this module contributes is a pre-pipeline enrichment
// (src/enrichment.js) and one forced search source:
//
//   1. Hub search is FORCED on for every turn (state.forceAux), so the agent
//      always has huggingface.co model cards, datasets and papers in front of
//      it instead of waiting for hfIntent to notice a hub question. That is a
//      research-source choice, not a provider one: the Hub is where models are
//      DOCUMENTED, whoever ends up serving them.
//   2. When the message is about CHOOSING, PRICING, EVALUATING or RUNNING a
//      model (modelIntent — English and Swedish alike, invariant 6), the live
//      cross-provider catalog is ranked against it and folded into the
//      conversation as a priced, verification-annotated context block, so the
//      answer quotes real current numbers rather than remembered ones. The same
//      rows ride out as a `model_cards` SSE event, which the composer renders
//      as pickable cards.
//
// Both halves are fail-soft (invariant 2): unreachable providers leave the
// conversation untouched and the turn is an ordinary research answer. And no
// model decides any of it — the intent gate is a regex and the ranking is a
// lexical scan (invariant 1).
//
// Privacy (invariant 4): the ranking happens in the isolate against catalogs
// this Worker already fetched. The user's message is never forwarded to a
// provider to do it — only the Hub SEARCH leg sends anything outward, and that
// sends AI-derived search terms, exactly as src/hf.js already documents.

import { getConfig } from "./config.js";
import {
  applyAllowance,
  buildCatalog,
  catalogBlock,
  modelAllowance,
  rankCatalog,
} from "./model-catalog.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

/** How many rows ride out on the event. The cards are a picker, not a catalog
 * dump, and every row spends answer-context tokens the research itself needs. */
const SHOWN = 8;
/** Rows folded into the model's context. Fewer than SHOWN: the UI can afford a
 * scroll list, a synthesis prompt cannot. */
const IN_CONTEXT = 6;

// Model-shopping intent. English and Swedish get the SAME breadth (invariant
// 6): definite forms ("modellen", "modeller"), the cost vocabulary people
// actually type ("vad kostar", "billigaste", "prislapp"), the run verbs ("kör",
// "starta", "aktivera", "sätt igång"), and — since the agent owns the whole
// lifecycle — the evaluation vocabulary too ("verify", "evaluate", "test",
// "verifiera", "utvärdera", "testa"). Deliberately requires a MODEL word next
// to an intent word rather than firing on either alone: in this mode half the
// questions mention models without asking to pick one, and a priced catalog
// block on every turn would crowd out the research.
const MODEL_WORD = /\b(model|models|llm|llms|checkpoint|modell|modeller|modellen|modellerna|språkmodell|spr[åa]kmodeller)\b/i;
const SHOP_WORD =
  /\b(cheap|cheapest|cost|costs|costly|price|pricing|priced|expensive|budget|afford|per\s+token|rate|rates|compare|comparison|which|recommend|pick|choose|choice|select|enable|disable|use|run|start|spin\s+up|switch|try|available|catalog|catalogue|context\s+window|verify|verified|verification|evaluate|evaluation|eval|test|tested|check|checks|benchmark|score|quality|reliable|billig|billigast|billigaste|kostar|kostnad|pris|priser|prislapp|prisv[äa]rd|dyr|dyrast|dyraste|j[äa]mf[öo]r|j[äa]mf[öo]relse|vilken|vilka|rekommendera|rekommenderar|v[äa]lj|v[äa]lja|aktivera|st[äa]ng\s+av|anv[äa]nd|anv[äa]nda|k[öo]r|k[öo]ra|starta|s[äa]tt\s+ig[åa]ng|byt|byta|prova|tillg[äa]nglig|tillg[äa]ngliga|katalog|kontextf[öo]nster|verifiera|verifierad|verifiering|utv[äa]rdera|utv[äa]rdering|testa|testad|kontrollera|kvalitet|tillf[öo]rlitlig)\b/i;

/**
 * Whether this message is about choosing, pricing, evaluating or starting a
 * model — the gate on the priced catalog block. Pure, no model call.
 * @param {unknown} text
 * @returns {boolean}
 */
export function modelIntent(text) {
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
export function modelQuery(text) {
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
 * The enrichment (registered in src/enrichment.js, gated on state.modelsMode).
 * Forces hub search for the turn, and — when the message is about models —
 * emits the priced, verification-annotated rows and folds them into context.
 * @param {EnrichmentCtx} c
 * @returns {Promise<Conversation>}
 */
export async function runModelsAgentEnrichment(c) {
  const { env, log, state, conversation } = c;
  // Hub search runs every turn in this mode, whatever the message looks like:
  // being the agent that knows the model ecosystem is the mode's whole
  // identity, and hfIntent exists to keep the hub OUT of unrelated turns in the
  // other modes. Core reads this generically (pipeline.js runAuxSearch), so
  // nothing about the pipeline learns which source it is.
  /** @type {any} */ (state).forceAux = ["hf"];

  const lastUser = lastUserText(conversation);
  if (!modelIntent(lastUser)) return conversation;

  c.step("models", "Reading the model catalog…");
  const [config, built] = await Promise.all([
    getConfig(env),
    // The account's lifecycle state was resolved by the request handler and put
    // on the state (chat.js). The pipeline holds no identity by design.
    buildCatalog(env, log, /** @type {any} */ (state).account || { enabled: [], checks: {} }),
  ]);
  const allowance = modelAllowance(config);
  applyAllowance(built.rows, allowance);
  const query = modelQuery(lastUser);
  const rows = rankCatalog(built.rows, query).slice(0, SHOWN);

  if (!rows.length) {
    c.stepDone("models", built.rows.length ? "No matching models" : "The model catalog is unavailable");
    return conversation;
  }
  const enabled = built.rows.filter((r) => r.state === "enabled").length;
  const verified = built.rows.filter((r) => r.verification.pass > 0).length;
  c.stepDone("models", `${rows.length} model${rows.length === 1 ? "" : "s"}${query ? ` for “${query}”` : " (cheapest first)"}`, [
    `${built.rows.length} models across ${built.providers.filter((p) => p.configured).length} providers`,
    `${enabled} enabled, ${verified} with verification results`,
  ]);
  // The event the composer turns into pickable cards. A client that doesn't
  // know the type ignores it (the SSE forward-compatibility rule), so the mode
  // degrades to a plain priced answer on an old bundle.
  c.emit({
    status: {
      type: "model_cards",
      query,
      models: rows,
      providers: built.providers,
      allowance: { max_output_usd: allowance.maxOutputUsd, max_enabled: allowance.maxEnabled, used: enabled },
      total: built.rows.length,
    },
  });
  /** @type {any} */ (state).modelCards = { shown: rows.length, total: built.rows.length, query, enabled, verified };

  const block = catalogBlock(rows, IN_CONTEXT);
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

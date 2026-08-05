// @ts-check
// PHASE 0 — THE IMAGE READ. One vision call that turns an attached picture
// into text BEFORE anything plans research.
//
// ---- why this exists --------------------------------------------------------
//
// Nothing in this pipeline that decides WHAT to research can see an image.
// Triage, the gap check and validation are JSON calls on the fixed planning
// model (invariant 3), and every one of them reads the conversation through
// conversation.js `textOf`, which flattens image parts to "[N image(s)
// attached]". The one model that CAN see the picture — the user's answer model
// — does not run until synthesis, by which time the searches have been chosen.
//
// chat_logs #1305 (user feedback #60) is what that costs: a LinkedIn profile
// screenshot with "Write a report about what you can find on this founder"
// planned ZERO queries and answered in 14 s against a 10-minute budget, because
// the only searchable noun in the message was "this founder" — the subject's
// name was in pixels nobody had read. So this runner goes FIRST, transcribes
// the attachment, and appends the transcription as a labeled context block.
// Triage then has a name to plan against, the search wave has terms to issue,
// and synthesis has the same words in front of it.
//
// ---- why it runs on the ANSWER model, and must keep doing so ----------------
//
// Invariant 3 pins the THREE JSON PLANNING PHASES (triage, gap check,
// validation) to the fixed reliable planning model. This is not one of them —
// it is an enrichment, like the source snapshot or the sample corpus — and it
// deliberately calls `state.model`, the user's answer model.
//
// That is forced by capability, not preference: `src/validation.js`
// resolveModel REJECTS an image-bearing request whose chosen model lacks vision
// (and rejects one carrying more images than that model's profile allows), so
// on every turn this phase actually runs, the answer model is known to see
// images. The planning model is Mistral Small and is not. Routing this call to
// the planning model would make it blind — please do not "fix" it back.
//
// ---- what it is not ---------------------------------------------------------
//
// No tool calling (invariant 1): a plain completion, streamed and consumed
// here, exactly like the imagery describe helper. Fail-soft in every branch
// (invariant 2): a timeout, a provider error or an unusable reply leaves the
// conversation EXACTLY as it arrived and the turn proceeds without the block.
// No new dependency (invariant 5), and no cost at all on a turn without an
// image — the runner returns before it builds a request.
//
// The transcription is EVIDENCE, not a source. It comes from the user's own
// attachment, so the block says so in words: nothing in it may be cited as a
// source, and a name read off a picture is a lead to verify, not a fact. The
// prompt (IMAGE_READ_PROMPT, src/prompts.js) carries the matching guardrails —
// transcribe what is visible, never infer a personal characteristic from an
// appearance, never guess who an unnamed person is.

import { consumeChatStream } from "./berget.js";
import { appendToLast, imagePartsOf, lastUserMessage } from "./conversation.js";
import { IMAGE_READ_PROMPT } from "./prompts.js";
import { chatCompletion } from "./providers.js";
import { addUsage } from "./quota.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./enrichment.js').EnrichmentCtx} EnrichmentCtx */

// A transcription, not an essay: names, titles, employers, dates and captions
// fit in a few hundred tokens, and a bigger cap only buys a model room to
// speculate past the end of what it can actually read.
export const IMAGE_READ_MAX_TOKENS = 700;

// The read blocks triage, so a backend that accepts the request and then stalls
// would hang the whole turn on "Reading the attached image…" with no way out —
// the failure mode berget.js's stream guards exist for, and the one the Street
// View describe helper already opts into. `idleMs` bounds the wait for the next
// chunk, `maxMs` the whole consumption; the connect timeout inside
// chatCompletion bounds the wait for headers. A tripped guard throws into the
// catch below, which is the ordinary fail-soft path.
export const IMAGE_READ_GUARDS = { idleMs: 20_000, maxMs: 40_000 };

// Safety valve on what gets folded into the conversation: a model that ignores
// the prompt and free-associates must not push the real question out of the
// context window. IMAGE_READ_MAX_TOKENS already bounds this; the slice is the
// second fence.
const MAX_BLOCK_CHARS = 6000;

const INSTRUCTION =
  "Read the attached image(s) now: transcribe the text, then name the subjects, then say what each image is.";

/**
 * The labeled context block. The house shape: a header line saying WHAT this is
 * and WHERE it came from, the material, then a closing paragraph telling the
 * later phases how to use it — here above all that this is the user's own
 * attachment rather than a source, and that a name read off a picture is
 * unverified.
 * @param {number} images
 * @param {string} text
 * @returns {string}
 */
export function imageReadBlock(images, text) {
  return [
    `Text read from the ${images === 1 ? "image" : `${images} images`} attached to this message, ` +
      "transcribed by this system's vision pass. No web source was consulted for it.",
    "",
    text,
    "",
    "USING THIS BLOCK: these are the words visible in the user's OWN attachment, read by this pipeline — " +
      "they are not a web source and not a search result, so do not cite them as sources and do not list them " +
      'under "Sources:". Research the NAMES the block contains: search for the person, company, product, place ' +
      'or publication it identifies, never for "the image" or "the attached screenshot", which no search engine ' +
      "can see. And treat a name, job title, employer, date or number read off a picture as UNVERIFIED — a " +
      "screenshot can be edited, outdated, or of someone else entirely — so attribute it to the attachment " +
      '("the attached profile shows…") until an independent source confirms it, and say plainly when none does.',
  ].join("\n");
}

/**
 * The bounded vision call. Returns the transcription, or "" on ANY failure —
 * a non-ok response, a stalled stream, a thrown fetch, an empty completion.
 * Never throws. Token usage is folded into `state.totals` rather than
 * `state.visionTotals`: this runs on the user's ANSWER model, so it is billed
 * at that model's rate like the rest of that model's spend (visionTotals is for
 * the separate describe HELPER a non-vision answer model needs).
 *
 * The guards are a parameter so a unit test can prove the bound actually cuts a
 * stalled stream without waiting 20 seconds for it.
 * @param {Env} env
 * @param {Logger} log
 * @param {import('./types.js').RequestState} state
 * @param {any[]} imageParts image_url content parts from the latest user message
 * @param {{ idleMs?: number, maxMs?: number }} [guards]
 * @returns {Promise<string>}
 */
export async function readImages(env, log, state, imageParts, guards = IMAGE_READ_GUARDS) {
  const model = state.model;
  try {
    const upstream = await chatCompletion(
      env,
      /** @type {any} */ ([
        { role: "system", content: IMAGE_READ_PROMPT },
        { role: "user", content: [{ type: "text", text: INSTRUCTION }, ...imageParts] },
      ]),
      { model, maxTokens: IMAGE_READ_MAX_TOKENS },
    );
    if (!upstream?.ok || !upstream.body) {
      // The provider's error BODY, bounded — a bare status was never enough to
      // tell an image-count rejection from an auth failure (model-profiles.js).
      const detail = await upstream?.text?.().catch(() => "") || "";
      log?.warn?.("image_read.failed", {
        status: upstream?.status,
        images: imageParts.length,
        detail: String(detail).slice(0, 200),
      });
      return "";
    }
    const { text, usage } = await consumeChatStream(upstream.body, () => {}, guards);
    addUsage(state.totals, usage);
    const out = (text || "").trim();
    if (!out) {
      log?.warn?.("image_read.failed", { images: imageParts.length, error: "empty completion" });
      return "";
    }
    return out.slice(0, MAX_BLOCK_CHARS);
  } catch (/** @type {any} */ err) {
    log?.warn?.("image_read.failed", { images: imageParts.length, error: err?.message || String(err) });
    return "";
  }
}

/**
 * The enrichment runner (src/enrichment.js), and the first one in the core
 * registry — every later enrichment and every phase reads the conversation
 * after this one has had its say.
 *
 * Silent — no step, no event, no conversation change, no model call — on every
 * turn whose latest user message carries no image, which is nearly all of them.
 *
 * @param {EnrichmentCtx} c
 * @param {{ idleMs?: number, maxMs?: number }} [guards] test seam for the stream bound
 * @returns {Promise<Conversation>}
 */
export async function runImageReadEnrichment(c, guards = IMAGE_READ_GUARDS) {
  const { env, log, state, conversation } = c;
  const last = lastUserMessage(conversation);
  const parts = imagePartsOf(last);
  // Every image in the LATEST user message, and no cap of our own: validation
  // already refused a request carrying more than the chosen model's profile
  // allows, and the same parts are what the answer call will receive.
  if (!parts.length) return conversation;

  c.step("image_read", `Reading the attached ${parts.length === 1 ? "image" : `${parts.length} images`}…`);
  const text = await readImages(env, log, state, parts, guards);

  // The counters a chat_logs reader needs to tell "the picture was unreadable"
  // from "the read never ran" — the SHAPE only: never the transcription, never
  // the question.
  /** @type {any} */ (state).imageRead = { images: parts.length, chars: text.length };

  if (!text) {
    // Fail soft and VISIBLY: the step already told the user a read had started,
    // so silence here would read as a result rather than an outage. The turn
    // continues exactly as it would have without this phase.
    c.stepDone("image_read", "The attached image could not be read");
    return conversation;
  }

  c.stepDone(
    "image_read",
    `Read ${parts.length === 1 ? "1 image" : `${parts.length} images`} (${text.length} characters of text)`,
  );
  log?.info?.("image_read.done", {
    images: parts.length,
    chars: text.length,
    model: String(state.model || "").slice(0, 120),
  });

  // Appended to the message the images are ON — found by index rather than by
  // assuming it is the tail, so a trailing non-user message could never take
  // the block (and `appendToLast` keeps the image parts intact beside it).
  const block = imageReadBlock(parts.length, text);
  const at = conversation.lastIndexOf(/** @type {any} */ (last));
  return conversation.map((m, i) => (i === at ? appendToLast(m, block) : m));
}

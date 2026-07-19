// @ts-check
// The pipeline's answer-streaming internals: streamCompletion (the entry the
// phase runners call — the user's model first, then the ONE-shot failover to
// the reliable JSON model when nothing visible was delivered), streamOnModel
// (a single model's full attempt loop: connect-phase retries, the mid-stream
// idle guard, the finish_reason and empty-completion detections), and
// emitChunked (already-complete text re-emitted through the same delta path).
//
// Seam with pipeline.js: pipeline.js owns the phase FLOW and calls
// streamCompletion/emitChunked with the shared PipelineCtx it built in
// runPipeline; everything between "stream this answer" and the provider wire
// — retries, failover billing/alerts, stall handling — lives here. The
// PipelineCtx/PipelineState typedefs stay in pipeline.js (referenced here
// type-only, so there is no runtime import cycle).

import { classifyChatError, raiseAlert } from "./alerts.js";
import { consumeChatStream } from "./berget.js";
import { chatCompletion, providerName } from "./providers.js";
import { addUsage } from "./quota.js";

/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').ModelProfile} ModelProfile */
/** @typedef {import('./pipeline.js').PipelineCtx} PipelineCtx */

// The answer stream's inter-chunk inactivity bound. A production report
// (2026-07-08, screenshot: "stuck after a few response tokens") exposed the
// remaining unguarded hang: the round-2 fix bounds time-to-FIRST-response
// only, so a Berget stream that goes silent MID-generation (socket open, no
// chunks, no EOF) hung the pipeline forever — and because /api/chat's 15s
// SSE keepalives kept flowing, the CLIENT's stall watchdog (which stamps
// lastByteAt on keepalives too) never fired either: a truly infinite
// spinner on both sides. 60s of inter-chunk silence is far beyond anything
// a healthy stream does (slow models pause single-digit seconds between
// tokens) and cheap insurance. The enrichment describe call has its own
// bound already (src/enrichment.js).
const STREAM_IDLE_TIMEOUT_MS = 60_000;

// Whether a failed connect attempt looks provider-side and transient (worth
// another attempt) rather than deterministic (our request is at fault — a
// 400/401/413 will fail identically on every retry). Exported for tests.
/**
 * @param {number} status HTTP status of the failed connect.
 * @returns {boolean}
 */
export function isTransientConnectStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}

// A deterministic "input larger than this model's context window" upstream
// 400 (OpenAI-shape `context_length_exceeded`, or the equivalent "maximum
// context length" / "reduce the length of the messages" phrasing every
// OpenAI-compatible provider returns). Observed live (chat_logs #524,
// 2026-07-18): an introspection-mode "Security assessment" turn on the 32k
// Mistral Small prepended a source-snapshot block that overran the window,
// and the raw Berget 400 JSON was dumped straight at the user with no answer
// — the "gives up" complaint made concrete. It is NOT failover-eligible (the
// fixed JSON fallback shares the same small window and fails identically),
// and the raw provider JSON is meaningless to an end user, so we rewrite it
// into a clean, actionable sentence. Returns null for any other 400.
/**
 * @param {number} status HTTP status of the failed connect.
 * @param {string} detail Upstream response body (already truncated).
 * @returns {string | null}
 */
export function contextOverflowMessage(status, detail) {
  if (status !== 400 || !detail) return null;
  const overflow =
    /context[_ ]length[_ ]exceeded/i.test(detail) ||
    /maximum context length/i.test(detail) ||
    /context window/i.test(detail) ||
    /reduce the length of the (?:messages|input|prompt)/i.test(detail);
  if (!overflow) return null;
  return (
    "This conversation is too long for the selected model's context window. " +
    "Start a new chat, remove some attached files, or choose a model with a " +
    "larger context window, then try again."
  );
}

// Tags an error as eligible for the model failover in streamCompletion():
// set only where the failing model never delivered a byte the user still
// has on screen, so a different model's answer can't visibly diverge.
/**
 * @param {string} message
 * @returns {Error & { failover: true }}
 */
function failoverError(message) {
  const e = /** @type {Error & { failover: true }} */ (new Error(message));
  e.failover = true;
  return e;
}

// Streams one chat completion to the client; returns the full text.
//
// The user's chosen model gets its full retry budget first (streamOnModel).
// If it never delivered a visible byte — connect-phase exhaustion, an early
// stall whose fragment was discarded, clean-but-empty completions — the
// answer is retried ONCE on the pipeline's fixed reliable JSON model
// instead of erroring the chat. Observed live (2026-07-08, refs 6b753392 /
// 953b74e3): Berget's Mistral Medium refused to open a synthesis stream for
// 20+ minutes straight while Mistral Small answered the SAME requests'
// triage/gap calls in ~1-2s — retrying the dead model alone can't save
// that, but the reliable default was provably up the whole time. The
// failover is announced as a step so the user knows which model answered,
// its usage is billed to the jsonTotals bucket (that's the model that ran),
// and the provider issue still raises the admin alert an unrecovered
// failure would have — users stop hurting, admins keep seeing it.
/**
 * @param {PipelineCtx} ctx
 * @param {import('./conversation.js').Msg[]} messages
 * @returns {Promise<string>} The full streamed text.
 */
export async function streamCompletion(ctx, messages) {
  try {
    return await streamOnModel(ctx, messages, ctx.model, ctx.profile, ctx.state.totals);
  } catch (/** @type {any} */ err) {
    const fallback = ctx.jsonModel;
    if (!err?.failover || !fallback || fallback === ctx.model) throw err;
    ctx.log.warn("chat.model_failover", { from: ctx.model, to: fallback, error: err?.message || String(err) });
    const alert = classifyChatError(err?.message);
    await raiseAlert(ctx.env, alert.type, alert.severity, alert.message,
      `model: ${ctx.model} — failed over to ${fallback} — ${err?.message}`);
    const name = (/** @type {string} */ id) => String(id).split("/").pop();
    ctx.step("failover", `${name(ctx.model)} isn't responding — switching to ${name(fallback)}…`);
    try {
      const text = await streamOnModel(ctx, messages, fallback, ctx.jsonProfile, ctx.state.jsonTotals);
      ctx.state.failoverModel = fallback;
      ctx.stepDone("failover", `Answered by ${name(fallback)} — ${name(ctx.model)} was unavailable`);
      return text;
    } catch (err2) {
      ctx.stepDone("failover", `${name(fallback)} couldn't answer either`);
      throw err2;
    }
  }
}

// One model's full attempt loop; usage lands in the caller's totals bucket
// (split billing — each bucket priced at its own model's catalog rate).
/**
 * @param {PipelineCtx} ctx
 * @param {import('./conversation.js').Msg[]} messages
 * @param {string} model
 * @param {ModelProfile} profile This model's profile (retry budget).
 * @param {import('./types.js').TokenTotals} totals Billing bucket for this model's usage.
 * @returns {Promise<string>}
 */
async function streamOnModel(ctx, messages, model, profile, totals) {
  const maxAttempts = profile.maxCompletionAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Connect-phase failures get the same retry budget as the stall/empty
    // cases below — they're the CHEAPEST kind to retry (nothing has streamed
    // yet, so a second attempt can't visibly diverge from text already on
    // screen). Observed live (2026-07-08, ref 6b753392): a loaded Mistral
    // Medium sat on the synthesis request past berget.js's 30s connect
    // timeout and the abort ("The operation was aborted") threw straight
    // out of the pipeline as a fatal chat error — a provider blip the user
    // paid for with a dead research run, all searches already done.
    // The report-tier output cap (budget.js REPORT_TIER_CAPS): the extended/
    // full tiers raise max_tokens above the providers' long-standing 4096
    // default so the bigger report isn't truncated; brief/standard carry
    // 4096, keeping the default budget byte-identical on the wire.
    const maxTokens = ctx.state.plan?.synthMaxTokens;
    let upstream;
    try {
      // Cast: conversation.js's helpers hand back its looser Msg shape; the
      // messages here are the well-formed arrays the phase builders wrote.
      upstream = await chatCompletion(ctx.env, /** @type {Conversation} */ (messages), { model, maxTokens });
    } catch (/** @type {any} */ err) {
      // fetch() itself rejected: the connect-timeout abort or a network
      // reset. Always transient by nature.
      ctx.log.warn("chat.connect_failed", { model, attempt, error: err?.message || String(err) });
      if (attempt < maxAttempts) continue;
      throw failoverError(err?.message || String(err));
    }
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      // Input-too-large is deterministic and user-fixable — surface a clean,
      // actionable message instead of the raw provider JSON, and don't burn
      // the failover on it (the fallback model's window is no bigger).
      const overflow = contextOverflowMessage(upstream.status, detail);
      if (overflow) {
        ctx.log.warn("chat.context_overflow", { model, attempt, status: upstream.status });
        throw new Error(overflow);
      }
      const transient = !upstream.body || isTransientConnectStatus(upstream.status);
      ctx.log.warn("chat.connect_failed", { model, attempt, status: upstream.status, error: detail });
      if (transient && attempt < maxAttempts) continue;
      const message = `${providerName(model)} API error (${upstream.status}): ${detail}`;
      // A deterministic 4xx is OUR request's fault — the fallback model
      // would just fail the same way, so it isn't failover-eligible.
      throw transient ? failoverError(message) : new Error(message);
    }
    let streamed;
    let received = 0;
    try {
      streamed = await consumeChatStream(
        upstream.body,
        (/** @type {string} */ t) => {
          received += t.length;
          ctx.emitDelta(t);
        },
        // maxChars scales the runaway-generation safety valve with the
        // report tier — a legitimate full report can approach the default
        // 32k cap, so give a raised max_tokens matching headroom (~4 chars/
        // token, doubled) while a runaway still gets cut off by our code.
        { idleMs: STREAM_IDLE_TIMEOUT_MS, maxChars: maxTokens ? Math.max(32_000, maxTokens * 8) : undefined },
      );
    } catch (/** @type {any} */ err) {
      // A hang caught by the idle guard right at the START of the answer
      // (the reported case: a handful of tokens, then silence) is worth one
      // cheap retry — the same transient-blip reasoning as the empty-
      // completion retry below, and the user has barely seen any text. A
      // hang deep into a long answer is NOT retried (regenerated text would
      // visibly diverge from what is already on screen) — it surfaces as an
      // honest error with a (ref …) instead of an infinite spinner. The
      // client is told to discard the few rendered tokens (discard_text —
      // the same event the validation revise path uses) so the retried
      // answer doesn't append after them.
      ctx.log.warn("chat.stream_stalled", { model, attempt, received, error: err?.message || String(err) });
      if (received < 400) {
        if (received) ctx.emit({ status: { type: "discard_text" } });
        if (attempt < maxAttempts) continue;
        // Early stall, fragment already discarded — safe to hand to the
        // failover model, nothing of this model's answer remains on screen.
        throw failoverError(err?.message || String(err));
      }
      throw err;
    }
    const { text, usage, finishReason } = streamed;
    addUsage(totals, usage);
    if (!finishReason) {
      // A round 3 model-eval battery found Berget's connection can drop
      // mid-stream for some models with no error frame at all — the reader
      // just sees a clean EOF, so nothing throws and the caller would
      // otherwise silently return truncated (sometimes empty) text as if it
      // were a complete, successful answer. A normal completion always sets
      // finish_reason on its last chunk (standard OpenAI Chat Completions
      // behavior); its absence is the tell. Throwing here routes this
      // through chat.js's existing error handling — the user sees an honest
      // error instead of a confusing blank/truncated answer, and it's
      // finally visible in logs (chat.stream_failed) instead of invisible.
      throw new Error(`${providerName(model)} stream ended without a finish_reason (${text.length} chars received) — likely a dropped connection`);
    }
    if (text) return text;
    // A round 4 model-eval battery found a distinct failure mode from the
    // one above: a stream that completes CLEANLY (finish_reason set,
    // pipeline reaches "done") but with zero content — no dropped
    // connection, no thrown error, just an empty answer silently delivered
    // to the user. Retrying is cheap insurance against what looks like a
    // transient backend blip rather than a per-query determinism issue
    // (the same query succeeds cleanly on some runs); only after
    // exhausting maxCompletionAttempts (model-profiles.js — 2 by default,
    // higher for models evidenced to need it) do we give up and surface it.
    ctx.log.warn("chat.empty_completion", { model, attempt, maxAttempts });
    if (attempt === maxAttempts) {
      // Nothing was ever shown (the completions were empty) — eligible for
      // the failover model rather than surfacing an error.
      throw failoverError(`${providerName(model)} returned an empty response ${maxAttempts} times in a row for this model`);
    }
  }
  // Unreachable when maxCompletionAttempts >= 1 (model-profiles.js
  // guarantees it): the final attempt always returns or throws above.
  throw failoverError(`${providerName(model)} completion made no attempts`);
}

// Emits already-complete text as delta chunks (clarify questions, revised
// answers) so the client renders it through the same streaming path.
/**
 * @param {PipelineCtx} ctx
 * @param {string} text
 */
export function emitChunked(ctx, text) {
  for (let i = 0; i < text.length; i += 80) {
    ctx.emitDelta(text.slice(i, i + 80));
  }
}

// @ts-check
// The PROVIDER-AGNOSTIC native tool loop.
//
// Until now the one place this project let a model drive its own tools —
// introspection's source investigation and Agent Studio's build flow — spoke
// Anthropic's Messages API directly, so the exception was bounded not by policy
// but by the accident of which wire format the loop was written against. A
// Berget model with perfectly good tool support fell back to the deterministic
// path because nothing here could talk to it that way.
//
// This module is that loop, once, with the wire format as a parameter. Two
// dialects and no more:
//
//   · ANTHROPIC   — content blocks, `tool_use` / `tool_result` paired by id.
//                   Delegated to src/anthropic.js, which already had it right.
//   · OPENAI      — `tool_calls` on the assistant message, one `role: "tool"`
//                   message per call. Berget, OpenAI and the HF inference
//                   router all speak it, which is most of the catalog.
//
// THE TOOL DEFINITIONS DO NOT CHANGE SHAPE. Every tool in this repository is
// written Anthropic-style (`{ name, description, input_schema }`) and stays that
// way; `toOpenAiTools` translates at the wire, so adding a tool never means
// writing it twice and the two dialects can never drift apart in the catalog.
//
// What is deliberately NOT here: any judgement about WHEN a model should drive
// tools. That is the caller's, and it is a policy question — see
// src/agent-spec.js's capability block. This module answers "can this model do
// it, and how", never "should it".

import { anthropicToolRun } from "./anthropic.js";
import { providerConfigured, providerIdFor } from "./providers.js";

/** Rounds a loop will run before it is made to answer from what it has. */
export const DEFAULT_MAX_ROUNDS = 8;
/** One round's token cap. A round that STAGES a file needs far more than a read. */
export const DEFAULT_MAX_TOKENS = 8192;
/** One round's ceiling. Non-streaming, so this is the whole request. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Which dialect a model speaks, or `null` for "this model cannot drive tools
 * here". Null is a first-class answer, not an error: every caller has a
 * deterministic path to take instead, and taking it silently is the fail-soft
 * behaviour invariant 2 asks for.
 *
 * @param {import('./types.js').Env} env
 * @param {string} model
 * @returns {"anthropic" | "openai" | null}
 */
export function toolDialectFor(env, model) {
  const provider = providerIdFor(model);
  // Configuration is asked of the registry rather than of an env var per
  // provider: the registry is the seam that already knows which secret backs
  // which provider, and duplicating that table here is how the two drift.
  if (!providerConfigured(env, provider)) return null;
  return provider === "anthropic" ? "anthropic" : "openai";
}

/**
 * Can this run use native tools at all?
 *
 * Images are the one hard exclusion and it is not about the model: the tool
 * loop is non-streaming and re-sends the whole conversation every round, so a
 * conversation carrying image parts re-uploads them on each of up to eight
 * rounds. That is a cost the deterministic path does not pay.
 *
 * @param {import('./types.js').Env} env
 * @param {string} model
 * @param {{ hasImages?: boolean }} [ctx]
 */
export function canDriveTools(env, model, { hasImages = false } = {}) {
  if (hasImages) return false;
  return toolDialectFor(env, model) !== null;
}

/**
 * Anthropic-shaped tool definitions → OpenAI's function-calling shape.
 *
 * `input_schema` and `parameters` are the same JSON Schema under two names, so
 * this is a rename and not a translation — which is exactly why the catalog can
 * stay in one shape. A tool with no schema gets the empty object rather than
 * being dropped: some providers reject a function with no `parameters` at all.
 *
 * @param {any[]} tools
 * @returns {any[]}
 */
export function toOpenAiTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

/**
 * The OpenAI-dialect loop. Same contract as anthropicToolRun, same bounds, same
 * forced final answer when the round cap is reached.
 *
 * @param {import('./types.js').Env} env
 * @param {{
 *   model: string,
 *   system?: string,
 *   userContent: any,
 *   tools: any[],
 *   execTool: (name: string, input: any) => (string | Promise<string>),
 *   maxRounds?: number,
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   onToolUse?: (info: { round: number, name: string, input: any, result: string }) => void,
 *   chatUrl: string,
 *   headers: Record<string, string>,
 *   maxTokensField?: string,
 * }} opts
 */
export async function openAiToolRun(env, {
  model, system, userContent, tools, execTool,
  maxRounds = DEFAULT_MAX_ROUNDS, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS,
  onToolUse, chatUrl, headers, maxTokensField = "max_tokens",
}) {
  /** @type {any[]} */
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: userContent });
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const wireTools = toOpenAiTools(tools);
  let toolCalls = 0;

  /** @param {any} payload */
  const call = async (payload) => {
    const resp = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`tool call failed (${resp.status}): ${detail.slice(0, 200)}`);
    }
    const data = /** @type {any} */ (await resp.json());
    usage.prompt_tokens += data.usage?.prompt_tokens || 0;
    usage.completion_tokens += data.usage?.completion_tokens || 0;
    return data;
  };

  /** @param {any} payload */
  const withTokens = (payload) => ({ ...payload, [maxTokensField]: maxTokens });

  for (let round = 1; round <= maxRounds; round++) {
    const data = await call(withTokens({ model, messages, tools: wireTools, stream: false }));
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      return {
        text: typeof msg.content === "string" ? msg.content : textOfParts(msg.content),
        usage, rounds: round, toolCalls, stopReason: choice.finish_reason || null,
      };
    }
    // The assistant's tool_calls turn goes back verbatim, then one `tool`
    // message per call. The pairing is by `tool_call_id` and a provider will
    // reject the next request outright if one is missing — so a tool that
    // THREW still gets a reply, carrying the error as its result. That is also
    // the better answer: a model told what failed usually recovers.
    messages.push(msg);
    for (const tc of calls) {
      toolCalls++;
      const name = tc.function?.name || "";
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // A model that emitted unparseable arguments is told so rather than
        // silently receiving the result of a call it did not make.
        input = { __parse_error: String(tc.function?.arguments || "").slice(0, 500) };
      }
      let result;
      if (input && /** @type {any} */ (input).__parse_error !== undefined) {
        result = `Tool error: arguments were not valid JSON: ${/** @type {any} */ (input).__parse_error}`;
      } else {
        try {
          result = await execTool(name, input);
        } catch (/** @type {any} */ err) {
          result = `Tool error: ${err?.message || String(err)}`;
        }
      }
      const content = typeof result === "string" ? result : JSON.stringify(result);
      if (onToolUse) onToolUse({ round, name, input, result: content });
      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
  }

  messages.push({
    role: "user",
    content: "You have gathered enough. Do NOT request more tools — write the complete final answer now from what you found.",
  });
  const finalData = await call(withTokens({ model, messages, stream: false }));
  const finalMsg = finalData.choices?.[0]?.message || {};
  return {
    text: typeof finalMsg.content === "string" ? finalMsg.content : textOfParts(finalMsg.content),
    usage, rounds: maxRounds, toolCalls,
    stopReason: finalData.choices?.[0]?.finish_reason || null,
  };
}

/** Some OpenAI-compatible backends answer with content PARTS rather than a string. */
function textOfParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
}

/**
 * Run a native tool loop on whatever provider serves `model`.
 *
 * Throws when the model cannot drive tools here — callers catch and take their
 * deterministic path, which is the same thing they already did when the model
 * was not Anthropic. Throwing rather than returning empty is deliberate: an
 * empty answer is indistinguishable from a model that had nothing to say, and
 * falling back on THAT would hide a real failure.
 *
 * @param {import('./types.js').Env} env
 * @param {{
 *   model: string,
 *   system?: string,
 *   userContent: any,
 *   tools: any[],
 *   execTool: (name: string, input: any) => (string | Promise<string>),
 *   maxRounds?: number,
 *   maxTokens?: number,
 *   timeoutMs?: number,
 *   onToolUse?: (info: { round: number, name: string, input: any, result: string }) => void,
 * }} opts
 * @returns {Promise<{ text: string, usage: { prompt_tokens: number, completion_tokens: number }, rounds: number, toolCalls: number, stopReason: string | null }>}
 */
export async function toolRun(env, opts) {
  const dialect = toolDialectFor(env, opts.model);
  if (!dialect) throw new Error(`no tool dialect for model ${opts.model}`);
  if (dialect === "anthropic") return anthropicToolRun(env, opts);

  const provider = providerIdFor(opts.model);
  const wire = openAiWireFor(env, provider);
  if (!wire) throw new Error(`provider ${provider} has no OpenAI-compatible endpoint configured`);
  return openAiToolRun(env, { ...opts, ...wire });
}

/**
 * Endpoint + auth for an OpenAI-dialect provider.
 *
 * Kept here rather than exported from each provider module because it is the
 * one thing this loop needs that they do not already expose, and adding a
 * public endpoint getter to three modules to serve one caller is a wider seam
 * than a table. The GPT-5-era `max_completion_tokens` rename rides along, since
 * it is a property of the wire and not of the loop.
 *
 * @param {import('./types.js').Env} env
 * @param {string} provider
 * @returns {{ chatUrl: string, headers: Record<string, string>, maxTokensField: string } | null}
 */
export function openAiWireFor(env, provider) {
  const e = /** @type {any} */ (env);
  const bearer = (/** @type {string} */ token) => ({
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  });
  if (provider === "openai") {
    if (!e.OPENAI_API_KEY) return null;
    return {
      chatUrl: `${(e.OPENAI_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`,
      headers: bearer(env.OPENAI_API_KEY),
      // GPT-5-era models reject the legacy `max_tokens` on Chat Completions.
      maxTokensField: "max_completion_tokens",
    };
  }
  if (provider === "hf") {
    if (!e.HF_TOKEN) return null;
    return {
      chatUrl: `${(e.HF_ROUTER_URL || "https://router.huggingface.co/v1").replace(/\/$/, "")}/chat/completions`,
      headers: bearer(env.HF_TOKEN),
      maxTokensField: "max_tokens",
    };
  }
  if (!e.BERGET_API_TOKEN) return null;
  return {
    chatUrl: `${(e.BERGET_URL || "https://api.berget.ai/v1").replace(/\/$/, "")}/chat/completions`,
    headers: bearer(env.BERGET_API_TOKEN),
    maxTokensField: "max_tokens",
  };
}

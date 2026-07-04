// POST /api/chat — streaming chat with an Exa-backed web_search tool.
//
// The Worker drives the tool-call loop: the model streams either text (which
// is forwarded to the browser as OpenAI-style SSE) or tool calls (which the
// Worker executes against Exa, appending results and asking the model again).
// After MAX_TOOL_ROUNDS the model is called without tools, forcing a final
// answer. The client protocol is unchanged either way:
//   data: {"choices":[{"delta":{"content":"..."}}]}   text chunk
//   data: {"error":"..."}                             surfaced in the UI
//   data: [DONE]                                      end of stream

import { chatCompletion, consumeChatStream } from "./berget.js";
import { webSearch } from "./exa.js";
import { jsonResponse } from "./http.js";

const MAX_TOOL_ROUNDS = 3; // search rounds before forcing a final answer
const MAX_TOOL_CALLS_PER_ROUND = 5;
const MAX_MESSAGES = 60; // history cap: the API is stateless, clients resend everything
const MAX_MESSAGE_CHARS = 32_000;

const SYSTEM_PROMPT =
  "You are the assistant for Deepresearch.se. Be helpful, concise, and clear. " +
  "You have a `web_search` tool backed by Exa. Use it whenever the user asks " +
  "about recent events, current facts, specific data, or anything that may have " +
  "changed since your training. When you use search results, cite the source URLs.";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for current, factual, or up-to-date information. " +
        "Returns titles, URLs, and highlighted excerpts from relevant pages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
];

export async function handleChat(request, env, log) {
  if (!env.BERGET_API_TOKEN) {
    log.error("chat.misconfigured", { missing: "BERGET_API_TOKEN" });
    return jsonResponse(
      { error: "Server not configured: BERGET_API_TOKEN secret is missing." },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const invalid = validateMessages(body?.messages);
  if (invalid) {
    log.warn("chat.invalid_request", { reason: invalid });
    return jsonResponse({ error: invalid }, 400);
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...body.messages];
  const encoder = new TextEncoder();

  // The tool-call loop runs inside the ReadableStream so text streams to the
  // browser as it is produced, including final answers after a search.
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const startedAt = Date.now();
      let rounds = 0;
      let searches = 0;

      try {
        for (let round = 0; ; round++) {
          rounds = round + 1;
          const allowTools = round < MAX_TOOL_ROUNDS;
          const roundStartedAt = Date.now();

          const upstream = await chatCompletion(env, messages, {
            tools: allowTools ? TOOLS : undefined,
          });
          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            log.error("chat.upstream_error", {
              status: upstream.status,
              round,
              detail: detail.slice(0, 500),
            });
            emit({ error: `Berget API error (${upstream.status}).` });
            break;
          }

          const { text, toolCalls, usage, finishReason } = await consumeChatStream(
            upstream.body,
            (delta) => emit({ choices: [{ delta: { content: delta } }] }),
          );
          log.info("chat.round", {
            round,
            duration_ms: Date.now() - roundStartedAt,
            finish_reason: finishReason,
            tool_calls: toolCalls.length,
            chars_streamed: text.length,
            usage,
          });

          if (toolCalls.length === 0) break; // final answer already streamed

          if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
            log.warn("chat.tool_calls_capped", {
              requested: toolCalls.length,
              cap: MAX_TOOL_CALLS_PER_ROUND,
            });
          }
          const calls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);

          // Record the assistant's tool-call turn, then run each tool.
          messages.push({ role: "assistant", content: text || "", tool_calls: calls });
          for (const call of calls) {
            const result = await runTool(env, log, call);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          searches += calls.length;
        }
      } catch (err) {
        log.error("chat.stream_failed", { error: err?.message || String(err) });
        emit({ error: "Worker error: " + (err?.message || String(err)) });
      } finally {
        log.info("chat.complete", {
          rounds,
          searches,
          duration_ms: Date.now() - startedAt,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

// Returns an error string for invalid input, or null when acceptable.
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Expected a non-empty `messages` array.";
  }
  if (messages.length > MAX_MESSAGES) {
    return `Conversation too long (max ${MAX_MESSAGES} messages). Start a new chat.`;
  }
  for (const m of messages) {
    if (m?.role !== "user" && m?.role !== "assistant") {
      return "Each message must have role `user` or `assistant`.";
    }
    if (typeof m.content !== "string") {
      return "Each message `content` must be a string.";
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      return `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`;
    }
  }
  return null;
}

async function runTool(env, log, call) {
  const name = call.function?.name;
  if (name !== "web_search") {
    log.warn("chat.unknown_tool", { tool: name });
    return `Unknown tool: ${name}`;
  }
  let query = "";
  try {
    query = JSON.parse(call.function.arguments || "{}").query || "";
  } catch {
    log.warn("chat.bad_tool_arguments", { tool: name });
  }
  return webSearch(env, log, query);
}

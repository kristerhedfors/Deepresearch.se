// POST /api/chat — streaming chat with an Exa-backed web_search tool.
//
// The Worker drives the tool-call loop: the model streams either text (which
// is forwarded to the browser as OpenAI-style SSE) or tool calls (which the
// Worker executes against Exa, appending results and asking the model again).
// After MAX_TOOL_ROUNDS the model is called without tools, forcing a final
// answer.
//
// Client protocol (see CLAUDE.md "/api/chat SSE protocol"):
//   data: {"choices":[{"delta":{"content":"..."}}]}   text chunk
//   data: {"status":{...}}                            live activity for the UI
//   data: {"error":"..."}                             surfaced in the UI
//   data: [DONE]                                      end of stream
//
// Status events (clients must ignore unknown types):
//   search_start {round, query}
//   search_done  {round, query, results, duration_ms, sources: [{title,url}]}
//   discard_text {}  — clear the answer streamed so far (malformed tool call)
//   done         {rounds, searches, duration_ms, prompt_tokens,
//                 completion_tokens, co2_grams}

import { chatCompletion, consumeChatStream, defaultModel, listModels } from "./berget.js";
import { webSearch } from "./exa.js";
import { jsonResponse } from "./http.js";

const MAX_TOOL_ROUNDS = 5; // search rounds before forcing a final answer
const MAX_TOOL_CALLS_PER_ROUND = 5;
const MAX_MESSAGES = 60; // history cap: the API is stateless, clients resend everything
const MAX_MESSAGE_CHARS = 32_000;

const SYSTEM_PROMPT =
  "You are the research assistant for Deepresearch.se. Your job is deep " +
  "research: thorough, source-grounded answers, not quick guesses.\n\n" +
  "Workflow:\n" +
  "1. If the research request is ambiguous or missing key details (scope, " +
  "timeframe, region, purpose), first ask one short follow-up question to pin " +
  "it down — do not search yet.\n" +
  "2. Once the question is clear, research it with the `web_search` tool: run " +
  "several targeted searches from different angles, and run follow-up " +
  "searches on leads worth digging into.\n" +
  "3. Synthesize the findings into a structured answer: a short conclusion " +
  "first, then the key findings, citing source URLs for every claim. Note " +
  "disagreements between sources and gaps in the evidence honestly.\n\n" +
  "Only skip searching for small talk or questions about this site itself.\n" +
  "Always invoke web_search through the tool-calling interface — never write " +
  "the call out as text in your reply.";

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

  // Optional model override from the UI dropdown, validated against the
  // catalog. If the catalog is unreachable, fall back to the default rather
  // than blocking chat.
  let model = typeof body.model === "string" && body.model ? body.model : null;
  if (model) {
    try {
      const models = await listModels(env);
      if (!models.some((m) => m.id === model)) {
        log.warn("chat.invalid_model", { model: model.slice(0, 120) });
        return jsonResponse({ error: "Unknown model." }, 400);
      }
    } catch (err) {
      log.warn("chat.model_catalog_unavailable", { error: err?.message || String(err) });
      model = null;
    }
  }
  const activeModel = model || defaultModel(env);

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
      const totals = { prompt_tokens: 0, completion_tokens: 0, co2_grams: 0 };

      try {
        for (let round = 0; ; round++) {
          rounds = round + 1;
          const allowTools = round < MAX_TOOL_ROUNDS;
          const roundStartedAt = Date.now();

          const upstream = await chatCompletion(env, messages, {
            tools: allowTools ? TOOLS : undefined,
            model: activeModel,
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
          if (usage) {
            totals.prompt_tokens += usage.prompt_tokens || 0;
            totals.completion_tokens += usage.completion_tokens || 0;
            totals.co2_grams += usage.co2_grams || 0;
          }
          log.info("chat.round", {
            round,
            duration_ms: Date.now() - roundStartedAt,
            finish_reason: finishReason,
            tool_calls: toolCalls.length,
            chars_streamed: text.length,
            usage,
          });

          // Mistral Small occasionally writes a tool call as plain text
          // (`web_search{"query": "..."}`) instead of using the tool-calling
          // interface. Detect that, tell the UI to discard the garbage text
          // (discard_text), and run the search as if it were a real call.
          let effectiveCalls = toolCalls;
          let assistantText = text || "";
          if (toolCalls.length === 0 && allowTools) {
            const pseudo = extractPseudoToolCall(text, rounds);
            if (pseudo) {
              log.warn("chat.pseudo_tool_call", { round });
              emit({ status: { type: "discard_text" } });
              effectiveCalls = [pseudo];
              assistantText = ""; // don't feed the malformed text back to the model
            }
          }

          if (effectiveCalls.length === 0) break; // final answer already streamed

          if (effectiveCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
            log.warn("chat.tool_calls_capped", {
              requested: effectiveCalls.length,
              cap: MAX_TOOL_CALLS_PER_ROUND,
            });
          }
          const calls = effectiveCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);

          // Record the assistant's tool-call turn, then run each tool.
          messages.push({ role: "assistant", content: assistantText, tool_calls: calls });
          for (const call of calls) {
            const result = await runTool(env, log, emit, call, rounds);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          searches += calls.length;
        }
      } catch (err) {
        log.error("chat.stream_failed", { error: err?.message || String(err) });
        emit({ error: "Worker error: " + (err?.message || String(err)) });
      } finally {
        const duration_ms = Date.now() - startedAt;
        log.info("chat.complete", { rounds, searches, duration_ms, model: activeModel });
        emit({
          status: {
            type: "done",
            model: activeModel,
            rounds,
            searches,
            duration_ms,
            prompt_tokens: totals.prompt_tokens,
            completion_tokens: totals.completion_tokens,
            co2_grams: totals.co2_grams,
          },
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

// Detects a tool call written as plain text (Mistral Small quirk), e.g.
// `web_search{"query": "..."}`. Returns a synthetic tool-call object, or null.
function extractPseudoToolCall(text, round) {
  const m = (text || "").match(/web_search\s*(\{[^{}]*\})/);
  if (!m) return null;
  try {
    const args = JSON.parse(m[1]);
    if (typeof args.query === "string" && args.query) {
      return {
        id: `pseudo_${round}`,
        type: "function",
        function: { name: "web_search", arguments: JSON.stringify({ query: args.query }) },
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// Executes one tool call, emitting search_start / search_done status events
// around it so the UI can show live activity. Returns the tool result string
// that goes back to the model.
async function runTool(env, log, emit, call, round) {
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

  emit({ status: { type: "search_start", round, query } });
  const result = await webSearch(env, log, query);
  emit({
    status: {
      type: "search_done",
      round,
      query,
      results: result.resultCount,
      duration_ms: result.durationMs,
      sources: result.sources,
    },
  });
  return result.content;
}

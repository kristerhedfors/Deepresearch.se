// Berget.ai client (OpenAI-compatible chat completions API).
//
// Auth uses the BERGET_API_TOKEN secret. The default model is Mistral Small,
// overridable via the BERGET_MODEL var. See CLAUDE.md ("LLM provider").

const BERGET_URL = "https://api.berget.ai/v1/chat/completions";
export const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"; // alias: mistral-small

// Starts a streaming chat completion. Pass `tools` to enable function calling.
export function chatCompletion(env, messages, { tools } = {}) {
  const payload = {
    model: env.BERGET_MODEL || DEFAULT_MODEL,
    stream: true,
    max_tokens: 4096,
    messages,
  };
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
  return fetch(BERGET_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.BERGET_API_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
}

// Consumes one OpenAI-style SSE response body. Calls `onText` for each text
// delta as it arrives, and accumulates tool calls (which stream in fragments,
// addressed by index), usage stats, and the finish reason.
//
// Returns { text, toolCalls, usage, finishReason }.
export async function consumeChatStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = null;
  const toolCalls = []; // index -> { id, type, function: { name, arguments } }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // keep-alive / non-JSON line
      }

      // Berget appends usage chunks (token counts, then energy/CO2 stats)
      // with an empty `choices` array; merge them for logging.
      if (chunk.usage) usage = { ...(usage || {}), ...chunk.usage };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const slot = (toolCalls[i] ||= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  return { text, toolCalls: toolCalls.filter(Boolean), usage, finishReason };
}

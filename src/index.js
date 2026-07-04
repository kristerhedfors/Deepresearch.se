// Cloudflare Worker for Deepresearch.se.
//
// - Gates the entire site (UI + API) behind HTTP Basic Auth, with credentials
//   read from the BASIC_AUTH_USER / BASIC_AUTH_PASS secrets (fail closed).
// - POST /api/chat proxies Berget.ai's OpenAI-compatible chat completions API
//   (streaming) using the BERGET_API_TOKEN secret, defaulting to Mistral Small.
//   The model can call a `web_search` tool backed by Exa (EXA_API_KEY); the
//   Worker runs the tool-call loop and streams the grounded answer.
// - All other requests are served from the static ./public assets.
//
// Because auth must cover the static assets too, wrangler.toml sets
// run_worker_first = true and binds the assets as env.ASSETS.

const BERGET_URL = "https://api.berget.ai/v1/chat/completions";
const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"; // alias: mistral-small
const EXA_URL = "https://api.exa.ai/search";
const MAX_TOOL_ROUNDS = 3; // cap web-search rounds before forcing a final answer

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

export default {
  async fetch(request, env) {
    if (!isAuthorized(request, env)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Deepresearch.se", charset="UTF-8"',
        },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    // Everything else is a static asset.
    return env.ASSETS.fetch(request);
  },
};

function isAuthorized(request, env) {
  const expectedUser = env.BASIC_AUTH_USER;
  const expectedPass = env.BASIC_AUTH_PASS;
  // Fail closed: if the credential secrets aren't configured, deny everyone.
  if (!expectedUser || !expectedPass) return false;

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, expectedUser) && safeEqual(pass, expectedPass);
}

// Constant-time-ish comparison to avoid trivial timing leaks.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleChat(request, env) {
  if (!env.BERGET_API_TOKEN) {
    return json(
      { error: "Server not configured: BERGET_API_TOKEN secret is missing." },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const userMessages = Array.isArray(body?.messages) ? body.messages : null;
  if (!userMessages || userMessages.length === 0) {
    return json({ error: "Expected a non-empty `messages` array." }, 400);
  }

  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...userMessages];
  const encoder = new TextEncoder();

  // Drive the tool-call loop inside a ReadableStream so text (and final
  // answers after a search) stream to the browser as they're produced.
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for (let round = 0; ; round++) {
          const allowTools = round < MAX_TOOL_ROUNDS;
          const upstream = await callBerget(env, messages, allowTools);
          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            emit({ error: `Berget API error (${upstream.status}).`, detail });
            break;
          }

          const { text, toolCalls } = await pumpModelStream(
            upstream.body,
            emit,
          );

          if (toolCalls.length === 0) break; // final answer already streamed

          // Record the assistant's tool-call turn, then run each search.
          messages.push({ role: "assistant", content: text || "", tool_calls: toolCalls });
          for (const tc of toolCalls) {
            let query = "";
            try {
              query = JSON.parse(tc.function.arguments || "{}").query || "";
            } catch { /* leave query empty */ }
            const result = await exaSearch(env, query);
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          }
        }
      } catch (e) {
        emit({ error: "Worker error: " + (e?.message || String(e)) });
      } finally {
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

function callBerget(env, messages, allowTools) {
  const payload = {
    model: env.BERGET_MODEL || DEFAULT_MODEL,
    stream: true,
    max_tokens: 4096,
    messages,
  };
  if (allowTools) {
    payload.tools = TOOLS;
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

// Reads one OpenAI-style SSE response: forwards text deltas to the client and
// accumulates any tool_call deltas (which are addressed by index and arrive in
// fragments). Returns { text, toolCalls }.
async function pumpModelStream(body, emit) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
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
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        emit({ choices: [{ delta: { content: delta.content } }] });
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
  return { text, toolCalls: toolCalls.filter(Boolean) };
}

// Exa web search (REST). Returns a compact, LLM-friendly string of results.
async function exaSearch(env, query) {
  if (!env.EXA_API_KEY) return "Web search is unavailable: EXA_API_KEY is not configured.";
  if (!query) return "No search query was provided.";

  let resp;
  try {
    resp = await fetch(EXA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.EXA_API_KEY,
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        contents: { highlights: true },
      }),
    });
  } catch (e) {
    return `Search request failed: ${e?.message || String(e)}`;
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    return `Search error (${resp.status}): ${detail.slice(0, 300)}`;
  }

  const data = await resp.json().catch(() => ({}));
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return `No results found for: ${query}`;

  return results
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ") : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

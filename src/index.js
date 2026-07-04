// Cloudflare Worker: serves the static chat UI (via [assets]) and a streaming
// /api/chat endpoint that proxies the Anthropic Messages API.
//
// Static assets are matched first; requests that don't match an asset (i.e.
// /api/chat) fall through to this Worker.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const SYSTEM_PROMPT =
  "You are the assistant for Deepresearch.se. Be helpful, concise, and clear.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { error: "Server not configured: ANTHROPIC_API_KEY secret is missing." },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return json({ error: "Expected a non-empty `messages` array." }, 400);
  }

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      stream: true,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json(
      { error: "Upstream Anthropic API error.", status: upstream.status, detail },
      502,
    );
  }

  // Pass the Anthropic SSE stream straight through; the browser parses the
  // text_delta events. text/event-stream keeps intermediaries from buffering.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

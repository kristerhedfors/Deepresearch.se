// Cloudflare Worker for Deepresearch.se.
//
// - Gates the entire site (UI + API) behind HTTP Basic Auth (djup:forskning).
// - POST /api/chat proxies Berget.ai's OpenAI-compatible chat completions API
//   (streaming) using the BERGET_API_TOKEN secret, defaulting to Mistral Small.
// - All other requests are served from the static ./public assets.
//
// Because auth must cover the static assets too, wrangler.toml sets
// run_worker_first = true and binds the assets as env.ASSETS.

const BERGET_URL = "https://api.berget.ai/v1/chat/completions";
const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"; // alias: mistral-small
const SYSTEM_PROMPT =
  "You are the assistant for Deepresearch.se. Be helpful, concise, and clear.";

// Basic Auth credentials (overridable via BASIC_AUTH_USER / BASIC_AUTH_PASS secrets).
const DEFAULT_USER = "djup";
const DEFAULT_PASS = "forskning";

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
  const expectedUser = env.BASIC_AUTH_USER || DEFAULT_USER;
  const expectedPass = env.BASIC_AUTH_PASS || DEFAULT_PASS;

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

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return json({ error: "Expected a non-empty `messages` array." }, 400);
  }

  const upstream = await fetch(BERGET_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.BERGET_API_TOKEN}`,
    },
    body: JSON.stringify({
      model: env.BERGET_MODEL || DEFAULT_MODEL,
      stream: true,
      max_tokens: 4096,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json(
      { error: "Upstream Berget API error.", status: upstream.status, detail },
      502,
    );
  }

  // Forward the OpenAI-style SSE stream straight to the browser.
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

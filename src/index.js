// Cloudflare Worker for Deepresearch.se — entrypoint.
//
// Responsibilities: assign a request id, gate everything behind Basic Auth,
// route /api/chat vs static assets, and emit structured request logs.
// wrangler.toml sets run_worker_first = true so auth also covers the assets,
// which are served via the env.ASSETS binding.
//
// Module map:
//   src/auth.js   — Basic Auth (secrets only, fail closed)
//   src/chat.js   — /api/chat: streaming tool-call loop
//   src/berget.js — Berget.ai client + SSE consumption
//   src/exa.js    — Exa web_search tool
//   src/log.js    — structured JSON logger (LOG_LEVEL var)
//   src/http.js   — response helpers

import { requireBasicAuth } from "./auth.js";
import { defaultModel, listModels } from "./berget.js";
import { handleChat } from "./chat.js";
import { jsonResponse } from "./http.js";
import { createLogger } from "./log.js";

export default {
  async fetch(request, env) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const log = createLogger(env, {
      request_id: requestId,
      method: request.method,
      path: url.pathname,
    });

    try {
      const response = await route(request, env, url, log);
      // Note: for /api/chat this marks headers-sent; the end of the SSE
      // stream is logged separately as chat.complete.
      log.info("request.complete", {
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(response, requestId);
    } catch (err) {
      log.error("request.failed", {
        error: err?.message || String(err),
        stack: err?.stack,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(
        jsonResponse({ error: "Internal server error.", request_id: requestId }, 500),
        requestId,
      );
    }
  },
};

// Branding assets served WITHOUT auth: iOS fetches apple-touch-icon and
// Chrome downloads manifest icons without credentials, so behind Basic Auth
// home-screen/PWA icons silently 401 and fall back to a generic letter.
// Nothing sensitive here — the icon, favicon, and app name only.
function isPublicAsset(url, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/")
  );
}

async function route(request, env, url, log) {
  if (isPublicAsset(url, request.method)) {
    return env.ASSETS.fetch(request);
  }

  const denied = requireBasicAuth(request, env, log);
  if (denied) return denied;

  if (url.pathname === "/api/chat" && request.method === "POST") {
    return handleChat(request, env, log);
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    return handleModels(env, log);
  }
  return env.ASSETS.fetch(request);
}

// Model catalog for the UI dropdown (filtered + cached in src/berget.js).
async function handleModels(env, log) {
  try {
    const models = await listModels(env);
    log.debug("models.list", { count: models.length });
    return jsonResponse({ models, default: defaultModel(env) });
  } catch (err) {
    log.error("models.error", { error: err?.message || String(err) });
    return jsonResponse({ error: "Could not load the model catalog." }, 502);
  }
}

// Every response carries x-request-id so a user report can be correlated
// with the matching log entries. Clone first: asset responses are immutable.
function withRequestId(response, requestId) {
  const out = new Response(response.body, response);
  out.headers.set("x-request-id", requestId);
  return out;
}

// @ts-check
// The one server component (baseplate-worker). Gate ordering (load-bearing):
//   1. config sanity — no SESSION_SECRET => a config-error page, never a keyless
//      auth flow (fail closed).
//   2. the PUBLIC surface — the login page and the OAuth start/callback, which
//      by definition have no identity yet.
//   3. the identity gate — identify(); anonymous callers get the login page
//      (HTML) or a 401 (API).
//   4. routeAuthed — the app shell (static assets) + /api/chat + /logout.
// run_worker_first = true (wrangler.toml) means the worker sees every request,
// so the gate covers the static assets too.

import { identify, clearSessionCookie } from "./auth.js";
import { googleLogin, googleCallback, loginPage, googleConfigured } from "./google.js";
import { runPipeline } from "./pipeline.js";
import { createLogger } from "./log.js";
import { jsonResponse, htmlResponse } from "./http.js";

export default {
  /**
   * @param {Request} request
   * @param {any} env
   * @param {any} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID().slice(0, 8);
    const log = createLogger(env, { rid: requestId, path: url.pathname });

    try {
      const { response, refreshCookie } = await route(request, env, url, log);
      // Sliding sessions: reissue the cookie past its half-life.
      if (refreshCookie) response.headers.append("Set-Cookie", refreshCookie);
      return response;
    } catch (e) {
      log.error("worker.unhandled", { message: String(e && /** @type {any} */ (e).message) });
      return jsonResponse({ error: "internal error", ref: requestId }, 500);
    }
  },
};

/**
 * @param {Request} request @param {any} env @param {URL} url @param {import('./log.js').Logger} log
 * @returns {Promise<{ response: Response, refreshCookie?: string }>}
 */
async function route(request, env, url, log) {
  // 1. Config sanity — the whole site needs SESSION_SECRET to run sessions.
  if (!env.SESSION_SECRET) {
    if (url.pathname.startsWith("/api/")) return { response: jsonResponse({ error: "not configured" }, 503) };
    return { response: configErrorPage() };
  }

  // 2. The public (pre-identity) surface.
  if (url.pathname === "/auth/login" && googleConfigured(env)) {
    return { response: await googleLogin(url, env, log) };
  }
  if (url.pathname === "/auth/callback" && googleConfigured(env)) {
    return { response: await googleCallback(url, request, env, log) };
  }
  if (url.pathname === "/logout") {
    return {
      response: new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": clearSessionCookie() },
      }),
    };
  }

  // 3. The identity gate.
  const identity = await identify(request, env);
  if (!identity) {
    if (url.pathname.startsWith("/api/")) return { response: jsonResponse({ error: "unauthorized" }, 401) };
    return { response: loginPage(env) };
  }
  const refreshCookie = identity.refreshCookie ? await (await import("./auth.js")).createSessionCookie(env, identity.uid) : undefined;

  // 4. Authed routes.
  const authed = await routeAuthed(request, env, url, log, identity);
  return { response: authed, refreshCookie };
}

/**
 * @param {Request} request @param {any} env @param {URL} url
 * @param {import('./log.js').Logger} log @param {import('./auth.js').Identity} identity
 * @returns {Promise<Response>}
 */
async function routeAuthed(request, env, url, log, identity) {
  // The streaming research endpoint.
  if (url.pathname === "/api/chat" && request.method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "bad json" }, 400);
    }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      return jsonResponse({ error: "messages required" }, 400);
    }
    log.info("chat.start", { uid: identity.uid, turns: body.messages.length });
    const stream = runPipeline(env, log, body);
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  // A tiny "who am I / is search on" probe for the client.
  if (url.pathname === "/api/me" && request.method === "GET") {
    return jsonResponse({ uid: identity.uid, admin: identity.isAdmin, search: String(env.SEARCH_ENABLED ?? "true") !== "false" });
  }

  // Everything else -> the static app shell (served behind the gate).
  return env.ASSETS.fetch(request);
}

function configErrorPage() {
  return htmlResponse(
    `<!doctype html><meta charset="utf-8"><title>Not configured</title>` +
      `<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Instance not configured</h1><p>This DeepResearch Lite instance has no ` +
      `<code>SESSION_SECRET</code>. Set it (and the provider secrets) with ` +
      `<code>wrangler secret put</code> before it can run sessions.</p></body>`,
    503,
  );
}

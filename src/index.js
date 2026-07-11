// @ts-check
// Cloudflare Worker for Deepresearch.se — entrypoint.
//
// Responsibilities: assign a request id, resolve the caller's identity
// (Google-provisioned D1 user via the session cookie, or the admin-secrets
// break-glass over Basic Auth), route APIs vs static assets, slide the
// session cookie, and emit structured request logs. wrangler.toml sets
// run_worker_first = true so auth also covers the assets, which are served
// via env.ASSETS.
//
// Gate ordering (load-bearing, enforced in route/routeAuthed):
//   identity → terms acceptance → approval → handlers.
//
// Module map:
//   src/auth.js      — identity: session cookie + admin break-glass
//   src/google.js    — Google OIDC sign-in (the only user-facing login)
//   src/login.js     — sign-in page (PWAs can't answer a 401 challenge)
//   src/accounts.js  — user accounts (D1)
//   src/config.js    — global site config (D1 config table, cached)
//   src/quota.js     — usage accounting + quota enforcement
//   src/user-api.js  — /api/me + /api/models + /api/client-error + /api/history-key
//   src/history-key.js — per-user key for the client's encrypted local history
//   src/settings.js  — per-user settings (/api/settings: server_history + shodan_mcp knobs)
//   src/storage.js   — opt-in R2 cloud storage (/api/convos, /api/files, /api/storage)
//   src/rag.js       — document RAG: /api/embed proxy + /api/rag/* (Vectorize)
//   src/quiz-api.js  — /api/quiz/grade: free-text quiz-answer grading (src/quiz.js)
//   src/games.js     — /api/games: the games registry/shelf + per-game dispatch
//                      (Tokemon: src/tokemon-api.js, game core src/tokemon.js)
//   src/admin-api.js — /api/admin/* JSON API
//   src/chat.js      — /api/chat: streaming research pipeline
//   src/answers.js   — /api/chat/answer: TTL'd answer recovery cache
//   src/berget.js    — Berget.ai client + SSE consumption
//   src/exa.js       — Exa web_search
//   src/db.js        — optional D1 binding + schema
//   src/log.js       — structured JSON logger (LOG_LEVEL var)
//   src/http.js      — response helpers

import { handleAdminApi } from "./admin-api.js";
import { handleAnswerAck, handleAnswerGet } from "./answers.js";
import { clearSessionCookie, createSessionCookie, identify } from "./auth.js";
import { handleChat } from "./chat.js";
import { handleMcp } from "./mcp.js";
import { handleGoogleCallback, handleGoogleStart } from "./google.js";
import { jsonResponse } from "./http.js";
import { createLogger } from "./log.js";
import { acceptTerms } from "./accounts.js";
import { configErrorPage, loginPage, pendingPage, termsPage } from "./login.js";
import {
  handleClientError,
  handleHistoryKey,
  handleMe,
  handleMessages,
  handleModels,
} from "./user-api.js";
import { handleFeedbackApi } from "./feedback.js";
import { bashLiteEnabled, handleSettingsGet, handleSettingsPut } from "./settings.js";
import { handleBashStep } from "./bash-api.js";
import { handleStorage } from "./storage.js";
import { handleVault } from "./vault.js";
import { handleEmbed, handleRag } from "./rag.js";
import { handleQuizGrade } from "./quiz-api.js";
import { handleGames } from "./games.js";
import { handlePubGet, handlePubWrite } from "./pub.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */
/**
 * What `route` hands back to `fetch`: the response, plus the resolved
 * identity (when there is one) so the session cookie can slide.
 * @typedef {{ response: Response, identity?: Identity }} RouteResult
 */

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const log = createLogger(env, {
      request_id: requestId,
      method: request.method,
      path: url.pathname,
      host: url.host,
    });

    try {
      const { response, identity } = await route(request, env, url, log, ctx, requestId);
      // Note: for /api/chat this marks headers-sent; the end of the SSE
      // stream is logged separately as chat.complete.
      log.info("request.complete", {
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      const out = withRequestId(response, requestId);
      // Sliding sessions: past the cookie's half-life, reissue it so active
      // PWA users never see a login screen again.
      if (identity?.refreshCookie) {
        out.headers.append("Set-Cookie", await createSessionCookie(env, identity.id));
      }
      return out;
    } catch (err) {
      log.error("request.failed", {
        error: /** @type {any} */ (err)?.message || String(err),
        stack: /** @type {any} */ (err)?.stack,
        duration_ms: Date.now() - startedAt,
      });
      return withRequestId(
        jsonResponse({ error: "Internal server error.", request_id: requestId }, 500),
        requestId,
      );
    }
  },
};

// The public surface, served WITHOUT auth. Two kinds of things live here:
//
// Branding assets: iOS fetches apple-touch-icon and Chrome downloads
// manifest icons without credentials, so behind auth home-screen/PWA
// icons silently 401 and fall back to a generic letter.
//
// The promotional surface: the landing page (/welcome/, also served to
// signed-out visitors at /), the documentation, About, and the build
// story pages plus everything they need to render — the promo video, the
// markdown renderer, and the vendored libs (all public on GitHub anyway).
// The app itself and every /api/* stay gated.
/**
 * @param {URL} url
 * @param {string} method
 * @returns {boolean}
 */
function isPublicAsset(url, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/welcome/") ||
    url.pathname.startsWith("/help/") ||
    url.pathname.startsWith("/build/") ||
    url.pathname.startsWith("/story/") ||
    // DRC — the no-account client-side tier at /cure: the page, its
    // modules, and the vault/SSE primitives it reuses. Only FILES (with
    // an extension) match here: extensionless paths under /cure/ are page
    // routes (/cure/<slug> replays) and must fall through to the wordplay
    // routing below — without the extension check they'd 404 as missing
    // assets (found live 2026-07-10: /cure/<slug> served the sign-in 401,
    // then 404, until this).
    (url.pathname.startsWith("/cure/") && /\.[a-z0-9]+$/i.test(url.pathname)) ||
    // The vault's PURE core only — NOT /js/vault.js: that module's store/load
    // orchestration statically imports the DRS storage stack (history-store/
    // opfs/projects), which is deliberately not public, and any 401 inside a
    // public module graph kills the whole /cure tier (found live 2026-07-11:
    // /cure was dead — static "d5" stamp — because drc-core.js imported
    // vault.js and its DRS chain 401'd; fixed by splitting vault-core.js out
    // and importing that). If a module here ever needs vault functionality,
    // import vault-core.js, never vault.js.
    url.pathname === "/js/vault-core.js" ||
    url.pathname === "/js/sse.js" ||
    url.pathname === "/js/drc-core.js" ||
    url.pathname === "/js/drc-providers.js" ||
    url.pathname === "/js/drc-rag.js" ||
    // drc-rag.js's import chain: rag.js/chat-rag.js (the reused pure
    // helpers) each import settings.js — all three must be public or the
    // /cure module graph fails to link (the same class of breakage the
    // extension check above fixed; found live 2026-07-10 when d6 shipped
    // with drc-rag.js absent from this list).
    url.pathname === "/js/rag.js" ||
    url.pathname === "/js/chat-rag.js" ||
    url.pathname === "/js/settings.js" ||
    url.pathname === "/js/drc-research.js" ||
    url.pathname === "/js/drc-store.js" ||
    // drc-research.js statically imports the bash-lite sandbox modules (the
    // in-browser Linux execution tier is present on DRC too): the shared pure
    // agent core (bash-core.js — also imported by the DRS driver
    // bash-agent.js) AND the CheerpX VM bridge. All must be public or the
    // /cure module graph fails to link and the whole client tier's JS dies —
    // the same breakage class as drc-rag.js above (found live 2026-07-11: the
    // sandbox commit added the imports to drc-research.js but not to this
    // allowlist, so /js/bash-agent.js and /js/sandbox.js 401'd and /cure went
    // dark).
    url.pathname === "/js/bash-core.js" ||
    url.pathname === "/js/bash-agent.js" ||
    url.pathname === "/js/sandbox.js" ||
    // sandbox.js imports sandbox-files.js (the file-mounting pure core) — both
    // must be public or the /cure module graph (drc-research.js → sandbox.js)
    // fails to link.
    url.pathname === "/js/sandbox-files.js" ||
    url.pathname === "/llm-assiterad-utveckling.mp4" ||
    url.pathname === "/js/markdown.js" ||
    url.pathname === "/vendor/marked.min.js" ||
    url.pathname === "/vendor/purify.min.js"
  );
}

// Serves a static asset with an EXPLICIT browser-caching policy. Without
// one (the state until 2026-07-08), browsers applied HEURISTIC caching to
// the app's ~20 unversioned ES modules — and a day with several deploys
// that changed cross-module exports left real devices with a MIXED module
// graph (a fresh stream.js importing a stale-cached activity.js). The
// import linker then fails, app.js never runs, no submit handler attaches,
// and pressing Send falls through to the browser's NATIVE form submit — a
// full page reload that looks like the chat silently resetting to a blank
// new conversation ("no queries work"). `no-cache` (= store but REVALIDATE
// every use) fixes the class: the strong etags Workers assets already emit
// make revalidation a cheap 304, and every page load links a consistent,
// current module graph. Icons/media (not part of the module graph, rarely
// changed) keep a short real TTL. The Cloudflare EDGE cache is unaffected
// and safe — it is content-addressed per deploy.
const ASSET_REVALIDATE = /\.(js|css|html|md|webmanifest)$/i;
/**
 * @param {Request} request
 * @param {Env} env
 * @param {string | null} [overrideUrl] serve this path instead of the request's
 * @param {{ coep?: boolean }} [opts] coep: add Cross-Origin-Embedder-Policy so
 *   the served DOCUMENT becomes cross-origin isolated (with the site-wide
 *   COOP: same-origin), which SharedArrayBuffer — and thus the CheerpX
 *   execution sandbox (public/js/sandbox.js) — requires. We use `require-corp`
 *   (NOT `credentialless`): iOS Safari / WebKit does not implement
 *   `credentialless` COEP, so it silently never isolates there —
 *   `SharedArrayBuffer` stays undefined and the VM can't boot (confirmed live
 *   on iOS 18.7 Safari: header served, `crossOriginIsolated===false`,
 *   `SharedArrayBuffer` absent). `require-corp` is honored by Chrome, Firefox,
 *   AND Safari. Its cost: every cross-origin subresource must carry CORP — the
 *   sandbox's CDN loads (jsdelivr xterm, cxrtnc CheerpX) already send
 *   `Cross-Origin-Resource-Policy: cross-origin`, and the server-fetched Maps
 *   imagery is same-origin, so the only casualty is the keyless Street View
 *   Embed IFRAME (no CORP) — an acceptable trade for a sandbox that actually
 *   boots on iOS. Applied to the DRC page always and to the DRS app shell only
 *   when the caller's bash_lite knob is on (see routeAuthed).
 * @returns {Promise<Response>}
 */
async function serveAsset(request, env, overrideUrl = null, opts = {}) {
  // The COEP (cross-origin-isolated) shell must be served as a FRESH 200 that
  // is never cached: the COEP header is added dynamically per the bash_lite
  // knob, but the HTML content is identical whether the knob is on or off, so
  // a normal `no-cache` revalidation returns a 304 and the browser reuses its
  // stored NON-isolated response WITHOUT the COEP header — `crossOriginIsolated`
  // never turns on and the sandbox silently can't boot (the production defect
  // this fixes). So for the isolated shell we strip the request's conditional
  // headers (forcing a full 200, not a 304) and mark it `no-store`.
  const upstream = buildAssetRequest(request, overrideUrl, opts.coep);
  const res = await env.ASSETS.fetch(upstream);
  const pathname = new URL(overrideUrl || request.url).pathname;
  const headers = new Headers(res.headers);
  if (opts.coep) {
    headers.set("cross-origin-embedder-policy", "require-corp");
    headers.set("cache-control", "no-store");
  } else if (ASSET_REVALIDATE.test(pathname) || !/\.[a-z0-9]+$/i.test(pathname)) {
    // Extensionless paths are HTML routes (/, /welcome/, /admin) — revalidate.
    headers.set("cache-control", "no-cache");
  } else {
    headers.set("cache-control", "public, max-age=3600");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Builds the request handed to env.ASSETS. Normally the original request (or an
 * override URL). For the isolated (coep) shell, conditional headers are
 * stripped so ASSETS returns a full 200 (never a 304 that would drop the
 * dynamic COEP header — see serveAsset).
 * @param {Request} request
 * @param {string | null} overrideUrl
 * @param {boolean | undefined} coep
 * @returns {Request}
 */
function buildAssetRequest(request, overrideUrl, coep) {
  if (!coep) return overrideUrl ? new Request(overrideUrl, request) : request;
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(overrideUrl || request.url, { method: request.method, headers });
}

/**
 * Top-level routing: config sanity, the public (unauthenticated) surface,
 * then the identity gate ahead of everything else. Returns the identity
 * only when resolved, so the caller can slide the session cookie.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<RouteResult>}
 */
async function route(request, env, url, log, ctx, requestId) {
  // Canonical host. The Worker is routed on BOTH the apex and www
  // (wrangler.toml: deepresearch.se + www.deepresearch.se), but the whole app
  // must live on ONE host. Google OAuth's redirect_uri is registered only for
  // the apex, so a request arriving on www builds a www redirect_uri Google
  // rejects — "Error 400: redirect_uri_mismatch", hit signing in via
  // www.deepresearch.se (Firefox Focus). Pinning only the redirect_uri would
  // then split the CSRF state cookie across the two hosts, so instead
  // canonicalize FIRST: 301 www.* → apex, preserving path + query, so the whole
  // flow (state cookie, redirect_uri, callback, session) stays on the one
  // registered host.
  if (url.hostname.startsWith("www.")) {
    const canonical = new URL(url.toString());
    canonical.hostname = url.hostname.slice("www.".length);
    return { response: new Response(null, { status: 301, headers: { Location: canonical.toString() } }) };
  }

  // Hard configuration requirement: SESSION_SECRET must be set. It is the sole
  // key that signs/verifies session and OAuth-state cookies — the legacy
  // admin-credential-derived fallback was removed (it re-exposed the admin
  // password to offline brute force from any captured cookie; see src/auth.js).
  // Without the secret there is no safe way to run sessions, so instead of
  // degrading, present a clear misconfiguration message across the whole site.
  if (!env.SESSION_SECRET) {
    log.error("config.missing_session_secret", {});
    if (url.pathname.startsWith("/api/")) {
      return {
        response: jsonResponse({ error: "Server not configured: SESSION_SECRET is missing." }, 503),
      };
    }
    return { response: htmlResponse(configErrorPage(), 503) };
  }

  if (isPublicAsset(url, request.method)) {
    return { response: await serveAsset(request, env) };
  }

  // ---- the wordplay URL map (all BEFORE the identity gate) -----------------
  // The .se domain completes English words, and the two product tiers live
  // under them:
  //   deepresearch.se/cure — DRC, "deep research SECURE" (C = CLIENT-side):
  //       the public tier. Minimal server involvement by DESIGN: this
  //       Worker serves the static page and the public replay JSONs, and
  //       nothing else — model calls go browser→provider directly, storage
  //       is browser-local (public/cure/, public/js/drc-*.js). The root /
  //       redirects here; /my/project-<hash> reopens a browser-local saved
  //       project; /cure/<slug> is a published frozen replay (src/pub.js +
  //       the publish-research skill), continue-able in place.
  //   deepresearch.se/rver — DRS, "deep research SERVER" (R = REMOTE, as in
  //       a remote cloud-server): the signed-in tier with the hosted
  //       pipeline, web search, accounts, and cloud storage (handled in
  //       routeAuthed; unauthenticated visitors get the login page).
  // /free and /free/project-… are legacy aliases from DRC's free-mode era.
  // The root stays the PROMOTIONAL LANDING (public/welcome/) for visitors —
  // it links both tiers; signed-in arrivals are forwarded to DRS below.
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    (url.pathname === "/cure" ||
      /^\/cure\/[a-z0-9-]*$/.test(url.pathname) ||
      url.pathname === "/my" ||
      url.pathname === "/my/" ||
      url.pathname.startsWith("/my/project-") ||
      url.pathname === "/free" ||
      url.pathname === "/free/" ||
      url.pathname.startsWith("/free/project-"))
  ) {
    // The DRC page is served cross-origin isolated (COEP) so its client-side
    // execution sandbox (the experimental bash-lite tier) can boot CheerpX.
    // DRC's knob is browser-local (no server-side account to read here), and
    // the khaki page is self-contained — no cross-origin iframe to break — so
    // isolation is safe to apply unconditionally.
    return { response: await serveAsset(request, env, url.origin + "/cure/", { coep: true }) };
  }
  if (request.method === "GET" && (url.pathname === "/api/pub" || url.pathname.startsWith("/api/pub/"))) {
    const slug = url.pathname === "/api/pub" ? null : decodeURIComponent(url.pathname.slice("/api/pub/".length));
    return { response: await handlePubGet(env, slug) };
  }

  // ---- unauthenticated: sign-in surface -----------------------------------
  if (url.pathname === "/login" && request.method === "GET") {
    return { response: htmlResponse(loginPage(url.searchParams.get("flash") || ""), 200) };
  }
  if (url.pathname === "/auth/google" && request.method === "GET") {
    return { response: await handleGoogleStart(request, env, url, log) };
  }
  if (url.pathname === "/auth/google/callback" && request.method === "GET") {
    return { response: await handleGoogleCallback(request, env, url, log) };
  }

  // ---- everything else requires an identity ------------------------------
  const identity = await identify(request, env);
  if (!identity) {
    // Visitors hitting the root get the promotional landing page (video,
    // docs, build story, sign-in, and the DRC try-it-now link) rather
    // than a bare login form.
    if (url.pathname === "/" && request.method === "GET") {
      return {
        response: await serveAsset(request, env, url.origin + "/welcome/"),
      };
    }
    log.warn("auth.denied", { reason: "unauthenticated" });
    if (url.pathname.startsWith("/api/")) {
      return { response: jsonResponse({ error: "Authentication required." }, 401) };
    }
    // Sign-in page instead of a WWW-Authenticate challenge: installed PWAs
    // cannot show the native Basic Auth dialog (black screen on iOS).
    return { response: htmlResponse(loginPage(""), 401) };
  }

  const response = await routeAuthed(request, env, url, log, identity, ctx, requestId);
  return { response, identity };
}

/**
 * Routing behind the identity gate: logout, then the terms and approval
 * gates (in that order), then the API/admin/asset handlers.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<Response>}
 */
async function routeAuthed(request, env, url, log, identity, ctx, requestId) {
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
    });
  }

  // ---- terms gate, then approval gate (order is load-bearing) ------------
  const termsResponse = await termsGate(request, env, url, identity);
  if (termsResponse) return termsResponse;

  // Approval gate: pending users are parked on the waiting page — no APIs,
  // no app, no admin — until the admin flips them to active. The page
  // auto-refreshes, so approval takes effect without a re-login.
  if (identity.pending) {
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Your account is awaiting approval.", pending: true }, 403);
    }
    return htmlResponse(pendingPage(identity), 200);
  }

  const apiResponse = await routeApi(request, env, url, log, identity, ctx, requestId);
  if (apiResponse) return apiResponse;

  // ---- admin-only: the JSON API and the admin UI assets ------------------
  if (url.pathname.startsWith("/api/admin/")) {
    if (identity.role !== "admin") return jsonResponse({ error: "Admin access required." }, 403);
    return handleAdminApi(request, env, url, log, identity);
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    if (identity.role !== "admin") {
      return new Response(null, { status: 302, headers: { Location: "/rver" } });
    }
    return serveAsset(request, env);
  }

  // Publishing (PUT/DELETE /api/pub/:slug) is the ONE write surface of the
  // published-replays feature — admin only (the public reads are routed
  // before the identity gate).
  if (url.pathname.startsWith("/api/pub/")) {
    if (identity.role !== "admin") return jsonResponse({ error: "Admin access required." }, 403);
    return handlePubWrite(request, env, log, decodeURIComponent(url.pathname.slice("/api/pub/".length)));
  }

  // The signed-in app — DRS, "deep research SERVER" — lives at /rver (the
  // URL wordplay above): serve the app shell there. A signed-in arrival at
  // the root is forwarded home (the landing is for visitors).
  //
  // When this account has the experimental bash-lite sandbox on, the app
  // shell (and its assets) are served cross-origin isolated (COEP) so CheerpX
  // can boot; off (the default) they are served exactly as before, so the
  // Street View keyless-iframe fallback is untouched for everyone else.
  const coep = bashLiteEnabled(env, identity);
  if ((url.pathname === "/rver" || url.pathname === "/rver/") && request.method === "GET") {
    return serveAsset(request, env, url.origin + "/", { coep });
  }
  if (url.pathname === "/" && request.method === "GET") {
    return new Response(null, { status: 302, headers: { Location: "/rver" } });
  }

  return serveAsset(request, env, null, { coep });
}

/**
 * Terms gate: every account must accept the terms of use once, right
 * after first sign-in — before the approval wait, the app, or any API.
 * The break-glass identity has no user row to record acceptance on and
 * is exempt (it's the operator). /build/ (About) and /story/ (build
 * history) stay readable pre-acceptance so the full text the terms
 * summarize is one tap away, and /logout is handled before this gate.
 * Static assets (js/css/vendor/markdown files, matched by file extension)
 * always pass through — they're inert code, not gated content, and
 * /build/ + /story/ need their own scripts and history.md to render.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Identity} identity
 * @returns {Promise<Response | null>} null when the gate lets the request through
 */
async function termsGate(request, env, url, identity) {
  if (!identity.user || identity.user.terms_accepted_at) return null;

  if (url.pathname === "/terms/accept" && request.method === "POST") {
    await acceptTerms(env, identity.user.id);
    return new Response(null, { status: 303, headers: { Location: "/rver" } });
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "The terms of use must be accepted first.", terms: true }, 403);
  }
  const isStaticAsset = request.method === "GET" && /\.[a-z0-9]+$/i.test(url.pathname);
  const isAllowedPage = request.method === "GET" && /^\/(build|story)(\/|$)/.test(url.pathname);
  if (isStaticAsset || isAllowedPage) {
    return serveAsset(request, env);
  }
  return htmlResponse(termsPage(identity), 200);
}

/**
 * The signed-in (non-admin-gated) API surface, one route per handler
 * module. Returns null when nothing matched, so routeAuthed can continue
 * to the admin routes and the asset fallback.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<Response | null>}
 */
async function routeApi(request, env, url, log, identity, ctx, requestId) {
  if (url.pathname === "/api/chat" && request.method === "POST") {
    return handleChat(request, env, log, identity, ctx, requestId);
  }
  // MCP server (Streamable HTTP, JSON-RPC 2.0): exposes the research pipeline
  // as a `deep_research` tool for other agents. Placed after the identity gate
  // so it inherits the same access control (break-glass Basic Auth header or a
  // signed-in session).
  if (url.pathname === "/mcp" && request.method === "POST") {
    return handleMcp(request, env, log, identity, ctx, requestId);
  }
  // Answer recovery (src/answers.js): poll a dropped stream's finished
  // answer back, or ack an intact delivery so the cached copy is purged.
  if (url.pathname === "/api/chat/answer" && request.method === "GET") {
    return handleAnswerGet(env, url, identity);
  }
  if (url.pathname === "/api/chat/answer" && request.method === "DELETE") {
    return handleAnswerAck(env, url, identity);
  }
  if (url.pathname === "/api/models" && request.method === "GET") {
    return handleModels(env, log);
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    return handleMe(env, identity);
  }
  if (url.pathname === "/api/history-key" && request.method === "GET") {
    return handleHistoryKey(env, identity);
  }
  if (url.pathname === "/api/messages" && request.method === "GET") {
    return handleMessages(env, identity);
  }
  // Per-user settings (server_history + shodan_mcp knobs).
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return handleSettingsGet(env, identity);
  }
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    return handleSettingsPut(request, env, log, identity);
  }
  // Feedback mode (src/feedback.js): the user's own feedback entries and
  // their dialogue threads with the development agent.
  if (url.pathname === "/api/feedback" || url.pathname.startsWith("/api/feedback/")) {
    return handleFeedbackApi(request, env, url, log, identity);
  }
  // Free-text quiz-answer grading (the inline-quiz capability —
  // src/quiz-api.js; multiple-choice picks grade client-side).
  if (url.pathname === "/api/quiz/grade" && request.method === "POST") {
    return handleQuizGrade(request, env, log, identity);
  }
  // One turn of the experimental bash-lite agent loop (src/bash-api.js): the
  // browser-orchestrated in-browser Linux sandbox asks what command to run
  // next. Knob-gated inside the handler (bash_lite_mcp).
  if (url.pathname === "/api/bash/step" && request.method === "POST") {
    return handleBashStep(request, env, log, identity);
  }
  // Document-RAG embedding proxy (used in BOTH storage modes) + the
  // server-side index endpoints (knob-gated inside src/rag.js).
  if (url.pathname === "/api/embed" && request.method === "POST") {
    return handleEmbed(request, env, log, identity);
  }
  if (url.pathname.startsWith("/api/rag/")) {
    return handleRag(request, env, url, log, identity);
  }
  // Opt-in cloud storage: encrypted conversation/project records + files.
  if (
    url.pathname === "/api/convos" ||
    url.pathname.startsWith("/api/convos/") ||
    url.pathname === "/api/projects" ||
    url.pathname.startsWith("/api/projects/") ||
    url.pathname === "/api/files" ||
    url.pathname.startsWith("/api/files/") ||
    url.pathname === "/api/storage"
  ) {
    return handleStorage(request, env, url, log, identity);
  }
  // The secret-keyed project vault (src/vault.js): client-encrypted project
  // archives under a user-held secret the server never sees. Deliberately
  // NOT knob-gated — each store is its own explicit consent, and the blob
  // is ciphertext only.
  if (url.pathname.startsWith("/api/vault/")) {
    return handleVault(request, env, url, log, identity);
  }
  // The games subsystem (src/games.js): GET /api/games lists the shelf the
  // account panel renders; /api/games/<id>/* dispatches to the registered
  // game's own API (Tokemon: src/tokemon-api.js, core in src/tokemon.js).
  if (url.pathname === "/api/games" || url.pathname.startsWith("/api/games/")) {
    return handleGames(request, env, url, log, identity);
  }
  if (url.pathname === "/api/client-error" && request.method === "POST") {
    return handleClientError(request, log, identity);
  }
  return null;
}

/**
 * @param {string} html
 * @param {number} status
 * @returns {Response}
 */
function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Master switch for the Content-Security-Policy header (below). CSP is the
// strongest defense here but the most brittle while the integrations are still
// in flux — a single missed subresource host silently breaks a feature (e.g.
// Maps/Street View), so it stays OFF until that surface stabilizes. Flip to
// `true` to enforce; when doing so, re-verify the script-src hashes and the
// Maps/*.googleapis/*.gstatic origins against a live page (watch the browser
// console for CSP violations). Every OTHER security header below is safe and
// stays on unconditionally regardless of this flag.
const CSP_ENABLED = false;

// Content-Security-Policy for every response. The app renders untrusted LLM
// output and third-party web-search content into the DOM, so this is the
// second line of defense behind DOMPurify (markdown.js): even a sanitizer
// bypass or a tampered vendored purify.min.js cannot execute injected script
// under this policy. Currently gated OFF by CSP_ENABLED above.
//
// script-src is a strict allowlist — 'self' (the ES-module app + vendored
// libs), the two Google Maps hosts (the Street View SDK, loaded on demand),
// and the sha256 hashes of the ONLY two inline scripts in the whole surface:
// index.html's non-module boot guard and story/index.html's inline module.
// There is NO 'unsafe-inline' and NO 'unsafe-eval', so injected inline
// <script> / on*= handlers do not run. If either inline script is edited,
// recompute its hash (the boot guard only loses its safety net on a mismatch;
// the core app is external modules and is unaffected):
//   node -e 'const c=require("crypto"),h=require("fs").readFileSync("public/index.html","utf8").match(/<script>([\s\S]*?)<\/script>/)[1];console.log("sha256-"+c.createHash("sha256").update(h).digest("base64"))'
// Maps pulls tiles/styles/XHR from *.googleapis.com / *.gstatic.com; if any
// Maps subresource is ever blocked, renderStreetViewEmbed already fails soft
// to the keyless google.com Embed iframe (frame-src), so Street View degrades
// rather than breaking. img-src stays broad (data:/blob:/https:) for user
// uploads, server data-URL frames, and Maps imagery.
const BOOT_GUARD_HASH = "'sha256-w5cPLY1sDxZyXuQvRq2aJ4i2L1jyBf4ulNgTL0pzf10='";
const STORY_INLINE_HASH = "'sha256-ATMgXgI8+2fgznyrbCNX5n9ZAqIHL8/YoN64WD6CwlI='";
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' https://maps.googleapis.com https://maps.gstatic.com ${BOOT_GUARD_HASH} ${STORY_INLINE_HASH}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://*.googleapis.com https://*.gstatic.com",
  "frame-src https://www.google.com",
  "upgrade-insecure-requests",
].join("; ");

// Applied to every response (see below). frame-ancestors (CSP) plus
// X-Frame-Options both block clickjacking of the authenticated app; nosniff
// stops MIME confusion on served/stored content; HSTS pins HTTPS; the
// Referrer-Policy / COOP / Permissions-Policy lines minimize leakage and
// cross-window/API exposure. All are static and carry no breakage risk.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  // geolocation=(self): the Tokemon game (/games/tokemon/) walks the map by
  // real GPS position; everything else stays denied.
  "permissions-policy": "geolocation=(self), microphone=(), camera=(), payment=()",
};

// Every response carries x-request-id so a user report can be correlated
// with the matching log entries, plus the site-wide security headers. Clone
// first: asset responses are immutable.
/**
 * @param {Response} response
 * @param {string} requestId
 * @returns {Response}
 */
function withRequestId(response, requestId) {
  const out = new Response(response.body, response);
  out.headers.set("x-request-id", requestId);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Don't clobber a header a handler set deliberately (none set these today).
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  // CSP is opt-in (see CSP_ENABLED) — off while integrations are in flux.
  if (CSP_ENABLED && !out.headers.has("content-security-policy")) {
    out.headers.set("content-security-policy", CSP);
  }
  return out;
}

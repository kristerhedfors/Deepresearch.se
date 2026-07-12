// @ts-check
// Static-asset serving and the public (unauthenticated) allowlist. Split out
// of the router so index.js stays about routing and this owns two coupled
// concerns: WHICH paths are served without auth (`isPublicAsset` — dominated
// by the DRC /cure public module graph) and HOW assets are served (caching
// policy + the cross-origin-isolation COEP shell). The Worker serves assets
// through env.ASSETS with run_worker_first = true, so auth covers the assets
// too — hence a deliberate, documented allowlist rather than an open static
// root.

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
export function isPublicAsset(url, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  return (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/welcome/") ||
    url.pathname.startsWith("/help/") ||
    url.pathname.startsWith("/build/") ||
    url.pathname.startsWith("/story/") ||
    url.pathname.startsWith("/architecture/") ||
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
    // Introspection (developer mode): the shared pure core (imported by
    // /cure/drc.js — same public-graph rule as the modules above) and the
    // committed source-snapshot artifact both tiers fetch. The snapshot is
    // the repo's own tracked text files — public on GitHub anyway — so
    // serving it unauthenticated exposes nothing new; DRC needs it public
    // because its server-not-in-the-path posture forbids an authed endpoint.
    url.pathname === "/js/introspect-core.js" ||
    // The introspection mascot/picker component (imported by /cure/drc.js —
    // same public-graph rule; its own imports, introspect-core.js and
    // drc-providers.js, are already above).
    url.pathname === "/js/introspect-ui.js" ||
    // Provider country-of-processing flags — a leaf pure module imported by
    // /cure/drc.js and by introspect-core.js (both in the public graph).
    url.pathname === "/js/provider-region.js" ||
    url.pathname === "/introspect/source-snapshot.json" ||
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
// json included (2026-07-12): the introspection source snapshot
// (/introspect/source-snapshot.json) must track the deploy it shipped with —
// a fixed TTL would serve a previous deploy's source for up to an hour, the
// exact staleness class the cache-helper skill documents. Strong etags make
// the revalidation a cheap 304.
const ASSET_REVALIDATE = /\.(js|css|html|md|json|webmanifest)$/i;

/**
 * Serves a static asset with an explicit browser-caching policy.
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
export async function serveAsset(request, env, overrideUrl = null, opts = {}) {
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
export function buildAssetRequest(request, overrideUrl, coep) {
  if (!coep) return overrideUrl ? new Request(overrideUrl, request) : request;
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(overrideUrl || request.url, { method: request.method, headers });
}

/** @typedef {import('./types.js').Env} Env */

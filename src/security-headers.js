// @ts-check
// The site-wide response security headers and the Content-Security-Policy,
// plus `applySecurityHeaders` — the one function index.js's `fetch` wraps
// every response with. Kept out of the router so the entrypoint stays about
// routing and this stays about the header policy (which is the part most
// likely to be edited when a subresource host or an inline-script hash
// changes).

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
// The parse-time MODE-theme cue bootstrap in index.html (the
// `<script data-devtheme>` — carries an attribute so the boot-guard recompute
// regex above stays unique to the attribute-less boot guard). Adds the
// `dev-mode` (introspection, white titanium) or `sdk-mode` (SDK, green) class
// before first paint from the chat-mode cache (public/js/chat-mode.js).
// Recompute on edit:
//   node -e 'const c=require("crypto"),h=require("fs").readFileSync("public/index.html","utf8").match(/<script data-devtheme>([\s\S]*?)<\/script>/)[1];console.log("sha256-"+c.createHash("sha256").update(h).digest("base64"))'
const THEME_BOOT_HASH = "'sha256-j0ITewwYaGwqvf2qia2Am0RxLqDSZpHR1ZYm5r74r/4='";
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' https://maps.googleapis.com https://maps.gstatic.com ${BOOT_GUARD_HASH} ${STORY_INLINE_HASH} ${THEME_BOOT_HASH}`,
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

// Applied to every response (see applySecurityHeaders). frame-ancestors (CSP)
// plus X-Frame-Options both block clickjacking of the authenticated app;
// nosniff stops MIME confusion on served/stored content; HSTS pins HTTPS; the
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
export function applySecurityHeaders(response, requestId) {
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

// Exported for the unit suite to assert the policy's shape without reaching
// into a live Response.
export const _internals = { CSP_ENABLED, CSP, SECURITY_HEADERS };

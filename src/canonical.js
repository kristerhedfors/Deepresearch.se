// @ts-check
// Canonical origin. The Worker is routed on BOTH the apex and www
// (wrangler.toml: deepresearch.se + www.deepresearch.se) AND — because
// run_worker_first serves the Worker before any edge "Always Use HTTPS"
// rule — it can be reached over plain http too. The whole app must live on
// ONE origin: https://<apex>. Google OAuth's redirect_uri is registered only
// for the https apex, so a request arriving on www OR over http builds a
// redirect_uri Google rejects — "Error 400: redirect_uri_mismatch", hit
// signing in from Firefox Focus, which (unlike Chrome/Safari) wipes its HSTS
// memory every session and doesn't silently upgrade the first request to
// https, so the bare-domain hit lands on http and the OAuth start builds an
// http:// redirect_uri. (The site DOES send HSTS, but a browser only honors
// it over https and only after a prior visit — which Focus discards — so the
// server-side redirect is what actually protects that first hit.) Pinning
// only the redirect_uri would split the CSRF state cookie across origins, so
// canonicalize FIRST: 301 any non-canonical host/scheme → https apex,
// preserving path + query, so the whole flow (state cookie, redirect_uri,
// callback, session) stays on the one registered origin.
//
// Leaf module (imports nothing): a pure function of the request URL, called
// by src/index.js's `route` before anything else.

/**
 * Loopback hosts — a `wrangler dev` server, which is plain http by
 * construction and has no https to send anyone to.
 *
 * Without this exemption the rule fires on every local request and the
 * Location it builds is the SAME url, so a browser pointed at
 * `http://localhost:8787` follows a 301 to itself forever (observed
 * 2026-07-29 while wiring the Playwright suite to a local Worker: five hops,
 * still 301, `url_effective` unchanged). Nothing in the rationale above
 * applies locally — there is no www, no registered OAuth redirect_uri, and no
 * https listener — so the correct behaviour is to leave a loopback request
 * alone. Preview URLs (`*.workers.dev`) are already https and are unaffected.
 * @param {string} hostname
 */
function isLoopback(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * The 301 to the canonical https apex, or null when the URL is already
 * canonical (https, non-www) or is a local development server.
 * @param {URL} url
 * @returns {Response | null}
 */
export function canonicalRedirect(url) {
  if (isLoopback(url.hostname)) return null;
  if (url.protocol !== "https:" || url.hostname.startsWith("www.")) {
    const canonical = new URL(url.toString());
    canonical.protocol = "https:";
    if (canonical.hostname.startsWith("www.")) {
      canonical.hostname = canonical.hostname.slice("www.".length);
    }
    return new Response(null, { status: 301, headers: { Location: canonical.toString() } });
  }
  return null;
}

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
 * The 301 to the canonical https apex, or null when the URL is already
 * canonical (https, non-www).
 * @param {URL} url
 * @returns {Response | null}
 */
export function canonicalRedirect(url) {
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

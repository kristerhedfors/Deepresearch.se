// The pure logic behind scripts/verify-site.mjs and scripts/build-manifest.mjs
// (unit-tested in scripts/verify-lib.test.js — no I/O here, so it runs under
// plain `node --test` like the rest of the suite).
//
// Trust model recap (see the site-integrity skill): the repo has NO build
// step, so every file under public/ is served byte-for-byte. Verifying the
// site therefore means: enumerate public/ at a git commit, fetch each file's
// URL from the live site, and compare hashes. The Worker (src/) is NOT
// externally verifiable — nothing here should ever claim it is.

export const REPO_URL = "https://github.com/kristerhedfors/Deepresearch.se";

/**
 * Map a repo path under public/ to the URL path it serves on. Cloudflare's
 * asset handling (html_handling: auto-trailing-slash, the default) serves
 * `public/foo/index.html` at `/foo/` and REDIRECTS `/foo/index.html` there,
 * so index.html files must be requested at their directory URL to get a 200
 * with the file's bytes.
 * @param {string} repoPath e.g. "public/js/app.js"
 * @returns {string} e.g. "/js/app.js"
 */
export function assetUrlPath(repoPath) {
  if (!repoPath.startsWith("public/")) {
    throw new Error(`not a served asset path: ${repoPath}`);
  }
  const p = "/" + repoPath.slice("public/".length);
  if (p === "/index.html") return "/";
  if (p.endsWith("/index.html")) return p.slice(0, -"index.html".length);
  return p;
}

/**
 * Classify one fetched asset against its expected content. Encodes the
 * Worker's gate behavior (src/index.js) so gated responses read as "gated",
 * not as failures:
 *  - anything non-public without credentials → 401 (APIs) / the login page…
 *    but static asset GETs return 401 with the login HTML, still status 401;
 *  - unauthenticated GET / returns HTTP 200 with the WELCOME page (the
 *    promotional alias in route()) — a 200 whose body legitimately differs
 *    from public/index.html;
 *  - /admin/* for a signed-in non-admin → 302 to /.
 * @param {{ urlPath: string, status: number, matched: boolean, authed: boolean }} r
 * @returns {{ verdict: "ok"|"mismatch"|"gated"|"missing"|"error", note?: string }}
 */
export function classifyResult({ urlPath, status, matched, authed }) {
  if (status === 200) {
    if (matched) return { verdict: "ok" };
    if (urlPath === "/" && !authed) {
      return {
        verdict: "gated",
        note: "unauthenticated / serves the welcome page; pass credentials to verify the app shell",
      };
    }
    return { verdict: "mismatch" };
  }
  if (status === 401 || status === 403) {
    return { verdict: "gated", note: "authentication required" };
  }
  if (status >= 300 && status < 400) {
    return { verdict: "gated", note: "redirected (sign-in or admin-only)" };
  }
  if (status === 404) return { verdict: "missing" };
  return { verdict: "error", note: `unexpected HTTP ${status}` };
}

/**
 * Build the deterministic asset manifest that the attest workflow signs and
 * that independent verifiers regenerate: same commit in, byte-identical JSON
 * out (paths sorted, fixed key order, fixed serialization via manifestJson).
 * @param {{ commit: string, files: Iterable<[string, string]>, repo?: string }} input
 *   files: [repoPath, sha256hex] pairs, any order.
 */
export function buildManifest({ commit, files, repo = REPO_URL }) {
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [path, hash] of sorted) out[path] = hash;
  return { schema: 1, repo, commit, algorithm: "sha256", files: out };
}

/**
 * The one canonical serialization of a manifest — everything that signs or
 * compares manifests must go through this so the bytes are reproducible.
 * @param {object} manifest
 */
export function manifestJson(manifest) {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/**
 * Roll per-file verdicts up into the run result. Gated files don't fail the
 * run (without credentials most of the app is expectedly gated) — but
 * nothing may mismatch, go missing, or error.
 * @param {Array<{ verdict: string }>} results
 */
export function summarize(results) {
  const counts = { ok: 0, mismatch: 0, gated: 0, missing: 0, error: 0 };
  for (const r of results) {
    counts[/** @type {keyof typeof counts} */ (r.verdict)] += 1;
  }
  return {
    counts,
    ok: counts.mismatch === 0 && counts.missing === 0 && counts.error === 0,
  };
}

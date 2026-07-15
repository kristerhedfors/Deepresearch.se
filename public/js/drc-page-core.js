// DRC page's PURE core — the import-free helpers behind the /cure wiring
// (public/cure/drc.js). DRC ("deep research secure", C for CLIENT-side) keeps
// the page module thin: everything derivable/cryptographic already lives in
// drc-core.js, the pipeline in drc-research.js, the provider registry in
// drc-providers.js. This module holds the small pure fragments that were
// otherwise inlined (and, in a few cases, duplicated) inside the DOM-wiring
// layer — grant liveness, the web-search backend config normalizer, and the
// deep-link path parsers — so each has ONE definition and a direct Node test
// (the page wiring itself is verified live, not unit-tested).
//
// Import-free by design: a leaf in the /cure module graph. It is allowlisted in
// src/assets.js's isPublicAsset — a 401 on any module the /cure graph statically
// imports takes the whole client tier dark (found live 2026-07-11).

// ---- temporary-grant helpers -------------------------------------------------
//
// Both borrowed-capability subsystems — the web-search GRANT (src/websearch.js)
// and the secure-research-space proxy BUNDLE (src/proxy.js) — carry the same
// { token, expiresAt, remaining } liveness shape and the same "default-ON
// localStorage flag" master toggle. One definition each, so wsGrantActive /
// proxyLive (and wsEnabled / proxyEnabled) can never drift.

/**
 * A borrowed grant is live iff it has a token, has not expired, and has quota
 * left (an absent `remaining` means "unmetered / not yet spent", so it counts
 * as available).
 * @param {{token?: string, expiresAt?: number|string, remaining?: number|string|null}|null|undefined} g
 * @param {number} [now] epoch millis (injectable for tests)
 * @returns {boolean}
 */
export function grantLive(g, now = Date.now()) {
  return !!(g && g.token && Number(g.expiresAt) > now && (g.remaining == null || Number(g.remaining) > 0));
}

/**
 * A grant subsystem's master toggle, read from its raw localStorage value:
 * default ON (a grant present but never explicitly toggled is usable), off only
 * on an explicit "0".
 * @param {string|null} rawValue the stored flag ("1"/"0") or null when unset
 * @returns {boolean}
 */
export function grantFlagEnabled(rawValue) {
  return rawValue == null ? true : rawValue === "1";
}

// ---- web-search backend config ----------------------------------------------

/**
 * Normalize a raw (sealed-state or form-derived) web-search backend config into
 * the clean shape the pipeline and settings UI both use: a known backend id
 * (unknown → the default "grant" server-proxied path), a trailing-slash-trimmed
 * base URL, a trimmed key, and a clamped 1..20 result count (default 6). Pure,
 * so the sealed-state read (searchBackendCfg) and the settings-form persist use
 * ONE definition instead of the same clamps copied twice.
 * @param {{backend?: string, baseUrl?: string, key?: string, results?: number|string}|null|undefined} sb
 * @returns {{backend: string, baseUrl: string, key: string, results: number}}
 */
export function normalizeSearchBackend(sb) {
  sb = sb || {};
  return {
    backend: sb.backend === "searxng" || sb.backend === "exa_compatible" ? sb.backend : "grant",
    baseUrl: String(sb.baseUrl || "").trim().replace(/\/+$/, ""),
    key: String(sb.key || "").trim(),
    results: Number(sb.results) > 0 ? Math.min(20, Math.max(1, Math.round(Number(sb.results)))) : 6,
  };
}

// ---- deep-link path parsers -------------------------------------------------
//
// The /cure page recognizes three URL shapes on load. These pure parsers pull
// the regex/slug validation out of the DOM/fetch shells so each is testable and
// the shells stay thin — and so the future portability (#-fragment import,
// R10/M3) recognizer has established parsers to slot in beside.

/**
 * The saved-project deep link: /my/project-<hash> (and the /free legacy alias).
 * @param {string} pathname
 * @returns {string|null} the "project-<hash>" reference, or null when not a match
 */
export function parseProjectPath(pathname) {
  const m = String(pathname == null ? "" : pathname).match(/^\/(?:my|free)\/(project-[0-9a-z]+)/i);
  return m ? m[1] : null;
}

/**
 * The published-replay reference: /cure/<slug> in the path, or the legacy
 * ?continue=<slug> handoff. Returns the validated slug plus whether it came from
 * the path (the caller words its "no publication here" status differently for a
 * bad /cure/<slug> than for a stray ?continue=).
 * @param {string} pathname
 * @param {string} search the location.search string (e.g. "?continue=foo")
 * @returns {{slug: string, fromPath: boolean}|null}
 */
export function parsePublicationRef(pathname, search) {
  const m = String(pathname == null ? "" : pathname).match(/^\/cure\/([a-z0-9-]+)$/i);
  const slug = m ? m[1] : new URLSearchParams(search || "").get("continue");
  if (!slug || !/^[a-z0-9-]{1,80}$/i.test(slug)) return null;
  // "workspace" is a RESERVED word, not a publication: /cure/workspace is the
  // secure-workspaces page (workspace-core.js; src/pub.js refuses the slug on
  // the publish side for the same reason).
  if (slug.toLowerCase() === "workspace") return null;
  return { slug, fromPath: !!m };
}

// ---- wordmark rendering --------------------------------------------------------

// Render prose we build for innerHTML with the Se/cure & Se/rver wordmark
// slash tightened (the .sl rule) so it reads closer to "secure"/"server".
// Escapes &<> FIRST, so any plain string stays safe as markup.
/** @param {*} s @returns {string} */
export function wmHtml(s) {
  return String(s)
    .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
    .replace(/(se)\/(cure|rver)/gi, '$1<span class="sl">/</span>$2');
}

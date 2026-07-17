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

// ---- the consolidated Se/rver token ("one ticket, one JWT") -------------------
//
// The Se/rver token (src/server-token.js + src/server-grants.js) bundles the
// legacy single-capability grants into ONE JWT carrying a PERMISSION SET —
// so its client-side liveness question is per permission: the stored view is
// { token, perms, services: [{svc, quota, used, remaining}], expiresAt }.
// Same shape family as grantLive above, extended one level.

/**
 * One permission's live meter view inside a stored Se/rver-token grant, or
 * null when the token never carried (or has been stripped of) that service.
 * @param {{services?: Array<{svc?: string}>}|null|undefined} g
 * @param {string} svc
 * @returns {{svc: string, quota?: number, used?: number, remaining?: number|null}|null}
 */
export function serverTokenService(g, svc) {
  if (!g || !Array.isArray(g.services)) return null;
  return g.services.find((s) => s && s.svc === svc) || null;
}

/**
 * A Se/rver token is live FOR A GIVEN PERMISSION iff it has a token, has not
 * expired, and that permission's row has quota left (absent `remaining` =
 * not yet spent, so it counts as available — same convention as grantLive).
 * One permission running dry never kills the others: web can be exhausted
 * while api still serves.
 * @param {{token?: string, expiresAt?: number|string, services?: Array<{svc?: string, remaining?: number|string|null}>}|null|undefined} g
 * @param {string} svc
 * @param {number} [now] epoch millis (injectable for tests)
 * @returns {boolean}
 */
export function serverTokenLive(g, svc, now = Date.now()) {
  if (!g || !g.token || !(Number(g.expiresAt) > now)) return false;
  const s = serverTokenService(g, svc);
  return !!(s && (s.remaining == null || Number(s.remaining) > 0));
}

/**
 * One borrowed-service status line for the Settings rows — "🔎 Web search:
 * 3 of 25 left" / "… used up / expired". The Se/rver-token row and the
 * legacy proxy-bundle row must keep this wording in lockstep (the same
 * reason grant-http.js exists server-side), so both render through this
 * one builder. Absent `remaining` = not yet spent (the grantLive
 * convention). The caller resolves the meter object and liveness.
 * @param {string} label
 * @param {{quota?: number, remaining?: number|null}} meter
 * @param {boolean} live
 * @returns {string}
 */
export function grantMeterLine(label, meter, live) {
  const rem = meter.remaining == null ? meter.quota : meter.remaining;
  return label + ": " + (live ? rem + " of " + meter.quota + " left" : "used up / expired");
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
  // "workspace" and "help" are RESERVED words, not publications:
  // /cure/workspace is the secure-workspaces page (workspace-core.js) and
  // /cure/help is the Se/cure documentation (public/cure/help/, routed
  // server-side before the replay map; src/pub.js refuses both slugs on the
  // publish side for the same reason).
  if (slug.toLowerCase() === "workspace" || slug.toLowerCase() === "help") return null;
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

// ---- the PRIVACY NOTICE (owner directive, 2026-07-16) --------------------------

// The animations are tier identity again (Se/cure = umbrella, Se/rver =
// balloon — the 2026-07-15 per-task channel grammar was reverted the next
// day: "keep it stringent and clean with the animations"). The privacy
// communication moved HERE instead: an ℹ INFORMATION NOTICE, always
// available from the /cure header and popped up automatically when a shared
// secure workspace opens, whose text lays out in detail what THIS session
// sends where — the read-up on privacy that used to be spread over per-step
// bubbles. Pure and Node-tested; drc.js renders it.

/**
 * The privacy notice's paragraphs, from the session's CURRENT configuration
 * (drc.js gathers `ctx` from the same accessors the send path resolves):
 *   provider      — the picked answer provider's display label (e.g. "OpenAI")
 *   viaProxy      — true when a borrowed server allowance (proxy bundle or
 *                   Se/rver-token api permission) carries the model calls
 *   local         — true when the model runs on the user's OWN machine (the
 *                   keyless local provider or the in-browser on-device engine)
 *   search        — "self" (own browser-direct service) | "grant"
 *                   (server-metered borrowed allowance) | "off"
 *   embedProvider — the embeddings provider label (project recall), "" = none
 *   embedBorrowed — true when project recall embeds through the server on a
 *                   borrowed `api` allowance (not the user's own key)
 *   grantsConnected — true when any borrowed, account-connected allowance
 *                   (web search or LLM) is live in this session
 *   workspaceName — set when this session was opened from a shared secure
 *                   workspace link ("" / absent otherwise)
 * @param {{provider?: string, viaProxy?: boolean, local?: boolean,
 *          search?: string|null, embedProvider?: string, embedBorrowed?: boolean,
 *          grantsConnected?: boolean, workspaceName?: string}} [ctx]
 * @returns {string[]} paragraphs, most important first — never empty
 */
export function privacyNoticeLines(ctx = {}) {
  const lines = [];
  if (ctx.workspaceName) {
    const name = typeof ctx.workspaceName === "string" ? ctx.workspaceName : "";
    lines.push(
      `This session was opened from a shared secure workspace link${name ? ` (“${name}”)` : ""}. ` +
        "Everything the link carried — keys, settings, chats, borrowed allowances — was decrypted and applied IN THIS BROWSER; the link's contents never reach any server (the whole workspace travels in the URL fragment, which browsers do not send).",
    );
  }
  lines.push(
    "Your chats, API keys and projects rest sealed in THIS browser's storage. The DeepResearch.Se server stores none of them and is in no data path unless a line below says otherwise.",
  );
  const provider = ctx.provider || "your model provider";
  lines.push(
    ctx.viaProxy
      ? "Model calls: the conversation text is sent THROUGH the DeepResearch.Se server to Berget on a borrowed, metered, time-limited allowance — the one call path where your text touches the server."
      : ctx.local
        ? "Model calls: the model runs on YOUR OWN machine — the conversation never leaves your device, and no third party (this site's server included) is involved."
        : `Model calls: the conversation text is sent to ${provider}, directly from your browser on your own API key — they can read it; the DeepResearch.Se server is not involved.`,
  );
  lines.push(
    ctx.search === "self"
      ? "Web search: only the search QUERY is sent, directly from your browser to the search service you configured yourself. No DeepResearch.Se server, no third party of ours."
      : ctx.search === "grant"
        ? "Web search: only the search QUERY is sent, through the DeepResearch.Se server to the Exa search service on a borrowed, metered allowance."
        : "Web search: off — research runs from the model's own knowledge; no search query leaves this browser.",
  );
  if (ctx.embedProvider) {
    lines.push(
      ctx.embedBorrowed
        ? `Project recall: your question is embedded through the DeepResearch.Se server on ${ctx.embedProvider}'s embedding model, on a borrowed, metered allowance, to search the project index stored in this browser. Only the question text is sent; the index never leaves.`
        : `Project recall: your question is embedded with ${ctx.embedProvider}'s embedding API (your key) to search the project index stored in this browser. Only the question text is sent; the index never leaves.`,
    );
  }
  if (ctx.grantsConnected) {
    lines.push(
      "Borrowed allowances are quota-metered, time-limited, and connected to the account that minted them; the minter can pause or revoke them at any time. Turn them off in Settings to cut every server-touching path.",
    );
  }
  return lines;
}

// ---- the workspace-unlock celebration ------------------------------------------

/**
 * The full-screen unlock celebration's drawing-box size (px). When the correct
 * password opens a shared secure workspace (owner directive, 2026-07-15), ONE
 * LARGE umbrella plays the intro's arc FAST over the whole viewport — the
 * umbrella spinner's completion finale (speed-run into the pink bloom, fold
 * into the pink ✓) at celebration scale. ~72% of the short viewport side reads
 * big without clipping the dangling shaft (the spinner draws the canopy at
 * 0.3× its box and anchors it slightly high); clamped for tiny/huge screens,
 * defensive against nonsense input.
 * @param {number} w viewport width (px)
 * @param {number} h viewport height (px)
 * @returns {number}
 */
export function unlockCelebrationSize(w, h) {
  const s = Math.min(Number(w) || 0, Number(h) || 0);
  if (!Number.isFinite(s) || s <= 0) return 320;
  return Math.round(Math.min(760, Math.max(220, s * 0.72)));
}

// ---- the standing provider-visibility line (the model picker's disclosure) ----

/**
 * The one-line "where your words go" disclosure shown beside the model picker —
 * the STANDING counterpart of the per-step notices above. Honesty is the point
 * (docs/FOREVERAGENT-GAP-ANALYSIS.md §8): "private from this site" must never
 * be mistaken for "private from the model provider" — the chosen provider DOES
 * receive and can read the conversation — and with the local provider the line
 * flips to the strongest true statement the tier can make.
 * @param {string} providerId
 * @param {string} [label] the provider's display label (e.g. "OpenAI")
 * @returns {string} "" when no provider is picked yet
 */
export function providerVisibilityNote(providerId, label) {
  const id = String(providerId || "");
  if (!id) return "";
  if (id === "local") {
    return "Local model — nothing leaves this device: replies come from the server running on your own machine.";
  }
  if (id === "ondevice") {
    return "On-device model — nothing leaves this device: the model runs inside this browser, offline once downloaded.";
  }
  if (id === "proxy") {
    return (
      "Your messages route through this site's server to Berget on the borrowed, metered allowance — " +
      "the one Se/cure path where your words touch the server."
    );
  }
  const who = label || id;
  return `Your messages go to ${who} — they can read them. This site's server can't: calls go straight from your browser.`;
}

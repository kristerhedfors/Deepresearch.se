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

// ---- the per-task ONLINE/OFFLINE symbol grammar (owner directive, 2026-07-15) ----

// Every research step wears the symbol of its CHANNEL: the UMBRELLA for work
// that stays on this device (Se/cure's own symbol — shelter), the BALLOON for
// work that crosses the network (Se/rver's symbol — carried). On Se/cure an
// ONLINE step also completes into an INFORMATION NOTICE (ℹ) instead of the
// pink ✓, whose bubble (disclosureText below) says exactly what left the
// browser and where it went — the read-up on what each task is doing or
// leaking. Pure and Node-tested; drc.js consumes both.

// Phase → channel. Unknown phases default to ONLINE: over-disclosing is the
// safe failure for a privacy tier (a local task wrongly wearing the balloon
// invites a read; an online task wrongly wearing the umbrella lies).
const LOCAL_PHASES = new Set([
  "sandbox", // the CheerpX VM runs entirely in this browser
  "clarify", // asking the user a question — no call of its own
  "introspect", // reads the committed source snapshot (same-origin static)
  "_note", // the running step's re-label pseudo-phase
]);

/** @param {string} phase @returns {"local"|"online"} */
export function phaseChannel(phase) {
  return LOCAL_PHASES.has(String(phase)) ? "local" : "online";
}

/**
 * The information-notice text for a completed ONLINE step: what this task
 * sent, to whom, on whose credential. `ctx` is the send-time context drc.js
 * captures when it resolves the provider and search route:
 *   provider   — the answer provider's display label (e.g. "OpenAI")
 *   viaProxy   — true when the secure-research-space LLM proxy carries calls
 *   local      — true when the model is the user's OWN local server (the
 *                keyless provider): calls stay on the user's machine
 *   search     — "self" (own browser-direct service) | "grant" (server-metered)
 *   embedProvider — the embeddings provider label (recall), if any
 * Returns "" for local phases (they complete to the pink ✓, no notice).
 * @param {string} phase
 * @param {{provider?: string, viaProxy?: boolean, local?: boolean,
 *          search?: string|null, embedProvider?: string}} [ctx]
 * @returns {string}
 */
export function disclosureText(phase, ctx = {}) {
  if (phaseChannel(phase) === "local") return "";
  const provider = ctx.provider || "your model provider";
  const llm = ctx.viaProxy
    ? "This step sent the conversation text it needed THROUGH the DeepResearch.Se server to Berget — the borrowed secure-research-space API (metered, time-limited, Berget-only). This is the one call path where your text touches the server."
    : ctx.local
      ? "This step called the model server running on YOUR OWN machine — the conversation never left your device, and no third party (this site's server included) was involved."
      : `This step sent the conversation text it needed to ${provider}, directly from your browser on your own API key. The DeepResearch.Se server was not involved.`;
  switch (String(phase)) {
    case "search":
      return ctx.search === "self"
        ? "Only the search QUERY was sent — directly from your browser to the search service you configured yourself. No DeepResearch.Se server, no third party of ours."
        : "Only the search QUERY was sent — through the DeepResearch.Se server to the Exa search service, metered by your temporary web-search grant. The conversation itself never left your browser.";
    case "recall":
      return `Recall embedded your question with ${ctx.embedProvider || provider}'s embedding API (your key) to search the project index stored in this browser. Only the question text was sent; the index never leaves.`;
    case "triage":
    case "harvest":
    case "gap":
    case "synth":
    case "validate":
    case "answer":
    case "source":
      return llm;
    default:
      return "This step called an online API — the text it needed left your browser. " + llm;
  }
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
  if (id === "proxy") {
    return (
      "Your messages route through this site's server to Berget on the borrowed, metered allowance — " +
      "the one Se/cure path where your words touch the server."
    );
  }
  const who = label || id;
  return `Your messages go to ${who} — they can read them. This site's server can't: calls go straight from your browser.`;
}

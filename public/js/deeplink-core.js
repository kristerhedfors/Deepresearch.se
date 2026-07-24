// @ts-check
// Composer deep-links — the PURE parser behind the site's shareable "open with
// a question ready to ask" URLs. The agent-platform documentation links into
// the introspection agent this way: a doc line's "ask the source" link is
//     /?mode=introspection&ask=<url-encoded question>
// which, on load, selects the mode (when the capability allows) and prefills
// the composer with the question, so the reader gets the exact sourced answer
// from the project itself. Kept I/O-free and Node-tested (deeplink-core.test.js);
// app.js does the DOM side effects from what this returns.

/** Canonical chat-mode ids (mirror chat-mode.js). */
export const DEEPLINK_MODES = ["normal", "introspection", "sdk", "orchestrator"];

/** Friendly aliases → canonical mode id, so links can read naturally. */
const MODE_ALIASES = {
  normal: "normal",
  research: "normal",
  introspection: "introspection",
  introspect: "introspection",
  source: "introspection",
  sdk: "sdk",
  "agent-builder": "sdk",
  builder: "sdk",
  agent: "sdk",
  orchestrator: "orchestrator",
  orchestrate: "orchestrator",
  orch: "orchestrator",
  workflow: "orchestrator",
};

/** Cap on a prefilled question — long enough for a real ask, bounded for safety. */
export const MAX_ASK_CHARS = 2000;

/**
 * Parse a composer deep-link out of a location.search string. Returns
 * { mode, ask, send }: `mode` is a canonical id or null, `ask` is the trimmed
 * question or null, `send` is whether the link asked to auto-submit (default
 * false — a prefill the user still sends, so no surprise quota spend). Never
 * throws.
 * @param {string} search e.g. "?mode=introspection&ask=how%20does%20X%20work"
 * @returns {{ mode: string|null, ask: string|null, send: boolean }}
 */
export function parseComposerDeepLink(search) {
  let params;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return { mode: null, ask: null, send: false };
  }
  const rawMode = (params.get("mode") || "").trim().toLowerCase();
  const mode = /** @type {Record<string,string>} */ (MODE_ALIASES)[rawMode] || null;

  // `q` is a convenience alias; an empty/whitespace `ask` falls through to it.
  const norm = (/** @type {unknown} */ v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_ASK_CHARS) : null);
  let ask = norm(params.get("ask")) || norm(params.get("q"));

  const sendRaw = (params.get("go") || params.get("send") || "").trim().toLowerCase();
  const send = sendRaw === "1" || sendRaw === "true" || sendRaw === "yes";

  return { mode, ask, send };
}

/**
 * Build a composer deep-link URL (the inverse — used by docs tooling / the
 * Agent Studio's "share this question" affordance). `base` defaults to the
 * app root; pass "/" or an absolute origin.
 * @param {{ mode?: string|null, ask: string, send?: boolean, base?: string }} opts
 * @returns {string}
 */
export function buildComposerDeepLink(opts) {
  const base = opts.base || "/";
  const p = new URLSearchParams();
  if (opts.mode && DEEPLINK_MODES.includes(opts.mode)) p.set("mode", opts.mode);
  p.set("ask", String(opts.ask || "").slice(0, MAX_ASK_CHARS));
  if (opts.send) p.set("go", "1");
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

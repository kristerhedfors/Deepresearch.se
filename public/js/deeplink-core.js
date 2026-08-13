// @ts-check
// Composer deep-links — the PURE parser behind the site's shareable "open with
// a question ready to ask" URLs. The agent-platform documentation links into
// the introspection agent this way: a doc line's "ask the source" link is
//     /?mode=introspection&ask=<url-encoded question>
// which, on load, selects the mode (when the capability allows) and prefills
// the composer with the question, so the reader gets the exact sourced answer
// from the project itself. Kept I/O-free and Node-tested (deeplink-core.test.js);
// app.js does the DOM side effects from what this returns.

/** Canonical chat-mode ids (mirror chat-mode-core.js CHAT_MODES — all seven). */
export const DEEPLINK_MODES = ["science", "cyber", "introspection", "sdk", "orchestrator", "outrospection", "models"];

/** Friendly aliases → canonical mode id, so links can read naturally. The
 * `agent-builder` entry is the AgentSpec's name for the `sdk` mode
 * (sdk/AGENTS.json) — the spec vocabulary and the app's mode ids meet here. */
const MODE_ALIASES = {
  // The two RETIRED words for the general agent (2026-08-13). They keep
  // resolving — to Deep Science, the mode that inherited the fallback — because
  // a deep link is the one surface that outlives the roster: every `?mode=normal`
  // link written into a document, a chat log or somebody's bookmarks would
  // otherwise fall to `null` and open whatever mode the reader happened to be
  // in. Same reasoning as chat-mode-core.js RETIRED_CHAT_MODES on the wire.
  normal: "science",
  research: "science",
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
  outrospection: "outrospection",
  outrospect: "outrospection",
  outro: "outrospection",
  feed: "outrospection",
  models: "models",
  model: "models",
  hf: "models",
  huggingface: "models",
  "hugging-face": "models",
  // Deep Science (2026-07-31). The Swedish forms ship WITH the English ones
  // rather than "later" (invariant 6) — a link is exactly the deterministic
  // routing surface the rule is about, and a Swedish reader given a Swedish
  // link that silently opens the wrong agent is the failure feedback #22
  // already recorded once for outrospection.
  science: "science",
  scholar: "science",
  "deep-science": "science",
  literature: "science",
  papers: "science",
  "peer-reviewed": "science",
  vetenskap: "science",
  vetenskaplig: "science",
  litteratur: "science",
  artiklar: "science",
  forskningsartiklar: "science",
  "referentgranskad": "science",
  // Cyber (2026-08-13), bilingual from the first commit for the same reason.
  // The vocabulary covers the three ways this agent gets named — the field
  // ("cyber", "säkerhet"), the discipline ("osint", "underrättelser"), and the
  // work ("recon", "spaning", "sårbarhet") — with the Swedish side matching the
  // English breadth form for form, definite forms included, rather than a token
  // "säkerhet" standing in for six English words.
  cyber: "cyber",
  cybersecurity: "cyber",
  security: "cyber",
  infosec: "cyber",
  appsec: "cyber",
  osint: "cyber",
  recon: "cyber",
  reconnaissance: "cyber",
  vulnerability: "cyber",
  // Each Swedish form is also listed ASCII-folded (ä→a, å→a), because a URL is
  // typed and pasted across keyboards that do not have those letters and a
  // percent-encoded one is retyped wrong at least as often as it is copied.
  cybersäkerhet: "cyber",
  cybersakerhet: "cyber",
  säkerhet: "cyber",
  sakerhet: "cyber",
  säkerheten: "cyber",
  sakerheten: "cyber",
  informationssäkerhet: "cyber",
  informationssakerhet: "cyber",
  "it-säkerhet": "cyber",
  "it-sakerhet": "cyber",
  underrättelser: "cyber",
  underrattelser: "cyber",
  spaning: "cyber",
  sårbarhet: "cyber",
  sarbarhet: "cyber",
  sårbarheter: "cyber",
  sarbarheter: "cyber",
};

// NOTE (2026-07-31, still true 2026-08-13): the aliases ABOVE the science block
// are English-only, which is an invariant-6 gap that predates the science entry
// and is deliberately not fixed here — widening five mode vocabularies is its
// own change with its own parity tests, not a rider on adding a mode. The two
// modes ADDED since (science, cyber) shipped bilingual, so the debt is bounded
// and shrinking rather than growing. Recorded so it is a known debt rather than
// an oversight nobody wrote down.

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

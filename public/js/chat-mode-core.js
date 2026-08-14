// @ts-check
// The chat MODE registry — the pure core both tiers and the Worker share.
//
// A chat mode is THE unit that selects how a request is answered. Before
// 2026-07-26 the mode was carried indirectly: a per-account boolean knob
// (`developer_mode`) said "non-normal modes are allowed", four of the five
// non-normal modes each had their own request flag, and INTROSPECTION had no
// flag at all — it was whatever was left when the knob was on and no other
// flag was set. That made the knob three things at once (an availability gate,
// the persisted user choice, and introspection's activation signal), which is
// why the same choice had to be mirrored in three stores and reconciled on
// every page load. Now the mode is named on the wire and stored once, and
// everything else is DERIVED from it.
//
// This module is the shared core (the introspect-core.js / bash-core.js
// pattern): no DOM, no storage, no imports, so the browser modules
// (chat-mode.js), the Worker (src/chat-modes.js re-exports it) and the unit
// tests all agree on one table.

// ---- the roster is SPECIFIC, with no general member (owner directive, 2026-08-13)
//
// Until now the first member was `normal`, labeled "Deep Research": the general
// agent every unrouted request fell back to, and the one mode defined by what it
// did NOT specialise in. It is gone. Every mode below names a domain — the
// peer-reviewed literature, cybersecurity and OSINT, this platform's own source,
// building an agent, running a team, the outward feed, the model catalog — and a
// request that names none lands on one of them rather than on a catch-all.
//
// Two consequences are load-bearing and easy to lose:
//
//  1. **`science` is the fallback**, so the terminal `else` of the whole routing
//     system is now an agent with a POLICY — the peer-reviewed literature leads
//     and is numbered first, and the web leg runs behind it, labelled as web
//     reporting (feedback #69, 2026-08-14; it declared `search.web: false` and
//     ran no web leg at all before then) — rather than one without. A caller
//     that wants open-web research as the PRIMARY evidence must say so.
//  2. **The registry is no longer optional** — see `routingNeedsRegistry`.

/** The modes, in dropdown order. */
export const CHAT_MODES = ["science", "cyber", "introspection", "sdk", "orchestrator", "outrospection", "models"];

/** The mode a request falls back to when it names none — Deep Science. */
export const DEFAULT_CHAT_MODE = "science";

// Retired mode ids, mapped to what answers for them now. `normal` was the
// general "Deep Research" turn; requests carrying it are still arriving from
// stored settings (`settings_json.chat_mode`), `dr_chat_mode` in a browser that
// has not been reloaded, share links, and the eval harnesses — so it resolves
// rather than being clamped by the generic unknown-value path, which would land
// in the same place but silently and for the wrong reason.
/** @type {Record<string, string>} */
export const RETIRED_CHAT_MODES = { normal: "science" };

// Which `/api/chat` boolean selects each mode, and — by ARRAY ORDER — the
// precedence when a request carries several. Mirrors the `defaults` table in
// sdk/AGENTS.json, which is the routing authority; keep the two in step.
//
// `introspection_mode` is new (2026-07-26). Introspection used to be the
// derived leftover, so a request could never say "introspection" in so many
// words — the server inferred it from the knob. Now every mode has a name on
// the wire and introspection is selected like its four siblings.
/** @type {Array<{ mode: string, flag: string }>} */
export const MODE_REQUEST_FLAGS = [
  { mode: "sdk", flag: "sdk_mode" },
  { mode: "orchestrator", flag: "orchestrator_mode" },
  { mode: "outrospection", flag: "outrospection_mode" },
  { mode: "models", flag: "models_mode" },
  { mode: "introspection", flag: "introspection_mode" },
  { mode: "cyber", flag: "cyber_mode" },
  { mode: "science", flag: "science_mode" },
];

/** mode → its request flag (null for `normal`, which no flag selects). */
export const FLAG_FOR_MODE = Object.fromEntries(MODE_REQUEST_FLAGS.map((r) => [r.mode, r.flag]));

/**
 * Clamp any value to a known mode.
 * @param {unknown} v
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeChatMode(v, fallback = DEFAULT_CHAT_MODE) {
  if (CHAT_MODES.includes(/** @type {string} */ (v))) return /** @type {string} */ (v);
  const retired = RETIRED_CHAT_MODES[/** @type {string} */ (v)];
  // A retired id resolves to its successor rather than to `fallback`, so a
  // caller that passes "" as the fallback to mean "was a mode actually named?"
  // still gets a truthy answer for `normal` — it named one, and it still does.
  return retired || fallback;
}

// Whether a mode carries THIS SITE'S OWN SOURCE as context — the committed
// snapshot enrichment (src/introspect.js) plus, when the sandbox is also on,
// the /src mount in the browser VM.
//
// This used to be spelled `mode !== normal`, on the reasoning that every
// non-normal mode has business with the source: introspection answers FROM it,
// Agent Studio distils Se/cure OUT of it, Orchestrator briefs sub-agents that
// may need it, and Outrospection and Models compare this site against the
// outside world. That was true of all five, so the rule and the shortcut agreed
// and nothing distinguished them.
//
// SCIENCE broke the tie (2026-07-31). It is a DOMAIN mode — it answers from the
// peer-reviewed record and has no more business with this repo's source than a
// general research turn did, so under the old shortcut it would have loaded a
// multi-megabyte snapshot on every turn to ignore it. The set is declared
// outright now, which also means the next domain mode inherits nothing by
// accident: a mode carries the source because it is named here, not because it
// happens not to be the default.
//
// CYBER (2026-08-13) is the second domain mode and is absent for the same
// reason. It reads OWASP reference material and third-party host/imagery
// intelligence, none of which is this repo's source; a security assessment OF
// this platform is still Introspection's turn, which is why that mode keeps the
// `owasp` block too.
/** @type {string[]} */
export const SOURCE_CARRYING_MODES = ["introspection", "sdk", "orchestrator", "outrospection", "models"];

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function modeCarriesSource(mode) {
  return SOURCE_CARRYING_MODES.includes(normalizeChatMode(mode));
}

/**
 * The mode a `/api/chat` request resolves to. ONE function so the Worker, both
 * tiers and the tests can never disagree, and so the precedence is readable
 * rather than spread over five `&&` chains.
 *
 * Resolution order:
 *  1. **No capability → `normal`.** A client can never acquire a mode this
 *     identity may not use (the standing rule: a request may DECLINE a
 *     capability it holds, never acquire one it doesn't).
 *  2. **`developer_mode: false` → `normal`.** The off-only override kept from
 *     the old knob: a documented promise to callers written before `chat_mode`
 *     existed, and still the way to force plain web research without knowing
 *     the mode vocabulary. In-repo callers name the mode instead — the eval
 *     harnesses now send `chat_mode: "normal"`.
 *  3. **`chat_mode: "<mode>"`** — the explicit field; an unknown value is
 *     ignored rather than failing the request (invariant 2).
 *  4. **A mode flag**, in MODE_REQUEST_FLAGS order (sdk > orchestrator >
 *     outrospection > models > introspection). This is what older clients and
 *     hand-rolled requests send.
 *  5. **The account's stored mode** — the pick persisted in settings_json, so
 *     the mode follows the account across devices as it always has.
 *  6. **`normal`.**
 * @param {Record<string, any> | null | undefined} body the /api/chat request body
 * @param {{ available?: boolean, stored?: unknown }} [opts]
 * @returns {string}
 */
export function resolveBodyChatMode(body, opts = {}) {
  if (opts.available === false) return DEFAULT_CHAT_MODE;
  if (body?.developer_mode === false) return DEFAULT_CHAT_MODE;
  if (body?.chat_mode !== undefined) {
    const named = normalizeChatMode(body.chat_mode, "");
    if (named) return named;
  }
  for (const { mode, flag } of MODE_REQUEST_FLAGS) {
    if (body?.[flag] === true) return mode;
  }
  return normalizeChatMode(opts.stored, DEFAULT_CHAT_MODE);
}

/**
 * Whether loading the agent registry can change the outcome of a request.
 *
 * It always can, now — this returns `true` unconditionally, and the argument
 * for that is the whole point of retiring the general agent.
 *
 * The old answer was `mode !== "normal" || body.agent`: the default turn was
 * the GENERAL one, its agent declared nothing that narrowed it, and so paying a
 * multi-megabyte snapshot load to learn "plain research, as always" was pure
 * cost on the commonest path. That premise died with `normal`. Every mode now
 * names a domain, and a domain is enforced by the resolved capability —
 * `capHasContext` decides whether the literature legs run, whether host
 * intelligence runs, whether street imagery runs. A default-mode request that
 * skipped the registry would resolve a NULL capability and silently get the
 * unrestricted platform defaults: Deep Science would quietly stop being
 * literature-only, which is the exact failure the exclusivity work exists to
 * prevent.
 *
 * The cost is bounded: `loadAgentRegistry` caches per isolate, and it now reads
 * the small dedicated registry artifact (`AGENTS_REGISTRY_PATH`) rather than the
 * multi-megabyte source snapshot, so this is one small asset read per isolate
 * rather than a five-megabyte parse per isolate.
 *
 * The signature is kept — callers pass what they always passed — so that the
 * decision stays in one named place if a cheaper rule is ever wanted again.
 * @param {Record<string, any> | null | undefined} _body
 * @param {string} _mode the already-resolved chat mode
 * @returns {boolean}
 */
export function routingNeedsRegistry(_body, _mode) {
  return true;
}

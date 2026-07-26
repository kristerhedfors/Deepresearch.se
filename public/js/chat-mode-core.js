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

/** The modes, in dropdown order. `normal` is labeled "Deep Research" in the UI. */
export const CHAT_MODES = ["normal", "introspection", "sdk", "orchestrator", "outrospection", "models"];

/** The mode a request falls back to — plain deep research, no capability needed. */
export const DEFAULT_CHAT_MODE = "normal";

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
  return CHAT_MODES.includes(/** @type {string} */ (v)) ? /** @type {string} */ (v) : fallback;
}

// Whether a mode carries THIS SITE'S OWN SOURCE as context — the committed
// snapshot enrichment (src/introspect.js) plus, when the sandbox is also on,
// the /src mount in the browser VM.
//
// Every non-normal mode does. That is not an accident of the old knob but the
// deliberate rule it accidentally implemented, now stated in one place:
// introspection answers FROM the source, Agent Studio distils Se/cure OUT of
// it, Orchestrator briefs sub-agents that may need it, and Outrospection and
// Models compare this site against the outside world. Only plain Deep Research
// has no business with it — and it is the hot path, so it pays nothing.
/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function modeCarriesSource(mode) {
  return normalizeChatMode(mode) !== DEFAULT_CHAT_MODE;
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
 * Whether a request could route anywhere other than the plain Deep Research
 * turn — i.e. whether loading the agent registry can change the outcome.
 * `normal` with no addressed agent always resolves to the research agent, and
 * paying the multi-megabyte snapshot load to learn that would be a regression
 * on the commonest path.
 * @param {Record<string, any> | null | undefined} body
 * @param {string} mode the already-resolved chat mode
 * @returns {boolean}
 */
export function routingNeedsRegistry(body, mode) {
  if (normalizeChatMode(mode) !== DEFAULT_CHAT_MODE) return true;
  // An explicitly ADDRESSED agent (`body.agent`) is the other way routing can
  // differ. Opt-in by construction: a request that names none never pays the
  // load, and naming a nonexistent or ungranted id costs the load and then
  // resolves to the same agent the table would have given anyway.
  return typeof body?.agent === "string" && body.agent.trim() !== "";
}

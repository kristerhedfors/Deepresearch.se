// @ts-check
// WHAT the MCP server exposes, per account — the configuration behind
// Settings → "MCP server".
//
// The MCP surface (src/mcp.js) used to be take-it-or-leave-it: every caller
// who could satisfy the identity gate saw every tool the server had with the
// site's defaults. Once an account can hand a long-lived key to an external agent
// (src/mcp-key.js), "all of it, always" stops being a reasonable default —
// someone wiring Claude Code up for SDK planning has no reason to also lend it
// a research budget, and someone lending research has no reason to expose the
// manifest. So exposure became configuration: a catalog of exposable tools,
// one switch each, plus the defaults and override policy for the research
// tool's arguments.
//
// TWO PROPERTIES MAKE THIS THE RIGHT PLACE FOR IT.
//   - The config is read at CALL time and lives on the account, not in the
//     token. Narrowing exposure takes effect on the next call, for every
//     outstanding key at once, with nothing to re-issue (the same "token
//     fixed, the record governs" split as the grant families).
//   - The holder of a key can never edit it. Editing happens through
//     /api/mcp/config behind the identity gate, and an MCP key can never
//     satisfy that gate (src/mcp-key.js's scope note).
//
// THE CATALOG IS THE MIRROR OF src/mcp.js's TOOL LIST. Every tool that module
// serves has exactly one entry here, and src/mcp-config.test.js fails the
// build when the two drift — so adding a tool to the MCP server without
// deciding how an account switches it off is not possible by accident.
//
// Pure module: both its imports (src/extension-tools.js, the MCP tool seam of
// the extension registry, and src/platform-tools.js, which imports nothing at
// all) are themselves pure, so src/mcp.js still imports this statically without breaking its
// keep-the-pipeline-out-of-the-test file-layout rule. The client's Settings
// screen consumes the same catalog over /api/mcp/config rather than keeping a
// second copy of the tool list.

import { EXTENSION_MCP_CATALOG } from "./extension-tools.js";
import { PLATFORM_AGENT, PLATFORM_MCP_CATALOG, PLATFORM_SPENDING_TOOLS } from "./platform-tools.js";

/**
 * One exposable tool. `group` drives the Settings screen's headings; `label`
 * and `blurb` are UI copy (the MCP-facing descriptions stay in the tool
 * definitions themselves, where the calling model reads them). `def` is
 * whether a brand-new account exposes it — all true today, which is exactly
 * the behaviour this configuration replaced, so nothing changes for an
 * account that never opens the screen.
 * @typedef {{ id: string, group: string, label: string, blurb: string, def: boolean }} McpToolEntry
 */

/** @type {McpToolEntry[]} */
export const MCP_TOOL_CATALOG = [
  {
    id: "deep_research",
    group: "Research",
    label: "deep_research",
    blurb:
      "Runs the full research pipeline — plan, search, gap-check, synthesize, validate — and " +
      "returns a cited answer. This is the tool that spends: every call draws on your " +
      "account's research quota, at your account's model and search prices.",
    def: true,
  },
  {
    id: "literature_search",
    group: "Scientific corpora",
    label: "literature_search",
    blurb:
      "Semantic search over the hosted arXiv and PubMed indexes — up to six angles at once, " +
      "returning structured paper records. Spends a small amount on embedding and reranking, " +
      "and is gated by the same research quota as deep_research.",
    def: true,
  },
  {
    id: "literature_fetch",
    group: "Scientific corpora",
    label: "literature_fetch",
    blurb: "Looks up exact papers by arXiv id or PMID. A direct key read — contacts no third party and spends nothing.",
    def: true,
  },
  {
    id: "literature_similar",
    group: "Scientific corpora",
    label: "literature_similar",
    blurb:
      "Finds papers near a known one in the index, for a related-work sweep. Quota-gated like literature_search.",
    def: true,
  },
  {
    id: "literature_corpora",
    group: "Scientific corpora",
    label: "literature_corpora",
    blurb:
      "Describes what the two corpora hold — live vector counts, coverage windows, stored fields. " +
      "Reads nothing of yours and spends nothing.",
    def: true,
  },
  // The two adapter tools ChatGPT requires BY NAME. Their own group, because
  // their switches do not behave like the others: these two are the price of
  // being addable as a ChatGPT connector at all, so switching `search` off is
  // not "one less tool" — it is a connector that will not connect. The Settings
  // screen has to say that rather than leave someone to discover it as a failed
  // connection with no error worth reading.
  {
    id: "search",
    group: "ChatGPT connector",
    label: "search",
    blurb:
      "One query over the same hosted arXiv and PubMed indexes, returning id/title/url in the " +
      "fixed shape ChatGPT expects. ChatGPT will not connect to a server without a tool named " +
      "`search`, so switching this off makes the connector unusable there — every other client " +
      "is unaffected. Retrieves, so it draws on the same research quota as literature_search.",
    def: true,
  },
  {
    id: "fetch",
    group: "ChatGPT connector",
    label: "fetch",
    blurb:
      "Turns one id from a `search` result back into that paper's title, stored abstract and " +
      "link. ChatGPT requires it alongside `search` — the two are switched as a pair in " +
      "practice. A direct key read: contacts no third party and spends nothing.",
    def: true,
  },
  // The PLATFORM tools — this server asked about its own implementation. Their
  // rows live in src/platform-tools.js beside their schemas, so a change to the
  // family is one file rather than two that can disagree.
  ...PLATFORM_MCP_CATALOG,
  // The EXTENSION tools (street imagery, host intelligence) come from the tool
  // registry rather than being listed here, for the same reason src/mcp.js takes
  // them from there: this file must not become a second place a third-party
  // service is named (invariant 7). Their rows carry the same fields as the ones
  // above, so the Settings screen renders them without knowing the difference.
  //
  // Their switch means something slightly different, though, and the blurbs say
  // so: switching one ON here does not by itself let it run. Each also needs its
  // extension's per-account knob, which is the account's consent to reach that
  // third party at all, and is default OFF.
  ...EXTENSION_MCP_CATALOG,
];

/** Every exposable tool id, in catalog order. */
export const MCP_TOOL_IDS = MCP_TOOL_CATALOG.map((t) => t.id);

/** The research tool's budget bounds — the same 15–600 s window its input
 * schema advertises, repeated here because this module validates the stored
 * DEFAULT without importing the schema (leaf rule). src/budget.js clampBudget
 * still has the final word at call time. */
export const MCP_BUDGET_MIN = 15;
export const MCP_BUDGET_MAX = 600;
export const MCP_BUDGET_DEFAULT = 120;

/**
 * The effective per-account MCP configuration.
 * @typedef {Object} McpConfig
 * @property {boolean} enabled master switch for the whole MCP surface
 * @property {Record<string, boolean>} tools one entry per catalog id
 * @property {{ time_budget_s: number, web_search: boolean, model: string }} defaults
 *   what a tool call gets when the client does not say
 * @property {boolean} allow_model_override may a caller pick the answer model?
 * @property {boolean} allow_budget_override may a caller pick the time budget?
 * @property {McpKeyRecord | null} key the live key issue, or null when none
 */
/**
 * The non-secret record of the account's live MCP key. The TOKEN itself is
 * shown exactly once, at mint time, and never stored — only enough to
 * recognize and revoke it.
 * @typedef {Object} McpKeyRecord
 * @property {string} jti the issue id verification must match
 * @property {string} hint the token's last six characters, for the UI
 * @property {string} label a human name for the client it was pasted into
 * @property {number} created_at ms epoch
 * @property {number} exp epoch SECONDS (the token's own claim)
 */

/** A brand-new account's configuration: everything exposed, site defaults,
 * no key. Deliberately identical to the pre-configuration behaviour. */
export function defaultMcpConfig() {
  return /** @type {McpConfig} */ ({
    enabled: true,
    tools: Object.fromEntries(MCP_TOOL_CATALOG.map((t) => [t.id, t.def])),
    defaults: { time_budget_s: MCP_BUDGET_DEFAULT, web_search: true, model: "" },
    allow_model_override: true,
    allow_budget_override: true,
    key: null,
  });
}

/**
 * Read the effective config out of a stored settings_json value. Tolerant in
 * the same way src/settings.js's parseSettings is: unknown keys are dropped,
 * known keys are coerced, anything unreadable means defaults — so a malformed
 * row degrades to "everything exposed as before" rather than to a locked-out
 * account.
 * @param {unknown} settingsJson the users.settings_json column (string or object)
 * @returns {McpConfig}
 */
export function parseMcpConfig(settingsJson) {
  /** @type {any} */
  let raw = null;
  try {
    const parsed = typeof settingsJson === "string" ? JSON.parse(settingsJson) : settingsJson;
    if (parsed && typeof parsed === "object") raw = parsed.mcp;
  } catch {
    raw = null;
  }
  const config = defaultMcpConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;

  if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
  if (raw.tools && typeof raw.tools === "object") {
    for (const entry of MCP_TOOL_CATALOG) {
      if (typeof raw.tools[entry.id] === "boolean") config.tools[entry.id] = raw.tools[entry.id];
    }
    // A NEW pipeline-spending tool does not arrive switched on for an account
    // that had already switched the pipeline OFF.
    //
    // Every tool here defaults on, which is right: it reproduces the behaviour
    // that existed before this configuration did, so an account that never opens
    // the screen sees no change. But a stored row saying `deep_research: false`
    // is not silence — it is an account that decided this surface may not spend
    // its research budget, usually while handing out a long-lived key. Adding
    // two more tools that run the SAME pipeline against the SAME quota and
    // turning them on by default would hand that budget back without anyone
    // choosing to, and unlike the extension tools there is no second knob to
    // catch it. So the choice is INHERITED, once, for tools the row has never
    // mentioned; the moment Settings writes an explicit boolean the loop above
    // wins and this stops applying.
    if (raw.tools.deep_research === false) {
      for (const id of PLATFORM_SPENDING_TOOLS) {
        if (typeof raw.tools[id] !== "boolean") config.tools[id] = false;
      }
    }
  }
  if (raw.defaults && typeof raw.defaults === "object") {
    const budget = Number(raw.defaults.time_budget_s);
    if (Number.isFinite(budget)) config.defaults.time_budget_s = clampMcpBudget(budget);
    if (typeof raw.defaults.web_search === "boolean") config.defaults.web_search = raw.defaults.web_search;
    if (typeof raw.defaults.model === "string") config.defaults.model = raw.defaults.model.trim();
  }
  if (typeof raw.allow_model_override === "boolean") config.allow_model_override = raw.allow_model_override;
  if (typeof raw.allow_budget_override === "boolean") config.allow_budget_override = raw.allow_budget_override;
  config.key = parseKeyRecord(raw.key);
  return config;
}

/**
 * @param {any} raw
 * @returns {McpKeyRecord | null}
 */
function parseKeyRecord(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.jti !== "string" || !raw.jti) return null;
  return {
    jti: raw.jti,
    hint: typeof raw.hint === "string" ? raw.hint : "",
    label: typeof raw.label === "string" ? raw.label : "",
    created_at: Number.isFinite(raw.created_at) ? Number(raw.created_at) : 0,
    exp: Number.isFinite(raw.exp) ? Number(raw.exp) : 0,
  };
}

/**
 * Clamp a time budget into the window the research tool advertises.
 * @param {number} seconds
 * @returns {number}
 */
export function clampMcpBudget(seconds) {
  if (!Number.isFinite(seconds)) return MCP_BUDGET_DEFAULT;
  return Math.min(MCP_BUDGET_MAX, Math.max(MCP_BUDGET_MIN, Math.round(seconds)));
}

/**
 * Whether one tool is exposed right now. The master switch wins: with the
 * surface off, no tool is exposed regardless of its own row.
 * @param {McpConfig} config
 * @param {string} id
 * @returns {boolean}
 */
export function toolExposed(config, id) {
  if (!config?.enabled) return false;
  return config.tools?.[id] === true;
}

/**
 * Filter a list of MCP tool definitions down to what this account exposes.
 * Tools with no catalog entry are dropped rather than passed through — an
 * unlisted tool has no switch, and silently exposing what the Settings screen
 * cannot show would defeat the point of the mirror test.
 * @template {{ name: string }} T
 * @param {McpConfig} config
 * @param {T[]} tools
 * @returns {T[]}
 */
export function filterMcpTools(config, tools) {
  return tools.filter((tool) => toolExposed(config, tool.name));
}

/**
 * Apply the account's defaults and override policy to one `deep_research`
 * tool call. The client's arguments win only where the account allows it; the
 * result is what src/mcp.js reads instead of the raw arguments.
 * @param {McpConfig} config
 * @param {any} args the tool-call arguments as sent
 * @returns {{ time_budget_s: number, web_search: boolean, model: string | undefined, agent: string, style: "text"|"voice" }}
 */
export function resolveResearchArgs(config, args) {
  const given = args && typeof args === "object" ? args : {};
  const budgetGiven = Number(given.time_budget_s);
  // VOICE lowers the default budget, and only the DEFAULT: a caller that names a
  // budget gets the budget it named, in either style. The reason is not that a
  // spoken answer needs less research — it is that a spoken exchange has a
  // different failure mode. Two minutes of silence ends a voice session (that is
  // the 2026-08-13 incident that put progress notifications on this surface);
  // two minutes of a spinner in a chat window does not.
  const voice = normalizeStyle(given.style) === "voice";
  const styleDefault = voice
    ? Math.min(config.defaults.time_budget_s, MCP_VOICE_BUDGET_DEFAULT)
    : config.defaults.time_budget_s;
  const time_budget_s =
    config.allow_budget_override && Number.isFinite(budgetGiven) ? clampMcpBudget(budgetGiven) : styleDefault;
  // web_search has no override policy of its own: an account that does not
  // want the MCP surface searching sets the default off, and a caller asking
  // for search it isn't paying for is exactly what the quota gate is for.
  // Explicit `false` from a caller always wins — declining work is always
  // allowed, in both directions.
  const web_search =
    typeof given.web_search === "boolean"
      ? config.defaults.web_search && given.web_search
      : config.defaults.web_search;
  const requested = typeof given.model === "string" ? given.model.trim() : "";
  const model = config.allow_model_override && requested ? requested : config.defaults.model || undefined;
  // `agent` and `style` have no account policy of their own and are carried
  // through as asked. Neither can widen anything: an agent narrows a run to one
  // domain's sources and prompts (and is refused outright if this account may not
  // use it, which src/mcp.js decides against the same grant chat.js uses), and a
  // style only shapes the text that comes back.
  const agent = typeof given.agent === "string" ? given.agent.trim().slice(0, 64) : "";
  return { time_budget_s, web_search, model, agent, style: normalizeStyle(given.style) };
}

/**
 * The same reconciliation for a PLATFORM tool call — the two tools that ask this
 * server about its own implementation (src/platform-tools.js).
 *
 * Three things are forced rather than offered, and each is forced because
 * offering it could only produce a worse answer:
 *
 *   `agent` is the introspection agent. It is what the tool IS; a caller
 *   choosing a different one would get a specialist answering about a codebase
 *   outside its domain.
 *
 *   `web_search` is off. The answer is grounded in this deployment's own source,
 *   and the introspection agent declares no web leg anyway — so the knob could
 *   only add a search wave that pulls in unrelated third-party projects sharing
 *   the words "deep research", which is the exact failure the pipeline's
 *   introspection-first routing exists to prevent. A caller that wants outside
 *   material has deep_research.
 *
 *   `style` DEFAULTS to voice, where deep_research defaults to text. That
 *   asymmetry is the point of the family: these tools were added for a caller
 *   who is listening, and a default that has to be corrected on every call is
 *   not a default. Naming `text` still gets the screen-shaped answer, with the
 *   file references a reader can act on.
 *
 * Everything else — the budget window, the model override policy — is
 * deep_research's, unchanged, because it is the same pipeline and the same
 * money.
 *
 * @param {McpConfig} config
 * @param {any} args the tool-call arguments as sent
 * @returns {{ time_budget_s: number, web_search: boolean, model: string | undefined, agent: string, style: "text"|"voice", require_agent: boolean }}
 */
export function resolveIntrospectArgs(config, args) {
  const given = args && typeof args === "object" ? args : {};
  const style = typeof given.style === "string" ? normalizeStyle(given.style) : "voice";
  const base = resolveResearchArgs(config, { ...given, style });
  // `require_agent` is the fourth forced value and the one that is not about
  // shaping the answer: with the web off, an agent that failed to resolve leaves
  // the run with no grounding at all, and src/mcp.js refuses rather than letting
  // it answer from memory. deep_research does not set it, because its own
  // degradation still searches.
  return { ...base, web_search: false, agent: PLATFORM_AGENT, style, require_agent: true };
}

/** The voice default budget: long enough for a real search wave, short enough
 * that a spoken exchange does not die waiting. */
export const MCP_VOICE_BUDGET_DEFAULT = 60;

/**
 * The answer style, defaulting to the screen-shaped one. Anything unrecognized
 * is `text` rather than an error — a caller inventing a style should get the
 * answer it can already read, not a refusal.
 * @param {unknown} value
 * @returns {"text"|"voice"}
 */
export function normalizeStyle(value) {
  return typeof value === "string" && value.trim().toLowerCase() === "voice" ? "voice" : "text";
}

/**
 * Validate and normalize a PUT /api/mcp/config body into a patch. Rejects
 * rather than coerces — a Settings screen that silently stored something
 * other than what was switched would be worse than an error.
 * @param {any} body
 * @returns {{ ok: true, patch: Partial<McpConfig> }|{ ok: false, error: string }}
 */
export function normalizeConfigPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  /** @type {any} */
  const patch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean." };
    patch.enabled = body.enabled;
  }
  if (body.tools !== undefined) {
    if (!body.tools || typeof body.tools !== "object" || Array.isArray(body.tools)) {
      return { ok: false, error: "tools must be an object of {tool_id: boolean}." };
    }
    /** @type {Record<string, boolean>} */
    const tools = {};
    for (const [id, value] of Object.entries(body.tools)) {
      if (!MCP_TOOL_IDS.includes(id)) return { ok: false, error: `Unknown tool: ${id}` };
      if (typeof value !== "boolean") return { ok: false, error: `tools.${id} must be a boolean.` };
      tools[id] = value;
    }
    patch.tools = tools;
  }
  if (body.defaults !== undefined) {
    if (!body.defaults || typeof body.defaults !== "object" || Array.isArray(body.defaults)) {
      return { ok: false, error: "defaults must be an object." };
    }
    /** @type {any} */
    const defaults = {};
    if (body.defaults.time_budget_s !== undefined) {
      const budget = Number(body.defaults.time_budget_s);
      if (!Number.isFinite(budget)) return { ok: false, error: "defaults.time_budget_s must be a number." };
      if (budget < MCP_BUDGET_MIN || budget > MCP_BUDGET_MAX) {
        return {
          ok: false,
          error: `defaults.time_budget_s must be between ${MCP_BUDGET_MIN} and ${MCP_BUDGET_MAX} seconds.`,
        };
      }
      defaults.time_budget_s = Math.round(budget);
    }
    if (body.defaults.web_search !== undefined) {
      if (typeof body.defaults.web_search !== "boolean") {
        return { ok: false, error: "defaults.web_search must be a boolean." };
      }
      defaults.web_search = body.defaults.web_search;
    }
    if (body.defaults.model !== undefined) {
      if (typeof body.defaults.model !== "string") return { ok: false, error: "defaults.model must be a string." };
      defaults.model = body.defaults.model.trim();
    }
    patch.defaults = defaults;
  }
  for (const flag of ["allow_model_override", "allow_budget_override"]) {
    if (body[flag] !== undefined) {
      if (typeof body[flag] !== "boolean") return { ok: false, error: `${flag} must be a boolean.` };
      patch[flag] = body[flag];
    }
  }
  if (!Object.keys(patch).length) {
    return { ok: false, error: "Nothing to update — send enabled, tools, defaults, or an override flag." };
  }
  return { ok: true, patch };
}

/**
 * Merge a validated patch onto a config. `tools` and `defaults` merge
 * key-by-key so the Settings screen can send one switch without resending the
 * rest; everything else replaces.
 * @param {McpConfig} config
 * @param {Partial<McpConfig>} patch
 * @returns {McpConfig}
 */
export function applyConfigPatch(config, patch) {
  return {
    ...config,
    ...patch,
    tools: { ...config.tools, ...(patch.tools || {}) },
    defaults: { ...config.defaults, ...(patch.defaults || {}) },
    key: config.key,
  };
}

/**
 * Whether a hostname is the DEDICATED MCP host (mcp.<site>) — the one an
 * external client is pointed at. Matched by subdomain label rather than by a
 * hard-coded string so a preview deploy, a fork, or a local run behaves the
 * same way as production.
 * @param {string | null | undefined} hostname
 * @returns {boolean}
 */
export function isMcpHost(hostname) {
  if (typeof hostname !== "string" || !hostname) return false;
  return hostname.toLowerCase().split(".")[0] === "mcp";
}

/**
 * Whether a request is addressed to the MCP endpoint. `/mcp` on any host is
 * the canonical path; on the dedicated `mcp.` host the BARE ORIGIN counts too,
 * because MCP clients disagree about whether the configured URL already
 * includes the path — and a wrong-URL 404 is the single most common way an MCP
 * setup fails. Used by src/index.js on both sides of the identity gate (the
 * key-bearing route above it, the session route below), so the two can never
 * disagree about what the endpoint is.
 * @param {URL} url
 * @param {string} method
 * @returns {boolean}
 */
export function isMcpEndpoint(url, method) {
  if (method !== "POST") return false;
  return url.pathname === "/mcp" || (isMcpHost(url.hostname) && url.pathname === "/");
}

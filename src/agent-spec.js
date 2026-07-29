// @ts-check
// AgentSpec's SERVER FAÇADE. The implementation — the control vocabulary,
// validation, resolution, quota/theme/example helpers, and the snapshot loader
// — lives in ONE shared module, public/js/agent-spec-core.js (the sdk-core.js /
// bash-core.js / introspect-core.js pattern), so the CLI (sdk/pair-cli.mjs),
// the Worker (Agent Studio mode, share-link minting), and the tests all use a
// single source of truth. The core lives under public/ because the browser can
// only import served modules, while the Worker bundler can import from anywhere
// — so the server reaches it through this re-export. New shared AgentSpec logic
// goes in agent-spec-core.js; do not reintroduce a copy.

/** One resolved capability block — the shape `resolveCapability` returns.
 * Re-declared here so Worker modules can name the type without reaching across
 * into `public/`, the same courtesy the value re-exports below provide.
 * @typedef {import('../public/js/agent-spec-core.js').AgentCapability} AgentCapability */

export {
  AGENTS_PATH,
  AGENT_LINK_SERVICES,
  BASE_THEME,
  CONTROL_REGISTRY,
  CONTROL_TYPES,
  PLATFORM_TYPES,
  QUOTA_WINDOWS,
  agentLinkPlan,
  agentTokenGrantParams,
  ANSWER_PHASES,
  BASE_CAPABILITY,
  CAPABILITY_EVENTS,
  CAPABILITY_REQUIREMENTS,
  CHAT_MODE_IDS,
  CONTEXT_BLOCKS,
  DEFAULT_PROMPT_SET,
  GATE_IDS,
  IMPLIED_REQUIREMENTS,
  requirementsFor,
  resolveUntrustedAgent,
  PROMPT_ROLES,
  PROMPT_SETS,
  missingPromptRoles,
  resolvePromptSet,
  TOOL_CLASSES,
  TOOL_FALLBACKS,
  agentsFromSnapshot,
  capBound,
  capHasContext,
  capHasTool,
  capSearch,
  composerMarkup,
  defaultAgentForMode,
  resolveCapability,
  resolveRequestAgent,
  serverOnlySelections,
  validateCapability,
  composerModel,
  controlMarkup,
  exampleGenPrompt,
  findAgent,
  proveComposer,
  renderAgentList,
  renderAgentShow,
  resolveControl,
  resolveControls,
  resolveExamples,
  resolveQuota,
  resolveTheme,
  validateAgentRegistry,
  validateAgentSpec,
} from "../public/js/agent-spec-core.js";

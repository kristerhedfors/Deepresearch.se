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
  agentsFromSnapshot,
  composerMarkup,
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

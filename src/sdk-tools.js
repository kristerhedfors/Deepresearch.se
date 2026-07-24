// @ts-check
// DistillSDK's SERVER FAÇADE. The implementation — the manifest
// operations, the SDK/build tool schemas and executors, and the generated-app
// file staging rules — lives in ONE shared module, public/js/sdk-core.js (the
// bash-core.js / introspect-core.js pattern), so the CLI (sdk/pair-cli.mjs),
// the DRS pipeline (src/pipeline.js runSdkBuild), and the MCP server
// (src/mcp.js sdk_* tools) all use a single source of truth. The core lives
// under public/ because the browser can only import served modules, while the
// Worker bundler can import from anywhere — so the server reaches it through
// this re-export. New shared SDK logic goes in sdk-core.js; do not
// reintroduce a copy.

export {
  BUILD_FILE_EXTS,
  BUILD_TOOLS,
  BUILD_TOOL_NAMES,
  MANIFEST_PATH,
  MAX_BUILD_FILES,
  MAX_BUILD_FILE_BYTES,
  MAX_BUILD_TOTAL_BYTES,
  SDK_TOOLS,
  SDK_TOOL_NAMES,
  buildFilesSummary,
  buildSdkContextBlock,
  buildSecureSourceDigest,
  makeFileLineScanner,
  manifestFromSnapshot,
  parseFileBlocks,
  renderList,
  renderPlan,
  renderShow,
  runSdkTool,
  sanitizeBuildPath,
  sdkToolStepHeadline,
  slugify,
  snapshotFileCheck,
  stageBuildFile,
  stripFileBlocks,
  validateManifest,
} from "../public/js/sdk-core.js";

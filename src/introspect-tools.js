// @ts-check
// The native source-investigation tools' SERVER FAÇADE. The implementation —
// the tool schemas and the pure snapshot executors (grep_source / read_file /
// list_files) — lives in ONE shared module, public/js/introspect-core.js, so
// both tiers use a single source of truth: the DRS server (src/pipeline.js via
// src/anthropic.js's tool loop) and the DRC browser client
// (public/js/drc-research.js's tool loop against the user's own provider). The
// core lives under public/ because the browser can only import served modules,
// while the Worker bundler can import from anywhere — so the server reaches it
// through this re-export, the same arrangement as src/bash-agent.js over
// public/js/bash-core.js.
//
// This is the owner-authorized 2026-07-12 exception to CLAUDE.md invariant 1
// (no function calling), scoped to developer mode + tool-capable answer models.
// New shared tool logic goes in introspect-core.js; do not reintroduce a copy.

export {
  INTROSPECTION_TOOLS,
  MAX_GREP_CONTEXT,
  MAX_GREP_MATCHES,
  MAX_GREP_OUTPUT_CHARS,
  MAX_LIST_ENTRIES,
  MAX_LINE_CHARS,
  MAX_PATTERN_CHARS,
  MAX_READ_TOTAL_CHARS,
  MERMAID_DIAGRAM_NOTE,
  grepSource,
  readFileTool,
  listFilesTool,
  runIntrospectionTool,
} from "../public/js/introspect-core.js";

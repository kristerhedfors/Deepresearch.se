// @ts-check
// Native tool-use tools for DEVELOPER-MODE source investigation, executed
// SERVER-SIDE against the deployed source snapshot (state.sourceSnapshot,
// public/introspect/source-snapshot.json).
//
// This is the deliberate, owner-authorized EXCEPTION to CLAUDE.md invariant 1
// (2026-07-12): for answer models that support real function calling (Claude
// via src/anthropic.js), developer mode lets the ANSWER MODEL ITSELF drive the
// investigation with native tool calls — grep_source (≈ `grep -rn`), read_file
// (≈ `cat`), list_files (≈ `ls`) — instead of the deterministic Mistral-driven
// read loop (public/js/introspect-core.js runSourceReadLoop). Models that do
// NOT support tool use keep the deterministic loop, so the pipeline still works
// across the whole catalog — the invariant's benefit is preserved where it
// matters, and the native experience is unlocked where the model can do it.
//
// Why server-side and not the browser bash sandbox: a server-driven tool loop
// (the /api/chat request) cannot synchronously reach the browser's CheerpX VM,
// and the sandbox is browser-only. But for SOURCE investigation (what "run bash
// to assess the code" actually needs), grep+read over the deployed snapshot is
// the reliable equivalent, needs no cross-origin-isolation, and works for every
// dev-mode user. The browser bash pre-pass still runs when its knob is on and
// its transcript rides into the loop as context.
//
// Everything here is PURE (operates on a passed snapshot) and NEVER throws — a
// bad tool input returns an explanatory string, matching the pipeline's
// fail-soft posture. Node-tested in introspect-tools.test.js.

import { readSnapshotFiles } from "../public/js/introspect-core.js";

/** @typedef {import('../public/js/introspect-core.js').Snapshot} Snapshot */

// Output bounds — a single tool result is clamped so a broad grep or a huge
// file can't blow the model's context window or the loop's token budget.
export const MAX_GREP_MATCHES = 80; // matching lines returned from one grep
export const MAX_GREP_OUTPUT_CHARS = 6000; // total chars of grep output
export const MAX_LIST_ENTRIES = 300; // paths returned from one list_files
export const MAX_LIST_OUTPUT_CHARS = 6000;
export const MAX_PATTERN_CHARS = 300; // a grep pattern is clamped to this
export const MAX_LINE_CHARS = 240; // one matched line is clamped to this

// The Anthropic-format tool definitions the answer model is offered. The shape
// (name / description / input_schema) is the Messages API `tools` entry; OpenAI
// tool-calling (a future provider) would map the same three onto its own shape.
export const INTROSPECTION_TOOLS = [
  {
    name: "grep_source",
    description:
      "Search the site's own deployed source code with a regular expression, like `grep -rn`. Returns matching lines as `path:line: text`. Use this FIRST to locate where something is implemented before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "A JavaScript regular expression. Case-sensitive unless you prefix it with (?i), e.g. (?i)session_secret.",
        },
        path_glob: {
          type: "string",
          description: "Optional substring to limit which files are searched, e.g. 'src/', '.js', or 'auth'.",
        },
        max_matches: { type: "integer", description: `Max matching lines to return (default ${MAX_GREP_MATCHES}).` },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the full contents of one or more source files by exact repo path (like `cat`), e.g. 'src/auth.js'. Use paths from grep_source or list_files.",
    input_schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative file paths to read." },
      },
      required: ["paths"],
    },
  },
  {
    name: "list_files",
    description:
      "List repo file paths (optionally filtered by a substring) with byte sizes, so you know what exists before grepping or reading.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional substring to filter paths, e.g. 'src/' or '.test.js'." },
      },
      required: [],
    },
  },
];

/** @param {Snapshot} snapshot @returns {Array<{p:string,s:number,t:string}>} */
function filesOf(snapshot) {
  return snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
}

/** @param {any} s @param {number} max @returns {string} */
function clip(s, max) {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  return str.length <= max ? str : str.slice(0, max) + `\n…[truncated ${str.length - max} chars]`;
}

// Compile the model-supplied pattern into a per-line RegExp. Supports a leading
// (?i) for case-insensitivity (JS has no inline flag). Returns null on an
// invalid or empty pattern — the caller reports it rather than throwing.
/** @param {unknown} raw @returns {RegExp | null} */
function compilePattern(raw) {
  let pat = String(raw || "").slice(0, MAX_PATTERN_CHARS);
  if (!pat.trim()) return null;
  let flags = "";
  if (pat.startsWith("(?i)")) {
    flags = "i";
    pat = pat.slice(4);
  }
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

/**
 * grep_source: scan every snapshot file (optionally filtered by a path
 * substring) for the pattern, line by line, returning `path:line: text` up to
 * the match/char caps. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function grepSource(snapshot, input) {
  const re = compilePattern(input?.pattern);
  if (!re) return `Invalid or empty regular expression: ${JSON.stringify(input?.pattern ?? null)}`;
  const glob = String(input?.path_glob || "").toLowerCase();
  const cap = Math.max(1, Math.min(MAX_GREP_MATCHES, Number(input?.max_matches) || MAX_GREP_MATCHES));
  /** @type {string[]} */
  const out = [];
  let total = 0;
  let truncated = false;
  for (const f of filesOf(snapshot)) {
    if (glob && !f.p.toLowerCase().includes(glob)) continue;
    const lines = String(f.t || "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Reset lastIndex defensively (no /g flag here, but be safe if a future
      // change adds one) and test the raw line.
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      out.push(`${f.p}:${i + 1}: ${lines[i].trim().slice(0, MAX_LINE_CHARS)}`);
      total++;
      if (total >= cap) {
        truncated = true;
        break;
      }
    }
    if (total >= cap) break;
  }
  if (!out.length) return `No matches for /${input?.pattern}/${glob ? ` in files matching '${glob}'` : ""}.`;
  const header = `${total} match${total === 1 ? "" : "es"}${truncated ? ` (capped at ${cap})` : ""}:`;
  return clip([header, ...out].join("\n"), MAX_GREP_OUTPUT_CHARS);
}

/**
 * read_file: resolve the requested paths against the snapshot and return their
 * full text (clamped by the shared read budget). Accepts {paths:[...]} or a
 * single {path:"..."}. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @param {{ used: number }} budget shared across the loop to bound total bytes
 * @returns {string}
 */
export function readFileTool(snapshot, input, budget) {
  const requested = Array.isArray(input?.paths)
    ? input.paths
    : typeof input?.path === "string"
      ? [input.path]
      : [];
  const paths = requested.filter((/** @type {any} */ p) => typeof p === "string" && p.trim()).slice(0, 8);
  if (!paths.length) return "read_file needs a non-empty 'paths' array of repo-relative file paths.";
  // Fresh alreadyRead set each call: the model may legitimately re-read a file
  // in a later round; the shared byte budget still bounds the total.
  const reads = readSnapshotFiles(snapshot, paths, new Set(), budget);
  if (!reads.length) {
    return `No files resolved for ${JSON.stringify(paths)}. Use list_files or grep_source to find exact paths (e.g. src/auth.js).`;
  }
  const body = reads.map((r) => `# ${r.p}${r.truncated ? " (truncated)" : ""}\n${r.text}`).join("\n\n");
  const missing = paths.filter((/** @type {string} */ p) => !reads.some((r) => r.p.toLowerCase() === String(p).toLowerCase().replace(/^\.?\//, "")));
  const note = missing.length ? `\n\n(not found / already at budget: ${missing.join(", ")})` : "";
  return body + note;
}

/**
 * list_files: the repo file paths (optionally substring-filtered) with byte
 * sizes. Never throws.
 * @param {Snapshot} snapshot
 * @param {any} input
 * @returns {string}
 */
export function listFilesTool(snapshot, input) {
  const filter = String(input?.filter || "").toLowerCase();
  const matched = filesOf(snapshot).filter((f) => !filter || f.p.toLowerCase().includes(filter));
  if (!matched.length) return `No files${filter ? ` matching '${filter}'` : ""}.`;
  const shown = matched.slice(0, MAX_LIST_ENTRIES);
  const header = `${matched.length} file${matched.length === 1 ? "" : "s"}${
    shown.length < matched.length ? ` (showing ${shown.length})` : ""
  }:`;
  return clip([header, ...shown.map((f) => `${f.p}\t${f.s}`)].join("\n"), MAX_LIST_OUTPUT_CHARS);
}

/**
 * Dispatch one native tool call to its server-side executor. The single seam
 * the tool loop (src/anthropic.js anthropicToolRun) calls; returns the tool
 * result STRING the model sees next round. Never throws — an unknown tool or a
 * bad input becomes an explanatory result the model can recover from.
 * @param {Snapshot} snapshot
 * @param {string} name
 * @param {any} input
 * @param {{ used: number }} budget
 * @returns {string}
 */
export function runIntrospectionTool(snapshot, name, input, budget) {
  try {
    switch (name) {
      case "grep_source":
        return grepSource(snapshot, input);
      case "read_file":
        return readFileTool(snapshot, input, budget);
      case "list_files":
        return listFilesTool(snapshot, input);
      default:
        return `Unknown tool "${name}". Available tools: grep_source, read_file, list_files.`;
    }
  } catch (/** @type {any} */ err) {
    return `Tool "${name}" failed: ${err?.message || String(err)}`;
  }
}

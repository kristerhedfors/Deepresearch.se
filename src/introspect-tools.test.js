// @ts-nocheck
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INTROSPECTION_TOOLS,
  grepSource,
  readFileTool,
  listFilesTool,
  runIntrospectionTool,
  MAX_GREP_MATCHES,
  MAX_READ_TOTAL_CHARS,
} from "./introspect-tools.js";

// A tiny fake snapshot in the real shape ({ files: [{ p, s, t }] }).
const SNAP = {
  v: 1,
  digest: "deadbeef",
  count: 3,
  bytes: 0,
  files: [
    { p: "src/auth.js", s: 120, t: "// auth\nasync function sessionHmacKeys(env) {\n  if (!env.SESSION_SECRET) return [];\n}\nconst SESSION = 1;\n" },
    { p: "src/index.js", s: 80, t: "// entry\nimport { verifySessionCookie } from './auth.js';\nexport default { fetch() {} };\n" },
    { p: "SECURITY-RISKS.md", s: 40, t: "# Security risks\nSESSION_SECRET must be set.\n" },
  ],
};

describe("INTROSPECTION_TOOLS schema", () => {
  test("declares grep_source, read_file, list_files with input schemas", () => {
    const names = INTROSPECTION_TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, ["grep_source", "list_files", "read_file"]);
    for (const t of INTROSPECTION_TOOLS) {
      assert.equal(typeof t.description, "string");
      assert.equal(t.input_schema.type, "object");
    }
    const grep = INTROSPECTION_TOOLS.find((t) => t.name === "grep_source");
    assert.deepEqual(grep.input_schema.required, ["pattern"]);
  });
});

describe("grepSource", () => {
  test("returns path:line: text matches across files", () => {
    const out = grepSource(SNAP, { pattern: "SESSION_SECRET" });
    assert.match(out, /src\/auth\.js:3: .*SESSION_SECRET/);
    assert.match(out, /SECURITY-RISKS\.md:2:/);
    assert.match(out, /^2 matches:/);
  });

  test("path_glob limits which files are searched", () => {
    const out = grepSource(SNAP, { pattern: "SESSION_SECRET", path_glob: "src/" });
    assert.match(out, /src\/auth\.js/);
    assert.doesNotMatch(out, /SECURITY-RISKS/); // excluded by the glob
  });

  test("(?i) prefix makes it case-insensitive", () => {
    assert.match(grepSource(SNAP, { pattern: "(?i)session_secret" }), /matches:/);
    assert.match(grepSource(SNAP, { pattern: "session_secret" }), /No matches/);
  });

  test("no matches and invalid regex return explanatory strings, never throw", () => {
    assert.match(grepSource(SNAP, { pattern: "zzz-not-here" }), /No matches/);
    assert.match(grepSource(SNAP, { pattern: "(" }), /Invalid or empty/);
    assert.match(grepSource(SNAP, { pattern: "" }), /Invalid or empty/);
  });

  test("respects max_matches cap", () => {
    const many = { files: [{ p: "a.txt", s: 0, t: Array.from({ length: 50 }, () => "hit").join("\n") }] };
    const out = grepSource(many, { pattern: "hit", max_matches: 5 });
    assert.match(out, /5 matches \(capped at 5\)/);
    assert.ok(MAX_GREP_MATCHES >= 5);
  });
});

describe("readFileTool", () => {
  test("reads full files by path, formatted with a # path header", () => {
    const out = readFileTool(SNAP, { paths: ["src/auth.js"] }, { used: 0 });
    assert.match(out, /# src\/auth\.js/);
    assert.match(out, /sessionHmacKeys/);
  });

  test("accepts a single {path} and resolves a bare basename", () => {
    assert.match(readFileTool(SNAP, { path: "auth.js" }, { used: 0 }), /# src\/auth\.js/);
  });

  test("unknown paths return a helpful pointer, not an error", () => {
    assert.match(readFileTool(SNAP, { paths: ["nope.js"] }, { used: 0 }), /No files resolved/);
    assert.match(readFileTool(SNAP, {}, { used: 0 }), /needs a non-empty 'paths'/);
  });

  // Regression (2026-07-16): once an earlier batch had spent the shared read
  // budget, a later read_file of perfectly VALID paths reported "No files
  // resolved" — the model took that as intermittent tool failure, retried
  // paths that could never load, and reported files "failed to load".
  test("a spent read budget says so instead of 'No files resolved'", () => {
    const out = readFileTool(SNAP, { paths: ["src/auth.js"] }, { used: MAX_READ_TOTAL_CHARS });
    assert.match(out, /Read budget exhausted/);
    assert.match(out, /retrying will not help/);
    assert.doesNotMatch(out, /No files resolved/);
  });

  test("budget running out mid-call reports dropped paths as budget, not missing", () => {
    const budget = { used: MAX_READ_TOTAL_CHARS - 10 }; // room for 10 chars
    const out = readFileTool(SNAP, { paths: ["src/auth.js", "src/index.js"] }, budget);
    assert.match(out, /# src\/auth\.js \(truncated\)/);
    assert.match(out, /read budget exhausted before: src\/index\.js/);
    assert.doesNotMatch(out, /not found/);
  });

  test("wrong paths in a mixed batch still report as not found", () => {
    const out = readFileTool(SNAP, { paths: ["src/auth.js", "nope.js"] }, { used: 0 });
    assert.match(out, /# src\/auth\.js/);
    assert.match(out, /\(not found: nope\.js\)/);
    assert.doesNotMatch(out, /budget exhausted/);
  });
});

describe("listFilesTool", () => {
  test("lists paths with sizes, filtered by substring", () => {
    const all = listFilesTool(SNAP, {});
    assert.match(all, /3 files:/);
    assert.match(all, /src\/auth\.js\t120/);
    const filtered = listFilesTool(SNAP, { filter: "src/" });
    assert.match(filtered, /2 files/);
    assert.doesNotMatch(filtered, /SECURITY-RISKS/);
  });
});

describe("runIntrospectionTool dispatch", () => {
  test("routes to each executor and rejects unknown tools without throwing", () => {
    assert.match(runIntrospectionTool(SNAP, "grep_source", { pattern: "SESSION" }, { used: 0 }), /matches:/);
    assert.match(runIntrospectionTool(SNAP, "read_file", { paths: ["src/index.js"] }, { used: 0 }), /# src\/index\.js/);
    assert.match(runIntrospectionTool(SNAP, "list_files", {}, { used: 0 }), /files:/);
    assert.match(runIntrospectionTool(SNAP, "bogus", {}, { used: 0 }), /Unknown tool/);
  });
});

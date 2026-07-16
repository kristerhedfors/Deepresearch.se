// @ts-nocheck
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  INTROSPECTION_TOOLS,
  grepSource,
  readFileTool,
  listFilesTool,
  runIntrospectionTool,
  MAX_GREP_CONTEXT,
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

  // The standard file-exploration surface: grep with context, read with
  // offset/limit — and the read budget stated up front in the description,
  // so a model can plan targeted extraction instead of whole-file reads.
  test("declares the targeted-extraction params and states the read budget", () => {
    const grep = INTROSPECTION_TOOLS.find((t) => t.name === "grep_source");
    assert.equal(grep.input_schema.properties.context.type, "integer");
    const read = INTROSPECTION_TOOLS.find((t) => t.name === "read_file");
    assert.equal(read.input_schema.properties.offset.type, "integer");
    assert.equal(read.input_schema.properties.limit.type, "integer");
    assert.match(read.description, new RegExp(String(MAX_READ_TOTAL_CHARS)));
    assert.match(read.description, /offset\/limit/);
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

  // The standard `grep -C` shape: context lines marked with `-`, hunks
  // separated by `--` — the free way to see usage without a read_file spend.
  test("context returns surrounding lines with - markers and -- between hunks", () => {
    const f = { p: "a.js", s: 0, t: ["one", "two", "HIT a", "four", "five", "six", "seven", "HIT b", "nine"].join("\n") };
    const out = grepSource({ files: [f] }, { pattern: "HIT", context: 1 });
    assert.match(out, /^2 matches:/);
    assert.match(out, /a\.js-2- two/); // context line before the first match
    assert.match(out, /a\.js:3: HIT a/); // the match keeps the : marker
    assert.match(out, /a\.js-4- four/);
    assert.match(out, /\n--\n/); // gap between the two hunks
    assert.match(out, /a\.js:8: HIT b/);
  });

  test("overlapping context hunks merge without duplicate lines", () => {
    const f = { p: "b.js", s: 0, t: ["one", "HIT a", "three", "HIT b", "five"].join("\n") };
    const out = grepSource({ files: [f] }, { pattern: "HIT", context: 1 });
    assert.equal(out.split("\n").filter((l) => l.includes("-3-") || l.includes(":3:")).length, 1);
    assert.doesNotMatch(out, /--/); // contiguous — no hunk separator
  });

  test("context is clamped to MAX_GREP_CONTEXT and defaults to 0", () => {
    const f = { p: "c.js", s: 0, t: Array.from({ length: 30 }, (_, i) => (i === 15 ? "HIT" : `line ${i}`)).join("\n") };
    const plain = grepSource({ files: [f] }, { pattern: "HIT" });
    assert.equal(plain.split("\n").length, 2); // header + the one match, no context
    const clamped = grepSource({ files: [f] }, { pattern: "HIT", context: 99 });
    assert.equal(clamped.split("\n").length, 2 + 2 * MAX_GREP_CONTEXT);
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

  // Targeted extraction without bash: offset/limit reads a line range and
  // charges the budget only for the slice — the `sed -n` of the tool set.
  test("offset/limit reads a line range and charges only the slice", () => {
    const budget = { used: 0 };
    const out = readFileTool(SNAP, { paths: ["src/auth.js"], offset: 2, limit: 2 }, budget);
    assert.match(out, /# src\/auth\.js \(lines 2-3 of 6\)/);
    assert.match(out, /sessionHmacKeys/); // line 2
    assert.match(out, /SESSION_SECRET/); // line 3
    assert.doesNotMatch(out, /const SESSION = 1/); // line 5 not included
    const slice = SNAP.files[0].t.split("\n").slice(1, 3).join("\n");
    assert.equal(budget.used, slice.length);
  });

  test("offset beyond EOF clamps to the last line; limit alone starts at line 1", () => {
    assert.match(readFileTool(SNAP, { paths: ["src/auth.js"], offset: 999 }, { used: 0 }), /\(lines 6-6 of 6\)/);
    assert.match(readFileTool(SNAP, { paths: ["src/auth.js"], limit: 1 }, { used: 0 }), /\(lines 1-1 of 6\)/);
  });

  test("every read result reports the running shared budget", () => {
    const budget = { used: 0 };
    const out = readFileTool(SNAP, { paths: ["src/index.js"] }, budget);
    assert.match(out, new RegExp(`\\(read budget used: ${budget.used} of ${MAX_READ_TOTAL_CHARS} chars\\)`));
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

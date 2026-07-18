// Unit suite for the Agent-Pair SDK's shared pure core (sdk-core.js): the
// snapshot-backed manifest loading, the build-file staging rules, the
// deterministic FILE-block convention, and the native SDK tool executors.
// The manifest-operation helpers themselves (validate/close/order/render) are
// covered by sdk/pair-cli.test.mjs, which re-imports the same functions
// through the CLI façade — one implementation, two suites' entry points.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_TOOLS,
  MANIFEST_PATH,
  MAX_BUILD_FILES,
  MAX_BUILD_FILE_BYTES,
  SDK_TOOLS,
  buildFilesSummary,
  buildSdkContextBlock,
  manifestFromSnapshot,
  parseFileBlocks,
  runSdkTool,
  sanitizeBuildPath,
  sdkToolStepHeadline,
  slugify,
  snapshotFileCheck,
  stageBuildFile,
} from "./sdk-core.js";

const manifest = () => ({
  baseplate: ["arch"],
  layers: { 0: "Foundation", 1: "Plane" },
  modules: [
    { id: "arch", name: "Architecture", layer: 0, class: "D", deps: [], skill: "sdk/skills/arch/SKILL.md", provides: "p", reference: [], acceptance: "a" },
    { id: "client", name: "Client", layer: 1, class: "C", deps: ["arch"], skill: "sdk/skills/client/SKILL.md", provides: "p", reference: [], acceptance: "b" },
  ],
});

const snapshot = () => ({
  files: [
    { p: MANIFEST_PATH, s: 10, t: JSON.stringify(manifest()) },
    { p: "sdk/skills/arch/SKILL.md", s: 5, t: "# arch" },
    { p: "sdk/skills/client/SKILL.md", s: 5, t: "# client" },
  ],
});

test("manifestFromSnapshot: parses the committed manifest; fail-soft on junk", () => {
  const m = manifestFromSnapshot(snapshot());
  assert.equal(m.modules.length, 2);
  assert.equal(manifestFromSnapshot(null), null);
  assert.equal(manifestFromSnapshot({ files: [] }), null);
  assert.equal(manifestFromSnapshot({ files: [{ p: MANIFEST_PATH, s: 1, t: "{not json" }] }), null);
  assert.equal(manifestFromSnapshot({ files: [{ p: MANIFEST_PATH, s: 1, t: "{}" }] }), null);
});

test("snapshotFileCheck: existence against the snapshot's file list", () => {
  const check = snapshotFileCheck(snapshot());
  assert.equal(check("sdk/skills/arch/SKILL.md"), true);
  assert.equal(check("sdk/skills/nope/SKILL.md"), false);
});

test("sanitizeBuildPath: accepts clean relative text files, rejects everything else", () => {
  assert.equal(sanitizeBuildPath("index.html"), "index.html");
  assert.equal(sanitizeBuildPath("./css/app.css"), "css/app.css");
  assert.equal(sanitizeBuildPath("js\\app.js"), "js/app.js");
  assert.equal(sanitizeBuildPath("/etc/passwd"), null);
  assert.equal(sanitizeBuildPath("../up.html"), null);
  assert.equal(sanitizeBuildPath("a/../b.html"), null);
  assert.equal(sanitizeBuildPath(".hidden.html"), null);
  assert.equal(sanitizeBuildPath("app.exe"), null);
  assert.equal(sanitizeBuildPath("noext"), null);
  assert.equal(sanitizeBuildPath("sp ace.html"), null);
  assert.equal(sanitizeBuildPath(42), null);
});

test("stageBuildFile: stages, replaces, and enforces the caps with speaking errors", () => {
  const staged = new Map();
  const ok = stageBuildFile(staged, "index.html", "<h1>hi</h1>");
  assert.equal(ok.ok, true);
  assert.equal(ok.path, "index.html");
  // Replacement is allowed (iteration) and doesn't double-count.
  assert.equal(stageBuildFile(staged, "index.html", "<h1>v2</h1>").ok, true);
  assert.equal(staged.size, 1);
  const bad = stageBuildFile(staged, "../x.html", "x");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid path/);
  const noContent = stageBuildFile(staged, "a.js", null);
  assert.equal(noContent.ok, false);
  assert.match(noContent.error, /string `content`/);
  const big = stageBuildFile(staged, "big.txt", "x".repeat(MAX_BUILD_FILE_BYTES + 1));
  assert.equal(big.ok, false);
  assert.match(big.error, /too large/);
  // File-count cap.
  for (let i = 0; i < MAX_BUILD_FILES + 5; i++) stageBuildFile(staged, `f${i}.txt`, "x");
  assert.equal(staged.size, MAX_BUILD_FILES);
});

test("slugify: lowercased hyphen words, bounded, junk-safe", () => {
  assert.equal(slugify("My Cool App!"), "my-cool-app");
  assert.equal(slugify("  Åäö räksmörgås  "), "aao-raksmorgas");
  assert.equal(slugify(null), "");
});

test("parseFileBlocks: the deterministic FILE-block convention", () => {
  const text =
    "Here is the app.\n\nFILE: index.html\n```html\n<!doctype html>\n<h1>Hi</h1>\n```\n\n" +
    "FILE: css/app.css\n```css\nbody { color: red; }\n```\n\n" +
    "FILE: ../evil.html\n```html\nnope\n```\n" +
    "FILE: index.html\n```html\n<h1>v2</h1>\n```\n";
  const files = parseFileBlocks(text);
  assert.deepEqual(files.map((f) => f.path).sort(), ["css/app.css", "index.html"]);
  // The later duplicate wins (iteration semantics).
  assert.equal(files.find((f) => f.path === "index.html").content, "<h1>v2</h1>");
  assert.equal(files.find((f) => f.path === "css/app.css").content, "body { color: red; }");
  assert.deepEqual(parseFileBlocks("no files here"), []);
});

test("runSdkTool: list/show/plan/validate against the snapshot manifest", () => {
  const m = manifestFromSnapshot(snapshot());
  assert.match(runSdkTool(m, "sdk_list_modules", {}), /Layer 0 — Foundation/);
  assert.match(runSdkTool(m, "sdk_show_module", { id: "client" }), /deps: arch/);
  assert.match(runSdkTool(m, "sdk_show_module", { id: "nope" }), /unknown module/);
  const plan = runSdkTool(m, "sdk_plan", { modules: ["client"] });
  assert.match(plan, /1\. arch/);
  assert.match(plan, /2\. client/);
  assert.match(runSdkTool(m, "sdk_plan", {}), /non-empty `modules`/);
  assert.match(runSdkTool(m, "sdk_plan", { modules: ["ghost"] }), /Cannot plan: unknown module: ghost/);
  const check = snapshotFileCheck(snapshot());
  assert.match(runSdkTool(m, "sdk_validate", {}, { fileCheck: check }), /^OK: 2 modules/);
  assert.match(runSdkTool(null, "sdk_list_modules", {}), /unavailable/);
  assert.match(runSdkTool(m, "wat", {}), /Unknown SDK tool/);
});

test("tool definitions: provider-neutral shape, required fields present", () => {
  for (const t of [...SDK_TOOLS, ...BUILD_TOOLS]) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.equal(t.input_schema.type, "object");
  }
  assert.deepEqual(SDK_TOOLS.map((t) => t.name), ["sdk_list_modules", "sdk_show_module", "sdk_plan", "sdk_validate"]);
  assert.deepEqual(BUILD_TOOLS.map((t) => t.name), ["write_file", "publish_app"]);
});

test("headlines + summaries: legible activity labels", () => {
  assert.equal(sdkToolStepHeadline("write_file", { path: "index.html" }), "write_file  index.html");
  assert.match(sdkToolStepHeadline("sdk_plan", { modules: ["a", "b"] }), /sdk plan {2}a, b/);
  assert.deepEqual(buildFilesSummary([["index.html", "<h1>x</h1>"]]), ["index.html (10 bytes)"]);
});

test("buildSdkContextBlock: catalog + convention for the no-tools path only", () => {
  const m = manifestFromSnapshot(snapshot());
  const detBlock = buildSdkContextBlock(m, { toolMode: false });
  assert.match(detBlock, /Module catalog/);
  assert.match(detBlock, /FILE: index\.html/);
  const toolBlock = buildSdkContextBlock(m, { toolMode: true, buildUrl: "/build/x-1234/" });
  assert.doesNotMatch(toolBlock, /FILE: index\.html/);
  assert.match(toolBlock, /\/build\/x-1234\//);
  assert.match(buildSdkContextBlock(null, {}), /could not be loaded/);
});

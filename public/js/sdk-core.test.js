// Unit suite for DistillSDK's shared pure core (sdk-core.js): the
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
  SECURE_DIGEST_BUDGET,
  buildFilesSummary,
  buildSdkContextBlock,
  buildSecureSourceDigest,
  manifestFromSnapshot,
  parseFileBlocks,
  runSdkTool,
  sanitizeBuildPath,
  secureSourceExcerpt,
  sdkToolStepHeadline,
  slugify,
  snapshotFileCheck,
  sourceSkeleton,
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

test("buildSdkContextBlock: DistillSDK catalog + Se/cure reference + privacy invariants; convention for the no-tools path only", () => {
  const m = manifestFromSnapshot(snapshot());
  const detBlock = buildSdkContextBlock(m, { toolMode: false });
  assert.match(detBlock, /DistillSDK module catalog/);
  assert.match(detBlock, /public\/cure\/drc\.js/); // points at the real Se/cure source to distill
  assert.match(detBlock, /PRIVACY INVARIANTS/);
  assert.match(detBlock, /flavour/i);
  assert.match(detBlock, /FILE: index\.html/); // deterministic path teaches the convention
  const toolBlock = buildSdkContextBlock(m, { toolMode: true, buildUrl: "/app/x-1234/" });
  assert.doesNotMatch(toolBlock, /FILE: index\.html/);
  assert.match(toolBlock, /sdk_\* tools/); // tool path names the planners
  assert.match(toolBlock, /grep_source/); // tool path names the snapshot readers
  assert.match(toolBlock, /\/app\/x-1234\//);
  assert.match(buildSdkContextBlock(null, {}), /could not be loaded/);
});

test("sourceSkeleton: keeps the shape-bearing lines per language, drops the body", () => {
  const js = sourceSkeleton(
    "x.js",
    [
      "// ---- section one ----",
      "export function alpha(a, b) {",
      "  const hidden = a + b; // body line, must be dropped",
      "  return hidden;",
      "}",
      "const CAP = 40;",
      "class Beta {}",
    ].join("\n"),
  );
  assert.match(js, /export function alpha/);
  assert.match(js, /const CAP = 40/);
  assert.match(js, /class Beta/);
  assert.match(js, /section one/);
  assert.doesNotMatch(js, /hidden = a \+ b/); // interior body is not kept

  const css = sourceSkeleton("x.css", ":root {\n  --bg: #fff;\n  color: red;\n}\n.card {\n  padding: 4px;\n}");
  assert.match(css, /:root/);
  assert.match(css, /--bg: #fff/);
  assert.match(css, /\.card \{/);
  assert.doesNotMatch(css, /color: red/); // ordinary declaration dropped

  const html = sourceSkeleton("x.html", '<main id="stage">\n  <p>hello there body</p>\n  <form id="f"></form>\n');
  assert.match(html, /id="stage"/);
  assert.match(html, /id="f"/);
  assert.doesNotMatch(html, /hello there body/);

  assert.equal(sourceSkeleton("x.md", "# Title\n\nprose"), ""); // no skeleton for markdown
});

test("secureSourceExcerpt: verbatim when it fits, skeleton/clip when it doesn't", () => {
  const small = "export const a = 1;\n";
  assert.deepEqual(secureSourceExcerpt("s.js", small, 1000), { body: small, mode: "full" });

  const big = "export function keepMe() {}\n" + "  const filler = 0;\n".repeat(500);
  const ex = secureSourceExcerpt("b.js", big, 200);
  assert.equal(ex.mode, "skeleton");
  assert.ok(ex.body.length <= 200);
  assert.match(ex.body, /keepMe/); // the signature survives, the filler body doesn't

  // Markdown has no skeleton → a head excerpt (mode "head"), still bounded.
  const md = secureSourceExcerpt("d.md", "# Title\n" + "prose line\n".repeat(500), 120);
  assert.equal(md.mode, "head");
  assert.ok(md.body.length <= 120);
});

test("buildSecureSourceDigest: real source content, fairly shared, bounded", () => {
  const snap = {
    files: [
      { p: "public/cure/index.html", t: '<main id="stage"></main>\n'.repeat(400) },
      { p: "public/cure/drc.js", t: "export function bigThing(){}\n" + "x;\n".repeat(4000) },
      { p: "public/js/drc-store.js", t: "export const tiny = 42;\n" }, // small → verbatim, must not be starved
    ],
  };
  const digest = buildSecureSourceDigest(snap, { budget: 4000, refs: ["public/cure/index.html", "public/cure/drc.js", "public/js/drc-store.js"] });
  assert.match(digest, /reference SOURCE/);
  assert.match(digest, /public\/cure\/index\.html/);
  assert.match(digest, /public\/cure\/drc\.js/);
  assert.match(digest, /bigThing/); // the big file's signature is present
  assert.match(digest, /tiny = 42/); // the small trailing file still made it in (fair share)
  assert.ok(digest.length <= 6000, `digest ${digest.length} within budget-ish`); // bounded (headers add a little)

  assert.equal(buildSecureSourceDigest(null), ""); // no snapshot → empty
  assert.equal(buildSecureSourceDigest({ files: [] }), "");
  assert.ok(SECURE_DIGEST_BUDGET > 0);
});

test("buildSdkContextBlock: injects the Se/cure source digest when provided", () => {
  const m = manifestFromSnapshot(snapshot());
  const digest = "Se/cure reference SOURCE (the original to distill — study it before building):\n\n----- x.js (10 chars) -----\nexport a";
  const withDigest = buildSdkContextBlock(m, { toolMode: true, secureDigest: digest });
  assert.match(withDigest, /reference SOURCE/);
  assert.match(withDigest, /digest above is your starting material/i); // tool-path guidance leans on it
  const without = buildSdkContextBlock(m, { toolMode: true });
  assert.doesNotMatch(without, /reference SOURCE/);
});

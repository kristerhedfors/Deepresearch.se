// Unit suite for DistillSDK's shared pure core (sdk-core.js): the
// snapshot-backed manifest loading, the build-file staging rules, the
// deterministic FILE-block convention, and the native SDK tool executors.
// The manifest-operation helpers themselves (validate/close/order/render) are
// covered by sdk/pair-cli.test.mjs, which re-imports the same functions
// through the CLI façade — one implementation, two suites' entry points.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  APP_KIT_NOTE,
  APP_KIT_PATH,
  BUILD_TOOLS,
  MANIFEST_PATH,
  MAX_BUILD_FILES,
  MAX_BUILD_FILE_BYTES,
  SDK_TOOLS,
  SECURE_DIGEST_BUDGET,
  buildFilesSummary,
  buildNeedsAppKit,
  buildSdkContextBlock,
  buildSecureSourceDigest,
  buildTargetFor,
  findUnterminatedFileBlock,
  makeFileLineScanner,
  manifestFromSnapshot,
  mergeContinuation,
  parseFileBlocks,
  runSdkTool,
  stripFileBlocks,
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

test("stripFileBlocks: removes the blocks, keeps the prose around them", () => {
  const text =
    "Built **TABLOID WIRE** for you.\n\nFILE: index.html\n```html\n<!doctype html>\n<h1>Hi</h1>\n```\n\n" +
    "A note between files.\n\nFILE: css/app.css\n```css\nbody { color: red; }\n```\n\nEnjoy the app!";
  const prose = stripFileBlocks(text);
  assert.equal(prose, "Built **TABLOID WIRE** for you.\n\nA note between files.\n\nEnjoy the app!");
  assert.ok(!prose.includes("FILE:"));
  assert.ok(!prose.includes("doctype"));
  // No blocks → the text is just trimmed, never mangled.
  assert.equal(stripFileBlocks("  plain reply\nwith lines  "), "plain reply\nwith lines");
  assert.equal(stripFileBlocks(""), "");
  assert.equal(stripFileBlocks(/** @type {any} */ (null)), "");
});

// ---- the truncated build (feedback #30, chat_logs #650) ---------------------
// The draft stopped at the output ceiling mid-attribute, so no fence ever
// closed. parseFileBlocks saw zero files and the raw half-written index.html
// was shown to the user as prose, with no app and no link.

const truncated =
  "Here's the stripped-down client.\n\nFILE: index.html\n```html\n<!doctype html>\n" +
  '<div class="brand-sub">client-side · calls go';

test("findUnterminatedFileBlock: catches the file the model was still writing", () => {
  const cut = findUnterminatedFileBlock(truncated);
  assert.equal(cut.path, "index.html");
  assert.ok(cut.content.startsWith("<!doctype html>"));
  assert.equal(truncated.slice(cut.at + 1).startsWith("FILE: index.html"), true);
  // A well-formed draft has nothing open — every block terminated.
  assert.equal(
    findUnterminatedFileBlock("FILE: index.html\n```html\n<h1>Hi</h1>\n```\n\nDone!"),
    null,
  );
  // Complete files followed by a truncated one: only the last is open.
  const mixed = "FILE: a.html\n```html\n<h1>A</h1>\n```\n\nFILE: b.css\n```css\nbody { colo";
  assert.equal(findUnterminatedFileBlock(mixed).path, "b.css");
  assert.equal(findUnterminatedFileBlock("no files here"), null);
  assert.equal(findUnterminatedFileBlock(""), null);
  assert.equal(findUnterminatedFileBlock(/** @type {any} */ (null)), null);
});

test("stripFileBlocks: a truncated trailing block never reaches the user", () => {
  const prose = stripFileBlocks(truncated);
  assert.equal(prose, "Here's the stripped-down client.");
  assert.ok(!prose.includes("doctype"));
  assert.ok(!prose.includes("brand-sub"));
  assert.ok(!prose.includes("FILE:"));
});

test("mergeContinuation: splices the remainder into one parseable draft", () => {
  const merged = mergeContinuation(truncated, ' to the provider</div>\n```\n\nThat\'s the whole app.');
  const files = parseFileBlocks(merged);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "index.html");
  assert.ok(files[0].content.endsWith("to the provider</div>"));
  assert.equal(findUnterminatedFileBlock(merged), null);
  assert.equal(stripFileBlocks(merged), "Here's the stripped-down client.\n\nThat's the whole app.");
});

test("mergeContinuation: survives the two ways a model resumes badly", () => {
  // It re-opens a fence before continuing — the opener must not land in the file.
  const refenced = mergeContinuation(truncated, "```html\n to the provider</div>\n```");
  assert.ok(!parseFileBlocks(refenced)[0].content.includes("```"));
  // It restarts the whole file — its version replaces the truncated opening.
  const restarted = mergeContinuation(truncated, "FILE: index.html\n```html\n<!doctype html>\n<p>v2</p>\n```");
  const files = parseFileBlocks(restarted);
  assert.equal(files.length, 1);
  assert.equal(files[0].content, "<!doctype html>\n<p>v2</p>");
  assert.ok(!files[0].content.includes("brand-sub"));
  // Nothing usable back, or nothing open to continue: the draft is untouched.
  assert.equal(mergeContinuation(truncated, "   "), truncated);
  assert.equal(mergeContinuation("plain reply", "more"), "plain reply");
});

test("makeFileLineScanner: reports each FILE line once, only when its line is complete", () => {
  const scan = makeFileLineScanner();
  let buf = "Intro prose.\nFILE: index.ht";
  assert.deepEqual(scan.feed(buf), []); // line not complete yet
  buf += "ml\n```html\n<h1>";
  assert.deepEqual(scan.feed(buf), ["index.html"]);
  assert.deepEqual(scan.feed(buf), []); // no re-report without new content
  buf += "</h1>\n```\nFILE: ../evil.html\nFILE: css/app.css\n";
  assert.deepEqual(scan.feed(buf), ["css/app.css"]); // invalid path skipped
  // A FILE marker at the very start of the draft counts too.
  const scan2 = makeFileLineScanner();
  assert.deepEqual(scan2.feed("FILE: js/app.js\n"), ["js/app.js"]);
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

test("buildSdkContextBlock: Platform SDK catalog + Se/cure reference + privacy invariants; convention for the no-tools path only", () => {
  const m = manifestFromSnapshot(snapshot());
  const detBlock = buildSdkContextBlock(m, { toolMode: false, target: "platform" });
  assert.match(detBlock, /Platform SDK module catalog/);
  assert.match(detBlock, /public\/cure\/drc\.js/); // points at the real Se/cure source to distill
  assert.match(detBlock, /PRIVACY INVARIANTS/);
  assert.match(detBlock, /flavour/i);
  assert.match(detBlock, /FILE: index\.html/); // deterministic path teaches the convention
  const toolBlock = buildSdkContextBlock(m, { toolMode: true, buildUrl: "/app/x-1234/", target: "platform" });
  assert.doesNotMatch(toolBlock, /FILE: index\.html/);
  assert.match(toolBlock, /sdk_\* tools/); // tool path names the planners
  assert.match(toolBlock, /grep_source/); // tool path names the snapshot readers
  assert.match(toolBlock, /\/app\/x-1234\//);
  assert.match(buildSdkContextBlock(null, {}), /could not be loaded/);
});

// Feedback #41 (2026-07-27): a request for ONE agent ("a single-purpose
// legal-research agent") was built — and described to the user — as a Platform
// SDK distillation, which is the method for standing up a whole platform.
describe("which SDK builds this (feedback #41)", () => {
  test("buildTargetFor defaults to the agent and takes a platform ask in EN and SV", () => {
    // The default: an ordinary Agent Studio ask is ONE agent.
    assert.equal(buildTargetFor("Build a single-purpose legal-research agent in deep blue"), "agent");
    assert.equal(buildTargetFor("bygg en enkel researchassistent i mörkblått"), "agent");
    assert.equal(buildTargetFor(""), "agent");
    assert.equal(buildTargetFor("make me a todo app"), "agent");

    // Swedish parity, one case per EN concept (invariant 6).
    const platform = [
      ["build me a whole research platform", "bygg en hel researchplattform"],
      ["I want the entire site, my own copy", "jag vill ha hela sajten, en egen kopia"],
      ["distil both tiers into a new product", "destillera båda nivåerna till en ny produkt"],
      ["give me a clone of the deepresearch site", "ge mig en klon av deepresearch-sajten"],
      ["a full-stack version of this", "en fullstack-version av det här"],
    ];
    for (const [en, sv] of platform) {
      assert.equal(buildTargetFor(en), "platform", `EN: ${en}`);
      assert.equal(buildTargetFor(sv), "platform", `SV: ${sv}`);
    }
  });

  test("an agent build is briefed on the Agent SDK, a platform build on the Platform SDK", () => {
    const m = manifestFromSnapshot(snapshot());
    const agent = buildSdkContextBlock(m, { toolMode: true, target: "agent", agentBlock: "AGENT-REGISTRY-DIGEST" });
    assert.match(agent, /build an AGENT with the Agent SDK/);
    assert.match(agent, /AGENT SDK is the method/i);
    assert.match(agent, /AGENT-REGISTRY-DIGEST/); // the Agent SDK's own material rides along
    // The Platform SDK is still offered, but explicitly as the OTHER SDK.
    assert.match(agent, /the OTHER SDK/);

    const platform = buildSdkContextBlock(m, { toolMode: true, target: "platform", agentBlock: "AGENT-REGISTRY-DIGEST" });
    assert.match(platform, /build a PLATFORM with the Platform SDK/);
    assert.match(platform, /PLATFORM SDK is the method/i);
    assert.doesNotMatch(platform, /AGENT-REGISTRY-DIGEST/); // not the method here
  });

  // The codename is INTERNAL (the DRC/DRS rule). Whatever the context block
  // says is what the model repeats to the user — which is exactly how
  // "distilling a flavour with DistillSDK" reached the owner's screen.
  test("no internal codename reaches the model in any variant of the block", () => {
    const m = manifestFromSnapshot(snapshot());
    for (const target of /** @type {const} */ (["agent", "platform"])) {
      for (const toolMode of [true, false]) {
        const block = buildSdkContextBlock(m, { toolMode, target, agentBlock: "x" });
        assert.doesNotMatch(block, /DistillSDK/i, `${target}/${toolMode}`);
      }
    }
    assert.doesNotMatch(buildSdkContextBlock(null, {}), /DistillSDK/i);
    // The tool descriptions are read by the model AND by MCP clients.
    for (const t of SDK_TOOLS) assert.doesNotMatch(t.description, /DistillSDK/i, t.name);
  });
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

// ---- the app kit (feedback #66) ---------------------------------------------

describe("buildNeedsAppKit", () => {
  test("a script tag or a call site is the trigger", () => {
    assert.equal(
      buildNeedsAppKit([{ path: "index.html", content: `<script src="${APP_KIT_PATH}"></script>` }]),
      true,
    );
    assert.equal(buildNeedsAppKit([{ path: "js/app.js", content: "DRKit.mountModelPicker({})" }]), true);
    // A staged file AT the kit's path counts: it is about to be replaced by
    // the real one, and the app clearly means to use it.
    assert.equal(buildNeedsAppKit([{ path: APP_KIT_PATH, content: "…" }]), true);
  });

  test("a build with no key input asks for nothing", () => {
    assert.equal(buildNeedsAppKit([{ path: "index.html", content: "<h1>a game</h1>" }]), false);
    assert.equal(buildNeedsAppKit([]), false);
    assert.equal(buildNeedsAppKit(null), false);
  });

  test("reads a staging Map as readily as a file list", () => {
    // The tool path stages into a Map; the FILE-block path produces an array.
    assert.equal(buildNeedsAppKit(new Map([["js/app.js", "DRKit.chat(...)"]])), true);
    assert.equal(buildNeedsAppKit(new Map([["index.html", "<h1>hi</h1>"]])), false);
  });
});

test("APP_KIT_NOTE names the exact API a build has to call", () => {
  // The note is what the model reads; if it drifts from the shipped kit, the
  // build loads a kit it then calls wrongly.
  assert.match(APP_KIT_NOTE, new RegExp(APP_KIT_PATH.replace(/[.]/g, "\\.")));
  for (const fn of ["mountModelPicker", "DRKit.chat", "DRKit.chatStream", "picker.state()"]) {
    assert.ok(APP_KIT_NOTE.includes(fn), `${fn} is documented for the model`);
  }
  // The point of the feedback: same providers, flags, no hardcoded model id.
  for (const provider of ["OpenAI", "Anthropic", "Groq", "Hugging Face", "Berget"]) {
    assert.ok(APP_KIT_NOTE.includes(provider), `${provider} is named`);
  }
  assert.match(APP_KIT_NOTE, /flag/i);
  assert.match(APP_KIT_NOTE, /never write this file yourself|do NOT write this file yourself/);
});

test("APP_KIT_NOTE makes an unmasked or leaked key a stated failure", () => {
  // The two apps published on 2026-08-11 both chose type="password" by
  // themselves. That was luck: the note said nothing about masking, so the next
  // build was free to render a pasted key — a live credential — in plain text
  // on screen, and on camera. These three requirements are what removed the
  // luck; pin the SUBSTANCE so a rewrite of the prose cannot drop them.
  const lines = APP_KIT_NOTE.split("\n");

  // 1. Masked, and not helpfully autofilled or spell-checked into a dictionary.
  assert.match(APP_KIT_NOTE, /type="password"/, 'the key input is required to be type="password"');
  assert.match(APP_KIT_NOTE, /autocomplete="off"/);
  assert.match(APP_KIT_NOTE, /spellcheck="false"/);

  // 2. Not echoed — into the page's text, another element's attributes, or the URL.
  const echo = lines.find((l) => /echo/i.test(l));
  assert.ok(echo, "the note forbids echoing the key back into the page");
  for (const place of [/heading/i, /status/i, /title/i, /value/i, /\bURL\b/]) {
    assert.match(echo, place, `the no-echo rule names ${place}`);
  }

  // 3. Not persisted. The kit's own header promises the key stays in a
  //    variable on the page; the app must not undo that promise behind it.
  const stored = lines.find((l) => /localStorage/.test(l));
  assert.ok(stored, "the note forbids writing the key to storage");
  assert.match(stored, /sessionStorage/);
  assert.match(stored, /cookie/i);

  // 4. And it says WHY, the way the rest of the note does — a rule with a
  //    reason survives a rewrite that a bare rule does not.
  assert.match(APP_KIT_NOTE, /credential/i);
});

test("the SDK context block carries the app-kit note on both targets", () => {
  for (const target of ["agent", "platform"]) {
    const block = buildSdkContextBlock(null, { target });
    assert.ok(block.includes(APP_KIT_PATH), `${target} build is told about the kit`);
  }
});

test("a build is told not to use module scripts, which the sandbox blocks silently", () => {
  // Ground truth, 2026-08-11: the published Socratic Tutor renders, throws
  // nothing, and does nothing — its `<script type="module">` is fetched in
  // CORS mode and blocked by the opaque origin the app is served into. The
  // build model cannot discover that from the failure, because there is no
  // failure to see, so it has to be told.
  // Both routes a build can take: the native write_file tool, and the
  // deterministic fenced-block fallback for a model without tool use
  // (invariant 1). A constraint stated on only one of them is a constraint
  // half the models never see.
  const surfaces = [
    BUILD_TOOLS.find((t) => t.name === "write_file")?.description || "",
    buildSdkContextBlock(null, {}),
  ];
  for (const text of surfaces) {
    assert.match(text, /type=module|module script/i, "the constraint must be stated");
    assert.match(text, /opaque origin/i, "and say why, or it reads as a style preference");
    assert.match(text, /silent/i, "the silence is the point — there is no error to debug");
  }
});

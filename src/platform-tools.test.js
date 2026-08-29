// Unit tests for the PLATFORM introspection family on /mcp — the tools that ask
// this server about its own implementation.
//
// Two halves, tested apart for the same reason they are written apart: the
// schemas and lens notes (src/platform-tools.js) are pure and must stay
// importable without a binding, and the map runner
// (src/platform-tools-run.js) reads committed artifacts and is driven here
// against a fake ASSETS binding rather than a real deploy.
//
// What is worth pinning here, and why each one is a bug that already has a
// shape: the schemas have to keep VOICE as their default (the whole reason the
// family exists is a caller who is listening, and a default that must be
// corrected on every call is not one); the improvement lens has to keep asking
// for the settled-negative distinction (without it the answer confidently sends
// someone to redo finished work, and a listener cannot see that the source said
// the opposite); and the map has to answer a MISSING artifact rather than
// throwing or going quiet, because silence on this surface reads as "the
// platform does not have that".

import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPLAIN_NOTE,
  IMPROVE_NOTE,
  MAX_PLATFORM_QUESTION_CHARS,
  PLATFORM_AGENT,
  PLATFORM_ANSWERING_TOOLS,
  PLATFORM_MCP_CATALOG,
  PLATFORM_MCP_TOOLS,
  PLATFORM_SPENDING_TOOLS,
  PLATFORM_TOOL_NAMES,
  lensQuestion,
  readPlatformQuestion,
} from "./platform-tools.js";
import { MAX_GLOSSED_AREAS, MAX_SPOKEN_AREAS, runPlatformTool } from "./platform-tools-run.js";

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A snapshot in the shape scripts/bundle-source.mjs writes.
 *
 * Note `s` is what the byte total is computed from — validateSnapshot recomputes
 * `count` and `bytes` from the file rows rather than trusting the header, so a
 * fixture whose `s` does not match its text describes a snapshot that cannot
 * exist. Each helper below sets `s` from the text it actually carries.
 */
function fakeSnapshot(files) {
  const list = files || [];
  return {
    v: 1,
    digest: "test",
    count: list.length,
    bytes: list.reduce((n, f) => n + f.s, 0),
    files: list,
  };
}

/** One source file of a given size. */
function srcFile(path, text) {
  return { p: path, s: text.length, t: text };
}

/** A skill file's text, in the frontmatter shape skillsCatalog parses. */
function skillFile(name, description) {
  const t = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
  return { p: `.claude/skills/${name}/SKILL.md`, s: t.length, t };
}

/**
 * An env whose ASSETS binding serves the artifacts named in `assets` and 404s
 * everything else. Deliberately keyed by path SUFFIX: the loaders build an
 * absolute URL against a synthetic origin, and a test that hard-coded that
 * origin would pin the loader's internals rather than its behaviour.
 */
function fakeEnv(assets) {
  return {
    ASSETS: {
      async fetch(request) {
        const url = new URL(typeof request === "string" ? request : request.url);
        for (const [path, body] of Object.entries(assets || {})) {
          if (url.pathname === path) {
            return new Response(JSON.stringify(body), { status: 200 });
          }
        }
        return new Response("not found", { status: 404 });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The pure half — schemas, catalog, lenses
// ---------------------------------------------------------------------------

test("the family is three tools, named for the question shapes they route", () => {
  assert.deepEqual(
    PLATFORM_MCP_TOOLS.map((t) => t.name),
    ["explain_internals", "improvement_areas", "platform_map"],
  );
  assert.deepEqual([...PLATFORM_TOOL_NAMES].sort(), [
    "explain_internals",
    "improvement_areas",
    "platform_map",
  ]);
  // Every tool carries MCP's key (`inputSchema`), not Anthropic's
  // (`input_schema`) — src/mcp.js serves these definitions verbatim, so a tool
  // that arrived in the other shape would list with no schema at all.
  for (const tool of PLATFORM_MCP_TOOLS) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} schema type`);
    assert.equal(/** @type {any} */ (tool).input_schema, undefined, `${tool.name} uses inputSchema`);
    assert.ok(tool.description.length > 200, `${tool.name} description is written for a model`);
  }
});

test("the two answering tools default to VOICE, unlike deep_research", () => {
  // The asymmetry with deep_research (which defaults to `text`) is the point of
  // the family, so it is pinned rather than left to be tidied into consistency
  // by someone who reads the two schemas side by side.
  for (const name of ["explain_internals", "improvement_areas"]) {
    const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === name);
    const style = /** @type {any} */ (tool).inputSchema.properties.style;
    assert.deepEqual(style.enum, ["text", "voice"], `${name} offers both styles`);
    assert.equal(style.default, "voice", `${name} defaults to voice`);
    assert.deepEqual(/** @type {any} */ (tool).inputSchema.required, ["question"]);
  }
});

test("platform_map requires nothing and takes an optional area", () => {
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === "platform_map");
  assert.deepEqual(/** @type {any} */ (tool).inputSchema.required, []);
  assert.equal(/** @type {any} */ (tool).inputSchema.properties.area.type, "string");
});

test("only the two answering tools spend; the map is free", () => {
  assert.deepEqual([...PLATFORM_SPENDING_TOOLS].sort(), ["explain_internals", "improvement_areas"]);
  assert.equal(PLATFORM_SPENDING_TOOLS.has("platform_map"), false);
  // The answering set and the spending set are the same two tools, and that is
  // not a coincidence to be collapsed: they spend BECAUSE they run the pipeline.
  assert.deepEqual([...PLATFORM_ANSWERING_TOOLS].sort(), [...PLATFORM_SPENDING_TOOLS].sort());
});

test("every tool has a catalog row, so an account can switch it off", () => {
  // src/mcp-config.test.js's mirror test covers the whole surface; this one
  // fails FIRST and names the family, which is the difference between "some
  // tool somewhere lacks a switch" and a one-line fix.
  assert.deepEqual(
    PLATFORM_MCP_CATALOG.map((c) => c.id).sort(),
    PLATFORM_MCP_TOOLS.map((t) => t.name).sort(),
  );
  for (const row of PLATFORM_MCP_CATALOG) {
    assert.ok(row.group && row.label && row.blurb, `${row.id} needs Settings copy`);
    assert.equal(row.def, true, `${row.id} is on by default — nothing here reaches a third party`);
  }
});

test("the improvement lens asks for the settled-negative distinction", () => {
  // The load-bearing sentence. This repository records experiments that were
  // run, measured and rejected, precisely so nobody repeats them; an
  // improvement answer that reports one back as an opportunity is a confident
  // instruction to redo finished work, and a listener has no way to check it.
  assert.match(IMPROVE_NOTE, /already been measured and rejected/);
  assert.match(IMPROVE_NOTE, /still open/);
  // Both lenses have to pin the SUBJECT to this platform, because the failure
  // that produced the family is a model answering about the field instead.
  for (const note of [EXPLAIN_NOTE, IMPROVE_NOTE]) {
    assert.match(note, /THIS platform's own implementation/);
    assert.ok(note.length < 700, "a lens rides on the retrieval query — long notes retrieve worse");
  }
});

test("lensQuestion appends, never substitutes", () => {
  const q = "how does the gap check work";
  const explained = lensQuestion("explain_internals", q);
  assert.ok(explained.startsWith(q), "the caller's words reach the model as written");
  assert.equal(explained, q + EXPLAIN_NOTE);
  assert.equal(lensQuestion("improvement_areas", q), q + IMPROVE_NOTE);
  // An unknown name is a method-not-found further up, so this returns the
  // question untouched rather than inventing a second failure that would hide
  // the first.
  assert.equal(lensQuestion("platform_map", q), q);
  assert.equal(lensQuestion("nope", q), q);
});

test("readPlatformQuestion trims, caps, and refuses an empty question in words a model can act on", () => {
  assert.deepEqual(readPlatformQuestion({ question: "  how does routing work  " }), {
    ok: true,
    question: "how does routing work",
  });
  const long = readPlatformQuestion({ question: "x".repeat(MAX_PLATFORM_QUESTION_CHARS + 500) });
  assert.equal(long.ok, true);
  assert.equal(/** @type {any} */ (long).question.length, MAX_PLATFORM_QUESTION_CHARS);
  for (const args of [{}, { question: "" }, { question: "   " }, { question: 7 }, null]) {
    const bad = readPlatformQuestion(args);
    assert.equal(bad.ok, false, `${JSON.stringify(args)} is refused`);
    // Worded so the client's model retries with the right argument instead of
    // reporting a broken server.
    assert.match(/** @type {any} */ (bad).error, /`question`/);
    assert.match(/** @type {any} */ (bad).error, /nothing was spent/i);
  }
});

test("the agent every tool answers as is named once", () => {
  assert.equal(PLATFORM_AGENT, "introspection");
});

// ---------------------------------------------------------------------------
// The runner — platform_map against a fake ASSETS binding
// ---------------------------------------------------------------------------

test("platform_map speaks the size, the areas and where to go next", async () => {
  const snapshot = fakeSnapshot([
    srcFile("src/pipeline.js", "x".repeat(2_000_000)),
    srcFile("src/mcp.js", "y".repeat(1_000_000)),
    srcFile("public/js/app.js", "z"),
    srcFile("docs/PYGRAM.md", "w"),
    skillFile("cache-helper", "Every cache layer and the stale-site playbook."),
    skillFile("execution-sandbox", "The in-browser Linux sandbox and its bash agent."),
  ]);
  const env = fakeEnv({ "/introspect/source-snapshot.json": snapshot });
  const result = await runPlatformTool(env, quiet, "platform_map", {});

  assert.equal(result.isError, false);
  // Speakable: no markdown, no bullets, no file paths read out as punctuation.
  assert.doesNotMatch(result.text, /[#*`|]/, "the map is spoken, not rendered");
  assert.doesNotMatch(result.text, /\n\s*[-–]\s/, "no bullet list");
  // The figures are the snapshot's own, so a stale hand-written count cannot
  // survive here.
  assert.match(result.text, /6 source files/);
  assert.match(result.text, /about 3 megabytes/);
  // The playbook COUNT is deliberately not in this sentence: the next one gives
  // it as "N documented areas", and the two count different things (the catalog
  // includes the SDK's playbooks, the file division counts the directory). On a
  // screen that is two figures; in the ear it is one sentence contradicting
  // itself a clause later.
  assert.doesNotMatch(result.text, /\d+ engineering playbooks —/);
  assert.match(result.text, /2 documented areas/);
  // The areas are derived from the paths that actually exist — a prefix
  // matching nothing is dropped rather than spoken as an empty area.
  assert.match(result.text, /the Cloudflare Worker itself with 2 files/);
  assert.doesNotMatch(result.text, /the two software development kits/);
  // Counts agree with their nouns. "1 files" is a typo on a screen and a
  // sentence a listener stops trusting in the ear.
  assert.match(result.text, /the browser client with 1 file(?!s)/);
  assert.doesNotMatch(result.text, /\b1 files\b/);
  // And it says what to call next, which is the only reason a map is worth a
  // round trip on a voice call.
  assert.match(result.text, /where a part could improve/);
  assert.equal(result.areas, 2);
});

test("platform_map narrowed to an area finds it by name, then by summary", async () => {
  const snapshot = fakeSnapshot([
    srcFile("src/mcp.js", "x"),
    skillFile("cache-helper", "Every cache layer. Why a stale edge serves last week's bundle."),
    skillFile("execution-sandbox", "The in-browser Linux sandbox; its cache-helper interactions and shell code."),
    skillFile("deploy", "How code reaches production."),
  ]);
  const env = fakeEnv({ "/introspect/source-snapshot.json": snapshot });

  // A NAME hit outranks a SUMMARY hit, and both fixtures below mention caching:
  // someone who says "cache-helper" means the cache-helper playbook, not the one that
  // happens to name it in passing. Ordering is the assertion — both are
  // returned, and which comes first is what a listener hears as the answer.
  const byName = await runPlatformTool(env, quiet, "platform_map", { area: "cache-helper" });
  assert.equal(byName.isError, false);
  assert.equal(byName.areas, 2);
  const listed = byName.text.slice(byName.text.indexOf("own documented playbook"));
  assert.ok(
    listed.indexOf("cache helper,") < listed.indexOf("execution sandbox"),
    `name match should lead: ${listed}`,
  );

  // A summary-only hit still lands — this is the case that answers a caller who
  // knows the technology but not this repo's name for it.
  const bySummary = await runPlatformTool(env, quiet, "platform_map", { area: "linux" });
  assert.equal(bySummary.areas, 1);
  const summaryList = bySummary.text.slice(bySummary.text.indexOf("own documented playbook"));
  assert.match(summaryList, /execution sandbox/);
  assert.doesNotMatch(summaryList, /deploy/, "an unmatched playbook is not listed");

  // The slug is spoken as words: a speech engine reads the hyphen out loud.
  assert.doesNotMatch(bySummary.text, /execution-sandbox/);
});

test("a miss says the platform may still have it — the failure that reads as absence", async () => {
  const snapshot = fakeSnapshot([
    srcFile("src/mcp.js", "x"),
    skillFile("deploy", "How code reaches production."),
  ]);
  const env = fakeEnv({ "/introspect/source-snapshot.json": snapshot });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "quantum" });
  assert.equal(result.isError, false, "a miss is an answer, not an error");
  assert.equal(result.areas, 0);
  // The whole point: an unexplained empty reads to the client's model as "this
  // platform does not have that", which is the thing that ends a session.
  assert.match(result.text, /does not mean the platform lacks it/);
  assert.match(result.text, /Ask the question directly/);
});

test("a narrowed map is capped at what an ear can hold — but SAYS the true count", async () => {
  // The bug this pins: the first version sliced the matches, then reported the
  // SLICED length as the number of matches. Asked about the sandbox against the
  // real catalog it said "8 parts" where twelve matched, and the four it never
  // mentioned were, to the caller, parts this platform does not have — which is
  // precisely the failure platform_map exists to prevent, produced by
  // platform_map. A listener has no scrollback to check a spoken number.
  const total = MAX_SPOKEN_AREAS + 5;
  const skills = [];
  for (let i = 0; i < total; i++) {
    skills.push(skillFile(`area-${i}`, "Covers the sandbox in some way."));
  }
  const env = fakeEnv({ "/introspect/source-snapshot.json": fakeSnapshot(skills) });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "sandbox" });
  // The reported count — and the log's — is the TRUE one.
  assert.equal(result.areas, total);
  assert.match(result.text, new RegExp(`On sandbox, ${total} parts`));
  // The spoken LIST is still capped.
  const named = result.text.match(/area \d+/g) || [];
  assert.equal(named.length, MAX_SPOKEN_AREAS, "the list stays sayable");
  // And the remainder is acknowledged rather than silently dropped.
  assert.match(result.text, new RegExp(`${total - MAX_SPOKEN_AREAS} others matched and are not listed`));
});

test("a caller-supplied area cannot be echoed back unbounded", async () => {
  // platform_map is free — no quota gate, no concurrency slot — and it echoes
  // the area in both the match sentence and the miss. Uncapped, a megabyte in
  // was a megabyte out, repeatable in parallel from one key.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([srcFile("src/mcp.js", "x")]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "q".repeat(100_000) });
  assert.ok(result.text.length < 2000, `echo is bounded: ${result.text.length}`);
});

test("a missing snapshot is ANSWERED, not thrown and not silent", async () => {
  const result = await runPlatformTool(fakeEnv({}), quiet, "platform_map", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /not available on this deployment/);
  // It still points at the path that does not need this artifact, so a caller
  // is not left with nothing.
  assert.match(result.text, /Ask a question about how the platform works/);
  assert.match(result.text, /Nothing was spent/);
});

test("no ASSETS binding at all degrades the same way", async () => {
  const result = await runPlatformTool(/** @type {any} */ ({}), quiet, "platform_map", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /Nothing was spent/);
});

test("a throwing binding is caught and spoken", async () => {
  const env = {
    ASSETS: {
      async fetch() {
        throw new Error("binding exploded");
      },
    },
  };
  const result = await runPlatformTool(/** @type {any} */ (env), quiet, "platform_map", {});
  // loadSourceSnapshot swallows its own throw and returns null, so this lands on
  // the missing-snapshot branch rather than the outer catch. Either way the
  // contract holds: an isError RESULT, never a thrown transport failure.
  assert.equal(result.isError, true);
  assert.ok(result.text.length > 0);
});

test("the runner refuses a name that is not its own", async () => {
  const result = await runPlatformTool(fakeEnv({}), quiet, "explain_internals", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /Unknown platform tool/);
});

test("the docs corpus is optional — the map degrades by one clause, not by failing", async () => {
  const snapshot = fakeSnapshot([srcFile("src/mcp.js", "x"), skillFile("deploy", "Ships code.")]);
  const withDocs = await runPlatformTool(
    fakeEnv({
      "/introspect/source-snapshot.json": snapshot,
      "/introspect/docs-corpus.json": { v: 1, files: [{ p: "docs/A.md", s: 1, t: "a" }, { p: "docs/B.md", s: 1, t: "b" }] },
    }),
    quiet,
    "platform_map",
    {},
  );
  assert.match(withDocs.text, /2 documents/);

  const withoutDocs = await runPlatformTool(
    fakeEnv({ "/introspect/source-snapshot.json": snapshot }),
    quiet,
    "platform_map",
    {},
  );
  assert.equal(withoutDocs.isError, false);
  assert.doesNotMatch(withoutDocs.text, /documents/);
  assert.match(withoutDocs.text, /source files/);
});

// ---------------------------------------------------------------------------
// Speech shaping — every rule below is a defect that survived the first round
// of unit tests and only appeared when the map was run against the REAL
// committed snapshot and read aloud. They are pinned here because the fixture
// snapshots above are too tidy to reproduce them.
// ---------------------------------------------------------------------------

test("a playbook's LOAD TRIGGER is not spoken as its description", async () => {
  // A SKILL.md `description` is an instruction about when to READ THE FILE, not
  // a description of the subsystem — nearly every one opens "Load when working
  // on X". Spoken unedited, the map said "cache-helper covers load when working on
  // cache-helper", which is not clumsy so much as not about caching at all.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when working on the widget subsystem and its rendering path."),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.doesNotMatch(result.text, /load when/i, "the trigger preamble is gone");
  // A trigger clause keeps its "when" frame, because it IS a subordinate clause;
  // forcing it into "covers …" is what produced "cache helper covers the live
  // site serves stale content".
  assert.match(result.text, /widget is the playbook for when working on the widget subsystem/);
});

test("a skill named after its subject takes the clause AFTER the dash", async () => {
  // "working on cache-helper — every cache layer" : the half before
  // the dash is only the skill's own name, so keeping it says "cache-helper
  // covers cache-helper". Cutting at the dash UNCONDITIONALLY was the opposite bug and threw
  // away the good half for every skill whose head is a real description.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("cache-helper", "Load when working on cache-helper — every cache layer and the stale-site playbook."),
      skillFile(
        "deploy",
        "Load when working on the release pipeline and its rollback path — the git-connected " +
          "auto-deploy and its traps.",
      ),
    ]),
  });
  // Tail wins: the head is only the skill's own name. A DETAIL is a noun phrase,
  // so it takes the "covers" frame.
  const named = await runPlatformTool(env, quiet, "platform_map", { area: "cache-helper" });
  assert.match(named.text, /cache helper covers every cache layer/);

  // Head wins: it is a real description, so the detail after the dash is the
  // part that gets dropped. Cutting at the dash unconditionally would lose this.
  // A TRIGGER takes the "when" frame.
  const headed = await runPlatformTool(env, quiet, "platform_map", { area: "deploy" });
  assert.match(headed.text, /deploy is the playbook for when working on the release pipeline/);
  assert.doesNotMatch(headed.text, /git-connected/);
});

test("markdown and identifiers never reach a speech engine", async () => {
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile(
        "widget",
        "Load when touching the widget renderer and its `widget_mode` knob (see src/widget.js), " +
          "or anything about **layout** and the widget.js entry point.",
      ),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.doesNotMatch(result.text, /[`*]/, "no backticks or asterisks");
  assert.doesNotMatch(result.text, /widget_mode/, "no snake_case identifier");
  assert.doesNotMatch(result.text, /\.js/, "no bare filenames");
  assert.doesNotMatch(result.text, /src\//, "no paths");
  assert.doesNotMatch(result.text, /\(|\)/, "no parenthetical asides");
});

test("a description made only of file paths is named WITHOUT a gloss, not with a fragment", async () => {
  // The real case: "Load when working on src/pipeline.js, src/triage.js, …".
  // Strip the trigger and the paths and nothing is left but a conjunction, which
  // read aloud as a mistake. Naming the area alone is the honest answer.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when working on src/widget.js, src/widget-core.js, public/js/widget.js"),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.match(result.text, /widget\./, "the area is still named");
  assert.doesNotMatch(result.text, /widget covers\s*(or|and)?\s*\./, "no dangling fragment");
  assert.doesNotMatch(result.text, /covers\s+\./);
});

test("a chain of trigger verbs is stripped, not just the first", async () => {
  // "Load when declaring, running, or working on the try-it queue" — stripping
  // one gerund leaves the next, and the map said "covers running, or working on".
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when declaring, running, or working on the widget verdict queue"),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  // The surviving verb is kept — "for when working on the widget verdict queue"
  // is grammatical, and stripping the participle too is what produced the
  // headless "covers a NEW LLM provider" class of gloss. What must not survive
  // is the chain of DISCARDED verbs before it.
  assert.match(result.text, /widget is the playbook for when working on the widget verdict queue/);
  assert.doesNotMatch(result.text, /declaring/);
  assert.doesNotMatch(result.text, /running,/);
});

test("a narrowed call LEADS with its answer, not with ninety words of orientation", async () => {
  // A listener cannot skip a preamble the way a reader can. The whole-map
  // orientation is right as the first thing anyone hears and wrong in front of
  // "what do you have on python".
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when working on the widget subsystem and its rendering path."),
    ]),
  });
  const narrowed = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.ok(narrowed.text.startsWith("On widget,"), `leads with the answer: ${narrowed.text.slice(0, 60)}`);
  assert.doesNotMatch(narrowed.text, /single Cloudflare Worker/, "no whole-map preamble");

  const whole = await runPlatformTool(env, quiet, "platform_map", {});
  assert.match(whole.text, /single Cloudflare Worker/, "the preamble is for the unnarrowed call");
});

test("only the first few matches are glossed; the rest are named", async () => {
  const skills = [];
  for (let i = 0; i < 6; i++) {
    skills.push(skillFile(`widget-${i}`, `Load when working on widget subsystem number ${i} and its rendering.`));
  }
  const env = fakeEnv({ "/introspect/source-snapshot.json": fakeSnapshot(skills) });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.equal(result.areas, 6);
  const glosses = result.text.match(/ (?:covers|is the playbook for when) /g) || [];
  assert.equal(glosses.length, MAX_GLOSSED_AREAS, "an eight-clause list is not a map, it is an obstacle");
  assert.match(result.text, /There are also/);
});

test("counts agree with their nouns and their verbs, everywhere", async () => {
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when working on the widget subsystem and its rendering path."),
    ]),
  });
  const whole = await runPlatformTool(env, quiet, "platform_map", {});
  assert.match(whole.text, /there is 1 documented area\b/, "singular verb and singular noun");
  assert.doesNotMatch(whole.text, /\b1 \w+s\b/, "no '1 files' anywhere");

  const one = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.match(one.text, /1 part of the platform has its own/, "singular pronoun too");
});

test("shouted emphasis is spoken as words, not spelled out", async () => {
  // 45 of the 99 real playbook descriptions carried written CAPS emphasis. A
  // speech engine either spells those letter by letter or over-stresses them,
  // and neither is what the author meant. Real acronyms have to survive, which
  // is why this is an allowlist rather than a blanket lowercase.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when the widget HANGS or serves STALE content over the RAG and SDK paths."),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.match(result.text, /hangs or serves stale content/);
  assert.match(result.text, /RAG and SDK/, "acronyms survive");
  assert.doesNotMatch(result.text, /HANGS|STALE/);
});

test("a preposition left governing nothing is not spoken", async () => {
  // The path stripper removes what a preposition governed, and the clip can
  // strand another one just after it — so the trim runs on both sides of the
  // clip. "…a frozen public replay at." is audible in a way it never is on a
  // page.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("widget", "Load when publishing a widget session as a frozen public replay at deepresearch.se/cure/slug"),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.match(result.text, /frozen public replay\./, "the stranded preposition is gone");
  assert.doesNotMatch(result.text, /replay at\./);
});

test("a dash inside a parenthetical does not leak an unbalanced bracket", async () => {
  // The em-dash split used to run BEFORE parentheticals were stripped, so a dash
  // inside an aside split the text mid-aside and left an opener with no closer.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile(
        "widget",
        "Load when adding a widget source to the pipeline (a provider, an API — or a feed), or when debugging one.",
      ),
    ]),
  });
  const result = await runPlatformTool(env, quiet, "platform_map", { area: "widget" });
  assert.doesNotMatch(result.text, /[()]/, "no bracket reaches the spoken output");
});

test("matching normalizes separators, so a hyphenated name finds a spaced needle", async () => {
  // The real miss: "deep research" is the single likeliest thing to ask this
  // platform about, and every playbook that mentions it writes "deep-research",
  // so a raw substring test returned one unrelated playbook — the "you asked, so
  // it must not exist" failure this tool exists to prevent.
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("add-research-source", "Load when adding a source to the deep-research pipeline."),
      skillFile("deploy", "Load when shipping code to production."),
    ]),
  });
  for (const needle of ["deep research", "deep-research", "Deep Research"]) {
    const result = await runPlatformTool(env, quiet, "platform_map", { area: needle });
    assert.equal(result.areas, 1, `"${needle}" finds the hyphenated playbook`);
    assert.match(result.text, /add research source/);
  }
});

test("every needle term must match, so two words narrow rather than widen", async () => {
  const env = fakeEnv({
    "/introspect/source-snapshot.json": fakeSnapshot([
      srcFile("src/mcp.js", "x"),
      skillFile("alpha", "Load when working on the widget renderer."),
      skillFile("beta", "Load when working on the gadget renderer."),
    ]),
  });
  assert.equal((await runPlatformTool(env, quiet, "platform_map", { area: "renderer" })).areas, 2);
  assert.equal((await runPlatformTool(env, quiet, "platform_map", { area: "widget renderer" })).areas, 1);
});

test("a needle of nothing but stopwords is a miss, not the whole catalog", async () => {
  // "the" matched 98 of 99 by substring and produced the sentence "On the, 98
  // parts of the platform have their own documented playbook" — which is both
  // useless and unspeakable.
  const skills = [];
  for (let i = 0; i < 5; i++) skills.push(skillFile(`area-${i}`, "Load when working on the thing."));
  const env = fakeEnv({ "/introspect/source-snapshot.json": fakeSnapshot(skills) });
  for (const needle of ["the", "a", "and", "of the"]) {
    const result = await runPlatformTool(env, quiet, "platform_map", { area: needle });
    assert.equal(result.areas, 0, `"${needle}" is refused`);
    assert.match(result.text, /does not mean the platform lacks it/);
  }
});

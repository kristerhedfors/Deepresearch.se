// Declaration pins for the RESEARCH TOOLBOX (src/research-tools.js).
//
// This module is data, so almost everything worth testing about it is a
// property of the table rather than of a code path — and each of the
// properties below is one a future edit could quietly break while every other
// suite stayed green.
//
// The one that is not obvious: the tool NAMES here are service names
// (`street_view_look`), which is exactly why this registry exists and why it
// must never be listed in src/extensions.test.js's CORE_MODULES. That guard is
// asserted from the other side in `extensions.test.js`; here we assert the
// consequence — that nothing but this module needs to write those names down.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ANCIENT_SAMPLES_TOOL,
  CORPUS_TOOLS,
  EXTENSION_MCP_TOOLS,
  MAX_WEB_QUERIES,
  PYTHON_TOOLS,
  RESEARCH_SPENDING_TOOLS,
  RESEARCH_TOOLS,
  RESEARCH_TOOL_CONTEXT,
  RESEARCH_TOOL_EXTENSION,
  RESEARCH_TOOL_NAMES,
  SOURCE_SEARCH_TOOL,
  WEB_TOOLS,
  buildSourceSearchTool,
} from "./research-tools.js";
import { EXTENSIONS } from "./extensions.js";
import { LITERATURE_TOOLS, RETRIEVAL_NOTE } from "./literature-tools.js";
import { SEARCH_SOURCES } from "./search-sources.js";
import { CONTEXT_BLOCKS } from "./agent-spec.js";

describe("the toolbox's shape", () => {
  test("every definition is in this repository's one tool shape", () => {
    // `input_schema`, not MCP's `inputSchema`: src/tool-run.js renames at the
    // wire so a tool is never written twice, and a definition that arrived in
    // the other spelling would be handed to a model with no schema at all.
    for (const tool of RESEARCH_TOOLS) {
      assert.equal(typeof tool.name, "string", JSON.stringify(tool).slice(0, 80));
      assert.ok(tool.description.length > 80, `${tool.name} needs a description a model can act on`);
      assert.equal(tool.input_schema.type, "object", tool.name);
      assert.equal(/** @type {any} */ (tool).inputSchema, undefined, `${tool.name} is in MCP's shape, not ours`);
    }
  });

  test("no tool name appears twice", () => {
    // Two definitions under one name is a silent dispatch coin-flip: the model
    // sees the first description and the runner switches on the name.
    assert.equal(RESEARCH_TOOL_NAMES.size, RESEARCH_TOOLS.length);
  });

  test("the families compose into the catalog", () => {
    for (const family of [WEB_TOOLS, [SOURCE_SEARCH_TOOL], LITERATURE_TOOLS, CORPUS_TOOLS, PYTHON_TOOLS]) {
      for (const tool of family) assert.ok(RESEARCH_TOOL_NAMES.has(tool.name), tool.name);
    }
    // The extension families arrive through src/extension-tools.js, so the MCP
    // surface and the research toolbox can never offer different sets.
    for (const tool of EXTENSION_MCP_TOOLS) assert.ok(RESEARCH_TOOL_NAMES.has(tool.name), tool.name);
  });

  test("web_search tells the model to batch its angles", () => {
    // The latency lesson feedback #44 taught the wave path. A model that issues
    // one query per round spends the whole budget on round trips, and the only
    // place to say so is the description.
    const desc = WEB_TOOLS[0].description;
    assert.match(desc, /SEVERAL DISTINCT ANGLES IN ONE CALL/);
    assert.equal(WEB_TOOLS[0].input_schema.properties.queries.maxItems, MAX_WEB_QUERIES);
    // …and that an empty result is an ANSWER, not a failure.
    assert.match(desc, /EMPTY result means the provider found nothing/);
  });

  test("run_python promises no interpreter this platform cannot provide", () => {
    // The refusal contract is the whole value of the subset interpreter: exit
    // 90 with one line, retried on CPython, and the model told which engine
    // answered. A description that said "python" and nothing else would make a
    // refusal look like a bug.
    const desc = PYTHON_TOOLS[0].description;
    assert.match(desc, /exit 90/);
    assert.match(desc, /retried automatically on full CPython/);
    assert.match(desc, /no network/);
  });

  test("ancient_samples states the three conventions an answer gets wrong without them", () => {
    const desc = ANCIENT_SAMPLES_TOOL.description;
    assert.match(desc, /BP=1950/);
    assert.match(desc, /INTERVALS/);
    assert.match(desc, /PREFIX matching/);
    assert.match(desc, /Ignore_/);
  });
});

describe("source_search is generated from the registry", () => {
  test("the enum is the shipped registry, in registry order", () => {
    // The property that makes adding a search source touch no orchestrator
    // file: the enum is not a list anybody maintains.
    assert.deepEqual(SOURCE_SEARCH_TOOL.input_schema.properties.source.enum, SEARCH_SOURCES.map((s) => s.id));
  });

  test("each source's own promptNote survives into the description", () => {
    for (const source of SEARCH_SOURCES) {
      assert.ok(SOURCE_SEARCH_TOOL.description.includes(source.service), source.id);
      if (source.promptNote) {
        assert.ok(SOURCE_SEARCH_TOOL.description.includes(source.promptNote.trim()), `${source.id} promptNote`);
      }
    }
  });

  test("the Swedish half of the routing vocabulary survives the move (invariant 6)", () => {
    // The deterministic `intent` gates that used to route a Swedish message to
    // the right corpus do not run on this path. What kept invariant 6 alive
    // there was not only the gate but the bilingual vocabulary the sources
    // wrote for the planner, and that guidance is exactly what a self-selecting
    // model needs: the corpora index English titles and abstracts, so a
    // Swedish-worded query finds nothing while the ANSWER stays Swedish. If
    // this assertion fails, a Swedish question silently retrieves nothing from
    // the literature legs and reports the record as empty.
    assert.match(SOURCE_SEARCH_TOOL.description, /Swedish/);
    assert.match(SOURCE_SEARCH_TOOL.description, /ALWAYS in English even when the conversation is in Swedish/);
    assert.match(SOURCE_SEARCH_TOOL.description, /keep the user-facing answer in the conversation language/);
  });

  test("the retrieval caveat is quoted, not paraphrased", () => {
    // src/literature-tools.js already wrote the sentence that keeps "asked,
    // nothing above the floor" distinct from "could not ask". A second wording
    // of it is a second thing to keep true.
    assert.ok(SOURCE_SEARCH_TOOL.description.includes(RETRIEVAL_NOTE));
  });

  test("an empty or malformed registry still yields a usable tool", () => {
    // Invariant 2 at the declaration layer: a deployment whose registry will
    // not load must get a tool with an empty enum, not a thrown module.
    const empty = buildSourceSearchTool([]);
    assert.deepEqual(empty.input_schema.properties.source.enum, []);
    const junk = buildSourceSearchTool(/** @type {any} */ ([null, { id: "x", service: "X" }, "nope"]));
    assert.deepEqual(junk.input_schema.properties.source.enum, ["x"]);
  });
});

describe("the gating tables", () => {
  test("every tool has a context entry and every entry names a real block", () => {
    // A tool missing from this table would be admitted with NO capability check
    // at all — the failure mode is silent and the direction is the dangerous
    // one, so the table is required to be total.
    for (const tool of RESEARCH_TOOLS) {
      assert.ok(Object.prototype.hasOwnProperty.call(RESEARCH_TOOL_CONTEXT, tool.name), `${tool.name} has no context entry`);
      const block = RESEARCH_TOOL_CONTEXT[tool.name];
      if (block) assert.ok(Object.prototype.hasOwnProperty.call(CONTEXT_BLOCKS, block), `${tool.name} names an unknown block ${block}`);
    }
  });

  test("an extension tool's context block is its extension's own", () => {
    // The one place this table duplicates data that lives elsewhere. It is
    // duplicated because admission has to answer synchronously and cannot pull
    // in the registry's provider graph; pinned here so the two cannot drift.
    for (const [name, id] of Object.entries(RESEARCH_TOOL_EXTENSION)) {
      const extension = EXTENSIONS.find((e) => e.id === id);
      assert.ok(extension, `${name} names an unknown extension ${id}`);
      assert.equal(RESEARCH_TOOL_CONTEXT[name], extension.contextBlock, name);
    }
  });

  test("the free tools are declared free and the metered ones metered", () => {
    // A spending tool holds a slot in the per-run budget. Getting this backwards
    // either meters a free call or, worse, leaves a paid one uncapped.
    assert.equal(RESEARCH_SPENDING_TOOLS.has("run_python"), false);
    assert.equal(RESEARCH_SPENDING_TOOLS.has("ancient_samples"), false);
    assert.equal(RESEARCH_SPENDING_TOOLS.has("literature_fetch"), false, "an id read is not a search");
    assert.equal(RESEARCH_SPENDING_TOOLS.has("literature_corpora"), false, "committed facts cost nothing");
    for (const name of ["web_search", "read_pages", "source_search", "literature_search", "host_intel", "street_view_look"]) {
      assert.ok(RESEARCH_SPENDING_TOOLS.has(name), name);
    }
    for (const name of RESEARCH_SPENDING_TOOLS) assert.ok(RESEARCH_TOOL_NAMES.has(name), `${name} is not a tool`);
  });
});

test("this module is NOT registered as a core module", () => {
  // The trap the whole file exists around: `street_view_look` matches the core
  // purity guard's SERVICE_TOKENS, so adding this registry to CORE_MODULES
  // fails the build for doing its job. Asserted here rather than left as a
  // comment because the guard's list is hand-written.
  const guard = readFileSync(new URL("./extensions.test.js", import.meta.url), "utf8");
  const core = guard.slice(guard.indexOf("const CORE_MODULES"), guard.indexOf("// Every service token"));
  assert.equal(core.includes("research-tools.js"), false, "src/research-tools.js must not be in CORE_MODULES");
  assert.equal(core.includes("research-tools-run.js"), false);
});

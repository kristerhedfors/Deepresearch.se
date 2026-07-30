import test from "node:test";
import assert from "node:assert/strict";
import { WATCH_TOOLS, WATCH_TOOL_NAMES, runWatchTool } from "./watch-tools.js";
import { MCP_TOOL_IDS } from "./mcp-config.js";
import { CASES, DEFAULT_BUILD, SLOTS, encodeBuild, normalizeBuild } from "./watch.js";

/** Every tool returns JSON text; parse it the way a caller would. */
function run(name, args) {
  return JSON.parse(runWatchTool(name, args));
}

// ---------------------------------------------------------------------------
// The definitions.

test("every tool is well-formed, named consistently, and exposable", () => {
  assert.equal(WATCH_TOOLS.length, 6, "feedback #52 asked for a family, not one tool");
  assert.equal(WATCH_TOOL_NAMES.size, WATCH_TOOLS.length);
  for (const tool of WATCH_TOOLS) {
    assert.match(tool.name, /^watch_[a-z_]+$/, tool.name);
    assert.ok(WATCH_TOOL_NAMES.has(tool.name), `${tool.name} missing from the dispatch set`);
    assert.ok(tool.description.length > 80, `${tool.name}: the calling model reads this`);
    // Anthropic's key, which src/mcp.js renames to MCP's inputSchema — the same
    // convention src/sdk-tools.js follows.
    assert.equal(tool.input_schema.type, "object");
    assert.equal(tool.inputSchema, undefined);
    // Every account must be able to switch each tool off: the exposure catalog
    // is the mirror of the tool list (src/mcp-config.js).
    assert.ok(MCP_TOOL_IDS.includes(tool.name), `${tool.name} has no exposure switch`);
  }
});

// ---------------------------------------------------------------------------
// Reads.

test("watch_catalog: the overview, then one family in full", () => {
  const all = run("watch_catalog", {});
  assert.equal(all.movement.dialDia, 28.5);
  assert.equal(all.slots.length, SLOTS.length);
  assert.equal(all.cases.length, CASES.length);
  assert.ok(all.sources && Object.keys(all.sources).length, "dimensions have to name their source");

  const dials = run("watch_catalog", { slot: "dial" });
  assert.equal(dials.slot, "dial");
  assert.ok(dials.count >= 10);
  assert.ok(dials.options.every((o) => o.id && o.name.en && o.name.sv));
});

test("watch_catalog: an unknown slot answers with the valid set", () => {
  const miss = run("watch_catalog", { slot: "bezel" });
  assert.match(miss.error, /No such slot/);
  assert.ok(miss.slots.includes("insert"), "a caller that guessed wrong is told what exists");
});

test("watch_case: real millimetres, or the list of cases", () => {
  const skx = run("watch_case", { id: "skx007" });
  assert.equal(skx.case.dims.dia, 42.5);
  assert.equal(skx.case.dims.l2l, 46);
  assert.equal(skx.case.platform, "skx");
  assert.ok(skx.platform, "the shared-parts platform comes with it");

  const miss = run("watch_case", { id: "nope" });
  assert.match(miss.error, /No such case/);
  assert.ok(miss.cases.includes("62mas"));
  // A missing argument is a miss, not a throw.
  assert.match(run("watch_case", {}).error, /No such case/);
});

// ---------------------------------------------------------------------------
// The build reports.

test("watch_build: spec sheet, fit verdict, sourcing and a working permalink", () => {
  const r = run("watch_build", { build: { case: "62mas", dial: "62mas-cream", movement: "nh38" } });
  assert.equal(r.build.case, "62mas");
  // Unnamed slots fall back to the default build rather than erroring.
  assert.equal(r.build.strap, DEFAULT_BUILD.strap);
  assert.equal(r.code, encodeBuild(r.build));
  assert.match(r.permalink, /^https:\/\/deepresearch\.se\/watch\/#/);
  assert.equal(typeof r.spec.caseDia, "number");
  assert.equal(typeof r.spec.priceUsd.low, "number");
  assert.equal(typeof r.fit.ok, "boolean");
  assert.ok(Array.isArray(r.fit.errors) && Array.isArray(r.fit.warnings) && Array.isArray(r.fit.notes));
  assert.ok(r.sourcing.length >= 1);
});

test("watch_build: a permalink code round-trips through the tools", () => {
  const code = encodeBuild(normalizeBuild({ ...DEFAULT_BUILD, insert: "pepsi", strap: "jubilee" }));
  const r = run("watch_build", { code });
  assert.equal(r.build.insert, "pepsi");
  assert.equal(r.build.strap, "jubilee");
  assert.equal(r.code, code);
  // No build argument at all is the default build, not an error.
  assert.deepEqual(run("watch_build", {}).build, normalizeBuild(DEFAULT_BUILD));
});

test("watch_check: reports the errors that make a build unassemblable", () => {
  // An NH34 GMT movement with a three-hand set is the engine's clearest error.
  const bad = run("watch_check", { build: { movement: "nh34", hands: "skx-dive" } });
  assert.equal(bad.fit.ok, false);
  assert.ok(bad.fit.errors.some((e) => e.slot === "hands" && /24-hour|fourth/.test(e.problem)));
  // ...and stays quiet on a build that fits.
  assert.equal(run("watch_check", {}).fit.ok, true);
});

test("watch_sourcing: brands, price bands and locally built search URLs", () => {
  const all = run("watch_sourcing", {});
  assert.ok(all.rows.length >= 2);
  assert.equal(typeof all.priceUsd.low, "number");
  for (const row of all.rows) {
    assert.ok(row.links.length >= 1, `${row.slot}: nothing to search for`);
    // The index is curated query strings, never a scrape — the URLs are built
    // as strings and nothing here contacts a marketplace.
    for (const link of row.links) assert.match(link.url, /^https:\/\/www\.aliexpress\.com\/w\//);
  }
  // Named brands exist where the catalogue has them (the case families), and an
  // empty list elsewhere is data, not a gap to paper over with a guess.
  assert.ok(all.rows.some((r) => r.brands.length >= 1), "some row names its makers");
  const oneSlot = run("watch_sourcing", { slot: "case" });
  assert.equal(oneSlot.rows.length, 1);
  assert.equal(oneSlot.rows[0].slot, "case");
  assert.match(run("watch_sourcing", { slot: "nonsense" }).error, /No sourcing row/);
});

// ---------------------------------------------------------------------------
// The command tool — the same parser the inline chat builder runs on.

test("watch_command: applies plain language and says exactly what changed", () => {
  const r = run("watch_command", { command: "pepsi bezel and snowflake hands" });
  assert.equal(r.build.insert, "pepsi");
  assert.equal(r.build.hands, "snowflake");
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].recognized, true);
  assert.deepEqual(
    r.applied[0].changed.map((c) => c.slot).sort(),
    ["hands", "insert"],
  );
  assert.match(r.applied[0].summary, /Pepsi/);
  assert.ok(r.suggestions.length >= 1, "the tool offers the next commands too");
});

test("watch_command: Swedish is the same tool, not a second one", () => {
  const r = run("watch_command", { command: "laxrosa urtavla och läderband", lang: "sv" });
  assert.equal(r.build.dial, "salmon");
  assert.equal(r.build.strap, "leather");
  assert.match(r.applied[0].summary, /Urtavla → Laxrosa/);
  assert.ok(r.suggestions.some((s) => s.startsWith("byt ") || /släck|överraska|ovanifrån/.test(s)));
});

test("watch_command: several commands apply in order and accumulate", () => {
  const r = run("watch_command", {
    code: encodeBuild(normalizeBuild(DEFAULT_BUILD)),
    commands: ["use a 62MAS case", "cream dial", "put it on a leather strap"],
  });
  assert.equal(r.applied.length, 3);
  assert.equal(r.build.case, "62mas");
  assert.equal(r.build.dial, "62mas-cream");
  assert.equal(r.build.strap, "leather");
  // Each step reports only its own delta, so a caller can narrate the sequence.
  assert.deepEqual(r.applied.map((a) => a.changed.map((c) => c.slot)), [["case"], ["dial"], ["strap"]]);
});

test("watch_command: an unrecognized command is reported, not guessed at", () => {
  const r = run("watch_command", { command: "make it cooler" });
  assert.equal(r.applied[0].recognized, false);
  assert.deepEqual(r.applied[0].changed, []);
  assert.deepEqual(r.build, normalizeBuild(DEFAULT_BUILD));
  // No command at all is an error result WITH the examples that would work.
  const none = run("watch_command", {});
  assert.match(none.error, /`command`/);
  assert.ok(none.examples.length >= 3);
});

test("watch_command: view commands are display-only", () => {
  const r = run("watch_command", { command: "lights out" });
  assert.equal(r.applied[0].view.lume, true);
  assert.deepEqual(r.applied[0].changed, []);
  assert.deepEqual(r.build, normalizeBuild(DEFAULT_BUILD));
});

test("watch_command: a reroll is reproducible for the same input", () => {
  const a = run("watch_command", { command: "surprise me" });
  const b = run("watch_command", { command: "surprise me" });
  assert.deepEqual(a.build, b.build);
  assert.equal(a.applied[0].randomized, true);
  assert.equal(a.fit.ok, true, "a rerolled build the tool hands back has to be assemblable");
});

// ---------------------------------------------------------------------------
// Robustness. A tool-calling model sends junk; none of it may throw, because a
// thrown tool is a model that retries the same call forever.

test("every tool survives junk arguments", () => {
  for (const name of WATCH_TOOL_NAMES) {
    for (const args of [undefined, null, 42, "string", [], { build: "not an object" }, { code: 12 }, { slot: 7 }, { id: {} }]) {
      const text = runWatchTool(name, /** @type {any} */ (args));
      assert.equal(typeof text, "string", `${name} with ${JSON.stringify(args)}`);
      JSON.parse(text);
    }
  }
});

test("an unknown tool name throws, so a dispatch bug cannot pass silently", () => {
  assert.throws(() => runWatchTool("watch_nonsense", {}), /Unknown watch tool/);
});

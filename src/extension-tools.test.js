// Unit tests for src/extension-tools.js — the MCP tool seam of the extension
// registry, and the properties that keep invariant 7 intact through it.
//
// The seam exists so src/mcp.js can serve third-party tools without naming a
// third party. Two things enforce that and both are checked here: the registry
// is the single source of the tool list, the catalog rows and the spending set;
// and it is PURE, so src/mcp-config.js (a config leaf) can import it without
// pulling the provider graph in behind it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXTENSION_MCP_CATALOG,
  EXTENSION_MCP_TOOLS,
  EXTENSION_SPENDING_TOOLS,
  EXTENSION_TOOL_EXTENSION,
  EXTENSION_TOOL_FAMILIES,
  EXTENSION_TOOL_NAMES,
  extensionOffMessage,
} from "./extension-tools.js";
import { EXTENSIONS } from "./extensions.js";

test("every tool belongs to an extension that actually exists", () => {
  // The tie is what makes the knob gate meaningful: a tool whose `extension` id
  // matches no descriptor would be gated on a setting nobody can switch.
  const known = new Set(EXTENSIONS.map((e) => e.id));
  for (const family of EXTENSION_TOOL_FAMILIES) {
    assert.ok(known.has(family.extension), `${family.extension} is not a registered extension`);
  }
  for (const [tool, extension] of Object.entries(EXTENSION_TOOL_EXTENSION)) {
    assert.ok(known.has(extension), `${tool} names an unknown extension`);
  }
});

test("the tool list, the catalog and the spending set are the same set of names", () => {
  const names = EXTENSION_MCP_TOOLS.map((t) => t.name);
  assert.deepEqual([...EXTENSION_TOOL_NAMES], names);
  assert.deepEqual(EXTENSION_MCP_CATALOG.map((c) => c.id), names);
  // Everything registered today reaches a metered API. That is not a law — the
  // flag stays explicit precisely so a future free tool has to say so — but a
  // tool missing from the set silently skips the quota gate, so the assertion
  // is the reminder.
  assert.deepEqual([...EXTENSION_SPENDING_TOOLS].sort(), [...names].sort());
});

test("definitions arrive in MCP's key shape, with a schema and a description", () => {
  for (const tool of EXTENSION_MCP_TOOLS) {
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object inputSchema`);
    assert.equal(/** @type {any} */ (tool).input_schema, undefined, "MCP wants inputSchema, not Anthropic's key");
    assert.ok(tool.description.length > 80, `${tool.name}'s description is what the calling model reads`);
  }
});

test("every catalog row carries the Settings copy the screen renders", () => {
  for (const row of EXTENSION_MCP_CATALOG) {
    assert.ok(row.group, `${row.id} needs a group heading`);
    assert.ok(row.blurb.length > 40, `${row.id} needs a blurb explaining what it costs`);
    assert.equal(row.def, true);
    assert.equal(row.label, row.id);
  }
});

test("the refusal names the setting and tells the model not to retry", () => {
  const message = extensionOffMessage("host_intel");
  assert.match(message, /host_intel/);
  assert.match(message, /Host intelligence/);
  // The three things a calling model must not conclude: that this is a bug,
  // that it is a rate limit, or that a retry helps.
  assert.match(message, /Retrying will not help/);
  assert.match(message, /nothing was spent/);
  // An unknown tool still produces a sentence rather than "undefined".
  assert.match(extensionOffMessage("nope"), /this integration/);
});

test("the registry and its schema modules are import-pure", () => {
  // src/mcp-config.js imports this, and src/mcp.js imports THAT statically. If
  // any link in the chain reached a runner, importing the protocol module would
  // drag the provider graph into every test that touches it — the file-layout
  // rule at the top of src/mcp.js. The schema modules import nothing at all;
  // this one imports only them.
  for (const file of ["maps-tools.js", "shodan-tools.js"]) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(/^import\s/m.test(src), false, `${file} must import nothing`);
  }
  const registry = readFileSync(new URL("./extension-tools.js", import.meta.url), "utf8");
  const imports = [...registry.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./maps-tools.js", "./shodan-tools.js"]);
});

test("src/mcp.js names no third-party service, and reaches the runners dynamically", () => {
  // The same cut src/extensions.test.js enforces for the enrichment seam. It is
  // asserted here too because THIS module is the reason mcp.js can serve these
  // tools at all: if the dispatch ever inlines a service name or a static import
  // of a runner, the seam has stopped doing its job.
  const mcp = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  const code = mcp
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  for (const token of [/shodan/i, /googlemaps/i, /street[_ ]?view/i, /google[ -]?maps/i]) {
    assert.equal(token.test(code), false, `src/mcp.js names a service: ${token}`);
  }
  assert.equal(/^import\s.*extension-tools-run/m.test(mcp), false, "the runner must stay behind a dynamic import");
  assert.match(mcp, /await import\("\.\/extension-tools-run\.js"\)/);
});

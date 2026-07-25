// The façade-IS-the-core contract, enforced across the whole of src/ — a
// repo-wide guard in the shape of src/sql-injection-guard.test.js.
//
// Shared pure cores live under public/js/ because the browser can only import
// served modules; the server files re-export them as façades (CLAUDE.md, "Code
// layout"). The whole mirror discipline rests on one property: a façade's
// export must BE the core's implementation — the same function object — not a
// copy that drifted. src/bash-agent.test.js pinned that for one module by
// hand; twelve other façades had no such assertion (gap B5,
// docs/TESTING-GAP-ANALYSIS.md).
//
// This suite DISCOVERS the façades instead of listing them, so a new one is
// covered the day it lands and cannot quietly ship a re-implementation. It
// checks identity only — behaviour stays the core's own suite's job.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

// Any `import`/`export … from "../public/js/<core>.js"` in a src module makes
// that module a façade candidate. Whether it re-exports anything is decided
// by comparing the two namespaces, not by parsing the export form — a module
// that only borrows a helper for internal use (src/pool.js's
// sanitizePoolRequest) simply shares no exported name and contributes no
// assertions.
const CORE_IMPORT_RE = /(?:import|export)[\s\S]*?from\s*["']\.\.\/public\/js\/([\w.-]+)\.js["']/g;

/** @returns {Array<{module: string, core: string}>} one row per (façade, core) pair */
function discoverFacades() {
  const pairs = [];
  for (const name of readdirSync(SRC).sort()) {
    if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
    const text = readFileSync(join(SRC, name), "utf8");
    const cores = new Set();
    for (const m of text.matchAll(CORE_IMPORT_RE)) cores.add(m[1]);
    for (const core of cores) pairs.push({ module: name, core });
  }
  return pairs;
}

const FACADES = discoverFacades();

// Names a façade DELIBERATELY defines itself rather than re-exporting. Each
// entry is a reviewed decision, not a waiver: the server surface differs from
// the core's on purpose, and the server function still delegates to the core
// so there is exactly one implementation. Anything not listed here that
// diverges is drift and fails.
const DELIBERATE_OVERRIDES = {
  // The server signature carries `env` (every other src search helper does,
  // so callers stay uniform); the body is a one-line delegation to the core.
  "websearch-backends.js": new Set(["runBackendSearch"]),
};

describe("every src façade re-exports its shared core (single source of truth)", () => {
  // The walker is the load-bearing part: if it stops finding façades the
  // suite would pass vacuously.
  test("the façade scan still finds the known façades", () => {
    assert.ok(
      FACADES.length >= 12,
      `only ${FACADES.length} façade/core pairs found — the scanner is probably broken`,
    );
    const modules = new Set(FACADES.map((f) => f.module));
    for (const known of ["bash-agent.js", "introspect.js", "orchestrator.js", "space.js", "sdk-tools.js"]) {
      assert.ok(modules.has(known), `${known} is a known façade but the scan missed it`);
    }
  });

  for (const { module, core } of FACADES) {
    test(`${module} → public/js/${core}.js: shared names are the SAME object`, async () => {
      const facade = await import(`./${module}`);
      const impl = await import(`../public/js/${core}.js`);

      const allowed = DELIBERATE_OVERRIDES[module] || new Set();
      const shared = Object.keys(impl).filter((k) => k !== "default" && k in facade && !allowed.has(k));
      for (const name of shared) {
        assert.equal(
          facade[name],
          impl[name],
          `${module} exports its own \`${name}\` instead of re-exporting public/js/${core}.js's — ` +
            "a mirrored copy drifts; re-export the core.",
        );
      }
    });
  }
});

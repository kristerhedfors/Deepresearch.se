#!/usr/bin/env node
// The Agent-Pair SDK's command-line interface — dependency-free, runs anywhere
// Node runs: a desktop checkout (VS Code terminal, any editor, any agent
// harness) or INSIDE the pair's in-browser Linux VM (the source snapshot mounts
// this repo at /src, so `node /src/sdk/pair-cli.mjs …` works in the sandbox
// when the image ships nodejs — see the sdk/vm-toolchain skill).
//
// It operates on sdk/MANIFEST.json only (no network, no state):
//
//   node sdk/pair-cli.mjs list                     # module catalog by layer
//   node sdk/pair-cli.mjs show <id>                # one module's full entry
//   node sdk/pair-cli.mjs plan <id> [<id> …]       # selection -> dependency
//                                                  #   closure -> build order
//   node sdk/pair-cli.mjs validate                 # manifest + skill integrity
//
// `plan` is the generator's mechanical half: it closes the selection over
// `deps`, always includes the baseplate, orders by (layer, deps, manifest
// order), and prints each module with its skill path — the sequence the
// pair-generator skill executes one module at a time. `validate` is the
// pre-flight: ids unique, deps resolve, every skill file exists, classes and
// layers legal, and the class-C rule (a client-pure module may not depend on a
// server-backed one — C may depend on C/X/B, never S) holds at the manifest
// level.
//
// Since SDK mode was wired into the application (2026-07-18), the pure
// manifest logic lives in the SHARED core public/js/sdk-core.js — the ONE
// implementation this CLI, the Worker (src/sdk-tools.js), the /mcp sdk_*
// tools, and the browser all use. This file is the disk-reading CLI façade;
// it re-exports the helpers so its historical import surface
// (sdk/pair-cli.test.mjs and any external consumer) is unchanged. Do not
// re-implement a helper here — extend sdk-core.js.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLASSES,
  closeSelection,
  orderModules,
  renderList,
  renderPlan,
  renderShow,
  validateManifest,
} from "../public/js/sdk-core.js";

export {
  CLASSES,
  closeSelection,
  orderModules,
  renderList,
  renderPlan,
  renderShow,
  validateManifest,
} from "../public/js/sdk-core.js";

const SDK_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..");

/** Load and lightly shape the manifest. Throws on unreadable/unparsable. */
export function loadManifest(root = REPO_ROOT) {
  const raw = readFileSync(join(root, "sdk/MANIFEST.json"), "utf8");
  const m = JSON.parse(raw);
  if (!m || !Array.isArray(m.modules)) throw new Error("manifest has no modules[]");
  return m;
}

// ---- entry -------------------------------------------------------------------

function main(argv) {
  const [cmd, ...args] = argv;
  const m = loadManifest();
  if (cmd === "list") return console.log(renderList(m));
  if (cmd === "show") return console.log(renderShow(m, args[0] || ""));
  if (cmd === "plan") {
    if (!args.length) return console.error("usage: pair-cli plan <module-id> [...]");
    return console.log(renderPlan(m, args));
  }
  if (cmd === "validate") {
    const problems = validateManifest(m, (p) => existsSync(join(REPO_ROOT, p)));
    if (!problems.length) return console.log(`OK: ${m.modules.length} modules, all skills present, deps + class rules hold.`);
    for (const p of problems) console.error(`PROBLEM: ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log("usage: node sdk/pair-cli.mjs <list|show <id>|plan <id...>|validate>");
}

// Import-safe for tests: only run as a CLI when executed directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}

// Referenced so the static import isn't unused when only the CLI runs; the
// re-export block above is the real API surface.
void closeSelection;
void orderModules;
void CLASSES;

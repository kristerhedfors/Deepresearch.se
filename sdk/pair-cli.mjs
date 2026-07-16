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
// level. Pure helpers are exported for the unit suite (sdk/pair-cli.test.mjs).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SDK_ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..");

export const CLASSES = ["C", "S", "B", "X", "D"];

/** Load and lightly shape the manifest. Throws on unreadable/unparsable. */
export function loadManifest(root = REPO_ROOT) {
  const raw = readFileSync(join(root, "sdk/MANIFEST.json"), "utf8");
  const m = JSON.parse(raw);
  if (!m || !Array.isArray(m.modules)) throw new Error("manifest has no modules[]");
  return m;
}

/**
 * Structural validation of a manifest object. Returns a list of problem
 * strings — empty means valid. `fileCheck` (optional) maps a skill path to
 * existence, so the pure logic stays testable without a filesystem.
 * @param {any} m
 * @param {(path: string) => boolean} [fileCheck]
 * @returns {string[]}
 */
export function validateManifest(m, fileCheck) {
  const problems = [];
  const ids = new Map();
  for (const mod of m.modules) {
    if (!mod.id || typeof mod.id !== "string") problems.push(`module with missing id: ${JSON.stringify(mod).slice(0, 60)}`);
    if (ids.has(mod.id)) problems.push(`duplicate id: ${mod.id}`);
    ids.set(mod.id, mod);
  }
  for (const mod of m.modules) {
    if (!CLASSES.includes(mod.class)) problems.push(`${mod.id}: illegal class ${mod.class}`);
    if (!Number.isInteger(mod.layer) || mod.layer < 0 || mod.layer > 6) problems.push(`${mod.id}: illegal layer ${mod.layer}`);
    if (!mod.skill) problems.push(`${mod.id}: no skill path`);
    for (const d of mod.deps || []) {
      if (!ids.has(d)) problems.push(`${mod.id}: unresolved dep ${d}`);
      // The class-C manifest rule: client-pure modules must stay deployable on
      // a static host, so they may not depend on server-backed modules. The
      // bridged class (B) is itself the sanctioned crossing, so C->B is legal.
      else if (mod.class === "C" && ids.get(d).class === "S") {
        problems.push(`${mod.id} (C) depends on ${d} (S) — client-pure may not require the server tier`);
      }
    }
    if (fileCheck && mod.skill && !fileCheck(mod.skill)) problems.push(`${mod.id}: skill file missing: ${mod.skill}`);
  }
  for (const b of m.baseplate || []) {
    if (!ids.has(b)) problems.push(`baseplate names unknown module: ${b}`);
  }
  // Dependency cycles would deadlock the generator; detect via the same
  // topological walk plan() uses.
  try {
    orderModules(m, m.modules.map((x) => x.id));
  } catch (e) {
    problems.push(String(e && /** @type {Error} */ (e).message));
  }
  return problems;
}

/**
 * Close a selection over deps (baseplate always included). Unknown ids throw.
 * @param {any} m
 * @param {string[]} selection
 * @returns {Set<string>}
 */
export function closeSelection(m, selection) {
  const byId = new Map(m.modules.map((x) => [x.id, x]));
  const want = new Set(m.baseplate || []);
  const queue = [...selection];
  while (queue.length) {
    const id = queue.shift();
    if (!byId.has(id)) throw new Error(`unknown module: ${id}`);
    if (want.has(id)) continue;
    want.add(id);
    queue.push(...(byId.get(id).deps || []));
  }
  // Baseplate deps too (pair-architecture has none, but stay general).
  for (const id of [...want]) queue.push(...((byId.get(id) || {}).deps || []));
  while (queue.length) {
    const id = queue.shift();
    if (!want.has(id) && byId.has(id)) {
      want.add(id);
      queue.push(...(byId.get(id).deps || []));
    }
  }
  return want;
}

/**
 * Order a set of module ids for generation: dependencies first, then layer,
 * then manifest order (stable). Throws on a dependency cycle.
 * @param {any} m
 * @param {Iterable<string>} idSet
 * @returns {any[]} ordered module entries
 */
export function orderModules(m, idSet) {
  const want = new Set(idSet);
  const byId = new Map(m.modules.map((x) => [x.id, x]));
  const pos = new Map(m.modules.map((x, i) => [x.id, i]));
  const done = new Set();
  const out = [];
  const visiting = new Set();
  const visit = (id) => {
    if (done.has(id) || !want.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle through ${id}`);
    visiting.add(id);
    const deps = (byId.get(id).deps || []).filter((d) => want.has(d));
    deps.sort((a, b) => (byId.get(a).layer - byId.get(b).layer) || (pos.get(a) - pos.get(b)));
    for (const d of deps) visit(d);
    visiting.delete(id);
    done.add(id);
    out.push(byId.get(id));
  };
  const ordered = [...want].filter((id) => byId.has(id));
  ordered.sort((a, b) => (byId.get(a).layer - byId.get(b).layer) || (pos.get(a) - pos.get(b)));
  for (const id of ordered) visit(id);
  return out;
}

// ---- rendering (plain text, terminal + VM friendly) --------------------------

export function renderList(m) {
  const lines = [];
  const layers = m.layers || {};
  let current = null;
  const sorted = [...m.modules].sort((a, b) => a.layer - b.layer);
  for (const mod of sorted) {
    if (mod.layer !== current) {
      current = mod.layer;
      lines.push(`\nLayer ${current} — ${layers[String(current)] || ""}`);
    }
    const base = (m.baseplate || []).includes(mod.id) ? " [baseplate]" : "";
    lines.push(`  ${mod.id}  (${mod.class})${base} — ${mod.name}`);
  }
  return lines.join("\n").trim();
}

export function renderShow(m, id) {
  const mod = m.modules.find((x) => x.id === id);
  if (!mod) return `unknown module: ${id}`;
  return [
    `${mod.id} — ${mod.name}`,
    `  layer: ${mod.layer}   class: ${mod.class}`,
    `  deps: ${(mod.deps || []).join(", ") || "(none)"}`,
    `  skill: ${mod.skill}`,
    `  provides: ${mod.provides}`,
    `  reference: ${(mod.reference || []).join(", ")}`,
    `  acceptance: ${mod.acceptance}`,
  ].join("\n");
}

export function renderPlan(m, selection) {
  const ordered = orderModules(m, closeSelection(m, selection));
  const lines = [`Build order for selection [${selection.join(", ")}] (+${(m.baseplate || []).join("+")}):`, ""];
  ordered.forEach((mod, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${mod.id}  (layer ${mod.layer}, ${mod.class})`);
    lines.push(`      skill: ${mod.skill}`);
    lines.push(`      done when: ${mod.acceptance}`);
  });
  lines.push("");
  lines.push("Execute one module at a time (pair-generator skill): load the skill,");
  lines.push("run its Build plan, land its acceptance checklist green, then move on.");
  return lines.join("\n");
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

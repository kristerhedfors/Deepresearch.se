#!/usr/bin/env node
// @ts-check
// DRPL/1 reference tooling — the Deep Research Pipeline Language's validator,
// canonicalizer, structural fingerprinter and differ. Dependency-free, runs
// anywhere Node runs (a desktop checkout or inside the pair's sandbox VM at
// /src/sdk/drpl.mjs), the pair-cli.mjs of the pipeline language.
//
// DRPL declares the STRUCTURE of a deep-research pipeline — phases, dataflow,
// failure contracts, model routing, and (the part no established workflow
// language carries) the PRIVACY PLACEMENT: which party executes each phase and
// which parties receive which data. The language spec is
// docs/PIPELINE-LANGUAGE.md; the JSON Schema is docs/schemas/drpl-1.schema.json;
// two encoded real pipelines live in docs/examples/*.drpl.json.
//
//   node sdk/drpl.mjs validate <file.drpl.json>
//   node sdk/drpl.mjs show <file>                     # phase table
//   node sdk/drpl.mjs fingerprint <file> [--level shape|placement|full] [--spine]
//   node sdk/drpl.mjs diff <a> <b> [--level …] [--spine]
//
// The three comparison LEVELS project each phase down to a view:
//   shape      what research happens: kind, dataflow, optionality, loops,
//              failure policy — placement-blind (a server pipeline and a
//              browser pipeline doing the same research compare EQUAL)
//   placement  shape + who runs it and who receives what: exec.at, calls[],
//              model routing — the privacy posture made comparable
//   full       everything structural (loop bounds, retry, emits, params);
//              only prose (title/notes/degradesTo/until/meta) stays out
// `--spine` first drops `optional: true` phases (rewiring dataflow through
// them transitively), then fingerprints — the required research spine, which
// is how the reference pair's two tiers compare equal at shape level while
// carrying different optional enrichments.
//
// Pure helpers are exported for the unit suite (sdk/drpl.test.mjs).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const DRPL_V = 1;

// Registered phase kinds (open vocabulary: anything else must be "x-…").
export const PHASE_KINDS = [
  "triage", // question analysis → a research plan (JSON planning call)
  "enrichment", // opt-in pre-pipeline context (geocode / host-intel / maps …)
  "recall", // retrieval over prior local material (RAG / project memory)
  "search", // source gathering — web search OR offline knowledge harvest
  "notes", // structured claim distillation across gathered sources
  "gap-check", // coverage audit deciding follow-up rounds
  "synthesis", // the streamed answer on the user's chosen model
  "validation", // review of the draft with a revise-or-accept verdict
  "tool-loop", // an agentic tool loop (shell, source investigation …)
  "transform", // deterministic data shaping between phases
  "grade", // scoring/judging a produced artifact
  "human-gate", // an explicit user decision the pipeline waits on
];

// Registered data-receiving parties (open vocabulary via "x-…"). "none" as a
// call party is not allowed — express "no data leaves" as calls: [].
export const PARTIES = [
  "origin-server", // the node's own server component
  "model-provider", // a third-party LLM API (user- or server-keyed)
  "search-provider", // a third-party web-search API
  "embedding-provider", // a third-party embeddings API
  "enrichment-provider", // maps / host-intel / geocoding APIs
  "self-hosted", // a service the user runs themselves (local model, SearXNG)
];

export const EXEC_AT = ["client", "server"];
export const MODEL_ROUTES = ["planning", "answer"];
export const MODEL_MODES = ["json", "stream"];
export const FAILURE_POLICIES = ["soft", "hard"];
export const LEVELS = ["shape", "placement", "full"];

const FP_PREFIX = "drpl1";
const FP_HEX = 16;

/** @param {string} v @param {string[]} registry @returns {boolean} registered or an x- extension */
const inVocab = (v, registry) => registry.includes(v) || /^x-[a-z0-9-]+$/.test(v);

/**
 * Structural validation of a DRPL document. Returns a list of problem
 * strings — empty means valid (the pair-cli validateManifest convention).
 * @param {any} doc
 * @returns {string[]}
 */
export function validateDrpl(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["not an object"];
  if (doc.drpl !== DRPL_V) problems.push(`drpl must be ${DRPL_V} (got ${JSON.stringify(doc.drpl)})`);
  if (!doc.id || typeof doc.id !== "string") problems.push("id must be a non-empty string");
  if (!Array.isArray(doc.phases) || !doc.phases.length) return [...problems, "phases must be a non-empty array"];

  const ids = new Set();
  for (const ph of doc.phases) {
    if (!ph || typeof ph !== "object") {
      problems.push("phase is not an object");
      continue;
    }
    const id = typeof ph.id === "string" && ph.id ? ph.id : null;
    if (!id) problems.push(`phase with missing id: ${JSON.stringify(ph).slice(0, 60)}`);
    else if (ids.has(id)) problems.push(`duplicate phase id: ${id}`);
    if (id) ids.add(id);
    const at = id || "?";
    if (typeof ph.kind !== "string" || !inVocab(ph.kind, PHASE_KINDS)) problems.push(`${at}: unknown kind ${JSON.stringify(ph.kind)} (register or use x-…)`);
    if (ph.needs !== undefined && !Array.isArray(ph.needs)) problems.push(`${at}: needs must be an array of phase ids`);
    if (ph.optional !== undefined && typeof ph.optional !== "boolean") problems.push(`${at}: optional must be a boolean`);
    if (ph.repeats !== undefined && typeof ph.repeats !== "boolean" && !(ph.repeats && typeof ph.repeats === "object" && Number.isInteger(ph.repeats.max) && ph.repeats.max >= 1)) {
      problems.push(`${at}: repeats must be a boolean or { max: int >= 1 }`);
    }
    if (!ph.exec || typeof ph.exec !== "object" || !EXEC_AT.includes(ph.exec.at)) problems.push(`${at}: exec.at must be one of ${EXEC_AT.join("|")}`);
    if (!ph.failure || typeof ph.failure !== "object" || !FAILURE_POLICIES.includes(ph.failure.policy)) problems.push(`${at}: failure.policy must be one of ${FAILURE_POLICIES.join("|")}`);
    if (ph.calls !== undefined) {
      if (!Array.isArray(ph.calls)) problems.push(`${at}: calls must be an array`);
      else {
        for (const c of ph.calls) {
          if (!c || typeof c !== "object" || typeof c.party !== "string" || !inVocab(c.party, PARTIES)) problems.push(`${at}: call with unknown party ${JSON.stringify(c && c.party)}`);
          if (!c || !Array.isArray(c.carries) || !c.carries.length || c.carries.some((/** @type {any} */ x) => typeof x !== "string" || !x)) {
            problems.push(`${at}: every call must declare carries: [what data crosses]`);
          }
        }
      }
    }
    if (ph.model !== undefined) {
      const m = ph.model;
      if (!m || typeof m !== "object") problems.push(`${at}: model must be an object`);
      else {
        if (!MODEL_ROUTES.includes(m.route)) problems.push(`${at}: model.route must be one of ${MODEL_ROUTES.join("|")}`);
        if (!MODEL_MODES.includes(m.mode)) problems.push(`${at}: model.mode must be one of ${MODEL_MODES.join("|")}`);
        if (m.tools !== undefined && m.tools !== false && !(Array.isArray(m.tools) && m.tools.every((/** @type {any} */ t) => typeof t === "string" && t))) {
          problems.push(`${at}: model.tools must be false or a list of tool names`);
        }
      }
    }
  }
  for (const ph of doc.phases) {
    for (const n of Array.isArray(ph && ph.needs) ? ph.needs : []) {
      if (!ids.has(n)) problems.push(`${ph.id || "?"}: needs unknown phase ${JSON.stringify(n)}`);
    }
  }
  if (!problems.length && !topoOrder(doc.phases)) problems.push("phase dataflow has a cycle (needs must form a DAG)");
  return problems;
}

/**
 * Deterministic topological order of phases by `needs` (Kahn's algorithm,
 * lexicographic id tiebreak). Returns the ordered id list, or null on a cycle.
 * @param {any[]} phases
 * @returns {string[] | null}
 */
export function topoOrder(phases) {
  /** @type {Map<string, string[]>} */
  const needs = new Map(phases.map((p) => [p.id, [...new Set(Array.isArray(p.needs) ? p.needs : [])]]));
  /** @type {string[]} */
  const out = [];
  const done = new Set();
  while (out.length < needs.size) {
    const ready = [...needs.keys()].filter((id) => !done.has(id) && /** @type {string[]} */ (needs.get(id)).every((n) => done.has(n))).sort();
    if (!ready.length) return null;
    for (const id of ready) {
      out.push(id);
      done.add(id);
    }
  }
  return out;
}

/**
 * The SPINE projection: drop `optional: true` phases and rewire dataflow
 * through them (a phase needing a dropped phase inherits that phase's needs,
 * transitively) — the required research spine as its own comparable document.
 * @param {any} doc a valid DRPL document
 * @returns {any} a new document (input untouched)
 */
export function spineProject(doc) {
  const byId = new Map(doc.phases.map((/** @type {any} */ p) => [p.id, p]));
  /** @type {(id: string, seen?: Set<string>) => string[]} resolve to nearest required ancestors */
  const resolve = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const p = byId.get(id);
    if (!p) return [];
    if (!p.optional) return [id];
    return (Array.isArray(p.needs) ? p.needs : []).flatMap((/** @type {string} */ n) => resolve(n, seen));
  };
  const phases = doc.phases
    .filter((/** @type {any} */ p) => !p.optional)
    .map((/** @type {any} */ p) => ({
      ...p,
      needs: [...new Set((Array.isArray(p.needs) ? p.needs : []).flatMap((/** @type {string} */ n) => resolve(n)))].sort(),
    }));
  return { ...doc, phases };
}

/** @param {any} v @returns {any} recursively key-sorted copy (canonical JSON) */
export function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    /** @type {any} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

// Prose/annotation fields — never part of any structural level.
const PROSE_PHASE_FIELDS = new Set(["id", "title", "notes", "meta"]);

/**
 * Project one phase down to a comparison-level view. `index` maps phase id →
 * canonical (topological) position, so views are id-blind.
 * @param {any} ph
 * @param {"shape"|"placement"|"full"} level
 * @param {Map<string, number>} index
 * @returns {any}
 */
export function phaseView(ph, level, index) {
  /** @type {any} */
  const view = {
    kind: ph.kind,
    needs: (Array.isArray(ph.needs) ? ph.needs : []).map((/** @type {string} */ n) => index.get(n)).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b),
    optional: !!ph.optional,
    repeats: !!ph.repeats,
    failure: ph.failure.policy,
  };
  if (level === "shape") return view;
  view.at = ph.exec.at;
  view.calls = (Array.isArray(ph.calls) ? ph.calls : [])
    .map((/** @type {any} */ c) => ({ party: c.party, carries: [...c.carries].sort() }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.party + a.carries.join()).localeCompare(b.party + b.carries.join()));
  view.model = ph.model ? { route: ph.model.route, mode: ph.model.mode, tools: Array.isArray(ph.model.tools) ? [...ph.model.tools].sort() : false } : null;
  if (level === "placement") return view;
  // full: every remaining structural field, prose excluded.
  view.repeatsMax = ph.repeats && typeof ph.repeats === "object" ? ph.repeats.max : null;
  /** @type {any} */
  const rest = {};
  for (const [k, val] of Object.entries(ph)) {
    if (PROSE_PHASE_FIELDS.has(k) || ["kind", "needs", "optional", "repeats", "failure", "exec", "calls", "model"].includes(k)) continue;
    rest[k] = val;
  }
  view.failureRetry = ph.failure.retry ?? null;
  view.rest = sortKeysDeep(rest);
  return view;
}

/**
 * The canonical structural form at a level: phases in deterministic
 * topological order, ids replaced by positions, prose stripped, keys sorted.
 * @param {any} doc a valid DRPL document
 * @param {"shape"|"placement"|"full"} [level]
 * @param {{ spine?: boolean }} [opts]
 * @returns {any}
 */
export function canonicalForm(doc, level = "shape", opts = {}) {
  const d = opts.spine ? spineProject(doc) : doc;
  const order = topoOrder(d.phases);
  if (!order) throw new Error("cycle");
  const index = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(d.phases.map((/** @type {any} */ p) => [p.id, p]));
  return sortKeysDeep({
    drpl: DRPL_V,
    level: opts.spine ? `spine-${level}` : level,
    phases: order.map((id) => phaseView(byId.get(id), level, index)),
  });
}

/**
 * The structural fingerprint: `drpl1:<level>:<16 hex>` of the canonical form.
 * Two pipelines with the same structure at a level fingerprint EQUAL there —
 * whatever their ids, prose, field order, or (below the level) placement.
 * @param {any} doc @param {"shape"|"placement"|"full"} [level] @param {{ spine?: boolean }} [opts]
 * @returns {string}
 */
export function fingerprint(doc, level = "shape", opts = {}) {
  const canon = JSON.stringify(canonicalForm(doc, level, opts));
  const hex = createHash("sha256").update(canon).digest("hex").slice(0, FP_HEX);
  return `${FP_PREFIX}:${opts.spine ? `spine-${level}` : level}:${hex}`;
}

/**
 * Structural diff of two documents at a level, aligned by phase id.
 * @param {any} a @param {any} b @param {"shape"|"placement"|"full"} [level] @param {{ spine?: boolean }} [opts]
 * @returns {{ added: string[], removed: string[], changed: Array<{id: string, fields: string[]}>, same: string[] }}
 */
export function diffDrpl(a, b, level = "shape", opts = {}) {
  const da = opts.spine ? spineProject(a) : a;
  const db = opts.spine ? spineProject(b) : b;
  const lv = level;
  /** @type {(d: any) => Map<string, any>} */
  const views = (d) => {
    const order = topoOrder(d.phases);
    if (!order) throw new Error("cycle");
    const index = new Map(order.map((id, i) => [id, i]));
    return new Map(d.phases.map((/** @type {any} */ p) => [p.id, phaseView(p, lv, index)]));
  };
  const va = views(da);
  const vb = views(db);
  const result = { added: /** @type {string[]} */ ([]), removed: /** @type {string[]} */ ([]), changed: /** @type {Array<{id: string, fields: string[]}>} */ ([]), same: /** @type {string[]} */ ([]) };
  for (const id of [...va.keys()].sort()) {
    if (!vb.has(id)) {
      result.removed.push(id);
      continue;
    }
    const xa = va.get(id);
    const xb = vb.get(id);
    const fields = [...new Set([...Object.keys(xa), ...Object.keys(xb)])].filter((k) => JSON.stringify(sortKeysDeep(xa[k]) ?? null) !== JSON.stringify(sortKeysDeep(xb[k]) ?? null)).sort();
    if (fields.length) result.changed.push({ id, fields });
    else result.same.push(id);
  }
  for (const id of [...vb.keys()].sort()) if (!va.has(id)) result.added.push(id);
  return result;
}

// ---- rendering ---------------------------------------------------------------

/** @param {any} doc @returns {string} the phase table */
export function renderShow(doc) {
  const order = topoOrder(doc.phases) || doc.phases.map((/** @type {any} */ p) => p.id);
  const byId = new Map(doc.phases.map((/** @type {any} */ p) => [p.id, p]));
  const lines = [`${doc.id}  (drpl ${doc.drpl})${doc.title ? ` — ${doc.title}` : ""}`, ""];
  for (const id of order) {
    const p = byId.get(id);
    const flags = [p.optional ? "optional" : "", p.repeats ? "repeats" : "", p.failure.policy === "soft" ? "fail-soft" : "fail-hard"].filter(Boolean).join(", ");
    const calls = (p.calls || []).map((/** @type {any} */ c) => `${c.party}←[${c.carries.join(",")}]`).join(" ") || "(no data leaves)";
    const model = p.model ? `  model ${p.model.route}/${p.model.mode}${Array.isArray(p.model.tools) ? "+tools" : ""}` : "";
    lines.push(`  ${id}  [${p.kind}] @${p.exec.at}  needs(${(p.needs || []).join(", ") || "—"})  ${flags}${model}`);
    lines.push(`      calls: ${calls}`);
  }
  return lines.join("\n");
}

/** @param {string} path @returns {any} */
function loadDoc(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---- entry -------------------------------------------------------------------

/** @param {string[]} args @returns {{ level: "shape"|"placement"|"full", spine: boolean, rest: string[] }} */
export function parseCliFlags(args) {
  /** @type {any} */
  let level = "shape";
  let spine = false;
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--level" && LEVELS.includes(args[i + 1])) level = args[++i];
    else if (args[i] === "--spine") spine = true;
    else rest.push(args[i]);
  }
  return { level, spine, rest };
}

function main(argv) {
  const [cmd, ...raw] = argv;
  const { level, spine, rest } = parseCliFlags(raw);
  if (cmd === "validate" && rest[0]) {
    const problems = validateDrpl(loadDoc(rest[0]));
    if (!problems.length) return console.log(`OK: ${rest[0]} is a valid DRPL/${DRPL_V} document.`);
    for (const p of problems) console.error(`PROBLEM: ${p}`);
    process.exitCode = 1;
    return;
  }
  if (cmd === "show" && rest[0]) return console.log(renderShow(loadDoc(rest[0])));
  if (cmd === "fingerprint" && rest[0]) return console.log(fingerprint(loadDoc(rest[0]), level, { spine }));
  if (cmd === "diff" && rest[0] && rest[1]) {
    const d = diffDrpl(loadDoc(rest[0]), loadDoc(rest[1]), level, { spine });
    console.log(`level: ${spine ? `spine-${level}` : level}`);
    for (const id of d.same) console.log(`  = ${id}`);
    for (const c of d.changed) console.log(`  ~ ${c.id}  (${c.fields.join(", ")})`);
    for (const id of d.removed) console.log(`  - ${id}  (only in ${rest[0]})`);
    for (const id of d.added) console.log(`  + ${id}  (only in ${rest[1]})`);
    if (!d.changed.length && !d.added.length && !d.removed.length) console.log("  structurally identical at this level");
    return;
  }
  console.log("usage: node sdk/drpl.mjs <validate <f>|show <f>|fingerprint <f>|diff <a> <b>> [--level shape|placement|full] [--spine]");
}

// Import-safe for tests: only run as a CLI when executed directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}

// @ts-check
// DistillSDK's shared PURE core — the one implementation both tiers
// (and the sdk/pair-cli.mjs CLI) use for manifest operations, SDK-mode native
// tools, and generated-app ("build") file handling. The bash-core.js /
// introspect-core.js pattern: it lives under public/ because the browser can
// only import served modules while the Worker bundler imports from any repo
// path; src/sdk-tools.js is the thin server façade and sdk/pair-cli.mjs
// re-exports the manifest helpers so its CLI/test API is unchanged.
//
// Everything here is I/O-free and Node-tested (sdk-core.test.js): the manifest
// logic operates on a parsed manifest object (the CLI reads it from disk, the
// Worker from the committed source snapshot — public/introspect/
// source-snapshot.json — so what SDK mode plans with is by construction the
// deployed manifest), and the build-file logic validates/stages plain
// {path, content} pairs for src/build-pub.js to publish.

export const CLASSES = ["C", "S", "B", "X", "D"];

/** The manifest's repo path — resolved out of the source snapshot at runtime. */
export const MANIFEST_PATH = "sdk/MANIFEST.json";

// ---- manifest operations (ported verbatim from sdk/pair-cli.mjs) -------------

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
    orderModules(m, m.modules.map((/** @type {any} */ x) => x.id));
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
  const byId = new Map(m.modules.map((/** @type {any} */ x) => [x.id, x]));
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
  const byId = new Map(m.modules.map((/** @type {any} */ x) => [x.id, x]));
  const pos = new Map(m.modules.map((/** @type {any} */ x, /** @type {number} */ i) => [x.id, i]));
  const done = new Set();
  /** @type {any[]} */
  const out = [];
  const visiting = new Set();
  /** @param {string} id */
  const visit = (id) => {
    if (done.has(id) || !want.has(id)) return;
    if (visiting.has(id)) throw new Error(`dependency cycle through ${id}`);
    visiting.add(id);
    const deps = (byId.get(id).deps || []).filter((/** @type {string} */ d) => want.has(d));
    deps.sort((/** @type {string} */ a, /** @type {string} */ b) => (byId.get(a).layer - byId.get(b).layer) || (pos.get(a) - pos.get(b)));
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

// ---- rendering (plain text — terminal, VM, and tool-result friendly) ---------

/** @param {any} m @returns {string} */
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

/** @param {any} m @param {string} id @returns {string} */
export function renderShow(m, id) {
  const mod = m.modules.find((/** @type {any} */ x) => x.id === id);
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

/** @param {any} m @param {string[]} selection @returns {string} */
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

// ---- the manifest out of the committed source snapshot -----------------------

/**
 * Parse sdk/MANIFEST.json out of a source snapshot ({files:[{p,s,t}]}) — the
 * same committed artifact introspection mode runs on, so SDK mode plans with
 * by construction the deployed manifest. Null (never a throw) when the file is
 * missing or unparsable.
 * @param {{ files?: Array<{p: string, t: string}> } | null | undefined} snapshot
 * @returns {any | null}
 */
export function manifestFromSnapshot(snapshot) {
  try {
    const f = (snapshot?.files || []).find((x) => x.p === MANIFEST_PATH);
    if (!f || typeof f.t !== "string") return null;
    const m = JSON.parse(f.t);
    return m && Array.isArray(m.modules) ? m : null;
  } catch {
    return null;
  }
}

/**
 * A validateManifest fileCheck backed by the snapshot's file list — so
 * sdk_validate can verify every skill file exists in the deployed artifact.
 * @param {{ files?: Array<{p: string}> } | null | undefined} snapshot
 * @returns {(path: string) => boolean}
 */
export function snapshotFileCheck(snapshot) {
  const paths = new Set((snapshot?.files || []).map((f) => f.p));
  return (p) => paths.has(p);
}

// ---- generated-app ("build") file staging ------------------------------------

// A build is a small, self-contained collection of static text files the model
// writes and src/build-pub.js publishes under /build/<slug>/. The caps bound
// what one conversation can stage; the path rules make a staged path safe to
// use verbatim as an R2 key segment and a URL path (no traversal, no absolute
// paths, no dotfiles, extension allowlist — text formats only, no binaries).
export const MAX_BUILD_FILES = 40;
export const MAX_BUILD_FILE_BYTES = 400_000;
export const MAX_BUILD_TOTAL_BYTES = 2_000_000;
export const MAX_BUILD_PATH_CHARS = 120;
export const BUILD_FILE_EXTS = new Set([
  "html", "css", "js", "mjs", "json", "svg", "md", "txt", "csv", "tsv", "xml", "webmanifest",
]);

/**
 * Normalize + validate one build file path. Returns the clean repo-relative
 * path, or null when the path is unusable (traversal, absolute, dotfile,
 * illegal characters, disallowed extension).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeBuildPath(raw) {
  if (typeof raw !== "string") return null;
  let p = raw.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.startsWith("/") || p.length > MAX_BUILD_PATH_CHARS) return null;
  const segments = p.split("/");
  if (segments.length > 6) return null;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".")) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return null;
  }
  const name = segments[segments.length - 1];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (!BUILD_FILE_EXTS.has(ext)) return null;
  return p;
}

/**
 * Stage one file into the build (a Map path → content), enforcing the path
 * rules and the size caps. Returns {ok:true, path} or {ok:false, error} — the
 * error string doubles as the tool result the model sees, so it says exactly
 * what to fix. Overwriting an already-staged path is allowed (iteration).
 * @param {Map<string, string>} staged
 * @param {unknown} rawPath
 * @param {unknown} rawContent
 * @returns {{ ok: true, path: string, bytes: number } | { ok: false, error: string }}
 */
export function stageBuildFile(staged, rawPath, rawContent) {
  const path = sanitizeBuildPath(rawPath);
  if (!path) {
    return {
      ok: false,
      error:
        `Invalid path ${JSON.stringify(String(rawPath ?? ""))}: use a relative path of [A-Za-z0-9._-] segments ` +
        `(no leading /, no .., no dotfiles) ending in one of: ${[...BUILD_FILE_EXTS].join(", ")}.`,
    };
  }
  const content = typeof rawContent === "string" ? rawContent : null;
  if (content === null) return { ok: false, error: "write_file needs a string `content`." };
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > MAX_BUILD_FILE_BYTES) {
    return { ok: false, error: `File too large (${bytes} bytes; the cap is ${MAX_BUILD_FILE_BYTES}). Split or shrink it.` };
  }
  if (!staged.has(path) && staged.size >= MAX_BUILD_FILES) {
    return { ok: false, error: `Build already holds ${MAX_BUILD_FILES} files — the cap. Reuse or replace existing paths.` };
  }
  let total = bytes;
  for (const [p, c] of staged) if (p !== path) total += new TextEncoder().encode(c).length;
  if (total > MAX_BUILD_TOTAL_BYTES) {
    return { ok: false, error: `Build would exceed the total size cap (${MAX_BUILD_TOTAL_BYTES} bytes). Shrink the files.` };
  }
  staged.set(path, content);
  return { ok: true, path, bytes };
}

/**
 * Slug fragment from a title: lowercase words joined by hyphens, bounded.
 * (The publish layer appends a random suffix for uniqueness.)
 * @param {unknown} title
 * @returns {string}
 */
export function slugify(title) {
  return String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// The deterministic no-function-calling convention (CLAUDE.md invariant 1's
// default path): a model without native tool use emits each file as a line
//   FILE: path/to/file.ext
// followed by ONE fenced code block with the file's full content. Parsed
// fail-soft: unusable paths are skipped, later duplicates win (iteration).
const FILE_BLOCK_RE = /(?:^|\n)FILE:[ \t]*([^\n]+)\n+```[^\n]*\n([\s\S]*?)\n```/g;

/**
 * Parse FILE blocks out of a model's text reply.
 * @param {string} text
 * @returns {Array<{ path: string, content: string }>}
 */
export function parseFileBlocks(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (typeof text !== "string" || !text) return [];
  FILE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = FILE_BLOCK_RE.exec(text))) {
    const path = sanitizeBuildPath(m[1]);
    if (path) out.set(path, m[2]);
  }
  return [...out].map(([path, content]) => ({ path, content }));
}

// ---- SDK-mode native tools ----------------------------------------------------

// The provider-neutral tool definitions ({name, description, input_schema} —
// the INTROSPECTION_TOOLS shape). SDK_TOOLS are pure manifest operations (the
// MCP server exposes them too, so agents don't have to shell into the sandbox
// to run pair-cli); BUILD_TOOLS stage and publish the generated app and are
// executed by the pipeline (they need R2).
export const SDK_TOOLS = [
  {
    name: "sdk_list_modules",
    description:
      "List DistillSDK's module catalog (sdk/MANIFEST.json) grouped by layer — every buildable module with its id, capability class (C/S/B/X/D), and name. The same output as `node sdk/pair-cli.mjs list`, no shell needed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sdk_show_module",
    description:
      "Show one SDK module's full manifest entry: layer, class, dependencies, its skill path (readable with read_file), what it provides, reference files, and its acceptance criteria. Like `node sdk/pair-cli.mjs show <id>`.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "The module id, e.g. 'baseplate-client'." } },
      required: ["id"],
    },
  },
  {
    name: "sdk_plan",
    description:
      "Compute the build plan for a selection of SDK modules: closes the selection over dependencies (baseplate always included) and returns the numbered build order with each module's skill path and acceptance criteria. Like `node sdk/pair-cli.mjs plan <id...>`.",
    input_schema: {
      type: "object",
      properties: {
        modules: { type: "array", items: { type: "string" }, description: "Module ids to build." },
      },
      required: ["modules"],
    },
  },
  {
    name: "sdk_validate",
    description:
      "Validate the SDK manifest's integrity: unique ids, resolvable deps, legal classes/layers, the class-C rule (client-pure never depends on server-backed), and that every module's skill file exists in the deployed snapshot. Like `node sdk/pair-cli.mjs validate`.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export const BUILD_TOOLS = [
  {
    name: "write_file",
    description:
      "Stage one file of the app you are building. Give a relative path (e.g. index.html, css/app.css, js/app.js) and the file's FULL content. Re-writing a path replaces it. The collection is published as a static site, so make it self-contained (no external CDNs) and include an index.html entry point.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path; text formats only (html/css/js/json/svg/md/…)." },
        content: { type: "string", description: "The complete file content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "publish_app",
    description:
      "Publish every staged file as a live static site and get its public URL back. Call ONCE, after all write_file calls. `title` names the build; the URL is returned as `/build/<slug>/`. When the conversation already has a published build, the same slug is reused so the URL stays stable across iterations.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short human title for the build." },
      },
      required: ["title"],
    },
  },
];

/**
 * Execute one pure SDK tool against a manifest. Returns the result STRING the
 * model sees; never throws. write_file/publish_app are NOT handled here — they
 * carry state/IO and are executed at the pipeline/MCP call site.
 * @param {any | null} manifest
 * @param {string} name
 * @param {any} input
 * @param {{ fileCheck?: (path: string) => boolean }} [opts]
 * @returns {string}
 */
export function runSdkTool(manifest, name, input, opts = {}) {
  try {
    if (!manifest) return "The SDK manifest (sdk/MANIFEST.json) is unavailable in this deployment.";
    switch (name) {
      case "sdk_list_modules":
        return renderList(manifest);
      case "sdk_show_module":
        return renderShow(manifest, String(input?.id || ""));
      case "sdk_plan": {
        const sel = (Array.isArray(input?.modules) ? input.modules : [])
          .filter((/** @type {any} */ x) => typeof x === "string" && x.trim())
          .slice(0, 40);
        if (!sel.length) return "sdk_plan needs a non-empty `modules` array of module ids (see sdk_list_modules).";
        try {
          return renderPlan(manifest, sel);
        } catch (/** @type {any} */ err) {
          return `Cannot plan: ${err?.message || String(err)}`;
        }
      }
      case "sdk_validate": {
        const problems = validateManifest(manifest, opts.fileCheck);
        return problems.length
          ? problems.map((p) => `PROBLEM: ${p}`).join("\n")
          : `OK: ${manifest.modules.length} modules, deps + class rules hold${opts.fileCheck ? ", all skill files present" : ""}.`;
      }
      default:
        return `Unknown SDK tool "${name}".`;
    }
  } catch (/** @type {any} */ err) {
    return `Tool "${name}" failed: ${err?.message || String(err)}`;
  }
}

/** The SDK/build tool names, for dispatch tests and step labeling. */
export const SDK_TOOL_NAMES = new Set(SDK_TOOLS.map((t) => t.name));
export const BUILD_TOOL_NAMES = new Set(BUILD_TOOLS.map((t) => t.name));

/**
 * Activity headline for an SDK/build tool call (the toolStepHeadline
 * companion — introspection tools keep their own).
 * @param {string} name
 * @param {any} input
 * @returns {string}
 */
export function sdkToolStepHeadline(name, input) {
  if (name === "sdk_list_modules") return "sdk list";
  if (name === "sdk_show_module") return `sdk show  ${String(input?.id ?? "")}`;
  if (name === "sdk_plan") {
    const mods = Array.isArray(input?.modules) ? input.modules : [];
    return `sdk plan  ${mods.slice(0, 4).join(", ")}${mods.length > 4 ? " …" : ""}`;
  }
  if (name === "sdk_validate") return "sdk validate";
  if (name === "write_file") return `write_file  ${String(input?.path ?? "")}`;
  if (name === "publish_app") return `publish_app  "${String(input?.title ?? "").slice(0, 60)}"`;
  return String(name || "tool");
}

/**
 * One line per staged file (path + byte size) for step details / logs.
 * @param {Iterable<[string, string]> | Array<{ path: string, content: string }>} files
 * @returns {string[]}
 */
export function buildFilesSummary(files) {
  /** @type {string[]} */
  const lines = [];
  for (const f of files) {
    const path = Array.isArray(f) ? f[0] : f.path;
    const content = Array.isArray(f) ? f[1] : f.content;
    lines.push(`${path} (${new TextEncoder().encode(content).length} bytes)`);
  }
  return lines;
}

/**
 * The deployed Se/cure source files SDK mode points a build at as the original
 * to distill: the client-side, never-cloud research tier and its skill playbook.
 * DistillSDK is meant to be used WITH the actual site's source — especially
 * Se/cure, which the project can regenerate and redeploy as new flavours.
 */
export const SECURE_SOURCE_REFS = [
  "public/cure/index.html",
  "public/cure/drc.js",
  "public/cure/drc.css",
  "public/js/drc-core.js",
  "public/js/drc-providers.js",
  "public/js/drc-research.js",
  "public/js/drc-store.js",
  "public/js/drc-rag.js",
  "sdk/skills/secure-tier/SKILL.md",
];

/**
 * The SDK-mode context block appended to the conversation (the introspection-
 * block pattern): orients ANY answer model — tool-capable or not — about what
 * SDK mode IS (distilling the original site, especially the client-side Se/cure
 * tier, into a new FLAVOUR published lovable-style), the DistillSDK catalog and
 * where its skills live, the deployed Se/cure source to study, the privacy
 * invariants a Se/cure-derived flavour must uphold, and (for the deterministic
 * path) the FILE-block emission convention.
 * @param {any | null} manifest
 * @param {{ toolMode?: boolean, buildUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildSdkContextBlock(manifest, opts = {}) {
  const parts = [
    "SDK mode: DistillSDK — distill this site into a new flavour",
    "=".repeat(66),
    "The user is in SDK mode: they want you to DESIGN AND BUILD a runnable collection of files, published at a live URL, by DISTILLING this site into a new FLAVOUR. DistillSDK (sdk/ in this repo) is the method: it describes this site's Se/cure + Se/rver pair as 33 buildable modules, each with a skill playbook (sdk/skills/<id>/SKILL.md) you can read for implementation guidance. The site itself — above all the client-side Se/cure tier — is the original you distill from.",
    "",
    "The Se/cure tier (the original most flavours distill from): a fully client-side research assistant. The server is in NO data path — the browser talks to LLM/search providers DIRECTLY using the user's own API keys, the research pipeline runs in the page, and any state stays browser-local. Its deployed reference source:",
    SECURE_SOURCE_REFS.map((p) => `  - ${p}`).join("\n"),
    "",
    "PRIVACY INVARIANTS a Se/cure-derived flavour MUST uphold (this is the point of Se/cure — do not weaken them): no server round-trip for conversation content; provider calls go browser→provider directly; secrets (API keys) live only in memory/this device and never appear in any log or third-party request; outbound requests to third parties carry the minimum (a query, a coordinate) — never the conversation or identity. State the privacy posture of what you built, plainly, in the reply.",
  ];
  if (manifest) {
    parts.push("", "DistillSDK module catalog (sdk/MANIFEST.json) — use it to STRUCTURE the flavour:", renderList(manifest));
  } else {
    parts.push("", "(The DistillSDK manifest could not be loaded from the deployed snapshot — distill from the Se/cure source and describe the build honestly without it.)");
  }
  parts.push(
    "",
    "FLAVOUR: distill freely — a minimal single-purpose research client, a themed or domain-specific variant, a stripped-down single-file build, a different UI entirely. Study the Se/cure source and the relevant SDK modules/skills for HOW the tier does browser-direct calls and its pipeline, then build YOUR flavour; you need not copy the source verbatim. For requests that go beyond the SDK's scope, still build them well — the SDK guides, it never blocks.",
  );
  if (opts.buildUrl) {
    parts.push("", `This conversation already published a build at ${opts.buildUrl} — iterate on it (republishing keeps the same URL).`);
  }
  if (opts.toolMode) {
    parts.push("", "Plan with the sdk_* tools, read the relevant sdk/skills/<id>/SKILL.md playbooks and the Se/cure reference source with grep_source / read_file / list_files before building; stage each file with write_file; publish_app ONCE.");
  } else {
    parts.push(
      "",
      "To ship files WITHOUT native tools, emit each file in your reply exactly as:",
      "FILE: index.html",
      "```html",
      "…the complete file content…",
      "```",
      "One FILE line + one fenced block per file; relative paths; always include index.html. The build runs in a sandboxed opaque origin (no cookies/storage-with-origin/credentialed requests) — use in-memory state. The server collects the blocks, publishes them, and shares the live URL.",
    );
  }
  return parts.join("\n");
}

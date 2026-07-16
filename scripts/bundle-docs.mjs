#!/usr/bin/env node
// The HELP layer's documentation-corpus bundler (see the **help-docs** skill;
// the sibling of scripts/bundle-source.mjs). Walks the repo's git-TRACKED
// Markdown documentation — the root docs (README.md, CLAUDE.md, FEATURES.md,
// SECURITY-RISKS.md, SECURITY-ASSESSMENT.md, AGENTS.md) plus docs/*.md — and
// writes ONE deterministic committed artifact:
//
//   public/introspect/docs-corpus.json
//
// It is SNAPSHOT-SHAPED on purpose ({ v, digest, count, bytes, files:
// [{p,s,t}] }, the owasp-corpus.json precedent) so it reuses the introspection
// machinery verbatim: validateSnapshot, the deterministic chunker
// (introspect-core.js chunkSourceText), the int8 index format
// (scripts/bundle-docs-rag.mjs → docs-rag.json) and retrieveSourceChunks.
// Three help-specific extras ride alongside `files`:
//
//   - `sources`  {docPath: {title}} — each doc's human title (first heading),
//     for attribution lines in the injected block.
//   - `symbols`  {docPath: [{sym, file, line?}]} — every code symbol the doc
//     shows in backticks, RESOLVED against the real source tree: file paths
//     verified to exist, bare identifiers located at their definition site
//     (export/function/const/class). This is what lets a help answer attach a
//     provable source reference link to each symbol it quotes from the docs.
//   - `repo` — the GitHub blob base URL, so those references can be rendered
//     as clickable links (the repo is public).
//
// IMAGES: docs embed images with relative paths (docs/ENCRYPTION.md →
// img/encryption/*.png) that are NOT served by the site. The bundler copies
// every referenced local image into public/introspect/docs-img/<repo path>
// (served with the deploy, publicly allowlisted) and REWRITES the reference in
// the corpus copy of the text to that absolute URL — so an answer that quotes
// the documentation verbatim, image line and italic caption included, renders
// the actual image in the chat (markdown.js allows same-origin /introspect/
// docs-img/ images specifically for this).
//
// Determinism: docs sorted by path, no timestamp — regenerating from an
// unchanged tree is byte-identical, so `--check` (run by the unit suite,
// src/introspect.test.js) enforces freshness: edit any bundled doc → `npm run
// bundle:docs` (and `npm run bundle:docs-rag`) or `npm test` fails.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "public/introspect/docs-corpus.json";
const IMG_DIR = "public/introspect/docs-img";
const IMG_URL_BASE = "/introspect/docs-img";

// The documentation set: root Markdown + docs/*.md (top level). MERGED-BRANCHES
// is a branch-reconciliation ledger, not documentation; the skills
// (.claude/skills) already ride in the source snapshot's first-class catalog.
const DOC_INCLUDE = [/^[^/]+\.md$/, /^docs\/[^/]+\.md$/];
const DOC_EXCLUDE = [/^docs\/MERGED-BRANCHES\.md$/];

// Where bare-identifier symbols are looked up (definition sites).
const CODE_FILE_RE = /^(src|public\/js|public\/cure|scripts)\/.+\.(m?js)$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const PER_IMAGE_MAX = 2 * 1024 * 1024; // an embedded doc image larger than this is skipped
const MAX_SYMBOLS_PER_DOC = 48;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/** The GitHub blob base for symbol links, derived from the origin remote
 *  ("…/kristerhedfors/Deepresearch.se[.git]" → the public github.com URL). */
function repoBlobBase() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = url.replace(/\.git$/, "").match(/([\w.-]+)\/([\w.-]+)$/);
    if (m) return `https://github.com/${m[1]}/${m[2]}/blob/main/`;
  } catch {
    // fall through to the fixed default
  }
  return "https://github.com/kristerhedfors/Deepresearch.se/blob/main/";
}

/** First Markdown heading = the doc's human title (path stem as fallback). */
function docTitle(path, text) {
  const m = String(text || "").match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].replace(/[*_`]/g, "").trim();
  return path.replace(/^.*\//, "").replace(/\.md$/i, "");
}

// ---- symbol extraction + resolution -------------------------------------------

const BACKTICK_RE = /`([^`\n]{2,120})`/g;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
// Generic words that appear in backticks without naming a project symbol.
const SYMBOL_STOP = new Set([
  "true", "false", "null", "undefined", "string", "number", "boolean", "object", "async", "await",
  "function", "const", "let", "var", "class", "return", "import", "export", "default", "json",
  "http", "https", "get", "post", "put", "patch", "delete", "options", "main", "master", "npm",
  // Generic property/variable names that appear in backticks without naming ONE
  // project symbol — resolving these to an arbitrary definition site would make
  // misleading references.
  "name", "id", "label", "title", "status", "value", "text", "type", "key", "path", "file",
  "line", "description", "active", "enabled", "disabled", "count", "size", "data", "error",
  "message", "query", "config", "state", "user", "users", "admin", "model", "models",
]);

/**
 * A definition-site index over the source tree: identifier → [{file, line}].
 * One pass over the code files, deterministic (sorted paths, first hits kept).
 */
function buildDefinitionIndex(paths) {
  const DEF_RES = [
    (name) => new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function|const|class|let)\\s+${name}\\b`),
    (name) => new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`),
    (name) => new RegExp(`^\\s*(?:const|class|let)\\s+${name}\\b\\s*[=({]`),
    (name) => new RegExp(`^\\s*export\\s+\\{[^}]*\\b${name}\\b`),
  ];
  const files = paths
    .filter((p) => CODE_FILE_RE.test(p))
    .sort()
    .map((p) => ({ p, lines: readFileSync(join(ROOT, p), "utf8").split("\n") }));
  /** @type {Map<string, Array<{file: string, line: number}>>} */
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const hits = [];
    outer: for (const tier of DEF_RES) {
      const re = tier(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      for (const f of files) {
        for (let i = 0; i < f.lines.length; i++) {
          if (!re.test(f.lines[i])) continue;
          if (!hits.some((h) => h.file === f.p)) hits.push({ file: f.p, line: i + 1 });
          if (hits.length >= 2) break outer;
        }
      }
      if (hits.length) break; // a stronger tier resolved it — don't dilute with weaker matches
    }
    cache.set(name, hits);
    return hits;
  };
}

/**
 * The symbol references ONE doc shows in backticks, resolved against the real
 * tree: tracked file paths as-is; bare identifiers via the definition index.
 * Appearance order, deduped, capped.
 */
function docSymbols(text, trackedSet, findDefs) {
  const out = [];
  const seen = new Set();
  let m;
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(text)) && out.length < MAX_SYMBOLS_PER_DOC) {
    const raw = m[1].trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    // Path-like: an exact tracked file (allow a leading ./ and a trailing slash-less form).
    const asPath = raw.replace(/^\.\//, "");
    if (trackedSet.has(asPath)) {
      out.push({ sym: raw, file: asPath });
      continue;
    }
    // Bare identifier: resolve to its definition site(s).
    if (IDENTIFIER_RE.test(raw) && raw.length >= 3 && !SYMBOL_STOP.has(raw.toLowerCase())) {
      for (const d of findDefs(raw)) out.push({ sym: raw, file: d.file, line: d.line });
    }
  }
  return out.slice(0, MAX_SYMBOLS_PER_DOC);
}

// ---- image collection + reference rewriting -------------------------------------

const MD_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const HTML_IMG_RE = /(<img\b[^>]*\bsrc=")([^"]+)(")/gi;

/**
 * Resolve a doc's relative image reference to a repo path ("img/x.png" in
 * docs/ENCRYPTION.md → "docs/img/x.png"). Null for absolute/external/data refs.
 */
function resolveImageRef(docPath, ref) {
  const r = String(ref || "").trim();
  if (!r || /^(?:https?:)?\/\//i.test(r) || r.startsWith("data:") || r.startsWith("/")) return null;
  const dir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  const parts = (dir ? dir + "/" + r : r).split("/");
  const resolved = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

/**
 * Rewrite ONE doc's local image references to their served /introspect/docs-img
 * URLs, collecting the repo paths of the images to copy. Only tracked,
 * size-capped raster/vector files are rewritten; anything else is left as-is.
 */
function rewriteImages(docPath, text, trackedSet, wanted) {
  const rewriteRef = (ref) => {
    const repoPath = resolveImageRef(docPath, ref);
    if (!repoPath || !IMAGE_EXT_RE.test(repoPath) || !trackedSet.has(repoPath)) return null;
    const buf = readFileSync(join(ROOT, repoPath));
    if (buf.length > PER_IMAGE_MAX) return null;
    wanted.set(repoPath, buf);
    return `${IMG_URL_BASE}/${repoPath}`;
  };
  return text
    .replace(MD_IMG_RE, (all, pre, ref, post) => {
      const url = rewriteRef(ref);
      return url ? pre + url + post : all;
    })
    .replace(HTML_IMG_RE, (all, pre, ref, post) => {
      const url = rewriteRef(ref);
      return url ? pre + url + post : all;
    });
}

// ---- build -----------------------------------------------------------------------

export function buildDocsCorpus() {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const findDefs = buildDefinitionIndex(tracked);
  const docPaths = tracked
    .filter((p) => DOC_INCLUDE.some((re) => re.test(p)))
    .filter((p) => !DOC_EXCLUDE.some((re) => re.test(p)))
    .sort();

  const files = [];
  const sources = {};
  const symbols = {};
  /** @type {Map<string, Buffer>} images to copy: repo path → bytes */
  const wanted = new Map();
  let bytes = 0;
  const hash = createHash("sha256");
  for (const p of docPaths) {
    const raw = readFileSync(join(ROOT, p), "utf8");
    const text = rewriteImages(p, raw, trackedSet, wanted);
    const size = Buffer.byteLength(text, "utf8");
    files.push({ p, s: size, t: text });
    bytes += size;
    sources[p] = { title: docTitle(p, text) };
    const syms = docSymbols(text, trackedSet, findDefs);
    if (syms.length) symbols[p] = syms;
    hash.update(p);
    hash.update("\0");
    hash.update(text);
  }
  const digest = hash.digest("hex");
  const head = JSON.stringify({ v: 1, digest, count: files.length, bytes, repo: repoBlobBase() });
  const lines = files.map((f) => JSON.stringify(f));
  const json =
    head.slice(0, -1) +
    ',"files":[\n' +
    lines.join(",\n") +
    "\n]," +
    `"sources":${JSON.stringify(sources)},` +
    `"symbols":${JSON.stringify(symbols)}}\n`;
  return { json, images: wanted };
}

function main() {
  const check = process.argv.includes("--check");
  const { json, images } = buildDocsCorpus();
  const outPath = join(ROOT, OUT);
  if (check) {
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    let stale = current !== json;
    for (const [repoPath, buf] of images) {
      const copy = join(ROOT, IMG_DIR, repoPath);
      if (!existsSync(copy) || !readFileSync(copy).equals(buf)) stale = true;
    }
    if (stale) {
      console.error(
        `STALE: ${OUT} (or a copied doc image) does not match the working tree.\n` +
          "Re-run `npm run bundle:docs` (node scripts/bundle-docs.mjs) and commit the result.",
      );
      process.exit(1);
    }
    console.log(`${OUT} is up to date.`);
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  for (const [repoPath, buf] of images) {
    const copy = join(ROOT, IMG_DIR, repoPath);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, buf);
  }
  const parsed = JSON.parse(json);
  console.log(
    `Wrote ${OUT}: ${parsed.count} docs, ${parsed.bytes} bytes, ` +
      `${Object.values(parsed.symbols).reduce((n, a) => n + a.length, 0)} symbol refs, ` +
      `${images.size} images → ${IMG_DIR}/, digest ${parsed.digest.slice(0, 12)}…`,
  );
}

main();

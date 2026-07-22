// Builds public/introspect/docs-corpus-clean.json — the de-smelled REVIEW
// CANDIDATES that the /docs viewer shows opposite the originals in
// docs-corpus.json. One entry per file under docs/clean/, keyed by the
// ORIGINAL doc's repo path so the viewer can pair them:
//   docs/clean/README.md      -> README.md
//   docs/clean/ARCHITECTURE.md -> docs/ARCHITECTURE.md
//
// Doc image refs are rewritten to their served /introspect/docs-img/ URLs
// (same mapping as bundle-docs.mjs), reusing the images that bundle:docs
// already copied — so run `npm run bundle:docs` first if images changed.
//
// Run: node scripts/bundle-docs-clean.mjs   (npm run bundle:docs-clean)
// Freshness is NOT test-enforced — these are candidates the owner reviews via
// the toggle, not authoritative docs. Re-run after editing docs/clean/*.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLEAN_DIR = "docs/clean";
const OUT = "public/introspect/docs-corpus-clean.json";
const IMG_DIR = "public/introspect/docs-img";
const IMG_URL_BASE = "/introspect/docs-img";

const MD_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const HTML_IMG_RE = /(<img\b[^>]*\bsrc=")([^"]+)(")/gi;

/** Map a docs/clean/<name>.md file to the original doc's repo path. */
function originalPath(name) {
  return name === "README.md" ? "README.md" : `docs/${name}`;
}

/** Resolve "img/x.png" in docs/ENCRYPTION.md to repo path "docs/img/x.png". */
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

/** Rewrite image refs to /introspect/docs-img URLs when the copied file exists. */
function rewriteImages(docPath, text) {
  const rewriteRef = (ref) => {
    const repoPath = resolveImageRef(docPath, ref);
    if (!repoPath || !existsSync(join(IMG_DIR, repoPath))) return null;
    return `${IMG_URL_BASE}/${repoPath}`;
  };
  return text
    .replace(MD_IMG_RE, (all, pre, ref, post) => { const u = rewriteRef(ref); return u ? pre + u + post : all; })
    .replace(HTML_IMG_RE, (all, pre, ref, post) => { const u = rewriteRef(ref); return u ? pre + u + post : all; });
}

function build() {
  if (!existsSync(CLEAN_DIR)) {
    console.error(`${CLEAN_DIR}/ does not exist — nothing to bundle.`);
    process.exit(1);
  }
  const names = readdirSync(CLEAN_DIR).filter((n) => n.endsWith(".md")).sort();
  const files = [];
  for (const name of names) {
    const p = originalPath(name);
    const text = rewriteImages(p, readFileSync(join(CLEAN_DIR, name), "utf8"));
    files.push({ p, s: Buffer.byteLength(text, "utf8"), t: text });
  }
  const json = { v: 1, count: files.length, files };
  writeFileSync(OUT, JSON.stringify(json));
  console.log(`Wrote ${OUT}: ${files.length} cleaned docs, ${Buffer.byteLength(JSON.stringify(json))} bytes`);
}

build();

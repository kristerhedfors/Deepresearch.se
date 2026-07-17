// Build a point-in-time "code size" snapshot for the Project pulse dashboard:
// lines/chars per language, the README's own size, and dependency counts.
//
//   node scripts/build-pulse-size.mjs      # update public/pulse/size.json
//   npm run pulse:size                      # same, via package.json
//
// Unlike data.json (git history, one row per commit), this is a snapshot of
// the CURRENT working tree — `git ls-files` so only tracked, non-ignored
// files are counted. Committed generated/vendored artifacts are excluded
// from the line/char counts (same rationale as build-pulse.mjs's GENERATED
// list: a bundle regeneration shouldn't look like a wall of hand-written
// code), though they still count as files. Binary/image/audio/video/font
// files are counted as files but have no line/char metric (undefined, not
// zero — the page renders them as file-count-only rows).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "pulse", "size.json");

// Same exclusion rationale as build-pulse.mjs's GENERATED list: committed
// artifacts a bundler rewrites wholesale, not hand-written source.
const GENERATED = [
  /^public\/introspect\/source-snapshot\.json$/,
  /^public\/introspect\/source-rag\.json$/,
  /^public\/introspect\/docs-corpus\.json$/,
  /^public\/introspect\/docs-rag\.json$/,
  /^public\/pulse\/data\.json$/,
  /^public\/pulse\/timeline\.json$/,
  /^public\/pulse\/size\.json$/,
  /^public\/vendor\//,
  /\.min\.(js|css)$/,
  /(^|\/)package-lock\.json$/,
  /\.lock$/,
];

// Extensions with no meaningful text-line count (images, audio/video, fonts,
// compiled binaries, diagram source that isn't line-oriented text).
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".mp4", ".mov", ".wasm",
  ".woff", ".woff2", ".ttf", ".eot", ".drawio", ".pdf",
]);

// Extension → display label for the language breakdown. Anything not listed
// falls back to the bare extension (uppercased) so nothing is silently lost.
const LANG_LABEL = {
  js: "JavaScript", mjs: "JavaScript", ts: "TypeScript",
  html: "HTML", css: "CSS", json: "JSON", webmanifest: "JSON",
  md: "Markdown", sh: "Shell", py: "Python", toml: "TOML",
  yml: "YAML", yaml: "YAML",
};

/** @param {string} path @returns {boolean} */
function isGenerated(path) {
  return GENERATED.some((re) => re.test(path));
}

function listTrackedFiles() {
  const raw = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return raw.split("\n").filter(Boolean);
}

function countRuntimeDeps(pkgPath) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return {
      dependencies: Object.keys(pkg.dependencies || {}).length,
      devDependencies: Object.keys(pkg.devDependencies || {}).length,
    };
  } catch {
    return { dependencies: 0, devDependencies: 0 };
  }
}

function main() {
  const files = listTrackedFiles();
  // Keyed by LABEL, not extension, so js/mjs both roll up under "JavaScript".
  /** @type {Record<string, { label: string, exts: Set<string>, files: number, lines: number, chars: number }>} */
  const byLang = {};
  let totalFiles = 0, totalLines = 0, totalChars = 0, generatedExcluded = 0;
  let readme = null;

  for (const rel of files) {
    totalFiles += 1;
    const ext = extname(rel).slice(1).toLowerCase();
    const excluded = isGenerated(rel);
    if (excluded) generatedExcluded += 1;

    let lines = 0, chars = 0, isText = !BINARY_EXT.has(extname(rel).toLowerCase());
    if (isText && !excluded) {
      let stat;
      try { stat = statSync(join(ROOT, rel)); } catch { continue; }
      if (stat.size > 8 * 1024 * 1024) { isText = false; } // guard against stray huge text blobs
      else {
        let content;
        try { content = readFileSync(join(ROOT, rel), "utf8"); } catch { isText = false; content = ""; }
        if (isText) {
          if (content.includes("\0")) { isText = false; } // binary despite extension
          else {
            chars = content.length;
            lines = content.length ? content.split("\n").length : 0;
          }
        }
      }
    }

    if (isText && !excluded) {
      const label = LANG_LABEL[ext] || (ext ? ext.toUpperCase() : "Other");
      const bucket = (byLang[label] ||= { label, exts: new Set(), files: 0, lines: 0, chars: 0 });
      bucket.exts.add(ext || "(none)");
      bucket.files += 1; bucket.lines += lines; bucket.chars += chars;
      totalLines += lines; totalChars += chars;
    }

    if (basename(rel).toLowerCase() === "readme.md" && !readme) {
      const content = readFileSync(join(ROOT, rel), "utf8");
      readme = {
        file: rel,
        lines: content.length ? content.split("\n").length : 0,
        chars: content.length,
        words: content.split(/\s+/).filter(Boolean).length,
      };
    }
  }

  const languages = Object.values(byLang)
    .map(({ exts, ...v }) => ({ ext: [...exts].sort().join(", "), ...v }))
    .sort((a, b) => b.lines - a.lines);

  const root = countRuntimeDeps(join(ROOT, "package.json"));
  const testsPkgPath = join(ROOT, "tests", "package.json");
  const testDeps = countRuntimeDeps(testsPkgPath);

  const data = {
    generated: new Date().toISOString(),
    totals: {
      files: totalFiles,
      lines: totalLines,
      chars: totalChars,
      languages: languages.length,
      dependencies: root.dependencies + testDeps.dependencies,
      devDependencies: root.devDependencies + testDeps.devDependencies,
    },
    dependencies: {
      root,
      tests: testDeps,
    },
    languages,
    readme,
    excluded: { generatedArtifacts: generatedExcluded },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `pulse:size: ${totalFiles} files, ${totalLines.toLocaleString("en-US")} lines across ` +
      `${languages.length} language(s), ${root.dependencies + testDeps.dependencies} runtime dep(s), ` +
      `${root.devDependencies + testDeps.devDependencies} dev dep(s) → ${OUT}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

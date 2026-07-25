// The committed-artifact SET — a repo-wide guard, in the shape of
// src/sql-injection-guard.test.js.
//
// The freshness checks live next to their subsystems (src/introspect.test.js,
// public/js/introspect-core.test.js) and each one SKIPS when its artifact is
// absent, because the rag indexes need a Berget key to re-embed and a
// contributor without one should not be blocked. That is the right call for
// freshness and the wrong one for existence: deleting an artifact turns its
// own guard green (gap A5, docs/TESTING-GAP-ANALYSIS.md).
//
// This file is the missing half. It asserts only that each artifact is
// PRESENT, TRACKED, and structurally a JSON object of a plausible size — never
// that its contents are current. A deletion or an accidental `.gitignore`
// entry fails here; a stale index still fails in the freshness tests.
//
// Adding an artifact? Add its row below in the same commit as its bundler.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// path → {min, regen} — `min` is a floor generous enough that a real edit
// never trips it but a truncated/emptied file does; `regen` is the command
// that rebuilds it, quoted verbatim in the failure message so the fix needs
// no lookup.
const ARTIFACTS = [
  { path: "public/introspect/source-snapshot.json", min: 1_000_000, regen: "npm run bundle" },
  { path: "public/introspect/source-rag.json", min: 1_000_000, regen: "npm run bundle:rag" },
  { path: "public/introspect/docs-corpus.json", min: 100_000, regen: "npm run bundle:docs" },
  { path: "public/introspect/docs-rag.json", min: 100_000, regen: "npm run bundle:docs-rag" },
  { path: "public/introspect/owasp-corpus.json", min: 50_000, regen: "npm run fetch:owasp" },
  { path: "public/introspect/owasp-rag.json", min: 50_000, regen: "npm run bundle:owasp-rag" },
];

/** Every path git knows about, as a Set (one subprocess, not one per file). */
function trackedPaths() {
  const out = execFileSync("git", ["ls-files", "-z", "public/introspect"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return new Set(out.split("\0").filter(Boolean));
}

describe("the committed introspection artifacts all exist and are tracked", () => {
  const tracked = trackedPaths();

  for (const { path, min, regen } of ARTIFACTS) {
    test(`${path} is present, tracked, and non-trivial`, () => {
      const abs = join(ROOT, path);

      assert.ok(
        existsSync(abs),
        `${path} is MISSING — the deployed site serves it, so it must be committed. Regenerate with \`${regen}\`.`,
      );

      // Present but untracked is the subtler failure: the suite goes green
      // locally and the deploy serves a 404.
      assert.ok(
        tracked.has(path),
        `${path} exists on disk but is NOT tracked by git — it would not reach the deployment. \`git add ${path}\`.`,
      );

      const { size } = statSync(abs);
      assert.ok(
        size >= min,
        `${path} is ${size} bytes, under the ${min}-byte floor — it looks truncated or emptied. Regenerate with \`${regen}\`.`,
      );

      // Cheap structural check: every artifact is a JSON object, so a
      // half-written or HTML-error-page file fails here rather than at
      // runtime in the browser.
      const parsed = JSON.parse(readFileSync(abs, "utf8"));
      assert.equal(
        typeof parsed,
        "object",
        `${path} did not parse as a JSON object. Regenerate with \`${regen}\`.`,
      );
      assert.notEqual(parsed, null, `${path} parsed as null. Regenerate with \`${regen}\`.`);
    });
  }

  // The docs corpus references images by a same-origin path under
  // docs-img/; the copies are made by bundle-docs.mjs and must be committed
  // alongside the corpus or the rendered doc shows broken images.
  test("the doc images the corpus references are committed alongside it", () => {
    const corpus = JSON.parse(readFileSync(join(ROOT, "public/introspect/docs-corpus.json"), "utf8"));
    const files = Array.isArray(corpus.files) ? corpus.files : [];
    assert.ok(files.length > 0, "docs-corpus.json carries no files — regenerate with `npm run bundle:docs`.");

    // Image refs are rewritten to the served path "/introspect/docs-img/
    // <original path>" in each doc's body (`t`). Match the Markdown image
    // syntax specifically, so the prose mentions of the directory name in
    // the help-docs documentation aren't picked up as refs.
    const refs = new Set();
    for (const f of files) {
      for (const m of String(f?.t || "").matchAll(/!\[[^\]]*\]\(\/introspect\/(docs-img\/[^)\s]+)\)/g)) {
        refs.add(m[1]);
      }
    }
    assert.ok(refs.size > 0, "no doc image references found in the corpus — the image rewrite may have broken.");

    const tracked2 = trackedPaths();
    for (const ref of refs) {
      const rel = `public/introspect/${ref}`;
      assert.ok(
        tracked2.has(rel),
        `docs-corpus.json references ${ref} but ${rel} is not tracked — re-run \`npm run bundle:docs\` and commit the docs-img/ copies.`,
      );
    }
  });
});

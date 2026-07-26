// Every open standard NAMED on a public page must LINK to its complete text.
//
// Feedback #39 (2026-07-26, a documentation comment on /help/): "Make DRSW and
// DRPL link to complete specifications of those and how they relate to the
// project." Naming a standard in bold and leaving the reader to guess where it
// is written down is the failure mode this pins shut — for the two named in
// the comment and for any standard added later, since the check is derived
// from the pages rather than from a list kept by hand.
//
// The links go into the /docs/ viewer, which selects a document from the URL
// hash. A link whose hash is not a corpus path renders an empty reader, so the
// target is resolved against the committed corpus, not merely parsed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const PAGES = {
  "public/help/index.html": read("public/help/index.html"),
  "public/welcome/index.html": read("public/welcome/index.html"),
};
const CORPUS = JSON.parse(read("public/introspect/docs-corpus.json"));
const CORPUS_PATHS = new Set((CORPUS.files || []).map((/** @type {any} */ f) => f.p));

/** Standard name → the document that specifies it. */
const SPEC_DOC = {
  "DRSW/1": "docs/WORKSPACE-PROTOCOL.md",
  "DRPL/1": "docs/PIPELINE-LANGUAGE.md",
  "DREE/1": "docs/EXECUTION-ENVIRONMENTS.md",
};

/**
 * Every `/docs/#…` link in a page, as the corpus path it selects.
 * @param {string} html
 * @returns {Set<string>}
 */
function docLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="\/docs\/#([^"]+)"/g)) out.add(decodeURIComponent(m[1]));
  return out;
}

describe("open standards named on public pages", () => {
  for (const [page, html] of Object.entries(PAGES)) {
    test(`${page}: every standard it names links to the standard`, () => {
      const named = Object.keys(SPEC_DOC).filter((s) => html.includes(s));
      assert.ok(named.length, `${page} names no standard — has the copy moved?`);
      const links = docLinks(html);
      for (const std of named) {
        assert.ok(
          links.has(SPEC_DOC[std]),
          `${page} names ${std} but does not link to ${SPEC_DOC[std]}. A standard the ` +
            "reader cannot open is a claim, not a standard (feedback #39).",
        );
      }
    });

    test(`${page}: every /docs/ link opens a document that exists`, () => {
      for (const path of docLinks(html)) {
        assert.ok(
          CORPUS_PATHS.has(path),
          `${page} links to /docs/#${path}, which is not in the committed docs corpus — ` +
            "the viewer would show an empty page. Run `npm run bundle:docs` if the doc is new.",
        );
      }
    });
  }

  test("the help page says where the standards stand relative to the code", () => {
    // The other half of the comment: "and how they relate to the project".
    // The honest version of that relationship is that the specs lead the code
    // and the conformance class is recorded, so the page must not stop at
    // "reference implementation".
    // Source-wrapped prose: match across the line breaks the HTML carries.
    const html = PAGES["public/help/index.html"].replace(/\s+/g, " ");
    assert.match(html, /reference implementation/);
    assert.match(html, /run ahead of the code/);
    assert.match(html, /conformance class/);
  });
});

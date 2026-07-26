// The self-contained static pages under public/ — /story/, /build/, and the
// rest of the promo surface — where an inline <script> looks its own markup up
// by id.
//
// Why this file exists: /story/ shipped with the `id="history"` attribute
// missing off its container div. Nothing failed loudly. getElementById returned
// null, renderMarkdownInto threw on it, and the catch handler threw again on the
// same null — so the page rendered its lead paragraph, left the "Loading…"
// placeholder in place forever, and reported nothing on screen. The whole build
// story (public/build/history.md, ~90 KB of it) was unreachable from the UI
// while every unit test stayed green, because no test looks at these pages.
//
// The guard below is deliberately dumb and repo-wide: any id an inline script
// reaches for must be findable in the same file, either as a literal attribute
// or as an element the script builds itself. It catches the typo class without
// needing a DOM.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const htmlFiles = () =>
  execFileSync("git", ["ls-files", "-z", "--", "public/*.html", "public/**/*.html"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);

/** Bodies of the page's INLINE scripts only — external modules are out of scope. */
const inlineScripts = (src) =>
  [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

describe("static pages resolve the element ids their inline scripts look up", () => {
  for (const file of htmlFiles()) {
    const src = read(file);
    const wanted = new Set(
      [...inlineScripts(src).matchAll(/getElementById\(\s*["']([\w-]+)["']\s*\)/g)].map((m) => m[1]),
    );
    if (!wanted.size) continue;

    test(file, () => {
      for (const id of wanted) {
        // Either the markup carries the attribute, or the page builds the
        // element itself (public/index.html's injected #boot-guard bar).
        const declared =
          new RegExp(`\\bid=["']${id}["']`).test(src) ||
          new RegExp(`\\.id\\s*=\\s*["']${id}["']`).test(src) ||
          new RegExp(`setAttribute\\(\\s*["']id["']\\s*,\\s*["']${id}["']`).test(src);
        assert.ok(
          declared,
          `${file}: an inline script calls getElementById("${id}") but nothing in the ` +
            `file declares that id — the lookup returns null at runtime`,
        );
      }
    });
  }
});

describe("the build story page renders public/build/history.md", () => {
  const STORY = read("public/story/index.html");
  const ASSETS = read("src/assets.js");

  test("the markup declares the #history container the renderer targets", () => {
    // Pinned as a LITERAL attribute, not just any declaration: the page also
    // rebuilds the container defensively, and that fallback must not be what
    // keeps this page working.
    assert.match(
      STORY,
      /<div id="history">/,
      'public/story/index.html must carry <div id="history"> — without it the page ' +
        'sticks on "Loading…" and the build story never renders',
    );
  });

  test("the fetched history file exists and is tracked", () => {
    const target = STORY.match(/fetch\(\s*["'](\/build\/[\w.-]+)["']/);
    assert.ok(target, "the page must fetch its history markdown from /build/");
    const rel = `public${target[1]}`;
    const tracked = execFileSync("git", ["ls-files", "--", rel], { cwd: ROOT, encoding: "utf8" });
    assert.equal(tracked.trim(), rel, `${rel} must be a tracked file`);
    // A truncated or emptied history is the other way this page goes blank.
    assert.ok(read(rel).length > 10_000, `${rel} is suspiciously small — is it truncated?`);
  });

  test("the page and its history are on the public (no-auth) surface", () => {
    // The story is linked from the landing and from /build/, both reachable by
    // signed-out visitors; a 401 on either path is the same blank page.
    for (const prefix of ["/story/", "/build/"]) {
      assert.ok(
        ASSETS.includes(`url.pathname.startsWith("${prefix}")`),
        `${prefix} must stay allowlisted in isPublicAsset`,
      );
    }
    assert.ok(
      ASSETS.includes('url.pathname === "/js/markdown.js"'),
      "the story page's renderer import must stay public",
    );
  });

  test("the error path cannot throw on its own container", () => {
    // The original catch handler assigned to el.innerHTML with el === null,
    // which is why not even the failure message appeared.
    assert.match(
      STORY,
      /\.catch\(\(err\) => \{[\s\S]*?console\.error[\s\S]*?el\.innerHTML/,
      "the fetch/render catch must log and render a visible failure message",
    );
  });
});

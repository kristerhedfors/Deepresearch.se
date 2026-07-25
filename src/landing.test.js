// The landing page (public/welcome/index.html) — the front door served at `/`.
//
// Nothing here executes the page; these are structural pins on the three
// decisions that are easy to undo by accident:
//
//  1. The ROOT serves the landing IN PLACE (no redirect). The root has flipped
//     between the landing and a 302 to /cure before; this pins the current
//     answer so the flip is a deliberate edit to this test, not a silent one.
//  2. The two data-path diagrams are SHARED FILES, referenced by both the
//     landing (the short architecture block) and /architecture/ (the full
//     story). Re-inlining an SVG into either page is exactly the drift the
//     split exists to prevent.
//  3. The page still carries what the front door is for: the promo video, the
//     stated purpose, the capability list, and the MIT/GitHub line.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const LANDING = read("public/welcome/index.html");
const ARCH = read("public/architecture/index.html");
const ROUTER = read("src/index.js");

const DIAGRAMS = ["/architecture/path-secure.svg", "/architecture/path-server.svg"];

describe("the landing page at /", () => {
  test("the root serves the landing asset in place, not a redirect", () => {
    // The unauthenticated root branch in src/index.js.
    assert.match(
      ROUTER,
      /url\.pathname === "\/" &&[\s\S]{0,120}?serveAsset\(request, env, url\.origin \+ "\/welcome\/"\)/,
      "unauthenticated GET / must serve public/welcome/ via serveAsset",
    );
    assert.doesNotMatch(
      ROUTER,
      /Location: "\/cure"/,
      "the root must not 302 to /cure — the landing is the front door",
    );
  });

  test("keeps the promo video", () => {
    assert.match(LANDING, /<video[^>]+src="\/llm-assiterad-utveckling\.mp4"/);
  });

  test("states the purpose, the capabilities, and the MIT source", () => {
    assert.match(LANDING, /privacy capabilities of LLM/);
    assert.match(LANDING, /deep-research security architecture/);
    assert.match(LANDING, /<ul class="feat">/);
    assert.match(LANDING, /github\.com\/kristerhedfors\/Deepresearch\.se/);
    assert.match(LANDING, /MIT licence/);
  });

  test("names Se/cure before Se/rver in the paired architecture block", () => {
    const secure = LANDING.indexOf("path-secure.svg");
    const server = LANDING.indexOf("path-server.svg");
    assert.ok(secure > -1 && server > -1);
    assert.ok(secure < server, "secure-first: the Se/cure diagram comes first");
  });
});

describe("the shared data-path diagrams", () => {
  for (const src of DIAGRAMS) {
    test(`${src} is a self-contained standalone SVG`, () => {
      const svg = read("public" + src);
      assert.match(svg, /<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(svg, /viewBox="0 0 420 470"/);
      // Loaded through <img>, so it cannot inherit the page's font stack.
      assert.match(svg, /<svg[^>]*\sfont-family=/);
      assert.match(svg, /<title>/, "a title element is the accessible name");
    });

    test(`${src} is referenced by BOTH the landing and /architecture/`, () => {
      assert.ok(LANDING.includes(src), `landing must reference ${src}`);
      assert.ok(ARCH.includes(src), `/architecture/ must reference ${src}`);
    });
  }

  test("neither page re-inlines a copy of a diagram", () => {
    for (const [name, html] of [["landing", LANDING], ["architecture", ARCH]]) {
      assert.doesNotMatch(
        html,
        /<svg[^>]*viewBox="0 0 420 470"/,
        `${name} inlines a data-path SVG — reference the shared file instead`,
      );
    }
  });
});

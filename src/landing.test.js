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
//  4. The first-visit overlay INTRODUCES the site before it contrasts what the
//     site does and doesn't do, and stays short (feedback #32 — the overlay
//     opens over an unread page, so a does/doesn't with no subject lands on
//     nothing).
//  5. The feature-focus timeline card sits under the video, and BOTH it and
//     /pulse/timeline.html draw through the shared pure core rather than
//     carrying their own copy of the bucketing maths.
//  6. That card draws the code-volume backdrop BEHIND the curves, on its own
//     right-hand scale — the two series carry different units and must not
//     end up sharing one axis.

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
const TIMELINE = read("public/pulse/timeline.html");

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

  test("the capability list names the open Hugging Face catalog", () => {
    // Added 2026-07-27. Before it, the ONLY Hugging Face mention a visitor met
    // was Hub *search*, listed among the enrichment integrations — which read
    // as "we can look models up", not "we can run them". The Models agent made
    // the second true, so the front door has to say it.
    const FEAT = LANDING.slice(LANDING.indexOf('<ul class="feat">'), LANDING.indexOf("</ul>", LANDING.indexOf('<ul class="feat">')));
    assert.match(FEAT, /Hugging Face/, "the capability list must name Hugging Face as a model provider");
    assert.match(FEAT, /Models agent/, "…and say what promotes a model out of that open catalog");
  });

  test("the architecture diagrams' alt text matches the providers they draw", () => {
    // The alt text is the diagram for anyone who cannot see it, and it drifted
    // silently for as long as it named Groq — a provider the SVG stopped
    // drawing. Pin both directions on both tiers.
    const secureAlt = /alt="The Se\/cure data path:[^"]*"/.exec(LANDING)?.[0] || "";
    const serverAlt = /alt="The Se\/rver data path:[^"]*"/.exec(LANDING)?.[0] || "";
    assert.match(secureAlt, /Hugging Face/, "the Se/cure alt text names the drawn providers");
    assert.doesNotMatch(secureAlt, /Groq/, "…and not one the diagram no longer draws");
    assert.match(serverAlt, /Hugging Face/, "the Se/rver alt text names the drawn providers");
  });

  test("names Se/cure before Se/rver in the paired architecture block", () => {
    const secure = LANDING.indexOf("path-secure.svg");
    const server = LANDING.indexOf("path-server.svg");
    assert.ok(secure > -1 && server > -1);
    assert.ok(secure < server, "secure-first: the Se/cure diagram comes first");
  });
});

describe("the first-visit overlay", () => {
  // Everything below addresses one failure: the overlay is the FIRST thing a
  // visitor sees, drawn over a page they have not read yet.
  const CARD = LANDING.slice(LANDING.indexOf('<div id="wintro"'), LANDING.indexOf('<div id="mascot"'));

  test("introduces the site by name and tagline", () => {
    assert.match(CARD, /class="wname">DeepResearch\.se</, "the overlay must name the site");
    assert.match(CARD, /class="wlede">[\s\S]*?deep-research AI assistant/,
      "…and say what it is, in the same words as the page's own tagline");
  });

  test("the introduction comes BEFORE the does/doesn't contrast", () => {
    const name = CARD.indexOf('class="wname"');
    const lede = CARD.indexOf('class="wlede"');
    const grid = CARD.indexOf('class="dodont"');
    assert.ok(name > -1 && lede > -1 && grid > -1);
    assert.ok(name < lede && lede < grid,
      "name → tagline → does/doesn't; a contrast with no subject is what feedback #32 reported");
  });

  test("stays short — it is a doorway, not the page", () => {
    const bullets = (CARD.match(/<li>/g) || []).length;
    assert.ok(bullets > 0 && bullets <= 6,
      `the overlay carries ${bullets} bullets; keep it at 6 or fewer (it opens over the real page)`);
    const words = CARD.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
    assert.ok(words <= 140, `the overlay runs to ${words} words; keep it under ~140`);
  });

  test("still offers both halves and the dismiss", () => {
    assert.match(CARD, /It does/);
    assert.match(CARD, /It doesn't/);
    assert.match(CARD, /id="wintrook"/);
  });
});

describe("the feature-focus timeline on the landing", () => {
  test("the card sits directly under the promo video", () => {
    const video = LANDING.indexOf('<video src="/llm-assiterad-utveckling.mp4"');
    const card = LANDING.indexOf('id="focuscard"');
    const purpose = LANDING.indexOf("What this project is for");
    assert.ok(video > -1 && card > -1 && purpose > -1);
    assert.ok(video < card, "the timeline goes below the video");
    assert.ok(card < purpose, "…and stays high on the page, above the prose");
  });

  test("a feature's graph can be turned on and off", () => {
    // The whole point of the card: chips as the picker, plus the bulk resets.
    assert.match(LANDING, /id="fclegend"/);
    assert.match(LANDING, /class="fcchip"/, "each feature gets a toggle chip");
    assert.match(LANDING, /aria-pressed=/, "on/off state is exposed, not colour-only");
    for (const id of ["fcTop", "fcAll", "fcNone", "fcMore"]) {
      assert.ok(LANDING.includes(`id="${id}"`), `missing the ${id} control`);
    }
  });

  test("the card removes itself when the dataset can't be read", () => {
    // A broken chart on the front door is worse than no chart.
    assert.match(LANDING, /<div class="card" id="focuscard" hidden>/,
      "the card starts hidden and is only revealed once the data parses");
    assert.match(LANDING, /card\.hidden = false/);
    assert.match(LANDING, /\.catch\(\(\) => \{/, "a failed fetch must not throw on the landing");
  });

  test("the curves are drawn over the code-volume backdrop, on its own right-hand scale", () => {
    // Two units share the plot — commits per feature (left) and lines the tree
    // holds (right). Losing the second axis, or drawing the backdrop after the
    // curves, is what makes the card unreadable rather than merely different.
    assert.match(LANDING, /class="vol-area"/, "the volume backdrop is drawn");
    assert.match(LANDING, /volumeTicks/, "…with its own scale from the core");
    assert.match(LANDING, /class="vol-lbl"/, "…labelled on the right");
    assert.ok(
      LANDING.indexOf("volumeLayer(xOf)") < LANDING.indexOf("class=\"series-line\""),
      "the backdrop goes down before the curves, never over them",
    );
    assert.match(LANDING, /const VW = 1000, LP = \d+, RP = (?!14\b)\d+/,
      "the right padding must hold the volume labels");
  });

  test("it links through to the full timeline rather than reimplementing it", () => {
    assert.match(LANDING, /href="\/pulse\/timeline\.html"/);
    for (const owned of ["overview", "brush", "stream", "resetZoom", "tableView"]) {
      assert.ok(!LANDING.includes(`id="${owned}"`), `${owned} belongs to the full page, not the landing card`);
    }
  });
});

describe("the shared feature-timeline core", () => {
  const CORE = "/js/pulse-timeline-core.js";

  test("both surfaces import it", () => {
    for (const [name, html] of [["landing", LANDING], ["timeline page", TIMELINE]]) {
      assert.ok(html.includes(CORE), `${name} must draw the timeline through ${CORE}`);
    }
  });

  test("neither page keeps its own copy of the bucketing maths", () => {
    // The drift this split exists to prevent: two pages quietly disagreeing
    // about what a curve means (bin width, the multi-tag weight, the y-scale).
    for (const [name, html] of [["landing", LANDING], ["timeline page", TIMELINE]]) {
      for (const dup of ["function buildBuckets", "function pickStep", "function niceMax", "function normalizeCommits"]) {
        assert.ok(!html.includes(dup),
          `${name} redefines ${dup} — import it from ${CORE} instead`);
      }
    }
  });

  test("the core itself stays pure — no DOM, no fetch", () => {
    const src = read("public/js/pulse-timeline-core.js");
    for (const banned of ["document.", "window.", "fetch(", "localStorage"]) {
      assert.ok(!src.includes(banned),
        `the core touches ${banned}; keep it pure so both pages can unit-test the same maths`);
    }
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

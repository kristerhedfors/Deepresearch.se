// Structural pins on the documentation comment RAIL (public/js/docs-comments.js).
//
// The module is DOM-driven and mounts only behind the admin gate, so it has no
// unit-testable core beyond docs-comments-core.js. What these tests protect is
// the one property a reader complained about and that a later refactor would
// silently undo (feedback #40, 2026-07-26): on a phone the rail covered the
// document it was a rail for, and had no close control at any width.
//
//   "on mobile the right dark pane in documentation is in the way with no
//    clear way to close it. I must see the text when choosing what to comment."
//
// Three things must stay true, and each has exactly one line below:
//   1. a close control exists, at every width;
//   2. the rail is dismissible — its visibility follows an explicit open flag,
//      not just "am I in comment mode";
//   3. on a narrow viewport the rail is a BOTTOM sheet that leaves the top of
//      the page readable, and it does not open until the reader asks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "docs-comments.js"),
  "utf8",
);

describe("the documentation comment rail", () => {
  test("has a close control, rendered every time the rail renders", () => {
    assert.match(SRC, /class="dc-close"/, "the rail must render a close button");
    assert.match(SRC, /aria-label="Close the comments"/);
    assert.match(
      SRC,
      /querySelector\("\.dc-close"\)\?\.addEventListener\("click", \(\) => \{\s*railOpen = false;/,
      "the close button must actually close the rail",
    );
  });

  test("visibility follows an explicit open flag the reader controls", () => {
    // Before the fix this line was `rail.hidden = !commenting && !comments.length`
    // — nothing the reader did could hide it.
    assert.match(SRC, /rail\.hidden = !railOpen \|\|/);
    assert.doesNotMatch(
      SRC,
      /rail\.hidden = !commenting && !comments\.length/,
      "the rail is back to being un-closable",
    );
  });

  test("the count is a handle that reopens a closed rail", () => {
    assert.match(SRC, /<button type="button" class="dc-count"/);
    assert.match(SRC, /countEl\.addEventListener\("click", \(\) => \{\s*railOpen = !railOpen;/);
  });

  test("on a phone the rail is a bottom sheet, leaving the prose readable", () => {
    const sheet = SRC.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/);
    assert.ok(sheet, "no narrow-viewport rule for the rail");
    const css = sheet[1];
    assert.match(css, /\.dc-rail/);
    assert.match(css, /bottom: 0/);
    assert.match(css, /left: 0/, "a sheet spans the width; a column does not");
    assert.match(css, /top: auto/, "the rail must stop spanning the full height");
    assert.match(css, /max-height: 50vh/, "at least half the viewport stays document");
  });

  test("comment mode does not open the rail on a narrow screen", () => {
    // The whole point: you can read and mark the passage before anything
    // covers it. `narrow()` must gate the open, and marking must ungate it.
    assert.match(SRC, /const narrow = \(\) => window\.matchMedia\("\(max-width: 720px\)"\)\.matches/);
    assert.match(SRC, /railOpen = narrow\(\) \? false :/);
    assert.match(
      SRC,
      /function openComposer\(\) \{[\s\S]*?railOpen = true;/,
      "marking a passage must open the rail on any width",
    );
  });

  test("a document that already has comments does not ambush a phone reader", () => {
    assert.match(SRC, /railOpen = !narrow\(\) && comments\.length > 0/);
  });
});

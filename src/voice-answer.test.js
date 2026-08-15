// Unit tests for src/voice-answer.js — shaping a research answer for someone
// who will HEAR it.
//
// The contract these pin is narrow and important: every rule is a REMOVAL of
// something a speech engine would pronounce as itself. Nothing may paraphrase,
// summarize or reorder — a spoken answer that quietly said something different
// from the written one would be the worst bug this surface could have, because
// the listener cannot see the original to catch it.

import test from "node:test";
import assert from "node:assert/strict";

import { VOICE_NOTE, outletName, spokenAnswer, spokenSources, spokenText } from "./voice-answer.js";

test("markdown structure becomes prose, and the words survive", () => {
  const md = [
    "## Findings",
    "",
    "The **rate** fell to *3%* in 2024 [1], and the trend held [2,3].",
    "",
    "- First point",
    "- Second point",
    "",
    "See [the report](https://example.com/report) for more.",
  ].join("\n");
  const spoken = spokenText(md);
  assert.match(spoken, /^Findings\./m);
  assert.match(spoken, /The rate fell to 3% in 2024, and the trend held\./);
  assert.match(spoken, /First point/);
  assert.match(spoken, /See the report for more\./);
  // Everything a speech engine would read aloud as punctuation is gone…
  assert.equal(/[#*_|`]/.test(spoken), false);
  assert.equal(spoken.includes("https://"), false);
  assert.equal(/\[\d/.test(spoken), false);
  // …and every fact is still there.
  for (const word of ["rate", "3%", "2024", "trend", "First", "Second", "report"]) {
    assert.ok(spoken.includes(word), `"${word}" must survive`);
  }
});

test("a code block is announced rather than read out or silently dropped", () => {
  const spoken = spokenText("Here is how:\n\n```js\nconst x = 1;\n```\n\nThat is all.");
  assert.match(spoken, /a code block is omitted here/);
  assert.equal(spoken.includes("const x"), false);
  assert.match(spoken, /That is all\./);
  // Inline code keeps the code and loses the backticks.
  assert.equal(spokenText("Run `npm test` first."), "Run npm test first.");
});

test("a table becomes clauses instead of a wall of pipes", () => {
  const table = ["| Year | Rate |", "|------|------|", "| 2023 | 4% |", "| 2024 | 3% |"].join("\n");
  const spoken = spokenText(table);
  assert.equal(spoken.includes("|"), false);
  assert.match(spoken, /Year, Rate\./);
  assert.match(spoken, /2024, 3%\./);
});

test("citation markers go, real brackets stay", () => {
  assert.equal(spokenText("It rose [4]."), "It rose.");
  assert.equal(spokenText("It rose [1, 2]."), "It rose.");
  assert.equal(spokenText("It rose [1-3]."), "It rose.");
  // A bracketed aside is not a citation and must survive: the pattern is
  // anchored to digits for exactly this reason.
  assert.equal(spokenText("The result [as reported] held."), "The result [as reported] held.");
});

test("sources are named by outlet, not numbered", () => {
  const sources = [
    { url: "https://www.nature.com/articles/x", title: "A" },
    { url: "https://reuters.com/y", title: "B" },
    { url: "https://news.bbc.co.uk/z", title: "C" },
    { url: "https://example.org/w", title: "D" },
  ];
  const tail = spokenSources(sources);
  assert.match(tail, /nature\.com/);
  assert.match(tail, /reuters\.com/);
  // A country-code pair must not be shortened to "co.uk" — that names nobody.
  assert.match(tail, /bbc\.co\.uk/);
  assert.match(tail, /and 1 other source\./);
  assert.equal(spokenSources([]), "", "no sources means no closing sentence at all");
  assert.equal(spokenSources([{ url: "https://nature.com/a" }]), "Based on nature.com.");
});

test("outletName strips what a listener does not need and keeps what identifies", () => {
  assert.equal(outletName({ url: "https://www.nature.com/x" }), "nature.com");
  assert.equal(outletName({ url: "https://sub.domain.example.com/x" }), "example.com");
  assert.equal(outletName({ url: "https://news.bbc.co.uk/x" }), "bbc.co.uk");
  assert.equal(outletName({ url: "not a url" }), "");
  assert.equal(outletName({}), "");
});

test("duplicate outlets are named once but still counted", () => {
  const tail = spokenSources([
    { url: "https://nature.com/a" },
    { url: "https://nature.com/b" },
    { url: "https://nature.com/c" },
  ]);
  assert.equal(tail, "Based on nature.com, and 2 other sources.");
});

test("spokenAnswer joins the two halves and survives an empty one", () => {
  const out = spokenAnswer("## Result\n\nIt held [1].", [{ url: "https://nature.com/a" }]);
  assert.match(out, /Result\./);
  assert.match(out, /Based on nature\.com\./);
  assert.equal(spokenAnswer("Just text.", []), "Just text.");
  assert.equal(spokenAnswer("", [{ url: "https://nature.com/a" }]), "Based on nature.com.");
});

test("the model-facing note asks for the same thing the shaper enforces", () => {
  // The two halves must agree: the note improves the answer, the shaper
  // guarantees it. A note that asked for something else would produce text the
  // shaper then mangles.
  for (const asked of [/no markdown/, /no bullet/, /bracketed citation numbers/]) {
    assert.match(VOICE_NOTE, asked);
  }
  assert.ok(VOICE_NOTE.length < 600, "it rides on every voice call and competes with the question");
});

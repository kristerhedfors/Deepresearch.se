// Unit tests for pipeline-inputs.js — the pure input-block builders and output
// parsers extracted out of pipeline.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shellReplyMessages,
  knowledgeGapsSection,
  searchLedgerSection,
  takeSearchBatch,
  sdkReplyTail,
  endsWithQuestion,
  SDK_ITERATION_QUESTION,
} from "./pipeline-inputs.js";

describe("shellReplyMessages", () => {
  test("empty block → no message (byte-identical to no-sandbox run)", () => {
    assert.deepEqual(shellReplyMessages(""), []);
  });

  test("wraps a transcript as a ground-truth system message", () => {
    const out = shellReplyMessages("$ ls\nfile.txt");
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "system");
    assert.match(out[0].content, /^\$ ls\nfile\.txt/);
    assert.match(out[0].content, /ground truth/);
  });

  // Feedback #7 (2026-07-24): on an Agent Studio build turn the ground-truth
  // framing made sandbox-heredoc'd files read as "already built" — the build
  // variant must frame the transcript as context only, never shipped.
  test("sdkBuild variant frames the transcript as context only — never shipped", () => {
    const out = shellReplyMessages("$ cat > index.html << 'EOF'\n…", { sdkBuild: true });
    assert.equal(out.length, 1);
    assert.match(out[0].content, /CONTEXT ONLY/);
    assert.match(out[0].content, /NEVER published/);
    assert.doesNotMatch(out[0].content, /ground truth/);
    assert.deepEqual(shellReplyMessages("", { sdkBuild: true }), []);
  });
});

describe("knowledgeGapsSection", () => {
  // The one artefact the reflect node produces that the deleted gap cascade
  // never did. It only earns its place if it reaches synthesis as a stated
  // LIMITATION rather than as a to-do the answer might quietly fill in.
  test("empty (and thus absent from the message) when nothing was stated", () => {
    assert.equal(knowledgeGapsSection(undefined), "");
    assert.equal(knowledgeGapsSection([]), "");
    assert.equal(knowledgeGapsSection(["", "   ", null]), "");
  });

  test("lists the stated gaps and tells the answer not to fill them in", () => {
    const out = knowledgeGapsSection(["no source gives revenue after 2024"]);
    assert.match(out, /- no source gives revenue after 2024/);
    assert.match(out, /explicit limitation/);
    assert.match(out, /never fill one in from general knowledge/);
    assert.ok(out.endsWith("\n\n"), "block-separated like every other section");
  });

  test("junk entries are dropped, real ones survive alongside them", () => {
    const out = knowledgeGapsSection(["  spaced  ", "", 42, "real"]);
    assert.match(out, /- spaced/);
    assert.match(out, /- 42/);
    assert.match(out, /- real/);
  });
});

describe("takeSearchBatch", () => {
  const makeState = () => ({ ranQueries: new Set(), searchCount: 0, plan: { maxSearches: 3 } });

  test("trims, drops blanks, and marks queries as run", () => {
    const state = makeState();
    const batch = takeSearchBatch(state, ["  a ", "", "b"]);
    assert.deepEqual(batch, ["a", "b"]);
    assert.ok(state.ranQueries.has("a"));
    assert.ok(state.ranQueries.has("b"));
  });

  test("dedupes case-insensitively against already-run queries", () => {
    const state = makeState();
    state.ranQueries.add("a");
    assert.deepEqual(takeSearchBatch(state, ["A", "c"]), ["c"]);
  });

  test("never overruns plan.maxSearches (counting prior searches)", () => {
    const state = makeState();
    state.searchCount = 2; // one slot left
    assert.deepEqual(takeSearchBatch(state, ["a", "b", "c"]), ["a"]);
  });
});

describe("sdkReplyTail (the feedback-#13 closing shape both build paths share)", () => {
  // The shape src/build-pub.js publishBuild actually returns — `paths` is what
  // SHIPPED (the publish layer injects the app kit, feedback #66), which is why
  // the summary is built from it and not from what the model staged.
  const published = {
    slug: "demo",
    url: "https://deepresearch.se/app/demo/",
    files: 2,
    bytes: 2048,
    paths: ["index.html", "app.js"],
  };

  test("published build: summary + live link + iteration question", () => {
    const tail = sdkReplyTail("Built it.", published);
    assert.ok(tail.startsWith("\n\n"), "separates from existing prose");
    assert.ok(tail.includes("**Build summary:** 2 files, 2.0 KB — index.html · app.js"));
    assert.ok(tail.includes(`**Try it live:** [${published.url}](${published.url})`));
    assert.ok(tail.trim().endsWith(SDK_ITERATION_QUESTION));
  });

  test("singular file count and no leading separator on empty prose", () => {
    const tail = sdkReplyTail("", { ...published, files: 1, bytes: 1024, paths: ["index.html"] });
    assert.ok(!tail.startsWith("\n\n"));
    assert.ok(tail.includes("**Build summary:** 1 file, 1.0 KB — index.html"));
  });

  test("prose already carrying a real markdown link suppresses the Try-it line", () => {
    const tail = sdkReplyTail(`Done — [open it](${published.url})?`, published);
    assert.ok(!tail.includes("**Try it live:**"));
  });

  test("prose already ending on a question suppresses the canned question", () => {
    const tail = sdkReplyTail("Want any changes?", published);
    assert.ok(!tail.includes(SDK_ITERATION_QUESTION));
  });

  test("null published → the honest no-publish note, no link, no question", () => {
    const tail = sdkReplyTail("Tried to build.", null);
    assert.ok(tail.includes("_(Publishing was unavailable this turn — no live URL yet.)_"));
    assert.ok(!tail.includes("**Build summary:**"));
    assert.ok(!tail.includes(SDK_ITERATION_QUESTION));
  });
});

describe("endsWithQuestion", () => {
  test("plain and full-width question marks count, trailing markdown tolerated", () => {
    assert.equal(endsWithQuestion("Ready?"), true);
    assert.equal(endsWithQuestion("準備はいい？"), true);
    assert.equal(endsWithQuestion("Ready?**"), true);
    assert.equal(endsWithQuestion("_Ready?_)"), true);
    assert.equal(endsWithQuestion("Ready.  "), false);
    assert.equal(endsWithQuestion(""), false);
    assert.equal(endsWithQuestion(null), false);
  });
});

describe("searchLedgerSection", () => {
  test("empty (absent) with nothing issued", () => {
    assert.equal(searchLedgerSection(undefined), "");
    assert.equal(searchLedgerSection(new Set()), "");
    assert.equal(searchLedgerSection([]), "");
  });

  test("takes the Set the pipeline keeps, and an array", () => {
    const out = searchLedgerSection(new Set(["founder background", "eat cook joy austin"]));
    assert.match(out, /- founder background/);
    assert.match(out, /- eat cook joy austin/);
    assert.equal(searchLedgerSection(["one angle"]), searchLedgerSection(new Set(["one angle"])));
  });

  test("claims exhaustiveness only when the list IS exhaustive", () => {
    // The first version asserted "the whole search, not a sample" always, and
    // was wrong two ways — it read the PLANNED angles, and it cut silently at
    // 24 while the planner allows 34 searches. A block whose whole purpose is
    // to stop an answer overstating its evidence must not overstate its own.
    assert.match(searchLedgerSection(["a"]), /every angle that was issued, not a sample/);
    const many = searchLedgerSection(Array.from({ length: 55 }, (_, i) => `angle ${i}`));
    assert.match(many, /showing 40 of 55 issued/);
    assert.doesNotMatch(many, /not a sample/);
    assert.match(many, /This list is partial, so do not describe it as exhaustive/);
    assert.equal(many.split("\n").filter((l) => l.startsWith("- ")).length, 40);
  });

  test("the cap sits above the planner's own search ceiling", () => {
    // budget.js allows at most 34 searches, so a real request never truncates
    // and never reaches the partial wording.
    const at34 = searchLedgerSection(Array.from({ length: 34 }, (_, i) => `angle ${i}`));
    assert.match(at34, /every angle that was issued/);
    assert.doesNotMatch(at34, /showing/);
  });

  test("binds absence to the angles actually issued (feedback #61)", () => {
    const out = searchLedgerSection(["a"]);
    assert.match(out, /say which of these angles were tried and came back empty/);
    assert.match(out, /Never write that no source exists for something none of these angles targeted/);
  });

  test("drops junk", () => {
    assert.equal(searchLedgerSection(["", "   ", null, 42]), "");
  });

  test("ends with the blank line every section builder ends with", () => {
    assert.ok(searchLedgerSection(["a"]).endsWith("\n\n"));
  });
});

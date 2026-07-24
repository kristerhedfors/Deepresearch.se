// Unit tests for the PDF report's markdown parser (report.js mdToBlocks).
// The jsPDF drawing path needs a DOM and is verified live; the parsing that
// turns GFM pipe tables into real table blocks (instead of raw ASCII pipes)
// is pure and covered here — the regression behind feedback #15.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToBlocks } from "./report.js";

test("a GFM pipe table becomes one table block, not paragraphs", () => {
  const md = [
    "Intro line.",
    "",
    "| Port | Service | Attack surface |",
    "|---|---|---|",
    "| 25 | SMTP | Open relay, spoofing |",
    "| 443 | HTTPS | TLS misconfig, XSS |",
    "",
    "Closing line.",
  ].join("\n");
  const blocks = mdToBlocks(md);
  const tables = blocks.filter((b) => b.kind === "table");
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.deepEqual(t.header, ["Port", "Service", "Attack surface"]);
  assert.equal(t.rows.length, 2);
  assert.deepEqual(t.rows[0], ["25", "SMTP", "Open relay, spoofing"]);
  assert.deepEqual(t.rows[1], ["443", "HTTPS", "TLS misconfig, XSS"]);
  // No raw pipe text leaks into paragraph blocks.
  assert.ok(!blocks.some((b) => b.kind === "p" && b.text.includes("|")));
  // Surrounding prose survives as its own blocks.
  assert.ok(blocks.some((b) => b.kind === "p" && b.text === "Intro line."));
  assert.ok(blocks.some((b) => b.kind === "p" && b.text === "Closing line."));
});

test("delimiter row with alignment colons is still recognized", () => {
  const md = ["| A | B |", "|:--|--:|", "| 1 | 2 |"].join("\n");
  const [t] = mdToBlocks(md).filter((b) => b.kind === "table");
  assert.ok(t, "table detected");
  assert.deepEqual(t.header, ["A", "B"]);
  assert.deepEqual(t.rows, [["1", "2"]]);
});

test("rows without leading/trailing pipes parse the same", () => {
  const md = ["A | B", "--- | ---", "1 | 2"].join("\n");
  const [t] = mdToBlocks(md).filter((b) => b.kind === "table");
  assert.ok(t, "table detected");
  assert.deepEqual(t.header, ["A", "B"]);
  assert.deepEqual(t.rows, [["1", "2"]]);
});

test("inline bold/code inside cells is flattened", () => {
  const md = ["| Name | Note |", "|---|---|", "| **25** | `Postfix` relay |"].join("\n");
  const [t] = mdToBlocks(md).filter((b) => b.kind === "table");
  assert.deepEqual(t.rows[0], ["25", "Postfix relay"]);
});

test("a lone pipe line without a delimiter row stays a paragraph", () => {
  const md = "cost is 5 | 10 depending on plan";
  const blocks = mdToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "p");
});

test("headings, bullets and numbered items are unaffected", () => {
  const md = ["# Title", "- one", "1. first"].join("\n");
  const blocks = mdToBlocks(md);
  assert.equal(blocks[0].kind, "h1");
  assert.equal(blocks[1].kind, "li");
  assert.equal(blocks[2].kind, "li");
  assert.equal(blocks[2].ordered, true);
});

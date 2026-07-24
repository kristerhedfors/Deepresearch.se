// Unit tests for the PDF report's markdown parser (report.js mdToBlocks).
// The jsPDF drawing path needs a DOM and is verified live; the parsing that
// turns GFM pipe tables into real table blocks (instead of raw ASCII pipes)
// is pure and covered here — the regression behind feedback #15.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToBlocks, sanitizeForPdf } from "./report.js";

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

// jsPDF's standard font can only encode cp1252; a stray Unicode glyph (an
// arrow above all) otherwise corrupts the whole text() run into wide-spaced
// mojibake — feedback #17.
test("arrows and other non-cp1252 glyphs are transliterated to ASCII", () => {
  assert.equal(
    sanitizeForPdf("Värdnamn: basalt.se → IP 85.24.159.61"),
    "Värdnamn: basalt.se -> IP 85.24.159.61",
  );
  assert.equal(sanitizeForPdf("a ⇒ b ≥ c ≤ d ≠ e"), "a => b >= c <= d != e");
  assert.equal(sanitizeForPdf("done ✓ / skip ✗"), "done [x] / skip [ ]");
});

test("Swedish Latin-1 letters and supported cp1252 punctuation are preserved", () => {
  // å ä ö é ü are ≤ 0xFF; “smart quotes”, en/em dashes, ellipsis and the
  // bullet are cp1252 high chars jsPDF renders — none of these should change.
  const s = "Öppna portar — “klartext” … • räknas åäöéü";
  assert.equal(sanitizeForPdf(s), s);
});

test("an unmapped exotic glyph falls back to a space, never corrupting the run", () => {
  assert.equal(sanitizeForPdf("a 𝟙 b"), "a   b"); // math digit -> space
  assert.equal(sanitizeForPdf("port 中文 open"), "port    open"); // CJK -> spaces
});

test("sanitize runs through the block/table path so ASCII arrows reach the PDF", () => {
  const blocks = mdToBlocks("- Värdnamn: basalt.se → IP");
  assert.equal(blocks[0].kind, "li");
  assert.equal(blocks[0].text, "Värdnamn: basalt.se -> IP");
  const [t] = mdToBlocks(["| A | B |", "|---|---|", "| x → y | ≥ 5 |"].join("\n"))
    .filter((b) => b.kind === "table");
  assert.deepEqual(t.rows[0], ["x -> y", ">= 5"]);
});

test("headings, bullets and numbered items are unaffected", () => {
  const md = ["# Title", "- one", "1. first"].join("\n");
  const blocks = mdToBlocks(md);
  assert.equal(blocks[0].kind, "h1");
  assert.equal(blocks[1].kind, "li");
  assert.equal(blocks[2].kind, "li");
  assert.equal(blocks[2].ordered, true);
});

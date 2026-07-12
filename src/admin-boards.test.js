// The admin-BOARDS discovery index's pure logic (src/admin-boards.js): the
// registry shape (one self-describing entry per Claude-fetchable list), the
// ?format=text rendering an agent reads to discover every board, and the JSON
// handler. Static registry — no D1, so the handler is exercised directly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_BOARDS,
  formatBoardsText,
  handleAdminBoards,
} from "./admin-boards.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---- registry shape ---------------------------------------------------------

test("registry: every entry has the required fields, well-typed", () => {
  assert.ok(ADMIN_BOARDS.length >= 4, "at least the four known boards");
  for (const b of ADMIN_BOARDS) {
    assert.ok(typeof b.id === "string" && b.id.trim().length > 0, `${b.id} id`);
    assert.ok(typeof b.title === "string" && b.title.trim().length > 0, `${b.id} title`);
    assert.ok(typeof b.purpose === "string" && b.purpose.trim().length > 20, `${b.id} purpose`);
    assert.equal(typeof b.feeds_loop, "boolean", `${b.id} feeds_loop`);
    assert.match(b.api, /^\/api\/admin\//, `${b.id} api`);
    assert.ok(b.text_query.includes("format=text"), `${b.id} text_query yields the text view`);
    assert.ok(Array.isArray(b.orderings) && b.orderings.length > 0, `${b.id} orderings`);
    assert.ok(b.orderings.every((o) => typeof o === "string" && o.length), `${b.id} ordering names`);
    assert.ok(typeof b.order_help === "string" && b.order_help.trim().length > 20, `${b.id} order_help`);
    assert.match(b.script, /^scripts\//, `${b.id} script`);
    assert.ok(typeof b.skill === "string" && b.skill.trim().length > 0, `${b.id} skill`);
  }
});

test("registry: ids are unique", () => {
  const ids = ADMIN_BOARDS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
});

test("registry: the known boards are indexed with the right endpoints", () => {
  const by = Object.fromEntries(ADMIN_BOARDS.map((b) => [b.id, b]));
  assert.equal(by.security.api, "/api/admin/security");
  assert.equal(by.security.script, "scripts/security");
  assert.deepEqual(by.security.orderings, ["priority", "severity"]);
  assert.equal(by.features.api, "/api/admin/features");
  assert.equal(by.features.script, "scripts/features");
  assert.deepEqual(by.features.orderings, ["priority", "impact"]);
  assert.equal(by.feedback.api, "/api/admin/feedback");
  assert.equal(by.feedback.script, "scripts/feedback");
  assert.equal(by.chatlogs.api, "/api/admin/chatlogs");
  assert.equal(by.chatlogs.script, "scripts/chatlogs");
});

// ---- text rendering (the discovery entry point) -----------------------------

test("formatBoardsText: includes each board's fetch line, orderings, and skill", () => {
  const origin = "https://deepresearch.se";
  const text = formatBoardsText(ADMIN_BOARDS, origin);
  for (const b of ADMIN_BOARDS) {
    assert.ok(text.includes(b.title), `${b.id} title present`);
    assert.ok(text.includes(b.script), `${b.id} script line present`);
    // The exact curl line an agent can copy-run, with the concrete host.
    assert.ok(
      text.includes(`${origin}${b.api}?${b.text_query}`),
      `${b.id} curl fetch URL present`,
    );
    assert.ok(text.includes(b.orderings.join(", ")), `${b.id} orderings listed`);
    assert.ok(text.includes(b.skill), `${b.id} skill named`);
  }
  // Self-referential: it tells the reader how to re-run the index itself.
  assert.ok(text.includes("scripts/boards"), "names its own wrapper");
});

test("formatBoardsText: origin seeds the concrete curl host", () => {
  const text = formatBoardsText(ADMIN_BOARDS, "http://localhost:8787");
  assert.ok(text.includes("http://localhost:8787/api/admin/security"));
  assert.ok(!text.includes("https://deepresearch.se"));
});

// ---- the JSON/text handler (no D1 needed) -----------------------------------

test("handleAdminBoards: JSON default returns all boards", async () => {
  const url = new URL("https://deepresearch.se/api/admin/boards");
  const res = await handleAdminBoards(new Request(url), {}, url, noopLog);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const body = await res.json();
  assert.equal(body.boards.length, ADMIN_BOARDS.length);
  assert.deepEqual(
    body.boards.map((b) => b.id),
    ADMIN_BOARDS.map((b) => b.id),
  );
});

test("handleAdminBoards: ?format=text renders the readable index", async () => {
  const url = new URL("https://deepresearch.se/api/admin/boards?format=text");
  const res = await handleAdminBoards(new Request(url), {}, url, noopLog);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  const text = await res.text();
  for (const b of ADMIN_BOARDS) assert.ok(text.includes(b.script), `${b.id} in text`);
});

// The schema-statement splitter (src/db.js splitStatements) that getDb feeds to
// db.batch(). Regression guard for the site-wide outage: a SQL `--` comment
// containing a semicolon (PR #207's server_errors note "…count/last_seen_at; a
// recurrence…") made the old `SCHEMA.split(";")` cut the comment mid-sentence,
// leaving "a recurrence …" as a bogus statement. D1 rejected it
// (`near "a": syntax error`), db.batch threw, getDb threw, and every
// database-backed feature — sign-in included — 500'd. The splitter must strip
// comments first so every emitted statement is real DDL.

import test from "node:test";
import assert from "node:assert/strict";

import { splitStatements, SCHEMA } from "./db.js";

// Every statement getDb prepares from the real SCHEMA must begin with a DDL
// keyword — never a stray word left behind by a comment split.
test("every SCHEMA statement starts with a DDL keyword (no comment fragments)", () => {
  const statements = splitStatements(SCHEMA);
  assert.ok(statements.length > 0, "SCHEMA yields statements");
  for (const s of statements) {
    assert.match(
      s,
      /^(CREATE|ALTER|DROP|PRAGMA|INSERT)\b/i,
      `statement is real DDL, not a comment fragment: ${JSON.stringify(s.slice(0, 60))}`,
    );
  }
});

// No prepared statement may still contain a `--` comment marker (a leftover
// comment would be prose SQLite tolerates but D1's per-statement prepare may not).
test("no SCHEMA statement retains a -- comment", () => {
  for (const s of splitStatements(SCHEMA)) {
    assert.ok(!s.includes("--"), `statement carries a stray comment: ${JSON.stringify(s.slice(0, 60))}`);
  }
});

// The exact shape that caused the outage: a comment with a semicolon between two
// real statements must NOT produce a third, bogus one.
test("a semicolon inside a comment does not split into a bogus statement", () => {
  const schema = [
    "CREATE TABLE a (id INTEGER);",
    "-- Recurrences bump count/last_seen_at; a recurrence of a fixed row reopens",
    "-- it (regression). Notes only.",
    "CREATE TABLE b (id INTEGER);",
  ].join("\n");
  const statements = splitStatements(schema);
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^CREATE TABLE a/);
  assert.match(statements[1], /^CREATE TABLE b/);
});

// The server_errors and pool tables (the comment blocks that carry the
// offending semicolons) must still be emitted as CREATE statements.
test("comment-heavy tables are still created", () => {
  const joined = splitStatements(SCHEMA).join("\n");
  for (const table of ["server_errors", "pool_providers", "pool_tokens", "users"]) {
    assert.match(
      joined,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `${table} table is created`,
    );
  }
});

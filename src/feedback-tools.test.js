// No `// @ts-check` here, matching src/mcp.test.js: this suite reads its own
// sources through `new URL(..., import.meta.url)` to pin the file-layout rule,
// and that form does not typecheck under this project's tsconfig. The modules
// under test are both checked.
//
// Unit tests for the MCP feedback tool — src/feedback-tools.js (pure) and
// src/feedback-tools-run.js (the D1 write).
//
// The properties worth pinning are the ones a later change would break without
// meaning to: that the tool is WRITE-ONLY, that it refuses rather than guesses
// when there is no account to file against, that it never reports success for a
// report it did not store, and that it does not learn a second copy of the
// browser path's validation.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FEEDBACK_MCP_CATALOG,
  FEEDBACK_MCP_TOOLS,
  FEEDBACK_SPENDING_TOOLS,
  FEEDBACK_TOOL_NAME,
  FEEDBACK_TOOL_NAMES,
  FEEDBACK_TOOL_PAGE,
} from "./feedback-tools.js";
import { runFeedbackTool } from "./feedback-tools-run.js";
import { FEEDBACK_CAPS } from "./feedback.js";

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A D1 fake that records the feedback INSERT and hands back a row id. */
function captureDb({ failInsert = false } = {}) {
  /** @type {any[][]} */
  const inserts = [];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    async run() {
      if (/INSERT INTO feedback/i.test(sql)) inserts.push(args);
      return { success: true, meta: { last_row_id: failInsert ? 0 : 4242 } };
    },
    async first() {
      // The threading lookup: no prior entry, so every MCP report is new.
      if (/SELECT id, status FROM feedback/i.test(sql)) return null;
      return failInsert ? null : { id: 4242 };
    },
    async all() {
      return { results: [] };
    },
  });
  return { _inserts: inserts, prepare: (sql) => stmt(sql), async batch() { return []; } };
}

// --- the pure half --------------------------------------------------------

test("the tool is write-only: nothing in it can read the queue back", () => {
  // An MCP key is not a login (the server-token guarantee), and
  // `feedback.context` carries whole conversations on the chat path — so a tool
  // that could list or fetch feedback would hand one key holder another
  // account's transcripts. The absence of a read is the security property, so
  // it is asserted rather than left to the reviewer's memory.
  const names = [...FEEDBACK_TOOL_NAMES];
  assert.deepEqual(names, ["send_feedback"]);
  for (const t of FEEDBACK_MCP_TOOLS) {
    assert.doesNotMatch(t.name, /list|read|get|fetch|search/i, "no read-shaped tool in this family");
  }
  const run = readFileSync(new URL("./feedback-tools-run.js", import.meta.url), "utf8");
  assert.equal(/SELECT/i.test(run), false, "the runner issues no query of its own");
});

test("it spends nothing, so it is outside the quota gate", () => {
  // Free like platform_map: one D1 row, no provider. An agent whose budget is
  // gone is exactly the agent with something to report.
  assert.equal(FEEDBACK_SPENDING_TOOLS.size, 0);
});

test("the pure module imports nothing, so mcp-config.js may take its rows", () => {
  // The file-layout rule: src/mcp-config.js is a leaf by contract, and it now
  // imports this module for the catalog row. That is only safe while this file
  // pulls nothing in behind it.
  const src = readFileSync(new URL("./feedback-tools.js", import.meta.url), "utf8");
  assert.equal(/^import\s/m.test(src), false, "src/feedback-tools.js must import nothing");
});

test("the runner is reached dynamically, never as a static import", () => {
  const mcp = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  assert.match(mcp, /await import\("\.\/feedback-tools-run\.js"\)/);
  assert.equal(
    /^import .*from "\.\/feedback-tools-run\.js"/m.test(mcp),
    false,
    "the runner reaches D1 and must stay behind the dynamic import",
  );
});

test("the schema takes no images", () => {
  // The browser path sends screenshots; an agent has none, and base64 blobs on
  // a keyed surface are an abuse vector that buys nothing. Absent from the
  // schema means a caller cannot supply one at all.
  const [tool] = FEEDBACK_MCP_TOOLS;
  // Asserted over the key set rather than by reading `.images`: the property is
  // absent at the TYPE level too, so `properties.images` does not typecheck —
  // which is the strongest form of the guarantee this test exists for.
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    "answer_excerpt",
    "comment",
    "model",
    "question",
  ]);
  assert.deepEqual(tool.inputSchema.required, ["comment"]);
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(/** @type {any} */ (tool).input_schema, undefined, "MCP wants inputSchema");
});

test("the catalog row arrives exposed and says what the switch buys", () => {
  const [row] = FEEDBACK_MCP_CATALOG;
  assert.equal(row.id, FEEDBACK_TOOL_NAME);
  assert.equal(row.def, true, "free tools arrive on");
  assert.ok(row.blurb.length > 40);
  assert.match(row.blurb, /write-only/i, "the blurb states the posture the account is agreeing to");
});

// --- the write ------------------------------------------------------------

test("a report reaches D1 and the answer names the entry", async () => {
  const DB = captureDb();
  const r = await runFeedbackTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "send_feedback",
    { comment: "cve_intel said 100% and EPSS never reaches 1", question: "what is CVE-2021-44228" },
    { identity: { id: "u-1" }, requestId: "req-1" },
  );
  assert.equal(r.isError, false);
  assert.equal(r.entryId, 4242);
  assert.match(r.text, /#4242/);
  assert.equal(DB._inserts.length, 1, "exactly one feedback row");
  assert.ok(DB._inserts[0].includes("u-1"), "filed against the calling account");
  assert.ok(
    DB._inserts[0].some((a) => a === FEEDBACK_TOOL_PAGE),
    "records the surface it came in from, so the queue reader knows",
  );
});

test("an unidentified caller is refused, and told which half is missing", async () => {
  // Break-glass has no D1 row: nothing to attribute to and nothing to reply to.
  const DB = captureDb();
  const r = await runFeedbackTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "send_feedback",
    { comment: "something is wrong" },
    {},
  );
  assert.equal(r.isError, true);
  assert.match(r.text, /account/i);
  assert.equal(DB._inserts.length, 0, "nothing written for an unattributable report");
});

test("an empty comment is refused by the browser path's own validator", async () => {
  // Not a second copy of the rule — validateFeedbackCreate is what the account
  // panel uses, so the caps cannot drift between the two surfaces.
  const DB = captureDb();
  for (const bad of [{}, { comment: "" }, { comment: "   " }]) {
    const r = await runFeedbackTool(
      /** @type {any} */ ({ DB }),
      /** @type {any} */ (quietLog),
      "send_feedback",
      bad,
      { identity: { id: "u-1" } },
    );
    assert.equal(r.isError, true, JSON.stringify(bad));
  }
  assert.equal(DB._inserts.length, 0);
});

test("an over-long comment is truncated to the shared cap, not rejected", async () => {
  const DB = captureDb();
  const r = await runFeedbackTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "send_feedback",
    { comment: "x".repeat(FEEDBACK_CAPS.comment + 500) },
    { identity: { id: "u-1" } },
  );
  assert.equal(r.isError, false);
  const stored = DB._inserts[0].find((a) => typeof a === "string" && a.startsWith("xxx"));
  // The content is capped at the shared limit and a visible truncation marker
  // is appended, so a queue reader can see the report was cut rather than
  // silently losing its tail.
  assert.equal(stored.slice(0, FEEDBACK_CAPS.comment), "x".repeat(FEEDBACK_CAPS.comment));
  assert.match(stored, /\[truncated \d+ chars\]$/);
  // The COUNT in that marker is not asserted, deliberately. An over-long
  // comment is truncated TWICE on this path — validateFeedbackCreate caps it
  // and appends a marker, then createFeedbackEntry (feedback.js:830) caps the
  // result again and eats the first marker — so a 500-char overflow is
  // reported as "23 chars". That is pre-existing and shared with the browser
  // path, not introduced here, and pinning the wrong number would make the
  // eventual fix look like a regression.
});

test("no database means an explicit refusal, never a false confirmation", async () => {
  // The one place fail-soft would be wrong: a reporter who believes a lost
  // report was filed stops reporting, which costs more than the failure.
  const r = await runFeedbackTool(
    /** @type {any} */ ({}),
    /** @type {any} */ (quietLog),
    "send_feedback",
    { comment: "anything" },
    { identity: { id: "u-1" } },
  );
  assert.equal(r.isError, true);
  assert.match(r.text, /nothing was recorded/i);
});

test("a write that stores nothing is reported as a failure", async () => {
  const DB = captureDb({ failInsert: true });
  const r = await runFeedbackTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "send_feedback",
    { comment: "anything" },
    { identity: { id: "u-1" } },
  );
  assert.equal(r.isError, true);
  assert.match(r.text, /nothing was recorded/i);
});

test("the comment text never reaches the log line", async () => {
  // Invariant 4: outbound logs carry the minimum, and user content is not it.
  /** @type {any[]} */
  const lines = [];
  const log = {
    ...quietLog,
    info: (/** @type {string} */ event, /** @type {any} */ meta) => lines.push({ event, meta }),
  };
  const secret = "a sentence that must not be logged";
  await runFeedbackTool(
    /** @type {any} */ ({ DB: captureDb() }),
    /** @type {any} */ (log),
    "send_feedback",
    { comment: secret },
    { identity: { id: "u-1" } },
  );
  const filed = lines.find((l) => l.event === "mcp.feedback_filed");
  assert.ok(filed, "the file is logged");
  assert.equal(JSON.stringify(filed.meta).includes(secret), false, "but not its text");
  assert.equal(filed.meta.comment_chars, secret.length, "only its size");
});

test("an unknown name is refused rather than filed", async () => {
  const DB = captureDb();
  const r = await runFeedbackTool(
    /** @type {any} */ ({ DB }),
    /** @type {any} */ (quietLog),
    "not_a_tool",
    { comment: "x" },
    { identity: { id: "u-1" } },
  );
  assert.equal(r.isError, true);
  assert.equal(DB._inserts.length, 0);
});

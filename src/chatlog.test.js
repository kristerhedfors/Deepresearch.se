// Unit tests for the chat interaction log's pure logic (src/chatlog.js):
// truncation markers, inline-image scrubbing, row assembly, API projection,
// the readable text rendering, and LIKE escaping. The D1 write/read paths
// are covered by live verification (the chat-logs skill's probe).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOG_CAPS,
  buildChatLogEntry,
  formatChatLogsText,
  likePattern,
  projectChatLog,
  sanitizeConversationForLog,
  truncateForLog,
} from "./chatlog.js";

// ---- truncateForLog --------------------------------------------------------

test("truncateForLog passes short text through untouched", () => {
  assert.equal(truncateForLog("hello", 10), "hello");
});

test("truncateForLog trims with an explicit marker", () => {
  const out = truncateForLog("a".repeat(120), 100);
  assert.ok(out.startsWith("a".repeat(100)));
  assert.match(out, /…\[truncated 20 chars\]$/);
});

test("truncateForLog coerces null/undefined/non-strings", () => {
  assert.equal(truncateForLog(null, 10), "");
  assert.equal(truncateForLog(undefined, 10), "");
  assert.equal(truncateForLog(42, 10), "42");
});

// ---- sanitizeConversationForLog -------------------------------------------

test("sanitizeConversationForLog replaces inline data-URL images, keeps text", () => {
  const dataUrl = "data:image/png;base64," + "A".repeat(5000);
  const messages = [
    { role: "user", content: "plain question" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: dataUrl } },
        { type: "image_url", image_url: { url: "https://example.com/pic.jpg" } },
      ],
    },
  ];
  const out = sanitizeConversationForLog(messages);
  assert.equal(out[0].content, "plain question");
  assert.equal(out[1].content[0].text, "what is this?");
  assert.equal(out[1].content[1].image_url.url, `[inline image omitted: ${dataUrl.length} chars]`);
  assert.equal(out[1].content[2].image_url.url, "https://example.com/pic.jpg");
  // The live conversation must never be mutated.
  assert.equal(messages[1].content[1].image_url.url, dataUrl);
});

test("sanitizeConversationForLog tolerates junk input", () => {
  assert.deepEqual(sanitizeConversationForLog(null), []);
  assert.deepEqual(sanitizeConversationForLog("nope"), []);
  const out = sanitizeConversationForLog([{ role: "user" }, {}]);
  assert.equal(out.length, 2);
});

// ---- buildChatLogEntry -----------------------------------------------------

test("buildChatLogEntry derives the question from the last user message", () => {
  const e = buildChatLogEntry({
    user_id: 7,
    conversation: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
    ],
    answer: "final answer",
  });
  assert.equal(e.question, "follow-up");
  assert.equal(e.answer, "final answer");
  assert.equal(e.user_id, "7");
  assert.equal(e.channel, "chat");
  assert.equal(e.status, "ok");
  assert.equal(e.web_search, 1);
  assert.equal(e.client_gone, 0);
  assert.ok(Number.isFinite(e.ts));
  const conv = JSON.parse(e.conversation_json);
  assert.equal(conv.length, 3);
});

test("buildChatLogEntry applies caps, flags, and meta serialization", () => {
  const e = buildChatLogEntry({
    user_id: "3",
    channel: "mcp",
    conversation: [{ role: "user", content: "q".repeat(LOG_CAPS.question + 50) }],
    answer: "a".repeat(LOG_CAPS.answer + 50),
    status: "error",
    error: "boom",
    web_search: false,
    budget_s: 120,
    client_gone: true,
    meta: { queries: ["one", "two"] },
  });
  assert.ok(e.question.length <= LOG_CAPS.question + 40); // cap + marker
  assert.match(e.question, /truncated/);
  assert.match(e.answer, /truncated/);
  assert.equal(e.channel, "mcp");
  assert.equal(e.status, "error");
  assert.equal(e.error, "boom");
  assert.equal(e.web_search, 0);
  assert.equal(e.budget_s, 120);
  assert.equal(e.client_gone, 1);
  assert.deepEqual(JSON.parse(e.meta_json), { queries: ["one", "two"] });
});

test("buildChatLogEntry survives unserializable meta", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const e = buildChatLogEntry({ user_id: 1, conversation: [], meta: cyclic });
  assert.equal(e.meta_json, null);
});

test("buildChatLogEntry prefers an explicit question over derivation", () => {
  const e = buildChatLogEntry({ user_id: 1, question: "explicit", conversation: [{ role: "user", content: "derived" }] });
  assert.equal(e.question, "explicit");
});

// ---- projectChatLog --------------------------------------------------------

const ROW = {
  id: 42,
  request_id: "req-1",
  ts: 1751970000000,
  user_id: "3",
  channel: "chat",
  model: "m",
  json_model: "jm",
  question: "Q?",
  answer: "A.",
  conversation_json: '[{"role":"user","content":"Q?"}]',
  status: "ok",
  error: null,
  meta_json: '{"queries":["x"]}',
  web_search: 1,
  budget_s: 60,
  rounds: 2,
  searches: 5,
  sources: 9,
  prompt_tokens: 100,
  completion_tokens: 50,
  duration_ms: 12000,
  client_gone: 0,
};

test("projectChatLog list view carries full Q&A but no conversation/meta", () => {
  const out = projectChatLog(ROW);
  assert.equal(out.question, "Q?");
  assert.equal(out.answer, "A.");
  assert.equal(out.web_search, true);
  assert.equal(out.client_gone, false);
  assert.equal(out.time, new Date(ROW.ts).toISOString());
  assert.ok(!("conversation" in out));
  assert.ok(!("meta" in out));
});

test("projectChatLog full view parses conversation and meta", () => {
  const out = projectChatLog(ROW, { full: true });
  assert.deepEqual(out.conversation, [{ role: "user", content: "Q?" }]);
  assert.deepEqual(out.meta, { queries: ["x"] });
});

test("projectChatLog returns a truncated JSON blob raw rather than dropping it", () => {
  const out = projectChatLog({ ...ROW, conversation_json: '[{"role":"user"…[truncated 5 chars]' }, { full: true });
  assert.equal(typeof out.conversation, "string");
});

// ---- formatChatLogsText ----------------------------------------------------

test("formatChatLogsText renders a readable block per interaction", () => {
  const text = formatChatLogsText([
    projectChatLog({ ...ROW, error: "it broke", status: "error" }, { full: true }),
  ]);
  assert.match(text, /── #42 /);
  assert.match(text, /\[error\] chat user=3 model=m/);
  assert.match(text, /Q: Q\?/);
  assert.match(text, /ERROR: it broke/);
  assert.match(text, /A: A\./);
  assert.match(text, /META: /);
  assert.match(text, /ref=req-1/);
});

test("formatChatLogsText says so when nothing matches", () => {
  assert.match(formatChatLogsText([]), /no logged interactions/);
});

// ---- likePattern -----------------------------------------------------------

test("likePattern escapes SQL LIKE wildcards", () => {
  assert.equal(likePattern("50%_done\\x"), "%50\\%\\_done\\\\x%");
  assert.equal(likePattern("plain"), "%plain%");
});

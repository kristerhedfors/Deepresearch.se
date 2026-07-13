// Unit tests for the chat interaction log's pure logic (src/chatlog.js):
// truncation markers, inline-image scrubbing, row assembly, API projection,
// the readable text rendering, and LIKE escaping. The D1 write/read paths
// are covered by live verification (the chat-logs skill's probe).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOG_CAPS,
  SHELL_LOG_CAPS,
  buildChatLogEntry,
  cleanStr,
  formatChatLogsText,
  formatShellForLog,
  likePattern,
  projectChatLog,
  sanitizeConversationForLog,
  shellLogSummary,
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

// ---- cleanStr (shared by the testpoints/feedback board validators) --------

test("cleanStr returns a trimmed string for non-blank input", () => {
  assert.equal(cleanStr("  hi there  ", 100), "hi there");
});

test("cleanStr returns null for absent/blank/non-string input", () => {
  assert.equal(cleanStr("   ", 100), null);
  assert.equal(cleanStr("", 100), null);
  assert.equal(cleanStr(null, 100), null);
  assert.equal(cleanStr(undefined, 100), null);
  assert.equal(cleanStr(42, 100), null);
});

test("cleanStr truncates past the cap with truncateForLog's marker", () => {
  const out = cleanStr("a".repeat(120), 100);
  assert.ok(out && out.startsWith("a".repeat(100)));
  assert.match(out, /…\[truncated 20 chars\]$/);
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

// ---- shellLogSummary -------------------------------------------------------

test("shellLogSummary returns undefined when nothing ran", () => {
  assert.equal(shellLogSummary([]), undefined);
  assert.equal(shellLogSummary(null), undefined);
  assert.equal(shellLogSummary("nope"), undefined);
  // A transcript with only junk entries yields no tool calls → undefined.
  assert.equal(shellLogSummary([{ command: "" }, { exitCode: 0 }, null]), undefined);
});

test("shellLogSummary keeps the exact commands, exit codes, and output", () => {
  const out = shellLogSummary([
    { command: "whoami", exitCode: 0, stdout: "root\n", stderr: "" },
    { command: "false", exitCode: 1, stdout: "", stderr: "boom" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { command: "whoami", exitCode: 0, stdout: "root\n", stderr: "" });
  assert.equal(out[1].exitCode, 1);
  assert.equal(out[1].stderr, "boom");
});

test("shellLogSummary clamps oversized output and caps command count", () => {
  const long = "x".repeat(SHELL_LOG_CAPS.output + 500);
  const [one] = shellLogSummary([{ command: "cat big", exitCode: 0, stdout: long, stderr: "" }]);
  assert.match(one.stdout, /truncated/);
  assert.ok(one.stdout.length < long.length);

  const many = Array.from({ length: SHELL_LOG_CAPS.commands + 10 }, (_, i) => ({
    command: `echo ${i}`,
    exitCode: 0,
    stdout: String(i),
    stderr: "",
  }));
  assert.equal(shellLogSummary(many).length, SHELL_LOG_CAPS.commands);
});

test("shellLogSummary defaults a non-numeric exit code to 1 and skips blank commands", () => {
  const out = shellLogSummary([
    { command: "   ", exitCode: 0, stdout: "x", stderr: "" },
    { command: "ls", exitCode: "nope", stdout: "", stderr: "" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].command, "ls");
  assert.equal(out[0].exitCode, 1);
});

// ---- formatShellForLog / shell in the text view ----------------------------

test("formatShellForLog renders commands, exit codes, and indented output", () => {
  const block = formatShellForLog([
    { command: "whoami", exitCode: 0, stdout: "root\n", stderr: "" },
    { command: "ls /nope", exitCode: 2, stdout: "", stderr: "No such file" },
  ]);
  assert.match(block, /TOOLS: bash-lite ran 2 commands/);
  assert.match(block, /\$ whoami {3}\(exit 0\)/);
  assert.match(block, /^ {4}root$/m);
  assert.match(block, /\$ ls \/nope {3}\(exit 2\)/);
  assert.match(block, /^ {4}\[stderr\] No such file$/m);
});

test("formatShellForLog singularizes a lone command and drops empty output", () => {
  const block = formatShellForLog([{ command: "true", exitCode: 0, stdout: "", stderr: "" }]);
  assert.match(block, /ran 1 command$/m);
  // No blank indented line for a no-output command.
  assert.doesNotMatch(block, /\n {4}\n/);
});

test("formatChatLogsText surfaces shell tool calls above the META line", () => {
  const meta = { shell: [{ command: "whoami", exitCode: 0, stdout: "root", stderr: "" }], queries: [] };
  const text = formatChatLogsText([
    projectChatLog({ ...ROW, meta_json: JSON.stringify(meta) }, { full: true }),
  ]);
  assert.match(text, /TOOLS: bash-lite ran 1 command/);
  assert.match(text, /\$ whoami/);
  // The shell block precedes the raw META dump.
  assert.ok(text.indexOf("TOOLS: bash-lite") < text.indexOf("META: "));
});

// ---- likePattern -----------------------------------------------------------

test("likePattern escapes SQL LIKE wildcards", () => {
  assert.equal(likePattern("50%_done\\x"), "%50\\%\\_done\\\\x%");
  assert.equal(likePattern("plain"), "%plain%");
});

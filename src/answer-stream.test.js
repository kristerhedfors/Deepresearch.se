// Node tests for answer-stream.js's pure helpers: the connect-retry
// classifier, the context-overflow rewrite, and the failover image strip.
import { test } from "node:test";
import assert from "node:assert/strict";

import { contextOverflowMessage, isTransientConnectStatus, stripImageParts } from "./answer-stream.js";

test("isTransientConnectStatus retries provider-side statuses only", () => {
  assert.equal(isTransientConnectStatus(500), true);
  assert.equal(isTransientConnectStatus(503), true);
  assert.equal(isTransientConnectStatus(429), true);
  assert.equal(isTransientConnectStatus(408), true);
  // Deterministic: a second attempt fails identically.
  assert.equal(isTransientConnectStatus(400), false);
  assert.equal(isTransientConnectStatus(401), false);
  assert.equal(isTransientConnectStatus(413), false);
});

test("contextOverflowMessage rewrites only the context-window 400", () => {
  assert.ok(contextOverflowMessage(400, '{"error":{"code":"context_length_exceeded"}}'));
  assert.ok(contextOverflowMessage(400, "maximum context length is 32768 tokens"));
  assert.ok(contextOverflowMessage(400, "Please reduce the length of the messages"));
  assert.equal(contextOverflowMessage(400, '{"error":"invalid model"}'), null);
  assert.equal(contextOverflowMessage(500, "maximum context length"), null);
  assert.equal(contextOverflowMessage(400, ""), null);
});

test("stripImageParts returns the SAME array when there is nothing to strip", () => {
  const messages = [
    { role: "user", content: "plain question" },
    { role: "assistant", content: "answer" },
    { role: "user", content: [{ type: "text", text: "still no picture" }] },
  ];
  // Identity, not just deep-equality: the text-only failover must re-send
  // byte-identical messages.
  assert.equal(stripImageParts(messages), messages);
});

test("stripImageParts drops images but keeps the text on the failover path", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Here is a screenshot" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
      ],
    },
    { role: "assistant", content: "I see it." },
    {
      role: "user",
      content: [
        { type: "text", text: "Write a report" },
        { type: "text", text: "in Swedish" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
      ],
    },
  ];
  const out = stripImageParts(messages);
  assert.equal(out[0].content, "Here is a screenshot");
  assert.equal(out[1], messages[1]); // untouched turns keep their reference
  assert.equal(out[2].content, "Write a report\nin Swedish");
  assert.equal(JSON.stringify(out).includes("data:image/"), false);
  assert.equal(messages[0].content.length, 2); // the input is not mutated
});

test("stripImageParts leaves an image-only turn with non-empty content", () => {
  const out = stripImageParts([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ]);
  assert.equal(typeof out[0].content, "string");
  assert.ok(out[0].content.length > 0);
  assert.ok(!out[0].content.includes("data:image/"));
});

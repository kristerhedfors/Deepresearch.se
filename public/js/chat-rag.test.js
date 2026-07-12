// Node tests for chat-rag.js's pure helpers: chat doc ids and the
// block-stripping index text (the conventions DRC's drc-rag.js builds on).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chatConvId,
  chatDocId,
  chatIndexText,
  messageIndexText,
} from "./chat-rag.js";

test("chatDocId/chatConvId round-trip; chatConvId rejects non-chat ids", () => {
  const convId = "0f3b1c9a-1234-4abc-9def-0123456789ab";
  assert.equal(chatDocId(convId), "chat-" + convId);
  assert.equal(chatConvId(chatDocId(convId)), convId);
  assert.equal(chatConvId("some-file-uuid"), null);
  assert.equal(chatConvId(""), null);
  assert.equal(chatConvId(undefined), null);
});

test("messageIndexText reads string and multimodal content", () => {
  assert.equal(messageIndexText({ role: "user", content: "  plain question  " }), "plain question");
  assert.equal(
    messageIndexText({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } },
        { type: "text", text: "what is in this photo?" },
      ],
    }),
    "what is in this photo?",
  );
  assert.equal(messageIndexText({ role: "user", content: [] }), "");
  assert.equal(messageIndexText(null), "");
});

test("messageIndexText strips every appended context-block family", () => {
  const blocks = [
    "\n\n--- Attached document: report.pdf ---\nsecret doc text\n--- End of document ---",
    "\n\n--- Project: Alpha ---\ninventory\n--- End of project ---",
    "\n\n--- Related project chat: Earlier chat (an earlier conversation in this project, indexed for retrieval) ---\nexcerpt\n--- End of chat excerpts ---",
    "\n\n--- Image metadata: photo.jpg ---\nGPS: 1, 2\n--- End of image metadata ---",
  ];
  for (const block of blocks) {
    const out = messageIndexText({ role: "user", content: "the real question" + block });
    assert.equal(out, "the real question", "block not stripped: " + block.slice(0, 40));
  }
  // Everything after the FIRST block goes, even when several follow.
  const out = messageIndexText({ role: "user", content: "q" + blocks[1] + blocks[0] });
  assert.equal(out, "q");
});

test("chatIndexText labels turns and leads with the title on the first increment only", () => {
  const messages = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" },
    { role: "assistant", content: "second answer" },
  ];
  const first = chatIndexText(messages.slice(0, 2), 0, "My research");
  assert.ok(first.startsWith("Conversation: My research\n\n"));
  assert.ok(first.includes("User:\nfirst question"));
  assert.ok(first.includes("Assistant:\nfirst answer"));

  const increment = chatIndexText(messages, 2, "My research");
  assert.ok(!increment.includes("Conversation:"));
  assert.ok(!increment.includes("first question"));
  assert.ok(increment.includes("User:\nfollow-up"));
  assert.ok(increment.includes("Assistant:\nsecond answer"));
});

test("chatIndexText skips empty messages and returns '' when nothing is indexable", () => {
  assert.equal(chatIndexText([], 0, "t"), "");
  assert.equal(chatIndexText([{ role: "user", content: "   " }], 0, "t"), "");
  const out = chatIndexText(
    [
      { role: "user", content: [{ type: "image_url", image_url: {} }] },
      { role: "assistant", content: "described the image" },
    ],
    0,
    "",
  );
  assert.equal(out, "Assistant:\ndescribed the image");
});

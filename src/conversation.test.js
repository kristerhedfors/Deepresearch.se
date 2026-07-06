import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textOf, countImages, lastUserMessage, imagePartsOf, formatConversation, withImageNudge } from "./conversation.js";

describe("textOf", () => {
  test("plain string content passes through", () => {
    assert.equal(textOf("hello"), "hello");
  });
  test("multimodal array concatenates text parts", () => {
    const content = [{ type: "text", text: "part one" }, { type: "text", text: "part two" }];
    assert.equal(textOf(content), "part one\npart two");
  });
  test("images append a count marker", () => {
    const content = [
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
    ];
    assert.equal(textOf(content), "look at this\n[1 image attached]");
  });
  test("image-only content still gets the marker, singular vs plural", () => {
    const one = [{ type: "image_url", image_url: { url: "x" } }];
    const two = [{ type: "image_url", image_url: { url: "x" } }, { type: "image_url", image_url: { url: "y" } }];
    assert.equal(textOf(one), "[1 image attached]");
    assert.equal(textOf(two), "[2 images attached]");
  });
  test("non-string, non-array content returns empty string, not a throw", () => {
    assert.equal(textOf(null), "");
    assert.equal(textOf(undefined), "");
    assert.equal(textOf(42), "");
  });
});

describe("countImages", () => {
  test("counts image_url parts across all messages", () => {
    const messages = [
      { role: "user", content: "text only" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "a" } }] },
      { role: "assistant", content: [{ type: "image_url", image_url: { url: "b" } }, { type: "image_url", image_url: { url: "c" } }] },
    ];
    assert.equal(countImages(messages), 3);
  });
  test("zero for an all-text conversation", () => {
    assert.equal(countImages([{ role: "user", content: "hi" }]), 0);
  });
});

describe("lastUserMessage", () => {
  test("finds the most recent user message, ignoring trailing assistant turns", () => {
    const conv = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    assert.equal(lastUserMessage(conv).content, "second");
  });
  test("undefined when there is no user message at all", () => {
    assert.equal(lastUserMessage([{ role: "assistant", content: "hi" }]), undefined);
  });
});

describe("imagePartsOf", () => {
  test("extracts only image_url parts", () => {
    const msg = { content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "y" } }] };
    const parts = imagePartsOf(msg);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, "image_url");
  });
  test("empty for string content or a missing message", () => {
    assert.deepEqual(imagePartsOf({ content: "text" }), []);
    assert.deepEqual(imagePartsOf(undefined), []);
  });
});

describe("formatConversation", () => {
  test("labels turns by role and truncates to the last HISTORY_TURNS", () => {
    const conv = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const out = formatConversation(conv);
    const lines = out.split("\n");
    assert.equal(lines.length, 8, "only the last 8 turns are included");
    assert.ok(lines[0].startsWith("User: turn 4") || lines[0].startsWith("Assistant: turn 4"));
  });
});

describe("withImageNudge", () => {
  test("adds an explicit instruction when the last message is image-only", () => {
    const conv = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const nudged = withImageNudge(conv);
    const parts = nudged[nudged.length - 1].content;
    assert.equal(parts[0].type, "text");
    assert.match(parts[0].text, /No text was provided/);
  });
  test("leaves a message with real text untouched", () => {
    const conv = [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "x" } }] }];
    const nudged = withImageNudge(conv);
    assert.equal(nudged, conv, "returns the same array reference when no nudge is needed");
  });
  test("leaves plain string content and empty conversations alone", () => {
    assert.deepEqual(withImageNudge([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
    assert.deepEqual(withImageNudge([]), []);
  });
});

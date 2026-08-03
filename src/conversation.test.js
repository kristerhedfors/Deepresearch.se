// Unit tests for conversation.js: the message-array/content helpers (text
// view, image counting, last/previous user turn, non-mutating appenders).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { textOf, countImages, lastUserMessage, lastUserText, appendToLast, previousUserText, imagePartsOf, formatConversation, withImageNudge, withAppendedText, withAppendedImage, starterRefOf, withoutStarterTags } from "./conversation.js";

describe("previousUserText", () => {
  test("returns the user message before the latest one", () => {
    const convo = [
      { role: "user", content: "first question about Northvolt" },
      { role: "assistant", content: "some answer" },
      { role: "user", content: "undersök saken" },
    ];
    assert.equal(previousUserText(convo), "first question about Northvolt");
  });

  test("returns empty string when there is only one user turn", () => {
    assert.equal(previousUserText([{ role: "user", content: "only message" }]), "");
    assert.equal(previousUserText([]), "");
  });

  test("reads text out of multimodal content", () => {
    const convo = [
      { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:," } }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and now?" },
    ];
    assert.match(previousUserText(convo), /look at this/);
  });
});

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

describe("lastUserText", () => {
  test("returns the latest user turn's string content, ignoring later assistant turns", () => {
    const convo = [
      { role: "user", content: "an older question" },
      { role: "user", content: "vilka prover finns från Gotland?" },
      { role: "assistant", content: "an answer that must not be read" },
    ];
    assert.equal(lastUserText(convo), "vilka prover finns från Gotland?");
  });

  test("joins multipart text with a space and ignores image parts", () => {
    const convo = [{
      role: "user",
      content: [
        { type: "text", text: "which model" },
        { type: "image_url", image_url: { url: "data:," } },
        { type: "text", text: "is cheapest?" },
      ],
    }];
    // A space, not textOf's newline: the callers are intent gates matching
    // phrases across the parts, and no "[1 image attached]" marker is added.
    assert.equal(lastUserText(convo), "which model is cheapest?");
  });

  test("tolerates missing text, missing messages and non-string content", () => {
    assert.equal(lastUserText([]), "");
    assert.equal(lastUserText([{ role: "assistant", content: "no user turn" }]), "");
    assert.equal(lastUserText([{ role: "user", content: null }]), "", "unknown content shape stops the walk");
    assert.equal(
      lastUserText([{ role: "user", content: [{ type: "text" }, { type: "text", text: "b" }] }]),
      " b",
      "a text part with no text contributes an empty string",
    );
  });
});

describe("appendToLast", () => {
  test("appends a blank-line-separated block to string content, non-mutating", () => {
    const msg = { role: "user", content: "what does this say?" };
    const out = appendToLast(msg, "SAMPLES: none matched");
    assert.equal(out.content, "what does this say?\n\nSAMPLES: none matched");
    assert.equal(msg.content, "what does this say?", "original untouched");
  });

  test("adds a NEW text part to multipart content so the attachment survives", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "what is in this photo?" },
        { type: "image_url", image_url: { url: "data:," } },
      ],
    };
    const out = appendToLast(msg, "MODELS: …");
    assert.equal(out.content.length, 3);
    assert.deepEqual(out.content[2], { type: "text", text: "MODELS: …" });
    assert.equal(out.content[1].image_url.url, "data:,", "the image part rides along");
    assert.equal(out.content[0].text, "what is in this photo?", "the typed text is not edited in place");
    assert.equal(msg.content.length, 2, "original untouched");
  });

  test("passes through a missing message and an unknown content shape", () => {
    assert.equal(appendToLast(null, "block"), null);
    assert.equal(appendToLast(undefined, "block"), undefined);
    const odd = { role: "user", content: 42 };
    assert.equal(appendToLast(odd, "block"), odd, "returned unchanged rather than corrupted");
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

describe("withAppendedText", () => {
  test("appends to string content", () => {
    const conv = [{ role: "user", content: "hi" }];
    const out = withAppendedText(conv, "\n\nextra");
    assert.equal(out[0].content, "hi\n\nextra");
    assert.equal(conv[0].content, "hi", "original message is untouched");
  });

  test("appends to an existing text part in array content", () => {
    const conv = [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "x" } }] }];
    const out = withAppendedText(conv, "\n\nextra");
    assert.equal(out[0].content[0].text, "hi\n\nextra");
    assert.equal(out[0].content[1].type, "image_url");
  });

  test("adds a new leading text part when array content has none (image-only send)", () => {
    const conv = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const out = withAppendedText(conv, "extra");
    assert.equal(out[0].content[0].type, "text");
    assert.equal(out[0].content[0].text, "extra");
    assert.equal(out[0].content[1].type, "image_url");
  });

  test("returns the same reference when extraText is empty/falsy", () => {
    const conv = [{ role: "user", content: "hi" }];
    assert.equal(withAppendedText(conv, ""), conv);
    assert.equal(withAppendedText(conv, null), conv);
  });

  test("returns the same reference for an empty conversation", () => {
    assert.deepEqual(withAppendedText([], "extra"), []);
  });

  test("only modifies the LAST message, earlier turns are untouched", () => {
    const conv = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    const out = withAppendedText(conv, "!");
    assert.equal(out[0].content, "first");
    assert.equal(out[1].content, "reply");
    assert.equal(out[2].content, "second!");
  });
});

describe("withAppendedImage", () => {
  test("turns string content into a two-part array (text + image)", () => {
    const conv = [{ role: "user", content: "look here" }];
    const out = withAppendedImage(conv, "data:image/jpeg;base64,x");
    assert.equal(out[0].content[0].type, "text");
    assert.equal(out[0].content[0].text, "look here");
    assert.equal(out[0].content[1].type, "image_url");
    assert.equal(out[0].content[1].image_url.url, "data:image/jpeg;base64,x");
    assert.equal(conv[0].content, "look here", "original message is untouched");
  });

  test("empty string content yields an image-only array", () => {
    const conv = [{ role: "user", content: "" }];
    const out = withAppendedImage(conv, "data:image/jpeg;base64,x");
    assert.equal(out[0].content.length, 1);
    assert.equal(out[0].content[0].type, "image_url");
  });

  test("pushes the image onto existing array content", () => {
    const conv = [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "a" } }] }];
    const out = withAppendedImage(conv, "b");
    assert.equal(out[0].content.length, 3);
    assert.equal(out[0].content[2].image_url.url, "b");
    assert.equal(conv[0].content.length, 2, "original array untouched");
  });

  test("returns the same reference when url is falsy or conversation empty", () => {
    const conv = [{ role: "user", content: "hi" }];
    assert.equal(withAppendedImage(conv, ""), conv);
    assert.equal(withAppendedImage(conv, null), conv);
    assert.deepEqual(withAppendedImage([], "x"), []);
  });

  test("only touches the last message", () => {
    const conv = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    const out = withAppendedImage(conv, "x");
    assert.equal(out[0].content, "first");
    assert.equal(Array.isArray(out[1].content), true);
  });
});

// The starter-prompt tag (#XP-07) an evaluation-mode chip prepends to its
// question. It has to reach the chat log and the feedback entry, and it must
// NOT reach a model — triage would plan against it and the search queries
// would carry it, so the thing being evaluated would no longer be the starter.
describe("starter tags", () => {
  test("starterRefOf reads the tag off the first user turn", () => {
    const conv = [
      { role: "user", content: "#XP-07 Where does your own source code live?" },
      { role: "assistant", content: "…" },
      { role: "user", content: "and how is it retrieved?" },
    ];
    assert.deepEqual(starterRefOf(conv), { xp: 7, tag: "#XP-07" });
    assert.equal(starterRefOf([{ role: "user", content: "just a question" }]), null);
    assert.equal(starterRefOf([]), null);
    // A tag typed mid-conversation is not a starter — only the opening turn
    // can be one, so only the opening turn is consulted.
    assert.equal(starterRefOf([
      { role: "user", content: "hello" },
      { role: "user", content: "#XP-07 later" },
    ]), null);
  });

  test("withoutStarterTags strips every user turn, non-mutating", () => {
    const conv = [
      { role: "user", content: "#XP-07 Where does your own source code live?" },
      { role: "assistant", content: "#XP-07 stays here — assistant turns are untouched" },
      { role: "user", content: "#xp7: och på svenska?" },
    ];
    const out = withoutStarterTags(conv);
    assert.equal(out[0].content, "Where does your own source code live?");
    assert.equal(out[1].content, "#XP-07 stays here — assistant turns are untouched");
    assert.equal(out[2].content, "och på svenska?");
    assert.equal(conv[0].content, "#XP-07 Where does your own source code live?", "original untouched");
  });

  test("withoutStarterTags handles multimodal content and returns the same reference when there is nothing to strip", () => {
    const withImage = [{
      role: "user",
      content: [{ type: "text", text: "#XP-12 what is in this photo?" }, { type: "image_url", image_url: { url: "a" } }],
    }];
    const out = withoutStarterTags(withImage);
    assert.equal(out[0].content[0].text, "what is in this photo?");
    assert.equal(out[0].content[1].image_url.url, "a", "the image part rides along");

    const plain = [{ role: "user", content: "an ordinary question" }];
    assert.equal(withoutStarterTags(plain), plain, "untagged conversations are not copied");
    assert.deepEqual(withoutStarterTags([]), []);
    assert.equal(withoutStarterTags(null), null);
  });
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateMessages, resolveModel } from "./validation.js";
import { DEFAULT_MODEL } from "./berget.js";

const noopLog = { warn: () => {} };

describe("validateMessages", () => {
  test("rejects a non-array or empty messages value", () => {
    assert.match(validateMessages(null), /non-empty/);
    assert.match(validateMessages([]), /non-empty/);
  });

  test("rejects more than 60 messages", () => {
    const messages = Array.from({ length: 61 }, () => ({ role: "user", content: "hi" }));
    assert.match(validateMessages(messages), /too long/);
  });

  test("accepts exactly 60 messages", () => {
    const messages = Array.from({ length: 60 }, () => ({ role: "user", content: "hi" }));
    assert.equal(validateMessages(messages), null);
  });

  test("rejects an unknown role", () => {
    const messages = [{ role: "system", content: "hi" }];
    assert.match(validateMessages(messages), /role `user` or `assistant`/);
  });

  test("rejects a string message over the character limit", () => {
    const messages = [{ role: "user", content: "x".repeat(32_001) }];
    assert.match(validateMessages(messages), /character limit/);
  });

  test("accepts a string message at exactly the character limit", () => {
    const messages = [{ role: "user", content: "x".repeat(32_000) }];
    assert.equal(validateMessages(messages), null);
  });

  test("rejects content that is neither a string nor a non-empty array", () => {
    assert.match(validateMessages([{ role: "user", content: 42 }]), /string or a non-empty array/);
    assert.match(validateMessages([{ role: "user", content: [] }]), /string or a non-empty array/);
  });

  test("rejects an unsupported content part type", () => {
    const messages = [{ role: "user", content: [{ type: "video", url: "x" }] }];
    assert.match(validateMessages(messages), /Unsupported message content part/);
  });

  test("sums text parts against the per-message character limit", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "text", text: "y".repeat(20_000) },
        ],
      },
    ];
    assert.match(validateMessages(messages), /character limit/);
  });

  test("rejects an image_url part whose url is not a data:image/ URL", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }];
    assert.match(validateMessages(messages), /data:image/);
  });

  test("rejects a single image over the per-image size cap", () => {
    const url = "data:image/png;base64," + "a".repeat(300_000);
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }];
    assert.match(validateMessages(messages), /too large after encoding/);
  });

  test("rejects more than 4 images in one message", () => {
    const part = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
    const messages = [{ role: "user", content: [part, part, part, part, part] }];
    assert.match(validateMessages(messages), /Too many images in one message/);
  });

  test("rejects more than 8 images across the whole conversation", () => {
    const part = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
    const messages = Array.from({ length: 9 }, () => ({ role: "user", content: [part] }));
    assert.match(validateMessages(messages), /Too many images in the conversation/);
  });

  test("rejects total image bytes over the per-request cap even under the per-message/per-request count caps", () => {
    const url = "data:image/png;base64," + "a".repeat(200_000);
    const part = { type: "image_url", image_url: { url } };
    // 4 images x 200,000 chars = 800,000 > 750,000 total cap, but only 1 message and 4 images (both under their own caps).
    const messages = [{ role: "user", content: [part, part, part, part] }];
    assert.match(validateMessages(messages), /provider's request size limit/);
  });

  test("accepts a well-formed mixed text+image conversation", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];
    assert.equal(validateMessages(messages), null);
  });
});

describe("resolveModel", () => {
  const catalog = [
    { id: "vision-model", name: "Vision Model", up: true, vision: true },
    { id: "text-model", name: "Text Model", up: true, vision: false },
    { id: "down-model", name: "Down Model", up: false, vision: true },
  ];

  test("no model in body and no catalog falls back to the env default", () => {
    const result = resolveModel({ messages: [] }, null, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });

  test("unknown model id against a real catalog is rejected", () => {
    const result = resolveModel({ model: "nonexistent", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /Unknown model/);
  });

  test("a model marked down in the catalog is rejected", () => {
    const result = resolveModel({ model: "down-model", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /temporarily unavailable/);
  });

  test("a valid, up model in the catalog is accepted", () => {
    const result = resolveModel({ model: "text-model", messages: [] }, catalog, {}, noopLog);
    assert.equal(result.model, "text-model");
  });

  test("a requested model is ignored (not validated) when the catalog is unreachable", () => {
    const result = resolveModel({ model: "text-model", messages: [] }, null, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });

  test("images present + resolved model lacks vision is rejected, listing vision-capable alternatives", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ model: "text-model", messages }, catalog, {}, noopLog);
    assert.equal(result.status, 400);
    assert.match(result.error, /does not support image input/);
    assert.match(result.error, /Vision Model/);
  });

  test("images present + resolved model has vision is accepted", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ model: "vision-model", messages }, catalog, {}, noopLog);
    assert.equal(result.model, "vision-model");
  });

  test("images present but the resolved model isn't found in the catalog: not rejected on vision grounds", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const result = resolveModel({ messages }, catalog, {}, noopLog);
    assert.equal(result.model, DEFAULT_MODEL);
  });
});

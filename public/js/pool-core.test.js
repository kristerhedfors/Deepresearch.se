// Unit tests for pool-core.js — the DRSC/1 strict wire profile for pooled
// completions. The contract under test: unknown fields are STRIPPED, sizes
// clamp, structural problems reject with stable codes, and stream is forced
// false — client and server share this exact function, so this suite is the
// wire spec.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POOL_MAX_COMPLETION_TOKENS,
  POOL_MAX_MESSAGES,
  POOL_ROLES,
  POOL_WIRE_V,
  poolDataFlowNotice,
  poolRequestToOpenAiBody,
  sanitizePoolRequest,
} from "./pool-core.js";

const GOOD = {
  model: "llama3",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" },
  ],
};

describe("sanitizePoolRequest", () => {
  it("passes a minimal valid body through, stamped and stream:false", () => {
    const out = sanitizePoolRequest(GOOD);
    assert.ok("request" in out);
    assert.equal(out.request.wire, POOL_WIRE_V);
    assert.equal(out.request.stream, false);
    assert.equal(out.request.model, "llama3");
    assert.deepEqual(out.request.messages, GOOD.messages);
  });

  it("strips everything outside the whitelist", () => {
    const out = sanitizePoolRequest({
      ...GOOD,
      stream: true,
      tools: [{ type: "function" }],
      functions: [{}],
      response_format: { type: "json_object" },
      logit_bias: { 1: 5 },
      n: 4,
      user: "someone",
      metadata: { a: 1 },
      api_key: "sneaky",
    });
    assert.ok("request" in out);
    assert.deepEqual(
      Object.keys(out.request).sort(),
      ["messages", "model", "stream", "wire"],
    );
    assert.equal(out.request.stream, false);
  });

  it("keeps only the two tuning knobs, clamped", () => {
    const out = sanitizePoolRequest({ ...GOOD, temperature: 9, max_tokens: 1e9, top_p: 0.5 });
    assert.equal(out.request.temperature, 2);
    assert.equal(out.request.max_tokens, POOL_MAX_COMPLETION_TOKENS);
    assert.equal("top_p" in out.request, false);
    const neg = sanitizePoolRequest({ ...GOOD, temperature: -3 });
    assert.equal(neg.request.temperature, 0);
    const mct = sanitizePoolRequest({ ...GOOD, max_completion_tokens: 42 });
    assert.equal(mct.request.max_tokens, 42);
  });

  it("rejects structural problems with stable codes", () => {
    assert.equal(sanitizePoolRequest(null).code, "bad_body");
    assert.equal(sanitizePoolRequest([]).code, "bad_body");
    assert.equal(sanitizePoolRequest({ messages: GOOD.messages }).code, "bad_model");
    assert.equal(sanitizePoolRequest({ model: "m", messages: [] }).code, "bad_messages");
    assert.equal(sanitizePoolRequest({ model: "m", messages: [null] }).code, "bad_message");
    assert.equal(sanitizePoolRequest({ model: "m", messages: [{ role: "tool", content: "x" }] }).code, "bad_role");
    assert.equal(
      sanitizePoolRequest({ model: "m", messages: [{ role: "user", content: [{ type: "text" }] }] }).code,
      "bad_content",
    );
    const many = { model: "m", messages: Array.from({ length: POOL_MAX_MESSAGES + 1 }, () => ({ role: "user", content: "x" })) };
    assert.equal(sanitizePoolRequest(many).code, "too_many_messages");
  });

  it("caps the total conversation size", () => {
    const big = "x".repeat(31_000);
    const body = { model: "m", messages: Array.from({ length: 6 }, () => ({ role: "user", content: big })) };
    assert.equal(sanitizePoolRequest(body).code, "too_large");
  });

  it("returns a NEW object — the input is never mutated", () => {
    const body = { ...GOOD, stream: true };
    const out = sanitizePoolRequest(body);
    assert.equal(body.stream, true);
    assert.notEqual(out.request, body);
    assert.notEqual(out.request.messages, body.messages);
  });

  it("the closed role vocabulary is system/user/assistant", () => {
    assert.deepEqual(POOL_ROLES, ["system", "user", "assistant"]);
  });
});

describe("poolRequestToOpenAiBody", () => {
  it("drops the wire marker and nothing else", () => {
    const { request } = sanitizePoolRequest({ ...GOOD, temperature: 1 });
    const body = poolRequestToOpenAiBody(request);
    assert.equal("wire" in body, false);
    assert.equal(body.model, "llama3");
    assert.equal(body.temperature, 1);
    assert.equal(body.stream, false);
  });
});

describe("poolDataFlowNotice", () => {
  it("names the pool owner and states the peer-read exposure plainly", () => {
    const lines = poolDataFlowNotice({ ownerLabel: "Alice" });
    assert.ok(lines.length >= 3);
    const all = lines.join("\n");
    assert.ok(all.includes("Alice's machine"));
    assert.ok(all.includes("Alice can read everything you send"));
    assert.ok(all.includes("DRSC/1"));
  });

  it("falls back to a generic owner label", () => {
    const all = poolDataFlowNotice().join("\n");
    assert.ok(all.includes("the pool owner"));
  });
});

// Unit tests for knowledge-core.js — the workspace-knowledge curation model
// (conclusions, ±block tagging with undo/redo) and the drskn sealed envelope.
// Real WebCrypto round-trips in Node, no mocks — the point is that the sealed
// box opens with the matching private key and fails closed otherwise, and
// that the curation reducer never loses work.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_TAGS,
  CONCLUSION_KIND,
  KNOWLEDGE_KIND,
  buildConclusion,
  buildKnowledgeBundle,
  conclusionToContext,
  curate,
  curationState,
  finalizeConclusion,
  generateKnowledgeKeypair,
  knowledgeKid,
  openKnowledge,
  sealKnowledge,
  splitBlocks,
  summarizeContext,
  validateConclusion,
  validateKnowledgeEnvelope,
} from "./knowledge-core.js";

const REPLY = [
  "First paragraph of the answer.",
  "Second paragraph, the key insight.",
  "```js\nconst x = 1;\n\nconst y = 2;\n```",
  "A closing remark.",
].join("\n\n");

function sampleConclusion() {
  return buildConclusion({
    query: "What is the key insight?",
    reply: REPLY,
    contextSummary: "A conversation about insights.",
    model: "llama3",
  });
}

describe("splitBlocks", () => {
  it("splits prose on blank lines and keeps fenced code whole", () => {
    const blocks = splitBlocks(REPLY);
    assert.equal(blocks.length, 4);
    assert.ok(blocks[2].text.startsWith("```js"));
    assert.ok(blocks[2].text.includes("const y = 2;"));
    assert.deepEqual(blocks.map((b) => b.id), ["b0", "b1", "b2", "b3"]);
    assert.ok(blocks.every((b) => b.tag === "neutral"));
  });

  it("is deterministic and tolerant of junk input", () => {
    assert.deepEqual(splitBlocks(""), []);
    assert.deepEqual(splitBlocks(null), []);
    assert.deepEqual(splitBlocks(REPLY), splitBlocks(REPLY));
  });
});

describe("summarizeContext", () => {
  it("compresses the trailing turns, one labeled line each, truncated", () => {
    const messages = [
      { role: "user", content: "First question about a topic" },
      { role: "assistant", content: "x".repeat(500) },
      { role: "system", content: "ignored" },
      { role: "user", content: "  follow   up\nwith  whitespace " },
    ];
    const s = summarizeContext(messages, { perTurnChars: 40 });
    const lines = s.split("\n");
    assert.equal(lines.length, 3); // the system turn is skipped
    assert.equal(lines[0], "Q: First question about a topic");
    assert.ok(lines[1].startsWith("A: ") && lines[1].endsWith("…") && lines[1].length <= 43);
    assert.equal(lines[2], "Q: follow up with whitespace");
  });

  it("is empty-safe and bounded by maxTurns", () => {
    assert.equal(summarizeContext([]), "");
    assert.equal(summarizeContext(null), "");
    const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: "m" + i }));
    assert.equal(summarizeContext(many, { maxTurns: 3 }).split("\n").length, 3);
  });
});

describe("conclusions", () => {
  it("builds a valid conclusion carrying summary + query + blocks", () => {
    const c = sampleConclusion();
    assert.equal(c.kind, CONCLUSION_KIND);
    assert.ok(validateConclusion(c));
    assert.equal(c.query, "What is the key insight?");
    assert.equal(c.summary, "A conversation about insights.");
    assert.equal(c.blocks.length, 4);
  });

  it("rejects malformed conclusions", () => {
    assert.equal(validateConclusion(null), false);
    assert.equal(validateConclusion({}), false);
    const c = sampleConclusion();
    c.blocks.push({ id: "bX", text: "t", tag: "bogus" });
    assert.equal(validateConclusion(c), false);
  });
});

describe("curation reducer", () => {
  it("plus/minus tag blocks; a second tap toggles back to neutral", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "plus", blockId: "b1" });
    assert.equal(st.conclusion.blocks[1].tag, "plus");
    curate(st, { type: "plus", blockId: "b1" });
    assert.equal(st.conclusion.blocks[1].tag, "neutral");
    curate(st, { type: "minus", blockId: "b3" });
    assert.equal(st.conclusion.blocks[3].tag, "minus");
  });

  it("undo and redo walk the full history", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "plus", blockId: "b0" });
    curate(st, { type: "minus", blockId: "b3" });
    assert.equal(st.conclusion.blocks[0].tag, "plus");
    assert.equal(st.conclusion.blocks[3].tag, "minus");
    curate(st, { type: "undo" });
    assert.equal(st.conclusion.blocks[3].tag, "neutral");
    curate(st, { type: "undo" });
    assert.equal(st.conclusion.blocks[0].tag, "neutral");
    curate(st, { type: "redo" });
    curate(st, { type: "redo" });
    assert.equal(st.conclusion.blocks[0].tag, "plus");
    assert.equal(st.conclusion.blocks[3].tag, "minus");
  });

  it("a new edit clears the redo line", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "plus", blockId: "b0" });
    curate(st, { type: "undo" });
    curate(st, { type: "minus", blockId: "b1" });
    curate(st, { type: "redo" }); // nothing to redo — the edit invalidated it
    assert.equal(st.conclusion.blocks[0].tag, "neutral");
    assert.equal(st.conclusion.blocks[1].tag, "minus");
  });

  it("unknown actions and block ids are no-ops, undo on empty history too", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "undo" });
    curate(st, { type: "explode", blockId: "b0" });
    curate(st, { type: "plus", blockId: "nope" });
    curate(st, { type: "tag", blockId: "b0", tag: "bogus" });
    assert.ok(st.conclusion.blocks.every((b) => b.tag === "neutral"));
    assert.equal(st.past.length, 0);
  });

  it("BLOCK_TAGS is the closed tag vocabulary", () => {
    assert.deepEqual(BLOCK_TAGS, ["plus", "neutral", "minus"]);
  });
});

describe("finalize + context rendering", () => {
  it("finalize removes minus blocks entirely; the curation copy keeps them", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "minus", blockId: "b3" });
    const shipped = finalizeConclusion(st.conclusion);
    assert.equal(shipped.blocks.length, 3);
    assert.ok(!shipped.blocks.some((b) => b.id === "b3"));
    assert.equal(st.conclusion.blocks.length, 4); // undo can still restore
  });

  it("context puts plus blocks under Key points and excludes minus", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "plus", blockId: "b1" });
    curate(st, { type: "minus", blockId: "b3" });
    const ctx = conclusionToContext(finalizeConclusion(st.conclusion));
    assert.ok(ctx.includes("Context: A conversation about insights."));
    assert.ok(ctx.includes("Question: What is the key insight?"));
    assert.ok(ctx.includes("Key points:\nSecond paragraph, the key insight."));
    assert.ok(!ctx.includes("A closing remark."));
  });
});

describe("the drskn sealed envelope", () => {
  it("seals to a public key and opens with the matching private JWK", async () => {
    const kp = await generateKnowledgeKeypair();
    const bundle = buildKnowledgeBundle({ conclusions: [sampleConclusion()], workspace: "ws-1", from: "anna" });
    const env = await sealKnowledge(bundle, kp.publicKeyB64);
    assert.equal(env.kind, KNOWLEDGE_KIND);
    assert.ok(validateKnowledgeEnvelope(env));
    assert.equal(env.kid, await knowledgeKid(kp.publicKeyB64));
    const opened = await openKnowledge(env, kp.privateJwk);
    assert.ok(opened);
    assert.equal(opened.workspace, "ws-1");
    assert.equal(opened.conclusions.length, 1);
    assert.equal(opened.conclusions[0].query, "What is the key insight?");
  });

  it("fails closed: wrong key, tampering, malformed envelopes", async () => {
    const kp = await generateKnowledgeKeypair();
    const other = await generateKnowledgeKeypair();
    const env = await sealKnowledge({ hello: "world" }, kp.publicKeyB64);
    assert.equal(await openKnowledge(env, other.privateJwk), null);
    const tampered = { ...env, ct: env.ct.slice(0, -4) + (env.ct.endsWith("AAAA") ? "BBBB" : "AAAA") };
    assert.equal(await openKnowledge(tampered, kp.privateJwk), null);
    assert.equal(await openKnowledge(null, kp.privateJwk), null);
    assert.equal(await openKnowledge({ ...env, kind: "drcr-result" }, kp.privateJwk), null);
  });

  it("two seals of the same bundle are unlinkable (fresh ephemerals)", async () => {
    const kp = await generateKnowledgeKeypair();
    const a = await sealKnowledge({ x: 1 }, kp.publicKeyB64);
    const b = await sealKnowledge({ x: 1 }, kp.publicKeyB64);
    assert.notEqual(a.epk, b.epk);
    assert.notEqual(a.ct, b.ct);
  });

  it("buildKnowledgeBundle finalizes and drops invalid conclusions", () => {
    const st = curationState(sampleConclusion());
    curate(st, { type: "minus", blockId: "b0" });
    const bundle = buildKnowledgeBundle({ conclusions: [st.conclusion, { junk: true }] });
    assert.equal(bundle.conclusions.length, 1);
    assert.ok(!bundle.conclusions[0].blocks.some((b) => b.id === "b0"));
  });
});

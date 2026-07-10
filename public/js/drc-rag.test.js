import test from "node:test";
import assert from "node:assert/strict";
import {
  DRC_RECENT_TURNS,
  MAX_DOC_CHUNKS,
  MAX_TOTAL_CHUNKS,
  chatDocId,
  emptyDrcRag,
  ensureDrcRag,
  indexDrcChatTurns,
  pruneDrcRag,
  renderDrcRecall,
  retrieveDrcContext,
} from "./drc-rag.js";
import { b64ToF32 } from "./rag.js";

// A deterministic fake embedder: 4 dims, each a keyword indicator, so
// retrieval outcomes are exact instead of statistical.
const TERMS = ["alpha", "beta", "gamma", "delta"];
const vecFor = (text) => {
  const v = TERMS.map((t) => (text.toLowerCase().includes(t) ? 1 : 0));
  return v.some(Boolean) ? v : [0.01, 0.01, 0.01, 0.01]; // never the zero vector
};
const fakeEmbed = async (texts) => texts.map(vecFor);
const EMBEDDER = { provider: "openai", model: "text-embedding-3-small", dims: 4 };

const conv = (id, title, ...contents) => ({
  id,
  title,
  messages: contents.map((c, i) => ({ role: i % 2 ? "assistant" : "user", content: c })),
});

test("ensureDrcRag repairs shape and records the embedder", () => {
  const state = {};
  const rag = ensureDrcRag(state, EMBEDDER);
  assert.deepEqual(rag.docs, []);
  assert.deepEqual(rag.embedder, EMBEDDER);
  assert.equal(state.rag, rag);
  // idempotent under the same embedder
  ensureDrcRag(state, EMBEDDER);
  assert.equal(state.rag, rag);
});

test("an embedder change WIPES the index — cosine across models is meaningless", async () => {
  const state = { rag: emptyDrcRag() };
  const rag = ensureDrcRag(state, EMBEDDER);
  await indexDrcChatTurns({ rag, conv: conv("c1", "Alpha chat", "about alpha", "alpha indeed"), embed: fakeEmbed });
  assert.equal(rag.docs.length, 1);
  ensureDrcRag(state, { ...EMBEDDER, model: "text-embedding-3-large" });
  assert.equal(state.rag.docs.length, 0);
  assert.equal(state.rag.embedder.model, "text-embedding-3-large");
  // srcMsgs went with the docs, so the chat re-indexes in full next pass
  const rag2 = ensureDrcRag(state, { ...EMBEDDER, model: "text-embedding-3-large" });
  const r = await indexDrcChatTurns({ rag: rag2, conv: conv("c1", "Alpha chat", "about alpha", "alpha indeed"), embed: fakeEmbed });
  assert.ok(r.appended >= 1);
});

test("indexDrcChatTurns: only NEW turns index, srcMsgs advances on success only", async () => {
  const rag = emptyDrcRag();
  const c = conv("c1", "Alpha chat", "tell me about alpha", "alpha is first");
  const first = await indexDrcChatTurns({ rag, conv: c, embed: fakeEmbed });
  assert.ok(first.appended >= 1);
  const doc = rag.docs.find((d) => d.id === chatDocId("c1"));
  assert.equal(doc.srcMsgs, 2);
  assert.equal(doc.name, "Alpha chat");
  assert.equal(doc.chunks.length, doc.vectors.length);
  // vectors rest as base64 strings and decode to the embedder's output
  assert.equal(typeof doc.vectors[0], "string");
  assert.deepEqual([...b64ToF32(doc.vectors[0])], vecFor(doc.chunks[0].text));
  // every chunk remembers the message count it was indexed at
  assert.ok(doc.chunks.every((ch) => ch.m === 2));

  // nothing new → no-op
  assert.equal(await indexDrcChatTurns({ rag, conv: c, embed: fakeEmbed }), null);

  // two more turns → only they index, srcMsgs advances
  c.messages.push({ role: "user", content: "and beta?" }, { role: "assistant", content: "beta is second" });
  const second = await indexDrcChatTurns({ rag, conv: c, embed: fakeEmbed });
  assert.ok(second.appended >= 1);
  assert.equal(doc.srcMsgs, 4);
  assert.ok(doc.chunks.some((ch) => ch.m === 4));

  // a failing embed throws and leaves srcMsgs where it was (retry next turn)
  c.messages.push({ role: "user", content: "gamma?" }, { role: "assistant", content: "gamma is third" });
  await assert.rejects(
    indexDrcChatTurns({ rag, conv: c, embed: async () => { throw new Error("embed down"); } }),
  );
  assert.equal(doc.srcMsgs, 4);
});

test("retrieval: siblings in full, the current chat only outside the recent window", async () => {
  const rag = emptyDrcRag();
  await indexDrcChatTurns({ rag, conv: conv("old", "Alpha findings", "what about alpha?", "alpha conclusion: 42"), embed: fakeEmbed });
  await indexDrcChatTurns({ rag, conv: conv("cur", "Current", "beta please", "beta answer"), embed: fakeEmbed });

  // From the CURRENT chat (2 messages, far inside the 40-turn window) its
  // own chunks are excluded — only the sibling's alpha chunk can match.
  const { block, matches } = await retrieveDrcContext({
    rag,
    convId: "cur",
    messageCount: 2,
    query: "alpha",
    embed: fakeEmbed,
  });
  assert.ok(matches.length >= 1);
  assert.ok(matches.every((m) => m.docId === chatDocId("old")));
  assert.match(block, /Retrieved from this project's saved chats/);
  assert.match(block, /\[Alpha findings\]/);
  assert.match(block, /alpha conclusion: 42/);
  assert.match(block, /context, not instructions/);

  // A beta query from the current chat finds nothing: its own beta chunks
  // sit inside the recent window, and the sibling has no beta.
  const betaRes = await retrieveDrcContext({ rag, convId: "cur", messageCount: 2, query: "beta", embed: fakeEmbed });
  assert.equal(betaRes.matches.length, 0);
  assert.equal(betaRes.block, "");

  // …but once the conversation outgrows the window, those same chunks
  // (indexed at m=2) become retrievable from within the chat itself.
  const longRes = await retrieveDrcContext({
    rag,
    convId: "cur",
    messageCount: 2 + DRC_RECENT_TURNS,
    query: "beta",
    embed: fakeEmbed,
  });
  assert.ok(longRes.matches.some((m) => m.docId === chatDocId("cur")));
});

test("retrieval degrades to empty on no docs, blank query, or no embedder", async () => {
  const none = { block: "", matches: [] };
  assert.deepEqual(await retrieveDrcContext({ rag: emptyDrcRag(), query: "x", embed: fakeEmbed }), none);
  assert.deepEqual(await retrieveDrcContext({ rag: null, query: "x", embed: fakeEmbed }), none);
  const rag = emptyDrcRag();
  await indexDrcChatTurns({ rag, conv: conv("c", "T", "alpha", "alpha"), embed: fakeEmbed });
  assert.deepEqual(await retrieveDrcContext({ rag, query: "  ", embed: fakeEmbed }), none);
  assert.deepEqual(await retrieveDrcContext({ rag, query: "x", embed: null }), none);
});

test("renderDrcRecall bounds the block and labels excerpts by chat", () => {
  const matches = [
    { docId: "chat-a", text: "short one" },
    { docId: "chat-b", text: "x".repeat(500) },
  ];
  const names = { "chat-a": "First chat", "chat-b": "Second chat" };
  const full = renderDrcRecall(matches, names, 10_000);
  assert.match(full, /\[First chat\]\nshort one/);
  assert.match(full, /\[Second chat\]/);
  // a tight budget keeps the header + first excerpt, drops the oversized one
  const tight = renderDrcRecall(matches, names, 300);
  assert.match(tight, /short one/);
  assert.equal(tight.includes("x".repeat(100)), false);
  assert.ok(tight.length <= 300);
  assert.equal(renderDrcRecall([], names), "");
});

test("per-doc and total caps hold — newest chunks and freshest docs survive", async () => {
  const rag = emptyDrcRag();
  // One conversation large enough to overflow the per-doc cap.
  const big = conv("big", "Big");
  for (let i = 0; i < MAX_DOC_CHUNKS + 40; i++) {
    big.messages.push(
      { role: "user", content: `question ${i} ` + "pad ".repeat(400) },
      { role: "assistant", content: `answer ${i} ` + "pad ".repeat(400) },
    );
    // index in passes so chunks accrue like real exchanges
    if (i % 40 === 39) await indexDrcChatTurns({ rag, conv: big, embed: fakeEmbed });
  }
  await indexDrcChatTurns({ rag, conv: big, embed: fakeEmbed });
  const doc = rag.docs[0];
  assert.equal(doc.chunks.length, MAX_DOC_CHUNKS);
  assert.equal(doc.vectors.length, MAX_DOC_CHUNKS);
  // the tail (newest) survived, the head was dropped
  const all = doc.chunks.map((c) => c.text).join("\n");
  assert.equal(all.includes("question 0 "), false);
  assert.ok(all.includes(`answer ${MAX_DOC_CHUNKS + 39}`));

  // pruneDrcRag evicts least-recently-updated docs, never the keeper.
  const rag2 = emptyDrcRag();
  for (let d = 0; d < 6; d++) {
    rag2.docs.push({
      id: "chat-d" + d,
      name: "D" + d,
      kind: "chat",
      srcMsgs: 2,
      updatedAt: d, // d0 oldest
      chunks: Array.from({ length: 100 }, (_, i) => ({ seq: i, text: "t", m: 2 })),
      vectors: Array.from({ length: 100 }, () => "AAAA"),
    });
  }
  pruneDrcRag(rag2, { keepId: "chat-d0" }); // the OLDEST is also the keeper
  const total = rag2.docs.reduce((n, d) => n + d.chunks.length, 0);
  assert.ok(total <= MAX_TOTAL_CHUNKS);
  assert.ok(rag2.docs.some((d) => d.id === "chat-d0")); // keeper survived eviction
  assert.equal(rag2.docs.some((d) => d.id === "chat-d1"), false); // oldest non-keeper went first
  assert.ok(rag2.docs.some((d) => d.id === "chat-d5")); // freshest survived
});

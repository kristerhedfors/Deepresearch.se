import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXCERPT_TOTAL_CHARS,
  deriveTitle,
  imageMetadataBlock,
  inlineDocBlock,
  ragExcerptBlocks,
  stripOldImages,
} from "./message-content.js";

test("deriveTitle uses the first user message's text", () => {
  assert.equal(deriveTitle([{ role: "user", content: "What is the capital of France?" }]), "What is the capital of France?");
  assert.equal(
    deriveTitle([{ role: "assistant", content: "hi" }, { role: "user", content: "Second one" }]),
    "Second one",
  );
});

test("deriveTitle reads the text part of multimodal content", () => {
  const history = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
        { type: "text", text: "Describe this photo" },
      ],
    },
  ];
  assert.equal(deriveTitle(history), "Describe this photo");
});

test("deriveTitle trims, caps at 60 chars, and falls back", () => {
  assert.equal(deriveTitle([{ role: "user", content: "   spaced   " }]), "spaced");
  assert.equal(deriveTitle([{ role: "user", content: "x".repeat(100) }]).length, 60);
  assert.equal(deriveTitle([]), "New conversation");
  assert.equal(deriveTitle([{ role: "user", content: "   " }]), "New conversation");
  assert.equal(deriveTitle([{ role: "user", content: [{ type: "image_url", image_url: {} }] }]), "New conversation");
});

test("stripOldImages keeps the latest message untouched", () => {
  const latest = {
    role: "user",
    content: [
      { type: "text", text: "current question" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZ" } },
    ],
  };
  const history = [{ role: "user", content: "older text" }, { role: "assistant", content: "reply" }, latest];
  const out = stripOldImages(history);
  assert.equal(out[2], latest); // same reference — untouched
  assert.equal(out[0].content, "older text"); // string content passes through
  assert.equal(out[1].content, "reply");
});

test("stripOldImages collapses images out of earlier user turns, keeping their text", () => {
  const history = [
    {
      role: "user",
      content: [
        { type: "text", text: "earlier question" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZ" } },
      ],
    },
    { role: "assistant", content: "answer" },
    { role: "user", content: "latest" },
  ];
  const out = stripOldImages(history);
  assert.equal(out[0].content, "earlier question\n[image was attached earlier in this conversation]");
  assert.ok(!Array.isArray(out[0].content));
});

test("stripOldImages marks an image-only earlier turn with no text", () => {
  const history = [
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZ" } }] },
    { role: "user", content: "latest" },
  ];
  const out = stripOldImages(history);
  assert.equal(out[0].content, "[image was attached earlier in this conversation]");
});

test("inlineDocBlock wraps text, metadata, and a truncation marker", () => {
  const block = inlineDocBlock({ name: "report.txt", text: "body text", truncated: false });
  assert.ok(block.includes("--- Attached document: report.txt ---"));
  assert.ok(block.includes("body text"));
  assert.ok(block.includes("--- End of document ---"));
  assert.ok(!block.includes("(truncated)"));
  assert.ok(!block.includes("[Document metadata]"));

  const withMeta = inlineDocBlock({ name: "spec.docx", text: "content", truncated: true, metadata: "Author: A" });
  assert.ok(withMeta.includes("--- Attached document: spec.docx (truncated) ---"));
  assert.ok(withMeta.includes("[Document metadata]\nAuthor: A"));
});

test("imageMetadataBlock is empty without metadata and labeled with it", () => {
  assert.equal(imageMetadataBlock({ name: "a.jpg" }), "");
  assert.equal(imageMetadataBlock({ name: "a.jpg", metadata: "" }), "");
  const block = imageMetadataBlock({ name: "photo.jpg", metadata: "GPS: 59.33, 18.06" });
  assert.ok(block.includes("--- Image metadata: photo.jpg ---"));
  assert.ok(block.includes("GPS: 59.33, 18.06"));
  assert.ok(block.includes("--- End of image metadata ---"));
});

test("ragExcerptBlocks groups excerpts under their document with a header", () => {
  const matches = [
    { docId: "d1", seq: 0, text: "first chunk of doc one" },
    { docId: "d1", seq: 3, text: "later chunk of doc one" },
    { docId: "d2", seq: 1, text: "chunk of doc two" },
  ];
  const names = new Map([["d1", "alpha.pdf"], ["d2", "beta.pdf"]]);
  const metaByDoc = new Map([["d1", "Author: Someone"]]);
  const out = ragExcerptBlocks(matches, names, metaByDoc);

  assert.ok(out.includes("--- Attached document: alpha.pdf (large document, indexed for retrieval"));
  assert.ok(out.includes("[Document metadata]\nAuthor: Someone"));
  assert.ok(out.includes("[Excerpt — part 1]\nfirst chunk of doc one"));
  assert.ok(out.includes("[Excerpt — part 4]\nlater chunk of doc one"));
  assert.ok(out.includes("--- Attached document: beta.pdf"));
  assert.ok(out.includes("chunk of doc two"));
  assert.ok(!out.slice(out.indexOf("beta.pdf")).includes("[Document metadata]")); // d2 has none
});

test("ragExcerptBlocks falls back to 'document' for an unknown name", () => {
  const out = ragExcerptBlocks([{ docId: "x", seq: 0, text: "text" }], new Map(), new Map());
  assert.ok(out.includes("--- Attached document: document (large document"));
});

test("ragExcerptBlocks honors the total char budget", () => {
  const matches = [
    { docId: "d1", seq: 0, text: "a".repeat(1000) },
    { docId: "d2", seq: 0, text: "b".repeat(1000) },
    { docId: "d3", seq: 0, text: "c".repeat(1000) },
  ];
  const names = new Map();
  const out = ragExcerptBlocks(matches, names, new Map(), 1500);
  // Budget 1500 admits the first excerpt (1000) and part of the second, then stops.
  assert.ok(out.includes("aaa"));
  assert.ok(out.includes("bbb"));
  assert.ok(!out.includes("ccc"));
});

test("ragExcerptBlocks skips whitespace-only excerpts and returns '' when nothing survives", () => {
  assert.equal(ragExcerptBlocks([{ docId: "d", seq: 0, text: "   " }], new Map(), new Map()), "");
  assert.equal(ragExcerptBlocks([], new Map(), new Map()), "");
});

test("EXCERPT_TOTAL_CHARS is the documented default budget", () => {
  assert.equal(EXCERPT_TOTAL_CHARS, 12000);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXCERPT_TOTAL_CHARS,
  STREAM_STALL_MS,
  asksStreetViewHere,
  conversationCopyText,
  deriveTitle,
  embedRef,
  imageMetadataBlock,
  inlineDocBlock,
  isStreamStale,
  ragExcerptBlocks,
  splitUserContent,
  stripOldImages,
} from "./message-content.js";

test("isStreamStale trips only when silent past the window AND in the foreground", () => {
  const t0 = 1_000_000;
  // Fresh bytes → alive regardless of foreground state.
  assert.equal(isStreamStale(t0, t0 + 1000, false), false);
  // Silent past the window while foregrounded → stale (the watchdog fires).
  assert.equal(isStreamStale(t0, t0 + STREAM_STALL_MS + 1, false), true);
  // Same silence but hidden → NOT stale: a backgrounded tab's socket may
  // resume on return, and its frozen timers can't have advanced anyway.
  assert.equal(isStreamStale(t0, t0 + STREAM_STALL_MS + 1, true), false);
  // Just under the window → alive (a quiet phase between 15s keepalives).
  assert.equal(isStreamStale(t0, t0 + STREAM_STALL_MS - 1, false), false);
});

test("isStreamStale honors a custom stall window", () => {
  const t0 = 0;
  assert.equal(isStreamStale(t0, 5001, false, 5000), true);
  assert.equal(isStreamStale(t0, 4999, false, 5000), false);
});

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

test("ragExcerptBlocks labels project-chat docs as conversations, not documents", () => {
  const matches = [
    { docId: "chat-c1", seq: 0, text: "we concluded X in that chat" },
    { docId: "d1", seq: 0, text: "doc chunk" },
  ];
  const names = new Map([["chat-c1", "Earlier analysis"], ["d1", "alpha.pdf"]]);
  const out = ragExcerptBlocks(matches, names, new Map(), undefined, new Set(["chat-c1"]));

  assert.ok(out.includes("--- Related project chat: Earlier analysis (an earlier conversation in this project"));
  assert.ok(out.includes("we concluded X in that chat"));
  assert.ok(out.includes("--- End of chat excerpts ---"));
  // The ordinary doc keeps the document header alongside it.
  assert.ok(out.includes("--- Attached document: alpha.pdf (large document"));
  assert.ok(out.includes("--- End of document excerpts ---"));
});

test("ragExcerptBlocks falls back to 'Untitled chat' for an unnamed chat doc", () => {
  const out = ragExcerptBlocks(
    [{ docId: "chat-x", seq: 2, text: "text" }],
    new Map(),
    new Map(),
    undefined,
    new Set(["chat-x"]),
  );
  assert.ok(out.includes("--- Related project chat: Untitled chat"));
  assert.ok(out.includes("[Excerpt — part 3]\ntext"));
});

test("EXCERPT_TOTAL_CHARS is the documented default budget", () => {
  assert.equal(EXCERPT_TOTAL_CHARS, 12000);
});

test("splitUserContent: string content is all text, no images", () => {
  assert.deepEqual(splitUserContent("hello"), { text: "hello", imageUrls: [] });
});

test("splitUserContent: multimodal array splits text parts and image URLs", () => {
  const content = [
    { type: "text", text: "line one" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
    { type: "text", text: "line two" },
  ];
  assert.deepEqual(splitUserContent(content), {
    text: "line one\nline two",
    imageUrls: ["data:image/jpeg;base64,AAA"],
  });
});

test("splitUserContent: malformed parts are skipped, never a throw", () => {
  const content = [null, { type: "image_url" }, { type: "text", text: "ok" }];
  assert.deepEqual(splitUserContent(content), { text: "ok", imageUrls: [] });
});

test("splitUserContent: non-string, non-array content yields empty", () => {
  assert.deepEqual(splitUserContent(undefined), { text: "", imageUrls: [] });
  assert.deepEqual(splitUserContent({ weird: true }), { text: "", imageUrls: [] });
});

test("conversationCopyText labels turns User:/Assistant:, blank-line separated", () => {
  const out = conversationCopyText([
    { role: "user", content: "What is X?" },
    { role: "assistant", content: "X is Y.\n\nMore detail." },
  ]);
  assert.equal(out, "User: What is X?\n\nAssistant: X is Y.\n\nMore detail.");
});

test("conversationCopyText references images instead of dumping data URLs", () => {
  const one = conversationCopyText([
    {
      role: "user",
      content: [
        { type: "text", text: "what's in this photo?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      ],
    },
  ]);
  assert.equal(one, "User: what's in this photo?\n[Image attached]");
  assert.ok(!one.includes("base64"));

  const two = conversationCopyText([
    {
      role: "user",
      content: [
        { type: "text", text: "compare these" },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,CCC" } },
      ],
    },
  ]);
  assert.ok(two.includes("[Image 1 attached]"));
  assert.ok(two.includes("[Image 2 attached]"));
});

test("conversationCopyText collapses appended document blocks to references", () => {
  const content =
    "summarize this" +
    "\n\n--- Attached document: report.pdf (truncated) ---\nSECRET-BODY-TEXT\n--- End of document ---" +
    "\n\n--- Attached document: big.docx (large document, indexed for retrieval — " +
    "showing the excerpts most relevant to this question) ---\n[Excerpt — part 1]\nEXCERPT-TEXT\n--- End of document excerpts ---";
  const out = conversationCopyText([{ role: "user", content }]);
  assert.equal(
    out,
    "User: summarize this\n[Attached document: report.pdf]\n[Attached document: big.docx]",
  );
  assert.ok(!out.includes("SECRET-BODY-TEXT"));
  assert.ok(!out.includes("EXCERPT-TEXT"));
});

test("conversationCopyText references project materials and related chats, drops image metadata", () => {
  const content =
    "question" +
    "\n\n--- Project: Alpha ---\nfiles listed here\n--- End of project ---" +
    "\n\n--- Related project chat: Earlier analysis (an earlier conversation in this project, " +
    "indexed for retrieval — showing the excerpts most relevant to this question) ---\nchat text\n--- End of chat excerpts ---" +
    "\n\n--- Image metadata: photo.jpg ---\nGPS: 59.3, 18.1\n--- End of image metadata ---";
  const out = conversationCopyText([{ role: "user", content }]);
  assert.ok(out.includes("[Project materials: Alpha]"));
  assert.ok(out.includes("[Related project chat: Earlier analysis]"));
  assert.ok(!out.includes("Image metadata"));
  assert.ok(!out.includes("GPS"));
});

test("conversationCopyText skips empty messages and survives malformed content", () => {
  const out = conversationCopyText([
    { role: "user", content: "" },
    { role: "user", content: null },
    { role: "assistant", content: "only me" },
  ]);
  assert.equal(out, "Assistant: only me");
  assert.equal(conversationCopyText([]), "");
  assert.equal(conversationCopyText(undefined), "");
});

test("embedRef formats each embed kind with its id number", () => {
  assert.equal(
    embedRef({ id: 1, kind: "streetview_embed", lat: 59.33421, lng: 18.06324 }),
    "[Embedded element #1: interactive Google Street View panorama at 59.33421, 18.06324]",
  );
  assert.equal(
    embedRef({ id: 2, kind: "streetview_frames", query: "Kungsgatan 1, Stockholm", directions: ["north", "east", "", "your current view"] }),
    '[Embedded element #2: Street View frames of "Kungsgatan 1, Stockholm" (north, east, your current view)]',
  );
  // No query, no directions — still a well-formed reference.
  assert.equal(embedRef({ id: 3, kind: "streetview_frames" }), "[Embedded element #3: Street View frames]");
  // The interactive map embed (the no-Street-View-coverage stand-in).
  assert.equal(
    embedRef({ id: 8, kind: "map_embed", lat: 59.65, lng: 17.12, q: "Basaltgatan 3, Enköping" }),
    "[Embedded element #8: interactive Google Map at 59.65, 17.12 (Basaltgatan 3, Enköping)]",
  );
  assert.equal(embedRef({ id: 9, kind: "map_embed", lat: 1, lng: 2 }), "[Embedded element #9: interactive Google Map at 1, 2]");
  // An unknown kind (a future source's embed) never silently vanishes.
  assert.equal(embedRef({ id: 4, kind: "sonar_sweep" }), "[Embedded element #4: sonar_sweep]");
  // The inline quiz: title + question count, completion marker when done
  // (the score itself lives in the summary appended to the turn text).
  assert.equal(
    embedRef({ id: 5, kind: "quiz", quiz: { title: "Nordic capitals", questions: [{}, {}, {}] } }),
    '[Embedded element #5: interactive quiz "Nordic capitals" — 3 questions]',
  );
  assert.equal(
    embedRef({ id: 6, kind: "quiz", completed: true, quiz: { title: "Q", questions: [{}] } }),
    '[Embedded element #6: interactive quiz "Q" — 1 question, completed]',
  );
  assert.equal(embedRef({ id: 7, kind: "quiz" }), "[Embedded element #7: interactive quiz]");
});

test("conversationCopyText appends embed references under their assistant turn", () => {
  const messages = [
    { role: "user", content: "what is at these coordinates?" },
    { role: "assistant", content: "It's the Royal Palace." },
    { role: "user", content: "and further north?" },
    { role: "assistant", content: "The museum." },
  ];
  const embeds = [
    { id: 1, kind: "streetview_embed", msgIndex: 1, lat: 59.1, lng: 18.2 },
    { id: 2, kind: "streetview_frames", msgIndex: 3, query: "museum", directions: ["north"] },
  ];
  const out = conversationCopyText(messages, embeds);
  const paras = out.split("\n\n");
  assert.equal(paras[1], "Assistant: It's the Royal Palace.\n[Embedded element #1: interactive Google Street View panorama at 59.1, 18.2]");
  assert.equal(paras[3], 'Assistant: The museum.\n[Embedded element #2: Street View frames of "museum" (north)]');
});

test("conversationCopyText without embeds is unchanged and out-of-range embeds are ignored", () => {
  const messages = [{ role: "user", content: "q" }, { role: "assistant", content: "a" }];
  assert.equal(conversationCopyText(messages), "User: q\n\nAssistant: a");
  assert.equal(
    conversationCopyText(messages, [{ id: 1, kind: "streetview_embed", msgIndex: 9, lat: 1, lng: 2 }]),
    "User: q\n\nAssistant: a",
  );
});

test("asksStreetViewHere gates the device-geolocation prompt to explicit here-asks", () => {
  assert.equal(asksStreetViewHere("street view here"), true);
  assert.equal(asksStreetViewHere("popup street view at my current location"), true);
  assert.equal(asksStreetViewHere("gatuvy här"), true);
  assert.equal(asksStreetViewHere("streer view here"), true); // typo-tolerant like the server gate
  assert.equal(asksStreetViewHere("street view of Storgatan 4"), false);
  assert.equal(asksStreetViewHere("what is here?"), false);
  assert.equal(asksStreetViewHere(""), false);
  assert.equal(asksStreetViewHere(undefined), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DOCS,
  MAX_DOC_CHARS,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  MAX_IMAGE_CHARS,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_IMAGE_CHARS,
  addPending,
  attachSummary,
  drcUserContent,
  sanitizeAttachName,
  sessionFilesFor,
} from "./drc-attach-core.js";

// A byte payload of a given length, cheap enough to make at 25 MB.
const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);
// `chars` is the TOTAL data-URL length, so a test can sit exactly on a cap.
const DATA_URL_PREFIX = "data:image/jpeg;base64,";
const img = (name, chars = 100) => ({
  kind: "image",
  name,
  type: "image/png",
  bytes: bytes(16),
  dataUrl: DATA_URL_PREFIX + "A".repeat(Math.max(0, chars - DATA_URL_PREFIX.length)),
});
const doc = (name, text = "hello") => ({
  kind: "doc",
  name,
  type: "application/pdf",
  bytes: bytes(32, 1),
  text,
});

// ---- sanitizeAttachName ----------------------------------------------------

// Pins: a name is reduced to its basename, so a path-traversal-looking file
// name can never reach the message block or the guest FS as a path.
test("sanitizeAttachName keeps only the basename of a traversal-looking name", () => {
  assert.equal(sanitizeAttachName("../../../etc/passwd"), "passwd");
  assert.equal(sanitizeAttachName("C:\\Users\\me\\secret.docx"), "secret.docx");
  assert.equal(sanitizeAttachName("/absolute/path/report.pdf"), "report.pdf");
});

// Pins: control characters are REMOVED (not replaced by a space, matching
// sandbox-files.js's sanitizeName) and ordinary whitespace collapsed, so a
// hostile name cannot smuggle newlines into the labeled block that frames a
// document — those block delimiters are line-based.
test("sanitizeAttachName strips control characters and collapses whitespace", () => {
  assert.equal(sanitizeAttachName("re\u0000po\nrt\t.pdf"), "report.pdf");
  assert.equal(sanitizeAttachName("  spaced   name.txt  "), "spaced name.txt");
});

// Pins: the length cap and the never-empty guarantee — every caller renders
// the result directly, so it must always be a usable string.
test("sanitizeAttachName caps length and never returns empty", () => {
  assert.equal(sanitizeAttachName("x".repeat(500)).length, 200);
  assert.equal(sanitizeAttachName(""), "file");
  assert.equal(sanitizeAttachName("."), "file");
  assert.equal(sanitizeAttachName(".."), "file");
  assert.equal(sanitizeAttachName(null), "file");
  assert.equal(sanitizeAttachName(undefined), "file");
});

// ---- addPending: purity ----------------------------------------------------

// Pins the purity contract: neither a success nor a rejection may mutate the
// caller's array — drc.js keeps the pending list in a module variable and
// re-renders from the returned one.
test("addPending never mutates the input list", () => {
  const list = [img("a.png")];
  const frozen = Object.freeze(list.slice());
  const ok = addPending(frozen, doc("b.pdf"));
  assert.equal(ok.error, null);
  assert.equal(frozen.length, 1);
  assert.equal(ok.list.length, 2);
  assert.notEqual(ok.list, frozen);

  const rejected = addPending(frozen, { kind: "doc", name: "big.pdf", bytes: bytes(MAX_FILE_BYTES + 1) });
  assert.ok(rejected.error);
  assert.equal(frozen.length, 1);
  assert.equal(rejected.list.length, 1);
});

// ---- addPending: each cap --------------------------------------------------

// Pins the image count cap and that its message names the actual limit.
test("addPending rejects past MAX_IMAGES with a useful message", () => {
  let list = [];
  for (let i = 0; i < MAX_IMAGES; i++) {
    const r = addPending(list, img(`i${i}.png`));
    assert.equal(r.error, null);
    list = r.list;
  }
  const over = addPending(list, img("one-too-many.png"));
  assert.equal(over.list.length, MAX_IMAGES);
  assert.match(over.error, /Max 4 images per message\./);
  // Documents are counted separately — a full image slate still takes a doc.
  assert.equal(addPending(list, doc("ok.pdf")).error, null);
});

// Pins the document count cap, counted independently of images.
test("addPending rejects past MAX_DOCS with a useful message", () => {
  let list = [img("photo.png")];
  for (let i = 0; i < MAX_DOCS; i++) {
    const r = addPending(list, doc(`d${i}.pdf`));
    assert.equal(r.error, null);
    list = r.list;
  }
  const over = addPending(list, doc("extra.pdf"));
  assert.equal(over.list.length, 1 + MAX_DOCS);
  assert.match(over.error, /Max 3 documents per message\./);
});

// Pins the per-file byte cap: a file the composer accepts must be one the
// 32 MB sandbox mount cap can also carry, so this rejects first and says so.
test("addPending rejects a file over MAX_FILE_BYTES and names the size", () => {
  const r = addPending([], { kind: "doc", name: "huge.pdf", bytes: bytes(MAX_FILE_BYTES + 1024) });
  assert.equal(r.list.length, 0);
  assert.match(r.error, /huge\.pdf/);
  assert.match(r.error, /25 MB per file/);
});

// Pins the total byte budget (the 64 MB sandbox mount budget): four 25 MB
// files pass the per-file cap individually but must not all mount.
test("addPending rejects once the total byte budget is exceeded", () => {
  const caps = { maxFileBytes: 1000, maxTotalBytes: 2500 };
  let list = [];
  for (const n of ["a.pdf", "b.pdf"]) {
    const r = addPending(list, { kind: "doc", name: n, bytes: bytes(1000) }, caps);
    assert.equal(r.error, null);
    list = r.list;
  }
  const over = addPending(list, { kind: "doc", name: "c.pdf", bytes: bytes(1000) }, caps);
  assert.equal(over.list.length, 2);
  assert.match(over.error, /c\.pdf/);
  assert.match(over.error, /budget/);
  // The real caps are the ones the sandbox mount plan uses.
  assert.equal(MAX_TOTAL_BYTES, 64 * 1024 * 1024);
});

// Pins the per-image data-URL cap — the provider's ~1 MB body limit.
test("addPending rejects an image whose data URL is over the per-image char cap", () => {
  const r = addPending([], img("wide.png", MAX_IMAGE_CHARS + 1));
  assert.equal(r.list.length, 0);
  assert.match(r.error, /wide\.png/);
  assert.match(r.error, /smaller image/);
});

// Pins the total image-char budget: this is the cap that also keeps a
// conversation inside Se/cure's ~5 MB localStorage seal.
test("addPending rejects once the total image char budget is full", () => {
  // Each image is exactly at the per-image cap, so only the TOTAL budget can
  // be what rejects the third one (280k × 2 fits under 700k, × 3 does not).
  const each = MAX_IMAGE_CHARS;
  assert.ok(2 * each <= MAX_TOTAL_IMAGE_CHARS && 3 * each > MAX_TOTAL_IMAGE_CHARS);
  const first = addPending([], img("a.png", each));
  assert.equal(first.error, null);
  const second = addPending(first.list, img("b.png", each));
  assert.equal(second.error, null);
  const third = addPending(second.list, img("c.png", each));
  assert.equal(third.list.length, 2);
  assert.match(third.error, /image budget/i);
});

// Pins the doc text truncation: an over-long extraction is cut to the inline
// budget and MARKED, never silently sent whole.
test("addPending truncates a document's inlined text at MAX_DOC_CHARS", () => {
  const r = addPending([], doc("long.txt", "x".repeat(MAX_DOC_CHARS + 500)));
  assert.equal(r.error, null);
  assert.equal(r.list[0].text.length, MAX_DOC_CHARS);
  assert.equal(r.list[0].truncated, true);
});

// Pins degenerate input: a null/garbage candidate is a rejection, not a
// throw, and a null list is treated as empty.
test("addPending handles degenerate input without throwing", () => {
  assert.match(addPending([], null).error, /Nothing to attach/);
  assert.match(addPending(null, undefined).error, /Nothing to attach/);
  assert.deepEqual(addPending(null, null).list, []);
  const r = addPending(null, { name: "note.txt", text: "hi" });
  assert.equal(r.error, null);
  assert.equal(r.list[0].kind, "doc"); // unknown kind defaults to doc
  assert.equal(r.list[0].name, "note.txt");
});

// Pins that the name stored on the pending item is already sanitized, so the
// card, the message block and the mount all show the same string.
test("addPending sanitizes the stored name", () => {
  const r = addPending([], { kind: "doc", name: "../../evil/../report.pdf", bytes: bytes(4) });
  assert.equal(r.list[0].name, "report.pdf");
});

// ---- sessionFilesFor -------------------------------------------------------

// Pins the sandbox payload shape AND the key decision: a document mounts its
// ORIGINAL bytes (the real PDF), not its extracted text.
test("sessionFilesFor emits {name,type,bytes} with the document's ORIGINAL bytes", () => {
  const original = new TextEncoder().encode("%PDF-1.7 real pdf bytes");
  const pending = [
    { kind: "doc", name: "report.pdf", type: "application/pdf", bytes: original, text: "extracted text" },
    img("chart.png"),
  ];
  const files = sessionFilesFor(pending);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => f.name),
    ["report.pdf", "chart.png"],
  );
  assert.equal(files[0].type, "application/pdf");
  assert.ok(files[0].bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(files[0].bytes), "%PDF-1.7 real pdf bytes");
  assert.equal(files[0].bytes, original); // the same buffer, not a re-encode of .text
  for (const f of files) assert.ok(f.bytes instanceof Uint8Array);
});

// Pins the skip rule: an attachment with no readable bytes is left out rather
// than mounted as an empty file (sandbox-files.js would drop it anyway).
test("sessionFilesFor skips attachments with no bytes and handles empty input", () => {
  const files = sessionFilesFor([
    { kind: "image", name: "only-data-url.png", dataUrl: "data:image/jpeg;base64,AAAA" },
    { kind: "doc", name: "empty.txt", bytes: new Uint8Array(0) },
    doc("kept.pdf"),
  ]);
  assert.deepEqual(
    files.map((f) => f.name),
    ["kept.pdf"],
  );
  assert.deepEqual(sessionFilesFor([]), []);
  assert.deepEqual(sessionFilesFor(null), []);
});

// ---- drcUserContent --------------------------------------------------------

// Pins the string half of the contract: with no attachments at all the
// content is the typed text, unchanged and still a string.
test("drcUserContent returns a STRING for text with no attachments", () => {
  assert.equal(drcUserContent("what is a workspace?", []), "what is a workspace?");
  assert.equal(drcUserContent("hi", null), "hi");
  assert.equal(drcUserContent(null, null), "");
});

// Pins the string half again for the documents-only case — the one that
// matters most, because a string keeps the sealed state and every planning
// prompt on the existing path.
test("drcUserContent returns a STRING for documents only, with the labeled block appended", () => {
  const content = drcUserContent("summarise this", [doc("report.pdf", "PAGE ONE TEXT")]);
  assert.equal(typeof content, "string");
  assert.ok(content.startsWith("summarise this"));
  assert.match(content, /--- Attached document: report\.pdf ---/);
  assert.match(content, /PAGE ONE TEXT/);
  assert.match(content, /--- End of document ---/);
});

// Pins that a truncated doc and its metadata ride into the same block via
// message-content.js, so both tiers frame a document identically.
test("drcUserContent marks a truncated document and includes its metadata", () => {
  const content = drcUserContent("read it", [
    { kind: "doc", name: "d.docx", text: "body", truncated: true, metadata: "Author: Ada" },
  ]);
  assert.match(content, /--- Attached document: d\.docx \(truncated\) ---/);
  assert.match(content, /\[Document metadata\]\nAuthor: Ada/);
});

// Pins the array half of the contract: any image switches the shape, the
// first part is the text part and carries the user's typed text, and each
// image becomes one image_url part with its data URL.
test("drcUserContent returns an ARRAY when an image is present, text part first", () => {
  const one = img("a.png");
  const two = img("b.png");
  const content = drcUserContent("what is in these?", [one, two]);
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 3);
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text.startsWith("what is in these?"));
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, one.dataUrl);
  assert.equal(content[2].image_url.url, two.dataUrl);
});

// Pins the mixed case: documents and images together still produce ONE text
// part carrying both the doc block and the image-metadata block.
test("drcUserContent puts doc blocks and image metadata in the single text part", () => {
  const content = drcUserContent("compare", [
    doc("report.pdf", "DOC BODY"),
    { ...img("photo.jpg"), metadata: "GPS: 59.33, 18.06" },
  ]);
  assert.ok(Array.isArray(content));
  const text = content[0].text;
  assert.ok(text.startsWith("compare"));
  assert.match(text, /--- Attached document: report\.pdf ---/);
  assert.match(text, /DOC BODY/);
  assert.match(text, /--- Image metadata: photo\.jpg ---/);
  assert.match(text, /GPS: 59\.33, 18\.06/);
  assert.equal(content.filter((p) => p.type === "image_url").length, 1);
});

// Pins the degenerate paths: an image with no data URL is not an image part
// (it would be an unsendable one), so the content stays a string.
test("drcUserContent ignores an image with no data URL and keeps the string shape", () => {
  const content = drcUserContent("hello", [{ kind: "image", name: "x.png", bytes: bytes(4) }]);
  assert.equal(typeof content, "string");
  assert.equal(content, "hello");
  // A doc with no extracted text appends nothing either.
  assert.equal(drcUserContent("hi", [{ kind: "doc", name: "d.pdf", bytes: bytes(4) }]), "hi");
});

// ---- attachSummary ---------------------------------------------------------

// Pins the composer line, including the singular/plural and the empty case.
test("attachSummary names the files and pluralises", () => {
  assert.equal(attachSummary([]), "");
  assert.equal(attachSummary(null), "");
  assert.equal(attachSummary([doc("report.pdf")]), "1 file attached (report.pdf)");
  assert.equal(
    attachSummary([doc("report.pdf"), img("chart.png")]),
    "2 files attached (report.pdf, chart.png)",
  );
});

// Pins that a long list counts the rest instead of growing without bound.
test("attachSummary caps the names it lists", () => {
  const list = [doc("a.pdf"), doc("b.pdf"), doc("c.pdf"), img("d.png"), img("e.png")];
  assert.equal(attachSummary(list), "5 files attached (a.pdf, b.pdf, c.pdf, +2 more)");
});

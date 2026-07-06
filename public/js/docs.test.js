import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parseDocFile, formatPdfMetadata } from "./docs.js";

// ---- test-only minimal ZIP writer -----------------------------------------
// Independent of docs.js's own zip READER, so this isn't tautological.
// Supports both STORED (method 0) and DEFLATE (method 8, via Node's zlib —
// exercises docs.js's DecompressionStream("deflate-raw") inflate path)
// entries, matching the two shapes real .docx producers use.

function buildZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, deflate = false } of entries) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const compressed = deflate ? zlib.deflateRawSync(Buffer.from(data)) : Buffer.from(data);
    const method = deflate ? 8 : 0;
    const crc = zlib.crc32(Buffer.from(data));

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    Buffer.from(nameBytes).copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    Buffer.from(nameBytes).copy(central, 46);
    centralParts.push(central);

    offset += local.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types/>';
const RELS = '<?xml version="1.0"?><Relationships/>';

function docxFile(name, { documentXml, coreXml, appXml, commentsXml, deflate = false }) {
  const entries = [
    { name: "[Content_Types].xml", content: CONTENT_TYPES, deflate },
    { name: "_rels/.rels", content: RELS, deflate },
    { name: "word/document.xml", content: documentXml, deflate },
  ];
  if (coreXml) entries.push({ name: "docProps/core.xml", content: coreXml, deflate });
  if (appXml) entries.push({ name: "docProps/app.xml", content: appXml, deflate });
  if (commentsXml) entries.push({ name: "word/comments.xml", content: commentsXml, deflate });
  return new File([buildZip(entries)], name);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (bodyXml) =>
  `<?xml version="1.0"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`;

describe("parseDocFile / docx", () => {
  test("plain docx with no docProps: text extracted, metadata is null", async () => {
    const file = docxFile("plain.docx", {
      documentXml: doc("<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>"),
    });
    const { text, metadata } = await parseDocFile(file, 9000);
    assert.equal(text, "Hello world");
    assert.equal(metadata, null);
  });

  test("works identically whether entries are STORED or DEFLATEd", async () => {
    const body = "<w:p><w:r><w:t>Deflated content check</w:t></w:r></w:p>";
    const stored = docxFile("stored.docx", { documentXml: doc(body), deflate: false });
    const deflated = docxFile("deflated.docx", { documentXml: doc(body), deflate: true });
    const a = await parseDocFile(stored, 9000);
    const b = await parseDocFile(deflated, 9000);
    assert.equal(a.text, "Deflated content check");
    assert.equal(a.text, b.text);
  });

  test("XML entities decode correctly in the main text", async () => {
    const file = docxFile("entities.docx", {
      documentXml: doc("<w:p><w:r><w:t>Budget &amp; scope: &quot;approved&quot; &#8212; final.</w:t></w:r></w:p>"),
    });
    const { text } = await parseDocFile(file, 9000);
    assert.equal(text, 'Budget & scope: "approved" — final.');
  });

  test("core.xml properties (author, revision, title) surface in metadata", async () => {
    const file = docxFile("core.docx", {
      documentXml: doc("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>"),
      coreXml:
        '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y">' +
        "<dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>John Smith</cp:lastModifiedBy>" +
        "<cp:revision>3</cp:revision><dc:title>Q2 Memo</dc:title></cp:coreProperties>",
    });
    const { metadata } = await parseDocFile(file, 9000);
    assert.match(metadata, /Author: Jane Doe/);
    assert.match(metadata, /Last modified by: John Smith/);
    assert.match(metadata, /Revision: 3/);
    assert.match(metadata, /Title: Q2 Memo/);
  });

  test("lastModifiedBy is omitted when identical to the creator (not redundant)", async () => {
    const file = docxFile("same-author.docx", {
      documentXml: doc("<w:p><w:r><w:t>x</w:t></w:r></w:p>"),
      coreXml:
        '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y">' +
        "<dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy></cp:coreProperties>",
    });
    const { metadata } = await parseDocFile(file, 9000);
    assert.match(metadata, /Author: Jane Doe/);
    assert.doesNotMatch(metadata, /Last modified by/);
  });

  test("app.xml properties (unprefixed tags) surface in metadata", async () => {
    const file = docxFile("app.docx", {
      documentXml: doc("<w:p><w:r><w:t>x</w:t></w:r></w:p>"),
      appXml: '<?xml version="1.0"?><Properties><Company>Acme Corp</Company><Application>Microsoft Office Word</Application></Properties>',
    });
    const { metadata } = await parseDocFile(file, 9000);
    assert.match(metadata, /Company: Acme Corp/);
    assert.match(metadata, /Created with: Microsoft Office Word/);
  });

  test("tracked deletions are excluded from the main text but surfaced in metadata", async () => {
    const file = docxFile("deletion.docx", {
      documentXml: doc(
        '<w:p><w:r><w:t>Visible text.</w:t></w:r>' +
          '<w:del w:id="1" w:author="Jane Doe" w:date="2024-05-01T09:00:00Z">' +
          '<w:r><w:delText> CONFIDENTIAL-DELETED-8842.</w:delText></w:r></w:del></w:p>',
      ),
    });
    const { text, metadata } = await parseDocFile(file, 9000);
    assert.equal(text, "Visible text.");
    assert.doesNotMatch(text, /CONFIDENTIAL-DELETED-8842/);
    assert.match(metadata, /Unaccepted tracked deletions.*\(1\)/);
    assert.match(metadata, /by Jane Doe on 2024-05-01/);
    assert.match(metadata, /CONFIDENTIAL-DELETED-8842/);
  });

  test("tracked insertions stay in the main text AND are listed in metadata", async () => {
    const file = docxFile("insertion.docx", {
      documentXml: doc(
        '<w:p><w:r><w:t>Base text.</w:t></w:r>' +
          '<w:ins w:id="1" w:author="John Smith" w:date="2024-05-02T10:00:00Z">' +
          '<w:r><w:t> Approved for release.</w:t></w:r></w:ins></w:p>',
      ),
    });
    const { text, metadata } = await parseDocFile(file, 9000);
    assert.equal(text, "Base text. Approved for release.");
    assert.match(metadata, /Unaccepted tracked insertions \(1\)/);
    assert.match(metadata, /by John Smith on 2024-05-02/);
    assert.match(metadata, /Approved for release/);
  });

  test("reviewer comments surface in metadata", async () => {
    const file = docxFile("comments.docx", {
      documentXml: doc("<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>"),
      commentsXml:
        `<?xml version="1.0"?><w:comments ${W}>` +
        '<w:comment w:id="0" w:author="Jane Doe" w:date="2024-05-01T09:05:00Z">' +
        "<w:p><w:r><w:t>Double check this figure.</w:t></w:r></w:p></w:comment></w:comments>",
    });
    const { metadata } = await parseDocFile(file, 9000);
    assert.match(metadata, /Reviewer comments \(1\)/);
    assert.match(metadata, /Jane Doe on 2024-05-01: "Double check this figure\."/);
  });

  test("more than 20 tracked changes are capped with a 'more not shown' note", async () => {
    const dels = Array.from({ length: 25 }, (_, i) =>
      `<w:del w:id="${i}" w:author="A"><w:r><w:delText>d${i}</w:delText></w:r></w:del>`).join("");
    const file = docxFile("many-deletions.docx", {
      documentXml: doc(`<w:p><w:r><w:t>Visible body text.</w:t></w:r>${dels}</w:p>`),
    });
    const { metadata } = await parseDocFile(file, 9000);
    assert.match(metadata, /\(25\)/);
    assert.match(metadata, /5 more not shown/);
  });

  test("a corrupted/non-zip file throws a user-presentable error, not a crash", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "broken.docx");
    await assert.rejects(() => parseDocFile(file, 9000), /does not look like a valid \.docx file/);
  });
});

describe("formatPdfMetadata", () => {
  test("null/empty info returns null", () => {
    assert.equal(formatPdfMetadata(null), null);
    assert.equal(formatPdfMetadata({}), null);
  });

  test("renders Author/Title/Producer and parses PDF-format dates", () => {
    const summary = formatPdfMetadata({
      Title: "Quarterly Review",
      Author: "Jane Doe",
      Producer: "Acrobat Distiller",
      CreationDate: "D:20240501143200Z",
    });
    assert.match(summary, /Title: Quarterly Review/);
    assert.match(summary, /Author: Jane Doe/);
    assert.match(summary, /PDF producer: Acrobat Distiller/);
    assert.match(summary, /Created: 2024-05-01 14:32:00/);
  });

  test("a malformed date string is omitted rather than shown garbled", () => {
    const summary = formatPdfMetadata({ Author: "Jane Doe", CreationDate: "not-a-date" });
    assert.match(summary, /Author: Jane Doe/);
    assert.doesNotMatch(summary, /Created:/);
  });
});

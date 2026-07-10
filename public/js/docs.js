// @ts-check
// Client-side document parsing for attachments: pdf, docx, md, txt.
// Everything runs in the browser — file contents never touch our server
// except as the extracted text (and, since metadata extraction below, a
// metadata summary) embedded in the chat message.
//
// - txt/md: read directly, no metadata (plain text carries none).
// - pdf: pdf.js (vendored, ~1.8MB with worker) dynamically imported ONLY
//   when a PDF is actually attached. Metadata comes from pdf.js's own
//   getMetadata() (the PDF Info dictionary — Author/Producer/dates/etc).
// - docx: a .docx is a ZIP with the text in word/document.xml. Parsed here
//   with a minimal central-directory reader + DecompressionStream
//   ("deflate-raw") — no library needed. Metadata additionally pulls
//   docProps/core.xml (author, last-modified-by, dates, revision),
//   docProps/app.xml (company/application), word/comments.xml (reviewer
//   comments), and unaccepted tracked changes in word/document.xml itself
//   — insertions AND deletions, since Word keeps deleted text physically
//   present in the file (as <w:delText>) even though it renders as struck
//   through / hidden. This is a well-known real-world metadata leak class
//   (e.g. redacted content resurfacing via tracked changes) — surfaced
//   here explicitly and labeled, rather than silently blended into the
//   document's main text the way a naive tag-stripping pass would.

const EXT_RE = /\.(pdf|docx|md|txt)$/i;

/**
 * One tracked change or reviewer comment pulled out of a docx.
 * @typedef {{author: string, date: string, text: string}} DocxRevision
 */

/** @param {File} file */
export function isParsableDoc(file) {
  return EXT_RE.test(file.name);
}

/**
 * @param {File} file
 * @returns {string} lowercased extension, "" when not parsable
 */
export function docExt(file) {
  return (file.name.match(EXT_RE)?.[1] || "").toLowerCase();
}

/**
 * Parse one attachment. metadata is a formatted summary string or null
 * (txt/md never have any; pdf/docx do when the file actually carries some).
 * hasTrackedDeletions flags the one docx case worth calling out as
 * sensitive on its own — unaccepted deletions are content someone tried to
 * remove, physically still present in the file (see the header comment) —
 * as opposed to routine author/date properties. Throws with a
 * user-presentable message.
 * @param {File} file
 * @param {number} maxChars inline cap; longer text is cut and flagged truncated
 * @returns {Promise<{text: string, truncated: boolean, metadata: string | null, hasTrackedDeletions: boolean}>}
 */
export async function parseDocFile(file, maxChars) {
  const ext = docExt(file);
  let text, metadata = null, hasTrackedDeletions = false;
  if (ext === "txt" || ext === "md") {
    text = await file.text();
  } else if (ext === "pdf") {
    ({ text, metadata } = await parsePdf(file, maxChars));
  } else if (ext === "docx") {
    ({ text, metadata, hasTrackedDeletions } = await parseDocx(file));
  } else {
    throw new Error("Unsupported file type.");
  }
  text = String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) throw new Error("No readable text found in " + file.name + ".");
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated, metadata, hasTrackedDeletions };
}

// ---- PDF (lazy pdf.js) -----------------------------------------------------

/** @type {Promise<any> | null} */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    // Served URL, not a package specifier — the typechecker can't resolve it.
    // @ts-ignore
    pdfjsPromise = import("/vendor/pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

/**
 * @param {File} file
 * @param {number} maxChars
 * @returns {Promise<{text: string, metadata: string | null}>}
 */
async function parsePdf(file, maxChars) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  /** @type {string | null} */
  let metadata = null;
  try {
    const meta = await doc.getMetadata().catch(() => null);
    metadata = formatPdfMetadata(meta?.info);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((/** @type {{str: string}} */ it) => it.str).join(" ") + "\n\n";
      // A little slack past the cap so the caller can mark truncation.
      if (out.length > maxChars + 2000) break;
    }
  } finally {
    doc.destroy();
  }
  return { text: out, metadata };
}

/**
 * PDF's Info dictionary — Title/Author/Subject/Keywords/Creator/Producer
 * plus CreationDate/ModDate in PDF's own "D:YYYYMMDDHHmmSS" date format.
 * @param {Record<string, any> | null | undefined} info pdf.js getMetadata().info
 * @returns {string | null}
 */
export function formatPdfMetadata(info) {
  if (!info) return null;
  const lines = [];
  if (info.Title) lines.push(`Title: ${info.Title}`);
  if (info.Author) lines.push(`Author: ${info.Author}`);
  if (info.Subject) lines.push(`Subject: ${info.Subject}`);
  if (info.Keywords) lines.push(`Keywords: ${info.Keywords}`);
  if (info.Creator) lines.push(`Created with: ${info.Creator}`);
  if (info.Producer) lines.push(`PDF producer: ${info.Producer}`);
  const created = parsePdfDate(info.CreationDate);
  if (created) lines.push(`Created: ${created}`);
  const modified = parsePdfDate(info.ModDate);
  if (modified) lines.push(`Modified: ${modified}`);
  return lines.length ? lines.join("\n") : null;
}

/**
 * @param {unknown} s
 * @returns {string | null}
 */
function parsePdfDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", se = "00"] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${se}`;
}

// ---- DOCX (minimal ZIP + document.xml + docProps + comments) --------------

/** @param {Uint8Array<ArrayBuffer>} bytes */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads whichever of `wanted` zip entry names are actually present.
 * Entries not in the archive are simply absent from the result — most docx
 * files have no comments.xml, for instance.
 * @param {File} file
 * @param {Set<string>} wanted
 * @returns {Promise<Map<string, Uint8Array>>} entry name → decompressed bytes
 */
async function readZipEntries(file, wanted) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);

  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(file.name + " does not look like a valid .docx file.");
  let off = dv.getUint32(eocd + 16, true); // central directory offset
  const count = dv.getUint16(eocd + 10, true);

  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (let n = 0; n < count && out.size < wanted.size; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (wanted.has(name)) {
      // Local header repeats name/extra lengths (extra may differ).
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + csize);
      out.set(name, method === 8 ? await inflateRaw(raw) : raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const WANTED_PARTS = new Set([
  "word/document.xml",
  "docProps/core.xml",
  "docProps/app.xml",
  "word/comments.xml",
]);

/**
 * @param {File} file
 * @returns {Promise<{text: string, metadata: string | null, hasTrackedDeletions: boolean}>}
 */
async function parseDocx(file) {
  const entries = await readZipEntries(file, WANTED_PARTS);
  const documentBytes = entries.get("word/document.xml");
  if (!documentBytes) throw new Error("Could not find the document text inside " + file.name + ".");
  const decoder = new TextDecoder();

  const { mainXml, insertions, deletions } = extractTrackedChanges(decoder.decode(documentBytes));
  const text = docxXmlToText(mainXml);

  const coreProps = entries.has("docProps/core.xml") ? extractCoreProps(decoder.decode(entries.get("docProps/core.xml"))) : {};
  const appProps = entries.has("docProps/app.xml") ? extractAppProps(decoder.decode(entries.get("docProps/app.xml"))) : {};
  const comments = entries.has("word/comments.xml") ? extractComments(decoder.decode(entries.get("word/comments.xml"))) : [];

  return {
    text,
    metadata: formatDocxMetadata({ coreProps, appProps, insertions, deletions, comments }),
    hasTrackedDeletions: deletions.length > 0,
  };
}

/**
 * Removes <w:del>...</w:del> blocks (deleted-but-still-present text) from
 * the main flow entirely, collecting their content separately; unwraps
 * <w:ins>...</w:ins> blocks (keeping their content in the main flow, same
 * as Word's own rendering of an unaccepted insertion) while also recording
 * who inserted what. Must run on the RAW xml (tags intact) before
 * docxXmlToText's generic tag-stripping.
 * @param {string} xml word/document.xml
 * @returns {{mainXml: string, insertions: DocxRevision[], deletions: DocxRevision[]}}
 */
function extractTrackedChanges(xml) {
  /** @type {DocxRevision[]} */
  const deletions = [];
  /** @type {DocxRevision[]} */
  const insertions = [];

  let mainXml = xml.replace(/<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/g, (_, attrs, inner) => {
    const text = [...inner.matchAll(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g)].map((m) => m[1]).join("");
    if (text.trim()) deletions.push({ author: xmlAttr(attrs, "author"), date: xmlAttr(attrs, "date"), text: decodeXmlEntities(text) });
    return "";
  });

  mainXml = mainXml.replace(/<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g, (_, attrs, inner) => {
    const text = [...inner.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
    if (text.trim()) insertions.push({ author: xmlAttr(attrs, "author"), date: xmlAttr(attrs, "date"), text: decodeXmlEntities(text) });
    return inner;
  });

  return { mainXml, insertions, deletions };
}

/**
 * @param {string} xml word/comments.xml
 * @returns {DocxRevision[]}
 */
function extractComments(xml) {
  /** @type {DocxRevision[]} */
  const comments = [];
  for (const m of xml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const text = [...m[2].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((mm) => mm[1]).join("");
    if (text.trim()) comments.push({ author: xmlAttr(m[1], "author"), date: xmlAttr(m[1], "date"), text: decodeXmlEntities(text) });
  }
  return comments;
}

/**
 * @param {string} attrs a tag's raw attribute string
 * @param {string} name w:-namespaced attribute local name
 */
function xmlAttr(attrs, name) {
  return attrs.match(new RegExp(`w:${name}="([^"]*)"`))?.[1] || "";
}

/**
 * Matches both namespace-prefixed tags (core.xml: <dc:creator>) and
 * unprefixed ones (app.xml: <Company>).
 * @param {string} xml
 * @param {string} localName
 * @returns {string | null}
 */
function extractTagText(xml, localName) {
  const m = xml.match(new RegExp(`<(?:[\\w]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?${localName}>`));
  return m ? decodeXmlEntities(m[1].trim()) || null : null;
}

/** @param {string} xml docProps/core.xml */
function extractCoreProps(xml) {
  return {
    creator: extractTagText(xml, "creator"),
    lastModifiedBy: extractTagText(xml, "lastModifiedBy"),
    created: extractTagText(xml, "created"),
    modified: extractTagText(xml, "modified"),
    revision: extractTagText(xml, "revision"),
    title: extractTagText(xml, "title"),
    subject: extractTagText(xml, "subject"),
    keywords: extractTagText(xml, "keywords"),
  };
}

/** @param {string} xml docProps/app.xml */
function extractAppProps(xml) {
  return {
    company: extractTagText(xml, "Company"),
    manager: extractTagText(xml, "Manager"),
    application: extractTagText(xml, "Application"),
  };
}

// Bounds how many tracked-change/comment entries get listed — a
// pathological review history shouldn't blow the per-doc character budget.
const MAX_LISTED = 20;

/**
 * @param {{
 *   coreProps: Partial<ReturnType<typeof extractCoreProps>>,
 *   appProps: Partial<ReturnType<typeof extractAppProps>>,
 *   insertions: DocxRevision[],
 *   deletions: DocxRevision[],
 *   comments: DocxRevision[],
 * }} parts
 * @returns {string | null}
 */
function formatDocxMetadata({ coreProps, appProps, insertions, deletions, comments }) {
  /** @type {string[]} */
  const lines = [];
  if (coreProps.creator) lines.push(`Author: ${coreProps.creator}`);
  if (coreProps.lastModifiedBy && coreProps.lastModifiedBy !== coreProps.creator) {
    lines.push(`Last modified by: ${coreProps.lastModifiedBy}`);
  }
  if (coreProps.created) lines.push(`Created: ${coreProps.created}`);
  if (coreProps.modified) lines.push(`Modified: ${coreProps.modified}`);
  if (coreProps.revision) lines.push(`Revision: ${coreProps.revision}`);
  if (coreProps.title) lines.push(`Title: ${coreProps.title}`);
  if (coreProps.subject) lines.push(`Subject: ${coreProps.subject}`);
  if (coreProps.keywords) lines.push(`Keywords: ${coreProps.keywords}`);
  if (appProps.company) lines.push(`Company: ${appProps.company}`);
  if (appProps.manager) lines.push(`Manager: ${appProps.manager}`);
  if (appProps.application) lines.push(`Created with: ${appProps.application}`);

  const listBlock = (/** @type {string} */ label, /** @type {DocxRevision[]} */ items) => {
    lines.push("", `${label} (${items.length}):`);
    for (const it of items.slice(0, MAX_LISTED)) {
      const who = it.author || "Unknown";
      const when = it.date ? ` on ${it.date.slice(0, 10)}` : "";
      lines.push(`  - by ${who}${when}: "${it.text.trim()}"`);
    }
    if (items.length > MAX_LISTED) lines.push(`  - (${items.length - MAX_LISTED} more not shown)`);
  };
  if (deletions.length) listBlock("Unaccepted tracked deletions — text removed but still present in the file", deletions);
  if (insertions.length) listBlock("Unaccepted tracked insertions", insertions);
  if (comments.length) listBlock("Reviewer comments", comments);

  return lines.length ? lines.join("\n") : null;
}

/** @param {string} s */
function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** @param {string} xml tracked-changes-stripped word/document.xml */
function docxXmlToText(xml) {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

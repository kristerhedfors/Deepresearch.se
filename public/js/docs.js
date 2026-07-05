// Client-side document parsing for attachments: pdf, docx, md, txt.
// Everything runs in the browser — file contents never touch our server
// except as the extracted text embedded in the chat message.
//
// - txt/md: read directly.
// - pdf: pdf.js (vendored, ~1.8MB with worker) dynamically imported ONLY
//   when a PDF is actually attached.
// - docx: a .docx is a ZIP with the text in word/document.xml. Parsed here
//   with a minimal central-directory reader + DecompressionStream
//   ("deflate-raw") — no library needed.

const EXT_RE = /\.(pdf|docx|md|txt)$/i;

export function isParsableDoc(file) {
  return EXT_RE.test(file.name);
}

export function docExt(file) {
  return (file.name.match(EXT_RE)?.[1] || "").toLowerCase();
}

// Returns {text, truncated}. Throws with a user-presentable message.
export async function parseDocFile(file, maxChars) {
  const ext = docExt(file);
  let text;
  if (ext === "txt" || ext === "md") {
    text = await file.text();
  } else if (ext === "pdf") {
    text = await parsePdf(file, maxChars);
  } else if (ext === "docx") {
    text = await parseDocx(file);
  } else {
    throw new Error("Unsupported file type.");
  }
  text = String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) throw new Error("No readable text found in " + file.name + ".");
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated };
}

// ---- PDF (lazy pdf.js) -----------------------------------------------------

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("/vendor/pdfjs/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

async function parsePdf(file, maxChars) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  let out = "";
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      out += tc.items.map((it) => it.str).join(" ") + "\n\n";
      // A little slack past the cap so the caller can mark truncation.
      if (out.length > maxChars + 2000) break;
    }
  } finally {
    doc.destroy();
  }
  return out;
}

// ---- DOCX (minimal ZIP + document.xml) --------------------------------------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function parseDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);

  // End-of-central-directory record: scan backwards for its signature.
  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(file.name + " does not look like a valid .docx file.");
  let off = dv.getUint32(eocd + 16, true); // central directory offset
  const count = dv.getUint16(eocd + 10, true);

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (name === "word/document.xml") {
      // Local header repeats name/extra lengths (extra may differ).
      const lNameLen = dv.getUint16(lho + 26, true);
      const lExtraLen = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + csize);
      const xmlBytes = method === 8 ? await inflateRaw(raw) : raw;
      return docxXmlToText(new TextDecoder().decode(xmlBytes));
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("Could not find the document text inside " + file.name + ".");
}

function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

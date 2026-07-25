// @ts-check
// PDF report generation for answers — branded DeepResearch.se.
// jsPDF (vendored, ~360KB) is injected on first use only, so the normal
// page load never pays for it.

/** @type {Promise<void>|null} */
let jspdfLoading = null;

// jsPDF is a vendored UMD bundle that attaches itself to window. Read it
// lazily — this module is imported in Node by its unit suite, where the
// pure helpers work fine but `window` does not exist.
const win = () => /** @type {Window & {jspdf?: any}} */ (window);
function loadJsPdf() {
  if (win().jspdf) return Promise.resolve();
  if (!jspdfLoading) {
    jspdfLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/jspdf.umd.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load the PDF library."));
      document.head.appendChild(s);
    });
  }
  return jspdfLoading;
}

const ACCENT = [13, 79, 160]; // --accent
const TEXT = [10, 46, 92]; // --text
const MUTED = [47, 93, 142]; // --muted

// jsPDF's standard Helvetica encodes text as cp1252 (WinAnsi). A character
// outside that set — an arrow above all — does NOT just render wrong: jsPDF
// silently switches the WHOLE text() run to a 2-byte encoding, so the entire
// line comes out wide-spaced mojibake (feedback #17: "Värdnamn: basalt.se →
// IP …" printed spaced-out with the → as `!'`). The model readily emits such
// glyphs, so map the common ones to ASCII and drop anything else cp1252 can't
// hold. Latin-1 (å ä ö é … ≤ 0xFF) and the cp1252 high punctuation that jsPDF
// DOES support (smart quotes, en/em dash, ellipsis, bullet) are kept as-is.
const PDF_CP1252_HIGH = new Set(
  "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""),
);
const PDF_TRANSLIT = {
  "→": "->", "⟶": "->", "↦": "->", "⇒": "=>", "⟹": "=>", "➞": "->", "➜": "->",
  "←": "<-", "⟵": "<-", "↔": "<->", "⇄": "<->", "⇆": "<->", "↑": "^", "↓": "v",
  "≥": ">=", "≤": "<=", "≠": "!=", "≈": "~", "≡": "=", "∼": "~", "∝": "~",
  "−": "-", "‑": "-", "‒": "-", "―": "-", "⁃": "-", "∙": "-", "▪": "-", "◦": "-",
  "±": "+/-", "∓": "-/+", "∞": "inf", "√": "sqrt", "∑": "sum", "∏": "prod",
  "✓": "[x]", "✔": "[x]", "☑": "[x]", "✗": "[ ]", "✘": "[ ]", "☒": "[ ]",
  "★": "*", "☆": "*", "▶": ">", "◆": "*",
};
/** @param {unknown} s */
function sanitizeForPdf(s) {
  let out = "";
  for (const ch of String(s)) {
    if ((ch.codePointAt(0) ?? 0) <= 0xff || PDF_CP1252_HIGH.has(ch)) { out += ch; continue; }
    out += /** @type {Record<string, string>} */ (PDF_TRANSLIT)[ch] ?? " ";
  }
  return out;
}

// Inline markers (** ` ) are flattened so the PDF text stays readable; the
// result is also sanitized to what jsPDF's standard font can encode.
/** @param {unknown} s */
function stripInline(s) {
  return sanitizeForPdf(
    String(s).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"),
  );
}

export { sanitizeForPdf };

// Split one GFM table row into trimmed, inline-flattened cells. Leading and
// trailing pipes are optional; escaped pipes (\|) stay inside a cell.
/** @param {unknown} line */
function splitTableRow(line) {
  const cells = String(line).trim().replace(/^\|/, "").replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => stripInline(c.replace(/\\\|/g, "|")).trim());
  return cells;
}

// A GFM delimiter row is all `---`/`:--:` cells, e.g. `|---|:--:|---|`.
/** @param {string|null|undefined} line */
function isTableDelimiter(line) {
  if (line == null || line.indexOf("|") === -1) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

// A line that could be a table row: non-blank and carrying a pipe.
/** @param {string|null|undefined} line */
function isTableRow(line) {
  return line != null && line.indexOf("|") !== -1 && line.trim().length > 0;
}

// Light markdown -> flow of typed blocks for the PDF: headings, bullets,
// plain paragraphs, and GFM pipe tables (header + `---` delimiter + rows),
// rendered as real ruled tables instead of raw ASCII pipes.
/** @param {unknown} md @returns {any[]} */
export function mdToBlocks(md) {
  const blocks = [];
  const raws = String(md).split("\n");
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];
    // A table starts where a pipe row is immediately followed by a
    // delimiter row. Everything up to the first non-table line is the body.
    if (isTableRow(raw) && isTableDelimiter(raws[i + 1])) {
      const header = splitTableRow(raw);
      const rows = [];
      i += 2; // consume header + delimiter
      while (i < raws.length && isTableRow(raws[i]) && !isTableDelimiter(raws[i])) {
        rows.push(splitTableRow(raws[i]));
        i++;
      }
      i--; // step back so the for-loop's i++ lands on the next line
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const line = stripInline(raw);
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      blocks.push({ kind: "h" + h[1].length, text: h[2].trim() });
    } else if (/^\s*[-*•]\s+/.test(line)) {
      blocks.push({ kind: "li", text: line.replace(/^\s*[-*•]\s+/, "") });
    } else if (/^\s*\d+\.\s+/.test(line)) {
      // Numbered items keep their own "1." marker — no bullet on top.
      blocks.push({ kind: "li", text: line.trim(), ordered: true });
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

/**
 * Generates and downloads the report.
 * @param {{text?: string, question?: string, images?: string[]}} turn  the turn
 *   object (turns.js Turn) — .text is the markdown answer, .question the
 *   title, .images the embedded figures
 * @param {{model?: string}} [meta]  extra metadata printed under the title
 * @returns {Promise<void>} resolves once the share sheet / download started
 */
export async function downloadReport(turn, meta = {}) {
  await loadJsPdf();
  const { jsPDF } = win().jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 52; // margin
  const bodyW = W - 2 * M;
  let y = 0;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const header = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...ACCENT);
    doc.text("DeepResearch.se", M, 36);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text("Research report · " + dateStr, W - M, 36, { align: "right" });
    doc.setDrawColor(...ACCENT);
    doc.setLineWidth(1.1);
    doc.line(M, 44, W - M, 44);
    y = 66;
  };
  const footer = () => {
    const page = doc.getCurrentPageInfo().pageNumber;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text("Generated by DeepResearch.se", M, H - 26);
    doc.text("Page " + page, W - M, H - 26, { align: "right" });
  };
  const newPage = () => {
    footer();
    doc.addPage();
    header();
  };
  const ensure = (/** @type {number} */ needed) => {
    if (y + needed > H - 48) newPage();
  };

  header();

  // Question as the title.
  if (turn.question) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...TEXT);
    for (const line of doc.splitTextToSize(sanitizeForPdf(turn.question), bodyW)) {
      ensure(20);
      doc.text(line, M, y);
      y += 19;
    }
    y += 2;
  }
  if (meta.model) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    ensure(14);
    doc.text("Model: " + sanitizeForPdf(meta.model), M, y);
    y += 18;
  }

  // Images the user attached to the question, embedded as figures under
  // the title — the same downscaled JPEG data URLs that went to the model.
  const maxImgH = H - 48 - 66; // printable height between header and footer
  for (const dataUrl of turn.images || []) {
    let props;
    try {
      props = doc.getImageProperties(dataUrl);
    } catch {
      continue; // unreadable image — never block the report over a figure
    }
    if (!props?.width || !props?.height) continue;
    let w = Math.min(bodyW, props.width * 0.75); // px at 96dpi → pt
    let h = (props.height / props.width) * w;
    if (h > maxImgH) {
      w *= maxImgH / h;
      h = maxImgH;
    }
    ensure(h + 6);
    doc.addImage(dataUrl, "JPEG", M, y, w, h);
    y += h + 14;
  }

  // Draws a GFM table as ruled cells with a shaded, repeated header row.
  const TABLE_BORDER = [198, 210, 226];
  const TABLE_HEAD_FILL = [223, 232, 245];
  const drawTable = (/** @type {string[]} */ header, /** @type {string[][]} */ rows) => {
    const ncols = Math.max(header.length, ...rows.map((/** @type {string[]} */ r) => r.length), 1);
    const colW = bodyW / ncols;
    const padX = 5, padY = 5, lineH = 12, fontSize = 9;
    const measure = (/** @type {string[]} */ cells, /** @type {string} */ style) => {
      doc.setFont("helvetica", style);
      doc.setFontSize(fontSize);
      let maxLines = 1;
      const arr = [];
      for (let c = 0; c < ncols; c++) {
        const txt = cells[c] == null ? "" : String(cells[c]);
        const wrapped = txt ? doc.splitTextToSize(txt, colW - 2 * padX) : [""];
        arr.push(wrapped);
        if (wrapped.length > maxLines) maxLines = wrapped.length;
      }
      return { arr, h: maxLines * lineH + 2 * padY };
    };
    const paint = (
      /** @type {string[]} */ cells,
      /** @type {string} */ style,
      /** @type {number[]|null} */ fill,
    ) => {
      const { arr, h } = measure(cells, style);
      if (fill) {
        doc.setFillColor(...fill);
        doc.rect(M, y, bodyW, h, "F");
      }
      doc.setDrawColor(...TABLE_BORDER);
      doc.setLineWidth(0.6);
      doc.setTextColor(...TEXT);
      doc.setFont("helvetica", style);
      doc.setFontSize(fontSize);
      for (let c = 0; c < ncols; c++) {
        const x = M + c * colW;
        doc.rect(x, y, colW, h);
        arr[c].forEach((/** @type {string} */ ln, /** @type {number} */ li) =>
        doc.text(ln, x + padX, y + padY + fontSize + lineH * li),
      );
      }
      y += h;
    };
    y += 6;
    if (y + measure(header, "bold").h > H - 48) newPage();
    paint(header, "bold", TABLE_HEAD_FILL);
    for (const r of rows) {
      if (y + measure(r, "normal").h > H - 48) {
        newPage();
        paint(header, "bold", TABLE_HEAD_FILL); // repeat header after a break
      }
      paint(r, "normal", null);
    }
    y += 8;
  };

  // Body.
  for (const b of mdToBlocks(turn.text)) {
    if (b.kind === "table") {
      drawTable(b.header, b.rows);
      continue;
    }
    if (!b.text.trim()) {
      y += 7;
      continue;
    }
    let size = 10.5;
    let style = "normal";
    let indent = 0;
    let prefix = "";
    let lead = 15;
    if (b.kind === "h1") { size = 13; style = "bold"; lead = 20; y += 6; }
    else if (b.kind === "h2") { size = 12; style = "bold"; lead = 18; y += 5; }
    else if (b.kind === "h3" || b.kind === "h4") { size = 11; style = "bold"; lead = 16; y += 4; }
    else if (b.kind === "li") { indent = 14; prefix = b.ordered ? "" : "•  "; }
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...TEXT);
    const lines = doc.splitTextToSize(b.text, bodyW - indent - (prefix ? 10 : 0));
    lines.forEach((/** @type {string} */ line, /** @type {number} */ i) => {
      ensure(lead + 2);
      doc.text((i === 0 ? prefix : prefix ? "   " : "") + line, M + indent, y);
      y += lead;
    });
  }
  footer();

  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  await savePdf(doc, `deepresearch-report-${stamp}.pdf`);
}

// NEVER use jsPDF's doc.save(): its Safari fallback navigates the page to
// the blob URL, and a navigation aborts every in-flight fetch (it killed a
// streaming answer in production). Hand the blob over ourselves instead —
// the native share sheet on touch devices (no navigation, and the natural
// way to save/AirDrop/mail a file on a phone), else a plain <a download>.
/**
 * @param {any} doc a jsPDF document
 * @param {string} filename
 */
async function savePdf(doc, filename) {
  const blob = doc.output("blob");
  const file = new File([blob], filename, { type: "application/pdf" });
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (/** @type {any} */ (err)?.name === "AbortError") return; // user closed the sheet
      // Gesture expired or share refused — fall through to the download.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the blob alive long enough for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

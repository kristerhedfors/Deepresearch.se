// @ts-check
// A minimal ZIP *writer* — enough to hand the browser a folder of text files
// as one download. Pure and I/O-free, so it is Node-tested (zip-core.test.js)
// and runs unchanged in the Worker (façade-free: src/memory.js imports it
// directly, the same way the other pure cores are shared).
//
// WHY HAND-ROLLED. Invariant 5: no runtime dependencies. The repo already
// hand-rolls the READ direction (public/js/docs.js's central-directory reader
// for .docx), and writing is the easier half — an archive of small Markdown
// notes needs one entry shape, not the format's full surface.
//
// STORED, NOT DEFLATED. Every entry is written with compression method 0, so
// there is no compressor to get wrong and no async step in the hot path. The
// cost is size, and for a Markdown vault that cost is small and bounded by the
// note caps in memory-core.js. `DecompressionStream` exists in both runtimes
// if the read direction is ever needed here, but the write direction has no
// symmetric `CompressionStream("deflate-raw")` guarantee across the browsers
// this project supports on old iOS, so stored is also the portable choice.
//
// The output is DETERMINISTIC for a given input: entry order is the caller's,
// and the DOS timestamp comes from an explicit argument rather than the clock.
// That is what lets a test assert on exact bytes, and it keeps two exports of
// an unchanged vault byte-identical.

/**
 * CRC-32 (IEEE 802.3), the checksum every zip entry carries. Table built once
 * per module load.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @returns {number} unsigned CRC-32
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Encode a Date as the DOS date/time pair zip stores. Zip's epoch is 1980 and
 * its seconds field has two-second resolution; anything before 1980 clamps to
 * it rather than writing a negative year that unzip tools reject.
 * @param {Date} date
 * @returns {{ time: number, date: number }}
 */
export function dosDateTime(date) {
  const y = date.getUTCFullYear();
  if (y < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00:00
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dosDate };
}

/**
 * Build a ZIP archive from text files.
 *
 * Names are stored as UTF-8 with the language-encoding flag (bit 11) set, so
 * non-ASCII note titles survive the round trip into Obsidian on every platform
 * — the Swedish titles this project's users will actually produce are the
 * reason that bit is not optional here (invariant 6's spirit: a feature is not
 * done if it only works in English).
 *
 * @param {Array<{ path: string, text: string }>} files entry path (forward
 *   slashes, no leading slash) and its UTF-8 text content
 * @param {{ date?: Date }} [opts] timestamp stamped on every entry; defaults
 *   to the zip epoch so output stays deterministic unless a caller opts in
 * @returns {Uint8Array} the complete archive
 */
export function zipText(files, opts = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(opts.date || new Date(Date.UTC(1980, 0, 1)));
  const entries = files.map((f) => ({
    name: enc.encode(String(f.path).replace(/^\/+/, "")),
    body: enc.encode(String(f.text ?? "")),
  }));

  // Size the buffer exactly: local headers (30) + central headers (46) + names
  // twice + bodies + the end-of-central-directory record (22).
  const total =
    entries.reduce((n, e) => n + 30 + e.name.length + e.body.length + 46 + e.name.length, 0) + 22;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;

  /** @param {Uint8Array} bytes */
  const put = (bytes) => {
    out.set(bytes, off);
    off += bytes.length;
  };

  const FLAG_UTF8 = 0x0800;
  /** @type {number[]} */
  const offsets = [];
  /** @type {number[]} */
  const crcs = [];

  for (const e of entries) {
    offsets.push(off);
    const crc = crc32(e.body);
    crcs.push(crc);
    dv.setUint32(off, 0x04034b50, true); // local file header signature
    dv.setUint16(off + 4, 20, true); // version needed
    dv.setUint16(off + 6, FLAG_UTF8, true);
    dv.setUint16(off + 8, 0, true); // method: stored
    dv.setUint16(off + 10, time, true);
    dv.setUint16(off + 12, date, true);
    dv.setUint32(off + 14, crc, true);
    dv.setUint32(off + 18, e.body.length, true); // compressed size == raw
    dv.setUint32(off + 22, e.body.length, true);
    dv.setUint16(off + 26, e.name.length, true);
    dv.setUint16(off + 28, 0, true); // extra field length
    off += 30;
    put(e.name);
    put(e.body);
  }

  const cdStart = off;
  entries.forEach((e, i) => {
    dv.setUint32(off, 0x02014b50, true); // central directory header signature
    dv.setUint16(off + 4, 20, true); // version made by
    dv.setUint16(off + 6, 20, true); // version needed
    dv.setUint16(off + 8, FLAG_UTF8, true);
    dv.setUint16(off + 10, 0, true); // method: stored
    dv.setUint16(off + 12, time, true);
    dv.setUint16(off + 14, date, true);
    dv.setUint32(off + 16, crcs[i], true);
    dv.setUint32(off + 20, e.body.length, true);
    dv.setUint32(off + 24, e.body.length, true);
    dv.setUint16(off + 28, e.name.length, true);
    dv.setUint16(off + 30, 0, true); // extra
    dv.setUint16(off + 32, 0, true); // comment
    dv.setUint16(off + 34, 0, true); // disk number start
    dv.setUint16(off + 36, 0, true); // internal attrs
    dv.setUint32(off + 38, 0, true); // external attrs
    dv.setUint32(off + 42, offsets[i], true);
    off += 46;
    put(e.name);
  });

  dv.setUint32(off, 0x06054b50, true); // end of central directory
  dv.setUint16(off + 4, 0, true); // this disk
  dv.setUint16(off + 6, 0, true); // disk with central directory
  dv.setUint16(off + 8, entries.length, true);
  dv.setUint16(off + 10, entries.length, true);
  dv.setUint32(off + 12, off - cdStart, true);
  dv.setUint32(off + 16, cdStart, true);
  dv.setUint16(off + 20, 0, true); // comment length

  return out;
}

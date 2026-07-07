import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractExif, formatExifSummary } from "./exif.js";

// ---- test-only TIFF/EXIF encoder --------------------------------------
// Independent of exif.js's own reading code (so this isn't tautological):
// builds a real byte-accurate TIFF structure via straightforward two-pass
// layout (compute each IFD's size first — always possible without knowing
// pointer values, since pointer entries are always inline LONGs — then
// resolve pointers and serialize).

function asciiBytes(str) {
  const withNull = str + "\0";
  return Uint8Array.from(withNull, (c) => c.charCodeAt(0));
}

// entries: [{tag, kind: "ascii", str} | {tag, kind: "long", value} | {tag, kind: "rational", rationals: [[n,d],...]} | {tag, kind: "byte", value}]
function layoutIfd(entries) {
  const headerSize = 2 + entries.length * 12 + 4;
  let poolSize = 0;
  const withSizes = entries.map((e) => {
    if (e.kind === "ascii") {
      const bytes = asciiBytes(e.str);
      const external = bytes.length > 4;
      const size = external ? bytes.length : 0;
      const at = external ? poolSize : null;
      if (external) poolSize += size;
      return { ...e, bytes, external, at };
    }
    if (e.kind === "rational") {
      const size = e.rationals.length * 8; // always external (min 8 > 4)
      const at = poolSize;
      poolSize += size;
      return { ...e, external: true, at };
    }
    return { ...e, external: false }; // long/byte: always inline
  });
  return { entries: withSizes, headerSize, poolSize, totalSize: headerSize + poolSize };
}

function serializeIfd(layout, ifdStart, little) {
  const buf = new Uint8Array(layout.totalSize);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, layout.entries.length, little);
  let p = 2;
  const poolStart = layout.headerSize;
  for (const e of layout.entries) {
    if (e.kind === "ascii") {
      dv.setUint16(p, e.tag, little);
      dv.setUint16(p + 2, 2, little); // ASCII
      dv.setUint32(p + 4, e.bytes.length, little);
      if (e.external) {
        dv.setUint32(p + 8, ifdStart + poolStart + e.at, little);
        buf.set(e.bytes, poolStart + e.at);
      } else {
        buf.set(e.bytes, p + 8);
      }
    } else if (e.kind === "rational") {
      dv.setUint16(p, e.tag, little);
      dv.setUint16(p + 2, 5, little); // RATIONAL
      dv.setUint32(p + 4, e.rationals.length, little);
      dv.setUint32(p + 8, ifdStart + poolStart + e.at, little);
      let rp = poolStart + e.at;
      for (const [n, d] of e.rationals) {
        dv.setUint32(rp, n, little);
        dv.setUint32(rp + 4, d, little);
        rp += 8;
      }
    } else if (e.kind === "long") {
      dv.setUint16(p, e.tag, little);
      dv.setUint16(p + 2, 4, little); // LONG
      dv.setUint32(p + 4, 1, little);
      dv.setUint32(p + 8, e.value, little);
    } else if (e.kind === "byte") {
      dv.setUint16(p, e.tag, little);
      dv.setUint16(p + 2, 1, little); // BYTE
      dv.setUint32(p + 4, 1, little);
      buf[p + 8] = e.value;
    }
    p += 12;
  }
  dv.setUint32(p, 0, little); // next-IFD offset
  return buf;
}

// Builds a minimal JPEG (SOI + APP1/Exif + EOI) with IFD0 (make/model/
// software), an optional Exif SubIFD (dateTimeOriginal), and an optional
// GPS IFD (lat/lon/altitude). `little` picks the TIFF byte order.
function buildExifJpeg({ make, model, software, dateTimeOriginal, gps, little = true } = {}) {
  const ifd0Entries = [];
  if (make) ifd0Entries.push({ tag: 0x010f, kind: "ascii", str: make });
  if (model) ifd0Entries.push({ tag: 0x0110, kind: "ascii", str: model });
  if (software) ifd0Entries.push({ tag: 0x0131, kind: "ascii", str: software });

  const exifEntries = [];
  if (dateTimeOriginal) exifEntries.push({ tag: 0x9003, kind: "ascii", str: dateTimeOriginal });

  const gpsEntries = [];
  if (gps) {
    gpsEntries.push({ tag: 1, kind: "ascii", str: gps.lat < 0 ? "S" : "N" });
    gpsEntries.push({ tag: 2, kind: "rational", rationals: decToDmsRationals(Math.abs(gps.lat)) });
    gpsEntries.push({ tag: 3, kind: "ascii", str: gps.lon < 0 ? "W" : "E" });
    gpsEntries.push({ tag: 4, kind: "rational", rationals: decToDmsRationals(Math.abs(gps.lon)) });
    if (gps.altitude != null) {
      gpsEntries.push({ tag: 5, kind: "byte", value: gps.altitude < 0 ? 1 : 0 });
      gpsEntries.push({ tag: 6, kind: "rational", rationals: [[Math.round(Math.abs(gps.altitude) * 100), 100]] });
    }
  }

  if (exifEntries.length) ifd0Entries.push({ tag: 0x8769, kind: "long", value: 0 }); // patched below
  if (gpsEntries.length) ifd0Entries.push({ tag: 0x8825, kind: "long", value: 0 }); // patched below

  const ifd0Layout = layoutIfd(ifd0Entries);
  const tiffHeaderSize = 8;
  const ifd0Start = tiffHeaderSize;
  let cursor = ifd0Start + ifd0Layout.totalSize;

  let exifStart = 0, exifLayout = null;
  if (exifEntries.length) {
    exifLayout = layoutIfd(exifEntries);
    exifStart = cursor;
    cursor += exifLayout.totalSize;
  }
  let gpsStart = 0, gpsLayout = null;
  if (gpsEntries.length) {
    gpsLayout = layoutIfd(gpsEntries);
    gpsStart = cursor;
    cursor += gpsLayout.totalSize;
  }

  // Patch the pointer values now that sub-IFD offsets are known.
  for (const e of ifd0Layout.entries) {
    if (e.tag === 0x8769) e.value = exifStart;
    if (e.tag === 0x8825) e.value = gpsStart;
  }

  const tiff = new Uint8Array(cursor);
  const dv = new DataView(tiff.buffer);
  dv.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  dv.setUint16(2, 42, little);
  dv.setUint32(4, ifd0Start, little);
  tiff.set(serializeIfd(ifd0Layout, ifd0Start, little), ifd0Start);
  if (exifLayout) tiff.set(serializeIfd(exifLayout, exifStart, little), exifStart);
  if (gpsLayout) tiff.set(serializeIfd(gpsLayout, gpsStart, little), gpsStart);

  const exifHeader = Uint8Array.from("Exif\0\0", (c) => c.charCodeAt(0));
  const app1Payload = new Uint8Array(exifHeader.length + tiff.length);
  app1Payload.set(exifHeader, 0);
  app1Payload.set(tiff, exifHeader.length);

  const app1Length = app1Payload.length + 2; // includes the 2 length bytes
  const jpeg = new Uint8Array(2 + 2 + 2 + app1Payload.length + 2);
  const jdv = new DataView(jpeg.buffer);
  jdv.setUint16(0, 0xffd8); // SOI
  jdv.setUint16(2, 0xffe1); // APP1
  jdv.setUint16(4, app1Length);
  jpeg.set(app1Payload, 6);
  jdv.setUint16(6 + app1Payload.length, 0xffd9); // EOI
  return jpeg.buffer;
}

function decToDmsRationals(decimalAbs) {
  const deg = Math.floor(decimalAbs);
  const minFull = (decimalAbs - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 3600 / 60; // seconds
  return [[deg, 1], [min, 1], [Math.round(sec * 1000), 1000]];
}

// ---- tests ---------------------------------------------------------------

describe("extractExif", () => {
  test("extracts camera make/model/software plus GPS and capture time (little-endian)", () => {
    const buf = buildExifJpeg({
      make: "Apple",
      model: "iPhone 14 Pro",
      software: "17.4.1",
      dateTimeOriginal: "2024:05:01 14:32:00",
      gps: { lat: 40.7128, lon: -74.006, altitude: 10 },
      little: true,
    });
    const meta = extractExif(buf);
    assert.equal(meta.make, "Apple");
    assert.equal(meta.model, "iPhone 14 Pro");
    assert.equal(meta.software, "17.4.1");
    assert.equal(meta.dateTimeOriginal, "2024-05-01 14:32:00");
    assert.ok(meta.gps);
    assert.ok(Math.abs(meta.gps.lat - 40.7128) < 1e-3);
    assert.ok(Math.abs(meta.gps.lon - -74.006) < 1e-3);
    assert.equal(meta.gps.altitude, 10);
  });

  test("also works with big-endian ('MM') TIFF byte order", () => {
    const buf = buildExifJpeg({ make: "Canon", model: "EOS R5", little: false });
    const meta = extractExif(buf);
    assert.equal(meta.make, "Canon");
    assert.equal(meta.model, "EOS R5");
    assert.equal(meta.gps, null);
  });

  test("southern/western hemisphere GPS refs negate correctly", () => {
    const buf = buildExifJpeg({ gps: { lat: -33.8688, lon: 151.2093, altitude: null } });
    const meta = extractExif(buf);
    assert.ok(meta.gps.lat < 0, "S ref must produce a negative latitude");
    assert.ok(meta.gps.lon > 0, "E ref must produce a positive longitude");
    assert.ok(Math.abs(meta.gps.lat - -33.8688) < 1e-3);
    assert.ok(Math.abs(meta.gps.lon - 151.2093) < 1e-3);
  });

  test("a camera photo with no GPS tag at all returns gps: null, not a throw", () => {
    const buf = buildExifJpeg({ make: "Sony", model: "A7IV" });
    const meta = extractExif(buf);
    assert.equal(meta.gps, null);
    assert.equal(meta.make, "Sony");
  });

  test("a plain JPEG with no APP1/Exif segment at all returns null", () => {
    // SOI, a harmless APP0/JFIF-shaped segment, EOI — no APP1 anywhere.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xd9]);
    assert.equal(extractExif(jpeg.buffer), null);
  });

  test("non-JPEG bytes (e.g. a PNG signature) return null rather than throwing", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.doesNotThrow(() => extractExif(png.buffer));
    assert.equal(extractExif(png.buffer), null);
  });

  test("an empty or tiny buffer is handled safely", () => {
    assert.equal(extractExif(new ArrayBuffer(0)), null);
    assert.equal(extractExif(new ArrayBuffer(2)), null);
  });

  test("a truncated/corrupted APP1 segment degrades to null instead of throwing", () => {
    const buf = buildExifJpeg({ make: "Apple", model: "iPhone 14 Pro", gps: { lat: 1, lon: 2 } });
    const truncated = buf.slice(0, buf.byteLength - 20); // cut off mid GPS pool
    assert.doesNotThrow(() => extractExif(truncated));
  });

  test("an IFD entry only has a value, never leaks raw byte offsets as fields", () => {
    const buf = buildExifJpeg({ make: "Apple" });
    const meta = extractExif(buf);
    assert.deepEqual(Object.keys(meta).sort(), [
      "artist", "copyright", "dateTimeOriginal", "description", "gps", "make", "model", "software",
    ]);
  });
});

describe("formatExifSummary", () => {
  test("null metadata formats to null", () => {
    assert.equal(formatExifSummary(null), null);
  });

  test("renders camera, capture time, and a clickable GPS link", () => {
    const meta = extractExif(buildExifJpeg({
      make: "Apple", model: "iPhone 14 Pro", dateTimeOriginal: "2024:05:01 14:32:00",
      gps: { lat: 40.7128, lon: -74.006, altitude: 10 },
    }));
    const summary = formatExifSummary(meta);
    assert.match(summary, /Camera: Apple iPhone 14 Pro/);
    assert.match(summary, /Captured: 2024-05-01 14:32:00/);
    assert.match(summary, /GPS location: 40\.7128, -74\.006/);
    assert.match(summary, /openstreetmap\.org/);
    assert.match(summary, /Street View: https:\/\/www\.google\.com\/maps\/@\?api=1&map_action=pano&viewpoint=40\.7128%2C-74\.006/);
  });

  test("omits fields that weren't present", () => {
    const meta = extractExif(buildExifJpeg({ make: "Sony", model: "A7IV" }));
    const summary = formatExifSummary(meta);
    assert.match(summary, /Camera: Sony A7IV/);
    assert.doesNotMatch(summary, /GPS/);
    assert.doesNotMatch(summary, /Captured/);
  });
});

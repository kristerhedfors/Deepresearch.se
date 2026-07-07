// Minimal JPEG/EXIF parser — no library, operates on the raw ArrayBuffer.
// Must run on the ORIGINAL file bytes before attachments.js's canvas-based
// downscale, since re-encoding through <canvas>.toDataURL() strips all
// metadata. PNG/WebP/GIF are not handled (real-world EXIF is overwhelmingly
// a JPEG/camera-photo phenomenon) — extractExif() returns null for them.
//
// Extracted fields can include the photo's GPS location, capture time, and
// device — genuinely sensitive, not just informational. Callers are
// responsible for surfacing that to the user before it's sent anywhere
// (see attachments.js's metadata badge + CLAUDE.md's documentation).

const APP1 = 0xffe1;
const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// Returns null (no EXIF / not a JPEG / malformed) or:
// { make, model, software, artist, copyright, description, dateTimeOriginal,
//   gps: { lat, lon, altitude } | null }
export function extractExif(arrayBuffer) {
  try {
    return parseJpegExif(new DataView(arrayBuffer));
  } catch {
    // Malformed/truncated segment: degrade to "no metadata" rather than
    // blocking the attachment — the image itself is still perfectly usable.
    return null;
  }
}

function parseJpegExif(dv) {
  if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return null; // not a JPEG (SOI)

  let offset = 2;
  while (offset + 4 <= dv.byteLength) {
    const marker = dv.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // not a marker — malformed
    if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; } // SOI/EOI, no length
    if (marker >= 0xffd0 && marker <= 0xffd7) { offset += 2; continue; } // RSTn, no length
    if (marker === 0xffda) break; // SOS: entropy-coded data follows, no more markers before it

    const length = dv.getUint16(offset + 2); // includes the 2 length bytes, excludes the marker
    if (marker === APP1 && hasExifHeader(dv, offset + 4)) {
      return parseTiff(dv, offset + 4 + 6); // skip "Exif\0\0"
    }
    offset += 2 + length;
  }
  return null;
}

function hasExifHeader(dv, at) {
  if (at + 6 > dv.byteLength) return false;
  return (
    dv.getUint8(at) === 0x45 && dv.getUint8(at + 1) === 0x78 && dv.getUint8(at + 2) === 0x69 &&
    dv.getUint8(at + 3) === 0x66 && dv.getUint8(at + 4) === 0 && dv.getUint8(at + 5) === 0
  );
}

function parseTiff(dv, tiffStart) {
  const bom = dv.getUint16(tiffStart);
  let little;
  if (bom === 0x4949) little = true;
  else if (bom === 0x4d4d) little = false;
  else return null;
  if (dv.getUint16(tiffStart + 2, little) !== 42) return null;

  const ifd0Offset = dv.getUint32(tiffStart + 4, little);
  const ifd0 = readIfd(dv, tiffStart, tiffStart + ifd0Offset, little);

  const out = {
    make: asString(ifd0.get(0x010f)),
    model: asString(ifd0.get(0x0110)),
    software: asString(ifd0.get(0x0131)),
    artist: asString(ifd0.get(0x013b)),
    copyright: asString(ifd0.get(0x8298)),
    description: asString(ifd0.get(0x010e)),
    dateTimeOriginal: null,
    gps: null,
  };

  const exifPtr = ifd0.get(EXIF_IFD_POINTER);
  if (exifPtr && typeof exifPtr.value[0] === "number") {
    const exifIfd = readIfd(dv, tiffStart, tiffStart + exifPtr.value[0], little);
    out.dateTimeOriginal = asDateTime(exifIfd.get(0x9003)) || asDateTime(exifIfd.get(0x9004));
  }

  const gpsPtr = ifd0.get(GPS_IFD_POINTER);
  if (gpsPtr && typeof gpsPtr.value[0] === "number") {
    const gpsIfd = readIfd(dv, tiffStart, tiffStart + gpsPtr.value[0], little);
    out.gps = readGps(gpsIfd);
  }

  if (!out.make && !out.model && !out.software && !out.artist && !out.copyright &&
      !out.description && !out.dateTimeOriginal && !out.gps) {
    return null; // header present but nothing usable — treat as "no metadata"
  }
  return out;
}

// Reads one IFD into a Map<tag, {type, count, value}>. `value` is always an
// array (length `count`) of numbers, or for ASCII/UNDEFINED a decoded string
// already assembled by readValue.
function readIfd(dv, tiffStart, ifdOffset, little) {
  const entries = new Map();
  if (ifdOffset <= 0 || ifdOffset + 2 > dv.byteLength) return entries;
  const count = dv.getUint16(ifdOffset, little);
  let p = ifdOffset + 2;
  for (let i = 0; i < count && p + 12 <= dv.byteLength; i++, p += 12) {
    const tag = dv.getUint16(p, little);
    const type = dv.getUint16(p + 2, little);
    const num = dv.getUint32(p + 4, little);
    const unitSize = TYPE_SIZES[type];
    if (!unitSize) continue; // unknown type — skip rather than misread
    const totalSize = unitSize * num;
    const valueAt = totalSize <= 4 ? p + 8 : tiffStart + dv.getUint32(p + 8, little);
    entries.set(tag, { type, count: num, value: readValue(dv, valueAt, type, num, little) });
  }
  return entries;
}

function readValue(dv, at, type, count, little) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (at + TYPE_SIZES[type] * (i + 1) > dv.byteLength) break;
    switch (type) {
      case 1: case 7: out.push(dv.getUint8(at + i)); break; // BYTE / UNDEFINED
      case 2: out.push(dv.getUint8(at + i)); break; // ASCII (assembled below)
      case 3: out.push(dv.getUint16(at + i * 2, little)); break; // SHORT
      case 4: out.push(dv.getUint32(at + i * 4, little)); break; // LONG
      case 5: { // RATIONAL
        const o = at + i * 8;
        out.push(dv.getUint32(o, little) / (dv.getUint32(o + 4, little) || 1));
        break;
      }
      case 9: out.push(dv.getInt32(at + i * 4, little)); break; // SLONG
      case 10: { // SRATIONAL
        const o = at + i * 8;
        out.push(dv.getInt32(o, little) / (dv.getInt32(o + 4, little) || 1));
        break;
      }
      default: break;
    }
  }
  if (type === 2) return [bytesToAscii(out)]; // ASCII: one assembled string
  return out;
}

function bytesToAscii(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0) break; // stop at the null terminator
    s += String.fromCharCode(b);
  }
  return s;
}

function asString(entry) {
  const v = entry?.value?.[0];
  return typeof v === "string" && v ? v : null;
}

// EXIF DateTimeOriginal is "YYYY:MM:DD HH:MM:SS" — normalize the date
// separators for readability without pulling in a date-parsing library.
function asDateTime(entry) {
  const v = asString(entry);
  if (!v) return null;
  const m = v.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : v;
}

function dmsToDecimal(values) {
  if (!Array.isArray(values) || values.length < 3) return null;
  const [deg, min, sec] = values;
  return deg + min / 60 + sec / 3600;
}

function readGps(gpsIfd) {
  const latRef = asString(gpsIfd.get(1));
  const lonRef = asString(gpsIfd.get(3));
  const latDms = gpsIfd.get(2)?.value;
  const lonDms = gpsIfd.get(4)?.value;
  const lat = dmsToDecimal(latDms);
  const lon = dmsToDecimal(lonDms);
  if (lat == null || lon == null) return null;
  const signedLat = latRef === "S" ? -lat : lat;
  const signedLon = lonRef === "W" ? -lon : lon;
  const altRef = gpsIfd.get(5)?.value?.[0];
  const altVal = gpsIfd.get(6)?.value?.[0];
  const altitude = typeof altVal === "number" ? (altRef === 1 ? -altVal : altVal) : null;
  return { lat: round6(signedLat), lon: round6(signedLon), altitude };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Human/LLM-readable summary block, or null if there's nothing to show.
export function formatExifSummary(meta) {
  if (!meta) return null;
  const lines = [];
  const camera = [meta.make, meta.model].filter(Boolean).join(" ");
  if (camera) lines.push(`Camera: ${camera}`);
  if (meta.dateTimeOriginal) lines.push(`Captured: ${meta.dateTimeOriginal}`);
  if (meta.software) lines.push(`Software: ${meta.software}`);
  if (meta.artist) lines.push(`Artist/Author: ${meta.artist}`);
  if (meta.copyright) lines.push(`Copyright: ${meta.copyright}`);
  if (meta.description) lines.push(`Description: ${meta.description}`);
  if (meta.gps) {
    const { lat, lon, altitude } = meta.gps;
    lines.push(
      `GPS location: ${lat}, ${lon}` +
        (altitude != null ? ` (altitude ${altitude} m)` : "") +
        ` — https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=15`,
    );
    // Keyless Google Maps URLs API deep link — opens the interactive Street
    // View panorama nearest the photo's coordinates. Nothing is fetched from
    // Google here; the URL only resolves if the user (or reader of the
    // answer) chooses to open it.
    lines.push(`Street View: https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat}%2C${lon}`);
  }
  return lines.length ? lines.join("\n") : null;
}

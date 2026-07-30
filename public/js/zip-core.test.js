// (no @ts-check: node:test / node:assert have no type declarations here.)
// Covers the hand-rolled ZIP writer. The test reads the archive back with an
// INDEPENDENT parser written here (central-directory walk, not a replay of the
// writer's own offsets), so a writer that is self-consistently wrong still
// fails — which is the only way to test a format implementation usefully.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, dosDateTime, zipText } from "./zip-core.js";

/**
 * Minimal reader: find the end-of-central-directory record, walk the central
 * directory, and pull each entry's bytes from its local header offset.
 */
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "no end-of-central-directory record");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(off, true), 0x02014b50, "central header signature");
    const flags = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const size = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const local = dv.getUint32(off + 42, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    assert.equal(dv.getUint32(local, true), 0x04034b50, "local header signature");
    const localNameLen = dv.getUint16(local + 26, true);
    const localExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + localNameLen + localExtraLen;
    out.push({ name, method, flags, crc, text: dec.decode(bytes.subarray(start, start + size)) });
    off += 46 + nameLen + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  return out;
}

describe("crc32", () => {
  test("matches the published check value", () => {
    // The standard CRC-32 check vector: "123456789" -> 0xCBF43926.
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  });

  test("empty input is zero", () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
});

describe("dosDateTime", () => {
  test("encodes a date after the zip epoch", () => {
    const { time, date } = dosDateTime(new Date(Date.UTC(2026, 6, 30, 13, 45, 20)));
    assert.equal((date >> 9) + 1980, 2026);
    assert.equal((date >> 5) & 0x0f, 7);
    assert.equal(date & 0x1f, 30);
    assert.equal(time >> 11, 13);
    assert.equal((time >> 5) & 0x3f, 45);
    assert.equal((time & 0x1f) * 2, 20);
  });

  test("clamps a pre-1980 date instead of writing a negative year", () => {
    const { date } = dosDateTime(new Date(Date.UTC(1970, 0, 1)));
    assert.equal(date >> 9, 0);
    assert.ok(date > 0, "month and day must still be valid");
  });
});

describe("zipText", () => {
  test("round-trips names and contents through an independent reader", () => {
    const files = [
      { path: "Memory.md", text: "# Memory\n\nhello" },
      { path: "People/Ada Lovelace.md", text: "---\ntitle: \"Ada Lovelace\"\n---\n\nbody" },
    ];
    const entries = readZip(zipText(files));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.name), ["Memory.md", "People/Ada Lovelace.md"]);
    assert.deepEqual(entries.map((e) => e.text), files.map((f) => f.text));
  });

  test("stores rather than deflates, and flags names as UTF-8", () => {
    const [entry] = readZip(zipText([{ path: "a.md", text: "x" }]));
    assert.equal(entry.method, 0, "compression method must be stored");
    assert.equal(entry.flags & 0x0800, 0x0800, "UTF-8 name flag must be set");
  });

  test("non-ASCII paths survive — a Swedish vault is the normal case", () => {
    const files = [{ path: "Places/Göteborgs universitet.md", text: "Ett lärosäte i Göteborg." }];
    const [entry] = readZip(zipText(files));
    assert.equal(entry.name, "Places/Göteborgs universitet.md");
    assert.equal(entry.text, "Ett lärosäte i Göteborg.");
  });

  test("records a correct CRC for each entry", () => {
    const text = "checksum me";
    const [entry] = readZip(zipText([{ path: "a.md", text }]));
    assert.equal(entry.crc, crc32(new TextEncoder().encode(text)));
  });

  test("an empty archive is still a valid zip", () => {
    assert.deepEqual(readZip(zipText([])), []);
  });

  test("output is deterministic — two exports of one vault are byte-identical", () => {
    const files = [{ path: "a.md", text: "same" }];
    assert.deepEqual(zipText(files), zipText(files));
  });

  test("a leading slash is stripped so entries stay relative", () => {
    const [entry] = readZip(zipText([{ path: "/People/X.md", text: "y" }]));
    assert.equal(entry.name, "People/X.md");
  });

  test("the system unzip accepts the archive", (t) => {
    // The reader above shares this file's assumptions; a real unzip does not.
    let dir;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      t.skip("unzip not available");
      return;
    }
    dir = mkdtempSync(join(tmpdir(), "zipcore-"));
    try {
      const archive = join(dir, "vault.zip");
      writeFileSync(archive, zipText([
        { path: "Memory.md", text: "# Memory" },
        { path: "Places/Göteborg.md", text: "En stad." },
      ]));
      const listing = execFileSync("unzip", ["-l", archive], { encoding: "utf8" });
      assert.match(listing, /Memory\.md/);
      const extracted = execFileSync("unzip", ["-p", archive, "Memory.md"], { encoding: "utf8" });
      assert.equal(extracted, "# Memory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

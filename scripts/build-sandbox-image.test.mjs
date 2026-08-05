// Guard: the browser VM's package list stays minimal.
//
// If this test fails, someone mirrored container/Dockerfile's package list into
// scripts/build-sandbox-image.sh. Read the policy comment above PKGS_COMMON in
// that script FIRST — the two images are asymmetric on purpose (owner
// directive, 2026-08-05: the OCR/PDF/image toolchain is for the SERVER-SIDE
// execution sandbox only; the on-device JS-emulated Linux VM stays minimal).
// Everything in this image is streamed lazily over the network to the device on
// first touch, cold first use of a binary runs ~98× slower than warm
// (docs/SANDBOX-PERFORMANCE.md §1), and this VM is what the Se/cure tier — the
// tier with no server in its data path — runs its shell on.
//
// The capability is not lost by keeping OCR out: an attached picture is
// transcribed by the answer model before triage (src/image-read.js), in the
// pipeline rather than in a shell.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "build-sandbox-image.sh");
const source = readFileSync(SCRIPT, "utf8");

// The heavy toolchain that lives in container/Dockerfile and must not appear
// here. `pil`/`pillow` are matched on package-token boundaries so the alpine
// branch's legitimate `py3-pip` does not trip the guard.
const BANNED = [
  { name: "tesseract", re: /tesseract/i },
  { name: "poppler", re: /poppler/i },
  { name: "pdftotext", re: /pdftotext/i },
  { name: "pdftoppm", re: /pdftoppm/i },
  { name: "imagemagick", re: /imagemagick/i },
  { name: "zbar", re: /zbar/i },
  { name: "exiftool", re: /exiftool/i },
  { name: "pil / pillow", re: /(^|[-_])(pil|pillow)([-_]|$)/i },
];

/** The value of PKGS_COMMON, split into package tokens. */
function packageList() {
  const m = source.match(/^PKGS_COMMON="([^"]*)"/m);
  assert.ok(m, "PKGS_COMMON=\"…\" not found in scripts/build-sandbox-image.sh");
  return m[1].split(/\s+/).filter(Boolean);
}

/** Every non-comment, non-blank line — where a package can actually be added. */
function codeLines() {
  return source
    .split("\n")
    .filter((line) => line.trim() && !/^\s*#/.test(line));
}

test("PKGS_COMMON still parses and carries the base toolchain", () => {
  const pkgs = packageList();
  assert.ok(pkgs.length > 0, "PKGS_COMMON is empty");
  // The pieces sandbox.js's launch contract and exec marker protocol depend on.
  for (const required of ["bash", "coreutils"]) {
    assert.ok(pkgs.includes(required), `PKGS_COMMON no longer installs ${required}`);
  }
});

test("PKGS_COMMON carries none of the container's OCR/PDF/image toolchain", () => {
  const pkgs = packageList();
  const offenders = [];
  for (const pkg of pkgs) {
    for (const { name, re } of BANNED) {
      if (re.test(pkg)) offenders.push(`${pkg} (matches ${name})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "PKGS_COMMON must stay minimal — the OCR/PDF/image group is server-side only " +
      "(see the policy comment above PKGS_COMMON):\n" + offenders.join("\n"),
  );
});

test("no distro branch installs the OCR/PDF/image toolchain either", () => {
  // PKGS_COMMON is not the only place packages enter the image: each distro
  // branch appends its own extras (the alpine branch adds py3-pip). Comments
  // are excluded so the policy comment, which names these packages, does not
  // trip its own guard.
  const offenders = [];
  for (const line of codeLines()) {
    for (const { name, re } of BANNED) {
      if (re.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a distro branch is installing server-side-only packages into the browser VM:\n" +
      offenders.join("\n"),
  );
});

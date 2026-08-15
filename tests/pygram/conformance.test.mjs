// The conformance runner must not feed the corpus it is measuring.
//
// The capture harness installs a `python3` shim first on $PATH that logs every
// invocation (scripts/pygram-capture/python-shim). The conformance runner
// executes every corpus entry under a reference interpreter — so while it
// resolved that interpreter by NAME, each run logged 212 invocations, and the
// next harvest merged them back into corpus.jsonl as observed evidence. The
// first harvest ended up with 138 of its 197 "observed" programs byte-identical
// to hand-written seed programs, 139 of them at count=8: one per conformance
// run rather than a Zipfian spread. Since `--plan` ranks the build order by
// those counts, the loop made the corpus rank guessed-at programs above the
// ones an agent actually typed.
//
// Two independent defences, tested separately here because either alone would
// have been enough to hide the other's failure:
//   1. referencePython() resolves to a real CPython ELF, skipping the shim.
//   2. runOne() spawns with PYGRAM_CAPTURE=0, so even a caller that points
//      PYTHON_BIN straight at the shim logs nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { referencePython } from "./conformance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "conformance.mjs");

/** A stand-in for the capture shim: a SHELL SCRIPT (not an ELF) that logs the
 *  invocation and then execs the real interpreter, exactly as the real shim
 *  does. Returns the directory to put first on PATH.
 *
 * It must resolve its log path the way the real shim does — $PYGRAM_LOG if set,
 * otherwise $HOME/.pygram/invocations.jsonl. That fallback is not a detail: the
 * runner spawns entries with a deliberately MINIMAL env that drops PYGRAM_LOG
 * but keeps HOME, so a stand-in that only honoured PYGRAM_LOG would quietly
 * write nowhere and the loop test would pass with every defence removed. It did,
 * the first time this test was written.
 */
function fakeShimDir(realPython) {
  const dir = mkdtempSync(join(tmpdir(), "pygram-shim-"));
  for (const name of ["python3", "python"]) {
    const p = join(dir, name);
    writeFileSync(
      p,
      `#!/bin/sh\n` +
        `if [ "\${PYGRAM_CAPTURE:-1}" != "0" ]; then\n` +
        `  L="\${PYGRAM_LOG:-$HOME/.pygram/invocations.jsonl}"\n` +
        `  mkdir -p "$(dirname "$L")" 2>/dev/null\n` +
        `  printf 'logged\\n' >> "$L"\n` +
        `fi\n` +
        `exec ${realPython} "$@"\n`,
    );
    chmodSync(p, 0o755);
  }
  return dir;
}

function realPython() {
  const r = spawnSync("sh", ["-c", "command -v python3.11 || command -v /usr/bin/python3"], { encoding: "utf8" });
  return (r.stdout || "").trim();
}

/** findRealCPython deliberately follows the symlink chain, so comparing its
 *  answer to a path by STRING is only valid when that path is already fully
 *  resolved. It is not, on most machines: /usr/bin/python3 is a symlink to
 *  /usr/bin/python3.N. This container happens to have an unresolved
 *  python3.11 on PATH and the naive assertion passed here, then failed on CI
 *  with `+ '/usr/bin/python3.12' - '/usr/bin/python3'`. Compare resolved
 *  paths — the claim being tested is "the same interpreter", not "the same
 *  spelling of it". */
function resolved(p) {
  return spawnSync("readlink", ["-f", p], { encoding: "utf8" }).stdout.trim() || p;
}

test("referencePython: skips a shell-script shim on PATH and finds the real ELF", () => {
  const real = realPython();
  if (!real) return; // no CPython here — nothing to resolve against
  const dir = fakeShimDir(real);
  const got = referencePython({ PATH: `${dir}:${process.env.PATH}`, PYTHON_BIN: "" });
  assert.notEqual(got, join(dir, "python3"), "resolved the shim, not a real interpreter");
  assert.ok(got && got !== "python3", `expected an absolute real interpreter, got ${got}`);
});

test("referencePython: PYTHON_BIN wins only when it names a real ELF", () => {
  const real = realPython();
  if (!real) return;
  const dir = fakeShimDir(real);
  // Pointed at the shim, PYTHON_BIN must NOT be taken as the reference: the
  // whole point is that the shim is not an interpreter, it wraps one.
  const shimmed = referencePython({ PATH: process.env.PATH, PYTHON_BIN: join(dir, "python3") });
  assert.notEqual(shimmed, join(dir, "python3"));
  // Pointed at a genuine interpreter it is honoured — same interpreter, which
  // is not the same string once the symlink chain is followed.
  assert.equal(resolved(referencePython({ PATH: process.env.PATH, PYTHON_BIN: real })), resolved(real));
});

test("a conformance run writes NOTHING to the capture log", { timeout: 120_000 }, () => {
  const real = realPython();
  if (!real) return;
  const dir = fakeShimDir(real);
  // A private HOME, because that is the path the shim falls back to once the
  // runner strips PYGRAM_LOG from the child env — and the path the real
  // contamination was written to.
  const home = mkdtempSync(join(tmpdir(), "pygram-home-"));
  const log = join(home, ".pygram", "invocations.jsonl");

  const res = spawnSync(process.execPath, [RUNNER], {
    encoding: "utf8",
    timeout: 110_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: home, PYGRAM_LOG: "", PYGRAM_BIN: "" },
  });

  assert.equal(res.status, 0, `conformance failed:\n${res.stdout}\n${res.stderr}`);
  const wrote = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.equal(
    wrote,
    "",
    `the conformance run fed the capture log with ${wrote.split("\n").filter(Boolean).length} ` +
      `sighting(s) — the corpus feedback loop is open again`,
  );
});

test("the fake shim in these tests would ITSELF log, without the defences", () => {
  // Guards against the test above passing because the stand-in never logged —
  // a green test that proves nothing is the failure mode being avoided.
  const real = realPython();
  if (!real) return;
  const dir = fakeShimDir(real);
  const log = join(mkdtempSync(join(tmpdir(), "pygram-log-")), "invocations.jsonl");
  writeFileSync(log, "");
  const res = spawnSync(join(dir, "python3"), ["-c", "print(1)"], {
    encoding: "utf8",
    env: { ...process.env, PYGRAM_LOG: log },
  });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(log, "utf8"), "logged\n");
});

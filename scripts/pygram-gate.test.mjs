// Unit tests for the pygram build gate (scripts/pygram-gate.mjs) — the pure
// parts: the ELF classifier, the strace parser, and the budget evaluation.
//
// The strace parser gets the most attention here because it already failed
// once in exactly the way that matters: a pattern that missed strace's bare
// `123  openat(…)` pid prefix parsed a 110-line trace as ZERO file opens, and
// zero opens reads as a perfect score on the one metric the whole project is
// optimising. A measurement bug that inverts into a pass is worse than a
// missing measurement, so the prefix forms and the failure/success split are
// pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BUDGET,
  classifyElf,
  evaluate,
  parseStraceOpens,
  projectColdMs,
} from "./pygram-gate.mjs";

const STATIC_I386 =
  "/tmp/t32: ELF 32-bit LSB executable, Intel 80386, version 1 (GNU/Linux), statically linked, BuildID[sha1]=1404e7, for GNU/Linux 3.2.0, not stripped";
const DYNAMIC_X64 =
  "/usr/bin/python3.11: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=e83bec, for GNU/Linux 3.2.0, stripped";

test("classifyElf separates the static i386 target from a dynamic host binary", () => {
  const a = classifyElf(STATIC_I386);
  assert.equal(a.isElf, true);
  assert.equal(a.isStatic, true);
  assert.equal(a.is32Bit, true);
  assert.equal(a.arch, "Intel 80386");
  assert.equal(a.stripped, false);

  const b = classifyElf(DYNAMIC_X64);
  assert.equal(b.isStatic, false);
  assert.equal(b.is32Bit, false);
  assert.equal(b.stripped, true);
});

test("classifyElf does not mistake 'dynamically linked' for static", () => {
  // The two verdicts share most of their words; a sloppy substring test passes
  // a dynamic binary as static and the gate's whole point evaporates.
  assert.equal(classifyElf(DYNAMIC_X64).isStatic, false);
  assert.equal(classifyElf("some.txt: ASCII text").isElf, false);
});

test("parseStraceOpens reads the bare-pid prefix that -f -o actually emits", () => {
  // This is the regression. Real output from `strace -f -e trace=file -o …`.
  const log = [
    '3583  execve("/usr/local/bin/python3", ["python3", "-c", "pass"], 0x7ffc /* 138 vars */) = 0',
    '3583  access("/etc/ld.so.preload", R_OK) = -1 ENOENT (No such file or directory)',
    '3583  openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3',
    '3583  openat(AT_FDCWD, "/lib/x86_64-linux-gnu/libm.so.6", O_RDONLY|O_CLOEXEC) = 3',
  ].join("\n");
  const got = parseStraceOpens(log);
  assert.equal(got.openCount, 2, "a bare-pid trace must not parse as zero opens");
  assert.deepEqual(got.opened, ["/etc/ld.so.cache", "/lib/x86_64-linux-gnu/libm.so.6"]);
  assert.equal(got.statLike, 1);
});

test("parseStraceOpens also reads the [pid N] prefix and the unprefixed form", () => {
  const log = [
    '[pid 42] openat(AT_FDCWD, "/a", O_RDONLY) = 3',
    'openat(AT_FDCWD, "/b", O_RDONLY) = 3',
    'open("/c", O_RDONLY) = 3',
  ].join("\n");
  const got = parseStraceOpens(log);
  // plain open(2) has no dirfd argument — the parser must handle both shapes.
  assert.deepEqual(got.opened, ["/a", "/b", "/c"]);
});

test("parseStraceOpens counts failed opens separately from successful ones", () => {
  // A probe for a file that does not exist is not free in the VM either — it
  // still costs a directory lookup over the wire — so it is reported, but it
  // must not inflate the count of files whose blocks get fetched.
  const log = [
    'openat(AT_FDCWD, "/exists", O_RDONLY) = 3',
    'openat(AT_FDCWD, "/nope", O_RDONLY) = -1 ENOENT (No such file or directory)',
    'openat(AT_FDCWD, "/nope2", O_RDONLY) = -1 EACCES (Permission denied)',
  ].join("\n");
  const got = parseStraceOpens(log);
  assert.equal(got.openCount, 1);
  assert.deepEqual(got.opened, ["/exists"]);
  assert.equal(got.failedOpens, 2);
});

test("parseStraceOpens counts a repeated path once", () => {
  // The metric is distinct files, because a second read of the same file hits
  // the IndexedDB block cache rather than the network.
  const log = [
    'openat(AT_FDCWD, "/same", O_RDONLY) = 3',
    'openat(AT_FDCWD, "/same", O_RDONLY) = 4',
  ].join("\n");
  assert.equal(parseStraceOpens(log).openCount, 1);
});

test("parseStraceOpens ignores non-file syscalls and empty input", () => {
  const log = ['mmap(NULL, 8192, PROT_READ, MAP_PRIVATE, 3, 0) = 0x7f', 'brk(NULL) = 0x55'].join("\n");
  const got = parseStraceOpens(log);
  assert.equal(got.openCount, 0);
  assert.equal(got.statLike, 0);
  assert.equal(parseStraceOpens("").openCount, 0);
});

test("the size budget is set against the measured floor, not a round number", () => {
  // 400 KB was the original guess and it was unreachable: an empty `main` is
  // 635,744 B under glibc-static i386, and Berry — a full dynamic-language VM
  // with neither `re` nor `json` — is 365,660 B. The gate has to admit the
  // 541,688 B MicroPython prototype plus room for the frozen shims, and still
  // reject a CPython-scale binary. docs/PYGRAM-RESEARCH.md §2.2, §6.
  assert.equal(DEFAULT_BUDGET.maxBytes, 700_000);
  const passes = (bytes) => evaluate({ bin: "x", exists: true, probeOk: true, isStatic: true, bytes, opens: 1 }, DEFAULT_BUDGET).pass;
  assert.equal(passes(541_688), true, "the measured prototype must fit");
  assert.equal(passes(6_639_992), false, "a CPython-scale binary must not");
});

test("evaluate fails a binary that is too big, dynamic, or opens too much", () => {
  const bad = { bin: "x", exists: true, probeOk: true, isStatic: false, bytes: 9_000_000, opens: 22 };
  const { pass, checks } = evaluate(bad, DEFAULT_BUDGET);
  assert.equal(pass, false);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed.sort(), ["file opens", "size", "statically linked"]);
});

test("evaluate passes a binary that meets every budget", () => {
  const good = { bin: "x", exists: true, probeOk: true, isStatic: true, bytes: 180_000, opens: 1 };
  assert.equal(evaluate(good, DEFAULT_BUDGET).pass, true);
});

test("evaluate fails a binary that cannot run the probe at all", () => {
  // A gate that passes something which cannot execute `-c 'pass'` is measuring
  // a paperweight.
  const broken = { bin: "x", exists: true, probeOk: false, probeExit: 127, isStatic: true, bytes: 1000, opens: 0 };
  assert.equal(evaluate(broken, DEFAULT_BUDGET).pass, false);
  assert.equal(evaluate({ bin: "x", exists: false }, DEFAULT_BUDGET).pass, false);
});

test("evaluate reports an unmeasurable open count as skipped rather than passing it silently", () => {
  const rec = { bin: "x", exists: true, probeOk: true, isStatic: true, bytes: 1000, opens: null, opensNote: "strace not available" };
  const { pass, checks } = evaluate(rec, DEFAULT_BUDGET);
  assert.equal(pass, true, "an unmeasurable check must not become a false red");
  const opens = checks.find((c) => c.name === "file opens");
  assert.equal(opens.skipped, true);
  assert.match(opens.got, /unmeasured/);
});

test("projectColdMs scales on the worse of bytes and opens, and refuses to guess without data", () => {
  const anchor = { bytes: 6_639_992, opens: 22, ms: 8573 };
  // Opens dominate: 11/22 = 0.5 beats a tiny byte share.
  assert.equal(projectColdMs({ exists: true, bytes: 100_000, opens: 11 }, anchor), Math.round(8573 * 0.5));
  // Bytes dominate when the binary is large but opens nothing.
  assert.equal(projectColdMs({ exists: true, bytes: 3_319_996, opens: 0 }, anchor), Math.round(8573 * 0.5));
  // No measurement, no projection — better silent than confidently wrong.
  assert.equal(projectColdMs({ exists: true, bytes: 1, opens: null }, anchor), null);
  assert.equal(projectColdMs({ exists: false }, anchor), null);
});

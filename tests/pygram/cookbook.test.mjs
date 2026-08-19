// docs/PYGRAM-COOKBOOK.md, executed.
//
// The cookbook tells an agent how to rewrite a program pygram refuses into one
// it runs. A rewrite that is merely PLAUSIBLE is worse than no cookbook: it
// reads well, it gets copied, and it quietly produces a different answer. So
// every recipe on that page is run here, both halves of it, under both
// interpreters.
//
// Three assertions per recipe, and each one catches a different way a recipe
// can be wrong:
//
//   1. the BEFORE still exits 90 with the contract line the page claims.
//      Catches a recipe that documents a gap which has since been CLOSED —
//      the page would be telling people to work around something that works.
//      That failure is reported as "obsolete", because the fix is to delete
//      the recipe, not to reopen the gap.
//   2. the AFTER matches CPython under pygram, on stdout and exit code.
//      Catches a rewrite that swapped one unsupported thing for another.
//   3. the BEFORE and the AFTER print the same thing under CPython.
//      Catches the failure the other two cannot see: a rewrite that runs
//      perfectly and answers a different question. This is the one that
//      earned its place — it caught draft recipes that read fine.
//
// The corpus is the evidence for WHICH gaps matter; this file is the evidence
// that the advice about them is true.
//
// Without PYGRAM_BIN the suite runs in REFERENCE-ONLY mode: it still parses the
// page, still checks that both halves are valid Python under CPython, and still
// checks assertion 3. Only the two pygram assertions are skipped. That is
// deliberate — the page rots by drifting from CPython at least as often as by
// drifting from pygram, and CI has no i386 build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referencePython, UNSUPPORTED_EXIT } from "./conformance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "..", "docs", "PYGRAM-COOKBOOK.md");

// Resolved to an absolute path ONCE. Every run gets its own temp cwd, so a
// relative PYGRAM_BIN would resolve against the temp dir and vanish — the same
// trap the conformance runner documents.
const PYGRAM = process.env.PYGRAM_BIN ? resolve(process.env.PYGRAM_BIN) : null;
const HAVE_PYGRAM = PYGRAM !== null && existsSync(PYGRAM);
const CPYTHON = referencePython();

/**
 * Parse the recipes out of the page.
 *
 * A recipe is a marker comment followed by exactly two fenced python blocks,
 * the first commented `# before` and the second `# after`. The marker carries
 * the machine-readable half: which contract line the before is expected to
 * produce, and what the program needs to run (stdin, argv).
 *
 * Deliberately strict — a malformed marker is an error rather than a skip.
 * A test that silently checks fewer recipes than the page contains is the
 * failure mode this whole file exists to prevent.
 */
export function parseCookbook(md) {
  const recipes = [];
  const markerRe = /<!--\s*recipe\s+([^>]*?)\s*-->/g;
  let m;
  while ((m = markerRe.exec(md)) !== null) {
    const attrs = {};
    const attrRe = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) {
      attrs[a[1]] = a[2].startsWith('"') ? JSON.parse(a[2]) : a[2];
    }
    assert.ok(attrs.id, `recipe marker without an id: ${m[1]}`);
    assert.ok(attrs.kind, `recipe ${attrs.id} has no kind`);
    assert.ok(attrs.detail, `recipe ${attrs.id} has no detail`);

    // The two fenced blocks that follow, up to the next marker.
    const rest = md.slice(m.index + m[0].length, markerRe.lastIndex + 20000);
    const nextMarker = rest.indexOf("<!-- recipe ");
    const scope = nextMarker === -1 ? rest : rest.slice(0, nextMarker);
    const blocks = [...scope.matchAll(/```python\n([\s\S]*?)```/g)].map((b) => b[1]);
    assert.equal(
      blocks.length,
      2,
      `recipe ${attrs.id} needs exactly two python blocks, found ${blocks.length}`,
    );
    const strip = (b) => b.replace(/^#[^\n]*\n/, "").replace(/\n$/, "");
    assert.ok(blocks[0].startsWith("# before"), `recipe ${attrs.id}: first block is not "# before"`);
    assert.ok(blocks[1].startsWith("# after"), `recipe ${attrs.id}: second block is not "# after"`);
    recipes.push({
      id: attrs.id,
      kind: attrs.kind,
      detail: attrs.detail,
      stdin: attrs.stdin ?? "",
      argv: attrs.argv ? JSON.parse(attrs.argv) : [],
      // `equivalent=no` opts out of assertion 3, and a recipe may only do that
      // when the before form genuinely cannot be run to completion — the heap
      // recipe's whole point is an input the before cannot hold.
      equivalent: attrs.equivalent !== "no",
      // `synthetic=yes` marks a recipe whose before is illustrative rather than
      // runnable (it names a placeholder). It skips execution entirely and is
      // the one escape hatch; keep it rare and keep it justified in the page.
      synthetic: attrs.synthetic === "yes",
      before: strip(blocks[0]),
      after: strip(blocks[1]),
    });
  }
  return recipes;
}

function run(bin, program, { stdin = "", argv = [] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pygram-cookbook-"));
  try {
    const r = spawnSync(bin, ["-c", program, ...argv], {
      input: stdin,
      encoding: "utf8",
      timeout: 10_000,
      cwd,
      // PYGRAM_CAPTURE=0 for the same reason the conformance runner sets it:
      // the capture shim would log every one of these as a real invocation and
      // the next harvest would fold the cookbook into the corpus as evidence.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LC_ALL: "C.UTF-8",
        PWD: cwd,
        PYGRAM_CAPTURE: "0",
      },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status };
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const RECIPES = parseCookbook(readFileSync(DOC, "utf8"));

test("the page parses and is not empty", () => {
  assert.ok(RECIPES.length >= 20, `only ${RECIPES.length} recipes parsed — did the format change?`);
  const ids = RECIPES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate recipe id");
});

test("every 'after' runs under CPython", () => {
  for (const r of RECIPES) {
    if (r.synthetic) continue;
    const res = run(CPYTHON, r.after, r);
    assert.equal(res.code, 0, `${r.id}: the rewrite fails under CPython:\n${res.stderr}`);
  }
});

// Assertion 3. This is the one that catches a rewrite which runs fine and
// answers a different question, and it needs no pygram build.
test("the rewrite computes what the original computed", () => {
  for (const r of RECIPES) {
    if (r.synthetic || !r.equivalent) continue;
    const before = run(CPYTHON, r.before, r);
    const after = run(CPYTHON, r.after, r);
    assert.equal(before.code, 0, `${r.id}: the ORIGINAL fails under CPython, so it is not a fair before:\n${before.stderr}`);
    assert.equal(
      after.stdout,
      before.stdout,
      `${r.id}: the rewrite answers a different question than the original`,
    );
  }
});

// Assertions 1 and 2 need the real binary.
test("every 'before' is still refused, with the contract line the page states", { skip: !HAVE_PYGRAM && "set PYGRAM_BIN" }, () => {
  for (const r of RECIPES) {
    if (r.synthetic) continue;
    const res = run(PYGRAM, r.before, r);
    assert.equal(
      res.code,
      UNSUPPORTED_EXIT,
      `${r.id}: OBSOLETE RECIPE — the before form exits ${res.code}, not ${UNSUPPORTED_EXIT}. ` +
        `If this gap was closed, delete the recipe rather than reopening it.\n${res.stderr}`,
    );
    const line = /^pygram: unsupported: (\w+): (.+)$/m.exec(res.stderr);
    assert.ok(line, `${r.id}: exit 90 without a contract line:\n${res.stderr}`);
    assert.equal(line[1], r.kind, `${r.id}: contract kind drifted`);
    assert.ok(
      line[2].startsWith(r.detail),
      `${r.id}: contract detail drifted — page says "${r.detail}", binary says "${line[2]}"`,
    );
    assert.equal(res.stdout, "", `${r.id}: a refusal must leave stdout untouched`);
  }
});

test("every 'after' matches CPython under pygram", { skip: !HAVE_PYGRAM && "set PYGRAM_BIN" }, () => {
  for (const r of RECIPES) {
    if (r.synthetic) continue;
    const got = run(PYGRAM, r.after, r);
    const want = run(CPYTHON, r.after, r);
    assert.equal(got.stdout, want.stdout, `${r.id}: the rewrite diverges from CPython under pygram`);
    assert.equal(got.code, want.code, `${r.id}: the rewrite's exit code diverges under pygram`);
  }
});

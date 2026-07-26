// Guard: no tracked file may carry an unresolved conflict marker.
//
// This exists because one shipped to production. PR #278's merge commit
// (17c70c16) left `<<<<<<< HEAD` / `=======` / `>>>>>>> origin/main` in
// public/index.html, so the landing page rendered the markers as literal text
// AND carried two elements with id="chat" — the second empty state was dead
// markup that getElementById never returned. Every suite passed: nothing reads
// index.html as text.
//
// The repo lands changes by merge (CLAUDE.md → Git workflow) and the four
// introspection artifacts conflict on nearly every one, so resolving conflicts
// is routine here and a missed hunk is a routine mistake. This makes it a test
// failure instead of a deploy.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");

// Anchored at line start with the trailing space/newline git writes, so prose
// ABOUT conflict markers (this file, the merge-branches skill) does not trip it.
const MARKER = /^(<{7}|>{7})[ \t]|^={7}$/;

// Binary and vendored trees have no business being scanned as text.
const SKIP = /^(node_modules|tests\/node_modules)\//;
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|mp3|mp4|wasm|zip|gz|pdf)$/i;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((f) => !SKIP.test(f) && !BINARY.test(f));
}

test("no tracked file carries an unresolved merge-conflict marker", () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    let text;
    try {
      text = readFileSync(join(REPO, file), "utf8");
    } catch {
      continue; // a symlink or a file removed from the worktree
    }
    if (text.includes("\0")) continue; // binary that dodged the extension list
    text.split("\n").forEach((line, i) => {
      if (MARKER.test(line)) offenders.push(`${file}:${i + 1}: ${line.slice(0, 40)}`);
    });
  }
  assert.deepEqual(offenders, [], `unresolved conflict markers:\n${offenders.join("\n")}`);
});

test("the landing page declares exactly one #chat element", () => {
  // The duplicate-id half of the same incident. app.js does
  // getElementById('chat'), so a second one is invisible dead markup that
  // silently takes over if the order ever changes.
  for (const page of ["public/index.html", "public/cure/index.html"]) {
    const html = readFileSync(join(REPO, page), "utf8");
    const count = (html.match(/\bid="chat"/g) || []).length;
    assert.equal(count, 1, `${page} declares ${count} id="chat" elements, expected 1`);
  }
});

test("no public test file opts into // @ts-check", () => {
  // tsconfig.public.json sets `"types": []` on purpose — public/** is checked
  // as BROWSER code, so Node globals must not be visible. A test file there
  // imports node:test and node:assert, which under that config cannot resolve:
  // opting one in fails `npm run typecheck` with errors nothing can fix short
  // of pulling @types/node into every browser module.
  //
  // This broke main twice on 2026-07-26, both times from the same branch, and
  // both times it was invisible locally because the container had no
  // node_modules so typecheck could not run at all. The convention is already
  // unanimous the other way — the modules opt in, their tests do not.
  const offenders = execFileSync("git", ["ls-files", "-z", "public/**/*.test.js"], {
    cwd: REPO,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((f) => /^\s*\/\/\s*@ts-check\b/m.test(readFileSync(join(REPO, f), "utf8").split("\n")[0] ?? ""));

  assert.deepEqual(
    offenders,
    [],
    `these public test files carry // @ts-check, which tsconfig.public.json cannot satisfy:\n${offenders.join("\n")}`,
  );
});

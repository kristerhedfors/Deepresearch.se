// @ts-check
// The coverage ratchet's one FORCED copy, pinned.
//
// scripts/coverage.mjs re-runs the suite itself so it can measure it, which
// means it carries its own list of test globs beside the one in package.json's
// `test` script. package.json cannot import a module and the script cannot
// safely derive the list by splitting an npm command string, so the copy stays
// — and this file is what makes it safe, the same way src/oauth-store.test.js
// pins the OAuth DDL that src/db.js has to repeat.
//
// Why it is worth a test at all: CI runs `npm test` and then, as a separate
// step, `npm run coverage:check`, which fails when the measured numbers fall
// below docs/coverage-baseline.json. TEST_GLOBS decides which suite the second
// step measures. If the two lists drift, nothing goes red — the ratchet simply
// starts describing a suite that is not the one CI runs, in whichever direction
// the drift went.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_GLOBS } from "./coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The glob arguments of package.json's `test` script, in order. */
function packageTestGlobs() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const script = String(pkg.scripts?.test || "");
  assert.ok(script.startsWith("node --test "), `the test script is no longer a bare node --test run: ${script}`);
  return script
    .slice("node --test ".length)
    .split(/\s+/)
    .filter(Boolean);
}

test("the coverage ratchet measures exactly the suite npm test runs", () => {
  // Order included deliberately. It does not change what runs, but a diff that
  // reorders one list and not the other is the cheapest possible warning that
  // somebody edited one copy without looking at the other.
  assert.deepEqual(
    TEST_GLOBS,
    packageTestGlobs(),
    "scripts/coverage.mjs TEST_GLOBS and package.json's `test` script have drifted — " +
      "the coverage baseline is now measured against a different suite than CI runs",
  );
});

test("every glob argument is a glob, not a flag", () => {
  // The reason this list is pinned rather than derived: adding a flag to the
  // `test` script (`node --test --concurrency=4 …`) would make a naive split
  // hand `--concurrency=4` to the coverage run as a test path. If that day
  // comes, this fails first and the derivation stays un-attempted.
  for (const g of packageTestGlobs()) {
    assert.ok(!g.startsWith("-"), `\`${g}\` is a flag — packageTestGlobs() needs to learn about it`);
  }
});

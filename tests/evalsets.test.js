import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tests/dr-eval.mjs resolves a set by filename and then trusts it completely —
// loadSet parses the JSON and does no schema check at all, so a malformed set
// fails as a run of `undefined` gold answers hours later rather than at load.
// These are the cheap checks that turn that into an immediate failure.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "evalsets");
const SETS = readdirSync(DIR).filter((f) => f.endsWith(".json"));

test("there are eval sets to check", () => {
  assert.ok(SETS.length > 0, "tests/evalsets/ is empty");
});

for (const file of SETS) {
  const name = file.replace(/\.json$/, "");

  test(`${name}: parses, and its \`set\` matches its filename`, () => {
    const data = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    // loadSet reads `tests/evalsets/${name}.json` — a `set` that disagrees with
    // the filename makes --rescore join run rows against the wrong gold.
    assert.equal(data.set, name, `set field is "${data.set}" but the file is ${file}`);
    assert.ok(Array.isArray(data.items) && data.items.length, "no items");
  });

  test(`${name}: every item has an id, a question and gold, and ids are unique`, () => {
    const { items } = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    const seen = new Set();
    for (const it of items) {
      assert.ok(it.id, "an item has no id");
      assert.ok(!seen.has(it.id), `duplicate id ${it.id} — paired comparison joins on id`);
      seen.add(it.id);
      // BrowseComp ships its questions encrypted; everything else is plaintext.
      const plain = it.question && it.answer;
      const encrypted = it.enc?.question && it.enc?.answer && it.enc?.canary;
      assert.ok(plain || encrypted, `${it.id}: neither plaintext question+answer nor a complete enc block`);
      assert.ok(Array.isArray(it.tags), `${it.id}: tags must be an array`);
    }
  });

  test(`${name}: gold URLs are well formed`, () => {
    const { items } = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    for (const it of items) {
      for (const u of it.goldUrls || []) {
        assert.match(u, /^https?:\/\//, `${it.id}: goldUrl is not a URL: ${u}`);
      }
    }
  });
}

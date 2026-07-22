// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDigest } from "./exa.js";

test("formatDigest produces a numbered digest", () => {
  const out = formatDigest([
    { title: "A", url: "http://a", highlights: ["one", "two"] },
    { title: "B", url: "http://b", highlights: [] },
  ]);
  assert.match(out, /^\[1\] A/m);
  assert.match(out, /http:\/\/a/);
  assert.match(out, /one … two/);
  assert.match(out, /\[2\] B/);
});

test("untitled results still render", () => {
  const out = formatDigest([{ url: "http://x" }]);
  assert.match(out, /\[1\] \(untitled\)/);
});

test("empty results => empty string", () => {
  assert.equal(formatDigest([]), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assetUrlPath,
  buildManifest,
  classifyResult,
  manifestJson,
  summarize,
} from "./verify-lib.mjs";

test("assetUrlPath maps plain files by stripping the public/ prefix", () => {
  assert.equal(assetUrlPath("public/js/app.js"), "/js/app.js");
  assert.equal(assetUrlPath("public/css/app.css"), "/css/app.css");
  assert.equal(assetUrlPath("public/build/history.md"), "/build/history.md");
  assert.equal(assetUrlPath("public/favicon.ico"), "/favicon.ico");
});

test("assetUrlPath maps index.html files to their directory URL (auto-trailing-slash)", () => {
  assert.equal(assetUrlPath("public/index.html"), "/");
  assert.equal(assetUrlPath("public/help/index.html"), "/help/");
  assert.equal(assetUrlPath("public/games/tokemon/index.html"), "/games/tokemon/");
});

test("assetUrlPath rejects paths outside public/", () => {
  assert.throws(() => assetUrlPath("src/index.js"), /not a served asset/);
  assert.throws(() => assetUrlPath("publicity/x.js"), /not a served asset/);
});

test("classifyResult: 200 with matching bytes is ok", () => {
  assert.deepEqual(classifyResult({ urlPath: "/js/app.js", status: 200, matched: true, authed: false }), {
    verdict: "ok",
  });
});

test("classifyResult: 200 with differing bytes is a mismatch", () => {
  const r = classifyResult({ urlPath: "/js/app.js", status: 200, matched: false, authed: true });
  assert.equal(r.verdict, "mismatch");
});

test("classifyResult: the unauthenticated welcome alias on / is gated, not a mismatch", () => {
  // route() serves /welcome/ content on GET / for signed-out visitors —
  // a 200 whose body legitimately differs from public/index.html.
  const anon = classifyResult({ urlPath: "/", status: 200, matched: false, authed: false });
  assert.equal(anon.verdict, "gated");
  // With credentials, / must serve the real app shell — a differing body is a finding.
  const authed = classifyResult({ urlPath: "/", status: 200, matched: false, authed: true });
  assert.equal(authed.verdict, "mismatch");
});

test("classifyResult: auth responses read as gated", () => {
  assert.equal(classifyResult({ urlPath: "/js/app.js", status: 401, matched: false, authed: false }).verdict, "gated");
  assert.equal(classifyResult({ urlPath: "/api/x", status: 403, matched: false, authed: true }).verdict, "gated");
  // /admin/* for a signed-in non-admin is a 302 to /.
  assert.equal(classifyResult({ urlPath: "/admin/", status: 302, matched: false, authed: true }).verdict, "gated");
});

test("classifyResult: 404 is missing, anything else is an error", () => {
  assert.equal(classifyResult({ urlPath: "/x", status: 404, matched: false, authed: false }).verdict, "missing");
  const err = classifyResult({ urlPath: "/x", status: 500, matched: false, authed: false });
  assert.equal(err.verdict, "error");
  assert.match(err.note, /500/);
});

test("buildManifest sorts paths and is deterministic regardless of input order", () => {
  const files = [
    ["public/js/app.js", "bb".repeat(32)],
    ["public/index.html", "aa".repeat(32)],
  ];
  const a = buildManifest({ commit: "c0ffee", files });
  const b = buildManifest({ commit: "c0ffee", files: [...files].reverse() });
  assert.deepEqual(Object.keys(a.files), ["public/index.html", "public/js/app.js"]);
  assert.equal(manifestJson(a), manifestJson(b));
  assert.equal(a.algorithm, "sha256");
  assert.equal(a.schema, 1);
  assert.equal(a.commit, "c0ffee");
});

test("manifestJson is stable and newline-terminated (the signed bytes must reproduce)", () => {
  const m = buildManifest({ commit: "c0ffee", files: [["public/a.js", "ab".repeat(32)]] });
  const once = manifestJson(m);
  assert.equal(once, manifestJson(buildManifest({ commit: "c0ffee", files: [["public/a.js", "ab".repeat(32)]] })));
  assert.ok(once.endsWith("}\n"));
  assert.ok(!once.includes("\r"));
});

test("summarize: gated files don't fail the run; mismatch/missing/error do", () => {
  assert.equal(summarize([{ verdict: "ok" }, { verdict: "gated" }]).ok, true);
  assert.equal(summarize([{ verdict: "ok" }, { verdict: "mismatch" }]).ok, false);
  assert.equal(summarize([{ verdict: "missing" }]).ok, false);
  assert.equal(summarize([{ verdict: "error" }]).ok, false);
  const s = summarize([{ verdict: "ok" }, { verdict: "ok" }, { verdict: "gated" }]);
  assert.deepEqual(s.counts, { ok: 2, mismatch: 0, gated: 1, missing: 0, error: 0 });
});

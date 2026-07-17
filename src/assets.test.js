// Unit tests for assets.js — the public (no-auth) allowlist, the asset
// caching policy, and the cross-origin-isolation (COEP) request shaping.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { isPublicAsset, buildAssetRequest, serveAsset } from "./assets.js";

const u = (path) => new URL("https://deepresearch.se" + path);

describe("isPublicAsset", () => {
  test("only GET/HEAD are ever public", () => {
    assert.equal(isPublicAsset(u("/welcome/"), "POST"), false);
    assert.equal(isPublicAsset(u("/welcome/"), "GET"), true);
    assert.equal(isPublicAsset(u("/welcome/"), "HEAD"), true);
  });

  test("promotional + branding surfaces are public", () => {
    for (const p of ["/favicon.ico", "/manifest.webmanifest", "/icons/x.png", "/welcome/", "/help/x", "/build/", "/story/", "/architecture/"]) {
      assert.equal(isPublicAsset(u(p), "GET"), true, p);
    }
  });

  test("DRC /cure files (with extension) are public, but page routes are not", () => {
    assert.equal(isPublicAsset(u("/cure/drc.js"), "GET"), true);
    assert.equal(isPublicAsset(u("/cure/drc.css"), "GET"), true);
    // Extensionless /cure/<slug> replay routes must fall through to routing.
    assert.equal(isPublicAsset(u("/cure/my-slug"), "GET"), false);
    assert.equal(isPublicAsset(u("/cure/"), "GET"), false);
  });

  test("the whole /cure module graph is on the allowlist", () => {
    for (const p of [
      "/js/vault-core.js", "/js/sse.js", "/js/drc-core.js", "/js/drc-providers.js",
      "/js/drc-page-core.js", "/js/proxy-bundle.js",
      "/js/drc-rag.js", "/js/rag.js", "/js/chat-rag.js", "/js/settings.js",
      "/js/drc-research.js", "/js/drc-store.js", "/js/bash-core.js", "/js/bash-agent.js",
      "/js/sandbox.js", "/js/sandbox-files.js", "/js/agent-backdrop.js",
      "/js/agent-backdrop-core.js", "/js/boot-messages.js", "/js/introspect-core.js",
      "/js/introspect-ui.js", "/introspect/source-snapshot.json", "/js/markdown.js",
      "/js/canned-faq.js", "/js/umbrella-spinner.js", "/js/websearch-backends-core.js",
    ]) {
      assert.equal(isPublicAsset(u(p), "GET"), true, p);
    }
  });

  // The recurring breakage class this repo has now hit FOUR times (drc-rag
  // 2026-07-10, sandbox 2026-07-11, boot-messages 2026-07-13,
  // websearch-backends-core 2026-07-15): a commit adds an import to the /cure
  // module graph but not to the allowlist, the module 401s for unauthenticated
  // visitors, the whole ES-module graph fails to link, and the public tier
  // goes inert (no umbrella intro, dead composer) while the static HTML still
  // paints. The hand-maintained list above can't catch that by construction —
  // this test derives the graph from the REAL source files on disk (static
  // AND dynamic imports, starting from /cure/index.html's scripts) so any
  // future import added without its allowlist entry fails `npm test` by name.
  test("every module reachable from the /cure page is public (derived from the real import graph)", () => {
    const pub = fileURLToPath(new URL("../public", import.meta.url));
    const html = readFileSync(join(pub, "cure/index.html"), "utf8");
    const queue = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(queue.length >= 1, "found no <script src> entries in /cure/index.html");
    const seen = new Set();
    while (queue.length) {
      const p = queue.shift();
      if (seen.has(p) || p.startsWith("http")) continue;
      seen.add(p);
      assert.equal(
        isPublicAsset(u(p), "GET"),
        true,
        `${p} is imported by the /cure module graph but NOT on the public allowlist — ` +
          "an unauthenticated visitor gets a 401, the graph fails to link, and /cure goes inert. " +
          "Add it to isPublicAsset (src/assets.js).",
      );
      let src;
      try {
        src = readFileSync(join(pub, p), "utf8");
      } catch {
        assert.fail(`${p} is referenced from the /cure graph but missing on disk`);
      }
      const specs = [];
      // Static imports (single- or multi-line): `import … from "spec"` and
      // bare `import "spec"`. Anchored to line start so comment PROSE about
      // imports never matches.
      for (const m of src.matchAll(/^\s*import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/gm)) specs.push(m[1]);
      // Dynamic imports — the intro (umbrella.js) and ghostwalk load this way,
      // and a 401 there is the same silent breakage.
      for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
      for (const spec of specs) {
        if (spec.startsWith("http") || !spec.endsWith(".js")) continue;
        queue.push(spec.startsWith("/") ? spec : posix.normalize(posix.join(posix.dirname(p), spec)));
      }
    }
    // Sanity that the walker actually walked the graph, not just the entry.
    assert.ok(seen.size >= 25, `suspiciously small /cure module graph (${seen.size} modules) — walker broken?`);
  });

  test("the vendored xterm files are public (sandbox.js loads them same-origin, /cure included)", () => {
    // These load via <script>/<link> injection (loadScript/loadCSS), not ES
    // imports, so the graph walker above can't derive them — pin them here.
    for (const p of ["/vendor/xterm/xterm.js", "/vendor/xterm/xterm.css", "/vendor/xterm/addon-fit.js"]) {
      assert.equal(isPublicAsset(u(p), "GET"), true, p);
    }
  });

  test("vault.js (DRS store/load) is NOT public — only the pure core is", () => {
    // vault.js statically imports the DRS storage stack; a 401 inside the
    // public /cure graph would kill the whole tier, so it must stay gated.
    assert.equal(isPublicAsset(u("/js/vault.js"), "GET"), false);
    assert.equal(isPublicAsset(u("/js/vault-core.js"), "GET"), true);
  });

  test("the app itself and APIs stay gated", () => {
    assert.equal(isPublicAsset(u("/"), "GET"), false);
    assert.equal(isPublicAsset(u("/js/app.js"), "GET"), false);
    assert.equal(isPublicAsset(u("/api/chat"), "GET"), false);
    assert.equal(isPublicAsset(u("/js/stream.js"), "GET"), false);
  });
});

describe("buildAssetRequest", () => {
  test("returns the original request when no override and no coep", () => {
    const req = new Request("https://deepresearch.se/x.js");
    assert.equal(buildAssetRequest(req, null, false), req);
  });

  test("retargets to the override URL when given one", () => {
    const req = new Request("https://deepresearch.se/rver");
    const out = buildAssetRequest(req, "https://deepresearch.se/", false);
    assert.equal(new URL(out.url).pathname, "/");
  });

  test("strips conditional headers for the COEP shell so ASSETS returns a full 200", () => {
    const req = new Request("https://deepresearch.se/", {
      headers: { "if-none-match": '"abc"', "if-modified-since": "yesterday" },
    });
    const out = buildAssetRequest(req, null, true);
    assert.equal(out.headers.get("if-none-match"), null);
    assert.equal(out.headers.get("if-modified-since"), null);
  });
});

describe("serveAsset caching policy", () => {
  // Minimal ASSETS binding double: echoes the requested path so the caching
  // branch can be asserted from the returned response's headers.
  const env = { ASSETS: { fetch: async (req) => new Response("body", { status: 200 }) } };

  test("module-graph assets (.js/.css/.html/.json) revalidate (no-cache)", async () => {
    for (const p of ["/js/app.js", "/css/app.css", "/index.html", "/introspect/source-snapshot.json"]) {
      const res = await serveAsset(new Request("https://deepresearch.se" + p), env);
      assert.equal(res.headers.get("cache-control"), "no-cache", p);
    }
  });

  test("extensionless HTML routes revalidate (no-cache)", async () => {
    const res = await serveAsset(new Request("https://deepresearch.se/welcome/"), env);
    assert.equal(res.headers.get("cache-control"), "no-cache");
  });

  test("icons/media get a short real TTL", async () => {
    const res = await serveAsset(new Request("https://deepresearch.se/icons/x.png"), env);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  });

  test("the COEP shell is isolated and never cached", async () => {
    const res = await serveAsset(new Request("https://deepresearch.se/"), env, "https://deepresearch.se/", { coep: true });
    assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  // A cross-origin-isolated page can only spawn a dedicated worker whose
  // SCRIPT RESPONSE carries a compatible COEP header — without it the worker
  // dies with a detail-less error event before a single line runs (the
  // on-device engine's "crashed before it could start", found live
  // 2026-07-17 on /cure). These responses must also never be revived from a
  // stale stored copy via a 304, so they get the shell's no-store treatment.
  test("worker scripts are served isolated (COEP) and never cached", async () => {
    for (const p of [
      "/js/ondevice-worker.js",
      "/vendor/transformers/ort-wasm-simd-threaded.mjs",
      "/vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs",
    ]) {
      const res = await serveAsset(new Request("https://deepresearch.se" + p), env);
      assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp", p);
      assert.equal(res.headers.get("cache-control"), "no-store", p);
    }
  });

  test("worker-script requests strip conditional headers so ASSETS returns a full 200", async () => {
    let seen = null;
    const capture = { ASSETS: { fetch: async (req) => ((seen = req), new Response("body", { status: 200 })) } };
    await serveAsset(
      new Request("https://deepresearch.se/js/ondevice-worker.js", {
        headers: { "if-none-match": '"abc"', "if-modified-since": "yesterday" },
      }),
      capture,
    );
    assert.equal(seen.headers.get("if-none-match"), null);
    assert.equal(seen.headers.get("if-modified-since"), null);
  });

  test("plain vendored subresources (wasm, the runtime module) are NOT isolated", async () => {
    // Only worker SCRIPTS need COEP; the multi-MB wasm blobs must keep their
    // cacheable TTL, and transformers.web.min.js its no-cache revalidation.
    const wasm = await serveAsset(new Request("https://deepresearch.se/vendor/transformers/ort-wasm-simd-threaded.wasm"), env);
    assert.equal(wasm.headers.get("cross-origin-embedder-policy"), null);
    assert.equal(wasm.headers.get("cache-control"), "public, max-age=3600");
    const runtime = await serveAsset(new Request("https://deepresearch.se/vendor/transformers/transformers.web.min.js"), env);
    assert.equal(runtime.headers.get("cross-origin-embedder-policy"), null);
    assert.equal(runtime.headers.get("cache-control"), "no-cache");
  });
});

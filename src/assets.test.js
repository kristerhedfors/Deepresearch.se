// Unit tests for assets.js — the public (no-auth) allowlist, the asset
// caching policy, and the cross-origin-isolation (COEP) request shaping.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

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
      "/js/drc-rag.js", "/js/rag.js", "/js/chat-rag.js", "/js/settings.js",
      "/js/drc-research.js", "/js/drc-store.js", "/js/bash-core.js", "/js/bash-agent.js",
      "/js/sandbox.js", "/js/sandbox-files.js", "/js/agent-backdrop.js",
      "/js/agent-backdrop-core.js", "/js/boot-messages.js", "/js/introspect-core.js",
      "/js/introspect-ui.js", "/introspect/source-snapshot.json", "/js/markdown.js",
      "/js/canned-faq.js",
    ]) {
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
});

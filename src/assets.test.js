// Unit tests for assets.js — the public (no-auth) allowlist, the asset
// caching policy, and the cross-origin-isolation (COEP) request shaping.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPublicAsset, buildAssetRequest, serveAsset } from "./assets.js";

const u = (path) => new URL("https://deepresearch.se" + path);

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// Walk the STATIC-import graph from an entry module (a web path under public/),
// following only same-origin "/js/…" and relative "./…" specifiers — the exact
// links a browser must fetch to link the module. Dynamic import() is excluded
// (it fail-softs; a static import that 401s kills the whole graph). Returns the
// set of web paths reachable, entry included.
function staticImportGraph(entryWebPath) {
  const seen = new Set();
  const walk = (webPath) => {
    if (seen.has(webPath)) return;
    seen.add(webPath);
    let src;
    try {
      src = readFileSync(path.join(PUBLIC_DIR, webPath), "utf8");
    } catch {
      return;
    }
    const re = /^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      let wp;
      if (spec.startsWith("/")) wp = spec;
      else if (spec.startsWith(".")) wp = path.posix.normalize(path.posix.join(path.posix.dirname(webPath), spec));
      else continue;
      walk(wp);
    }
  };
  walk(entryWebPath);
  return seen;
}

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
      "/js/canned-faq.js", "/js/umbrella-spinner.js",
      // drc.js statically imports the web-search backend core so Se/cure can
      // search a self-hosted backend browser-direct — a 401 here 401'd the
      // import and took the whole /cure tier dark (no umbrella intro, dead
      // buttons) for every unauthenticated visitor (found live 2026-07-15).
      "/js/websearch-backends-core.js",
    ]) {
      assert.equal(isPublicAsset(u(p), "GET"), true, p);
    }
  });

  // Regression guard for a bug class that has recurred repeatedly (drc-rag,
  // the sandbox/bash modules, boot-messages, websearch-backends-core): a commit
  // adds a new STATIC import to the /cure module graph but forgets the matching
  // allowlist entry, so that one file 401s for unauthenticated visitors, the
  // browser can't link drc.js, and the ENTIRE public tier goes dark (no
  // umbrella intro, dead buttons). Rather than hand-maintain the list above,
  // walk drc.js's real static-import graph and assert every same-origin module
  // in it is public — so the next forgotten import fails this test, not prod.
  test("every static import reachable from /cure/drc.js is public", () => {
    const graph = staticImportGraph("/cure/drc.js");
    // sanity: the walk actually resolved a real graph, not an empty set
    assert.ok(graph.size > 20, `expected a substantial graph, got ${graph.size}`);
    for (const p of graph) {
      if (p === "/cure/drc.js") continue; // the entry is served by the router, not the asset gate
      assert.equal(isPublicAsset(u(p), "GET"), true, `${p} is imported by the /cure graph but not on the public allowlist`);
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

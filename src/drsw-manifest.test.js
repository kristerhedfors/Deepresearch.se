// The DRSW/1 node discovery document (src/drsw-manifest.js, spec §7.1).
//
// The point of these tests is not that the JSON has the right keys — it is
// that the JSON cannot start LYING. A discovery document exists so another
// node can trust what it says without running this one, so every value that
// describes behavior is checked against the code that implements the
// behavior, and the conformance claim is checked against whether that code is
// actually there. Feedback #39, 2026-07-26: the help page called this site the
// reference implementation of DRSW/1 while nothing served this file, and the
// spec's own §6 claimed a class it did not meet.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NODE_CONFORMANCE,
  NODE_KIND,
  NODE_KIND_V,
  NODE_PORTAL,
  NODE_SECTIONS,
  SPEC_LINKS,
  drswManifest,
  drswManifestResponse,
} from "./drsw-manifest.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const WORKSPACE_CORE = read("public/js/workspace-core.js");
const SERVER_TOKEN = read("src/server-token.js");
const SPEC = read("docs/WORKSPACE-PROTOCOL.md");
const ROUTER = read("src/index.js");
const CORPUS = JSON.parse(read("public/introspect/docs-corpus.json"));

describe("the DRSW/1 discovery document", () => {
  test("declares the payload kind and version the workspace code actually reads", () => {
    // Change WORKSPACE_KIND / WORKSPACE_V and this file must change with it,
    // or the node advertises a payload it will reject.
    assert.match(WORKSPACE_CORE, new RegExp(`WORKSPACE_KIND = "${NODE_KIND}"`));
    assert.match(WORKSPACE_CORE, new RegExp(`WORKSPACE_V = ${NODE_KIND_V}\\b`));
    const m = drswManifest("https://deepresearch.se");
    assert.deepEqual(m.kinds, [{ kind: NODE_KIND, v: [NODE_KIND_V] }]);
  });

  test("points at the portal path the workspace links are built with", () => {
    assert.match(WORKSPACE_CORE, new RegExp(`WORKSPACE_PATH = "${NODE_PORTAL}"`));
    assert.equal(drswManifest("https://deepresearch.se").portal, NODE_PORTAL);
  });

  test("advertises only sections the payload validator accepts", () => {
    // Every advertised section must be a member validateWorkspacePayload
    // knows; advertising one it ignores is exactly the drift §7.1 forbids.
    for (const s of NODE_SECTIONS) {
      assert.match(
        WORKSPACE_CORE,
        new RegExp(`\\bw\\.${s}\\b|\\bopts\\.${s}\\b|"${s}"`),
        `the manifest advertises the "${s}" section, but public/js/workspace-core.js never handles it`,
      );
    }
  });

  test("does NOT advertise the §5 interchange sections, which are unimplemented", () => {
    // The spec leads the code here on purpose. The discovery file must not.
    for (const s of ["origin", "pipelines", "provenance", "route"]) {
      assert.ok(
        !NODE_SECTIONS.includes(s),
        `"${s}" is a §5 interchange section — do not advertise it until ` +
          "validateWorkspacePayload reads it",
      );
    }
  });

  test("claims class N only when the interchange sections have landed", () => {
    // The one rule that makes `conformance` worth reading. Class N needs the
    // §5 sections (§6); if a future change adds them, this test stops
    // objecting — and until then it refuses the aspirational claim.
    const carriesInterchange = ["origin", "pipelines", "provenance", "route"].every((s) =>
      NODE_SECTIONS.includes(s),
    );
    if (!carriesInterchange) {
      assert.ok(
        !NODE_CONFORMANCE.includes("N"),
        "conformance claims class N, but the node does not apply the §5 interchange sections",
      );
    }
    // R and W are the payload core, which the workspace module does implement.
    assert.deepEqual(NODE_CONFORMANCE, ["R", "W"]);
    assert.match(WORKSPACE_CORE, /export function validateWorkspacePayload/);
    assert.match(WORKSPACE_CORE, /export function workspaceLink/);
  });

  test("names the grant services the token subsystem actually issues", () => {
    const types = /** @type {any} */ (drswManifest("https://deepresearch.se")).grantTypes[0].types;
    assert.match(SERVER_TOKEN, /SERVER_TOKEN_SERVICES = \["web", "api"\]/);
    for (const t of ["web", "api"]) assert.ok(types.includes(t), `missing grant type ${t}`);
  });

  test("the spec links resolve to documents the /docs viewer can open", () => {
    // The whole point of the `spec` block: a reader that finds the node can
    // read the standard. A link into a document the corpus does not carry
    // renders an empty page.
    const paths = new Set((CORPUS.files || []).map((/** @type {any} */ f) => f.p));
    for (const [name, href] of Object.entries(SPEC_LINKS)) {
      if (/^https?:\/\//.test(href)) {
        // An off-origin link is allowed only for material this site does not
        // serve; it still has to exist in the repository it points into.
        const repoPath = href.replace(
          /^https:\/\/raw\.githubusercontent\.com\/kristerhedfors\/Deepresearch\.se\/main\//,
          "",
        );
        assert.notEqual(repoPath, href, `the "${name}" link is off-site and not a repo raw URL`);
        assert.doesNotThrow(() => read(repoPath), `the "${name}" link points at a missing file`);
        continue;
      }
      const hash = decodeURIComponent(href.split("#")[1] || "");
      assert.ok(
        paths.has(hash),
        `the "${name}" spec link points at ${hash}, which is not in the docs corpus`,
      );
    }
  });

  test("the origin is reflected, so a preview deploy describes itself", () => {
    const m = /** @type {any} */ (drswManifest("https://preview.example/"));
    assert.equal(m.node.operator, "preview.example");
    assert.equal(m.grantTypes[0].issuer, "https://preview.example");
  });

  test("is served publicly, before any identity gate", () => {
    assert.match(ROUTER, /url\.pathname === "\/\.well-known\/drsw\.json"/);
    assert.match(ROUTER, /drswManifestResponse\(url\.origin\)/);
  });

  test("the response is JSON a machine can actually fetch cross-origin", async () => {
    const res = drswManifestResponse("https://deepresearch.se");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = JSON.parse(await res.text());
    assert.equal(body.drsw, 1);
    assert.equal(body.status, "experimental");
  });

  test("the spec documents the members this implementation ships", () => {
    // Mirror discipline: §7.1 is the normative description of this file.
    for (const key of ["conformance", "spec", "status"]) {
      assert.ok(
        SPEC.includes(`- \`${key}\``),
        `docs/WORKSPACE-PROTOCOL.md §7.1 does not describe the "${key}" member`,
      );
    }
    assert.ok(
      SPEC.includes("/.well-known/drsw.json"),
      "the spec must name the discovery path the code serves",
    );
  });
});

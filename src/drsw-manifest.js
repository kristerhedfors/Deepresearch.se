// @ts-check
// `/.well-known/drsw.json` — the DRSW/1 node discovery document (spec §7.1).
//
// WHY THIS EXISTS (feedback #39, 2026-07-26). The help page called this site
// "the reference implementation" of DRSW/1 and DRPL/1 while nothing served the
// one file the standard defines for saying so, and §6 claimed a conformance
// class that requires it. A reference implementation that cannot be discovered
// by the mechanism it specifies is a claim, not a fact. This module makes the
// claim checkable — by a machine, without reading the prose — and states the
// conformance class the code ACTUALLY meets rather than the one the spec would
// like it to meet.
//
// It is deliberately a pure function over the request origin: the standard is
// explicit that a node's discovery file must be servable by a bare static host,
// so nothing here reads storage, identity or configuration. The route is public
// (`isPublicAsset`) because discovery that needs an account is not discovery.
//
// Drift is pinned in src/drsw-manifest.test.js, which reads the real values out
// of public/js/workspace-core.js and src/server-token.js: change what the
// workspace payload is, and this file has to change with it.

/** DRSW/1 payload discriminator + version the reference node reads and writes. */
export const NODE_KIND = "drc-workspace";
export const NODE_KIND_V = 1;

/** Where a `#w=` fragment opens (spec §7.1 `portal`). */
export const NODE_PORTAL = "/cure/workspace";

/**
 * The payload sections this node actually applies (spec §4). The §5
 * interchange sections (`origin`, `pipelines`, `provenance`, `route`) are
 * specified but not yet read by `validateWorkspacePayload`, so they are absent
 * here — a node that ignores a section conforms by SAYING it ignores it.
 */
export const NODE_SECTIONS = ["name", "note", "keys", "settings", "conversations", "grants"];

/**
 * Conformance classes met (spec §6): R (open and apply) and W (mint). Not N —
 * that needs the §5 interchange sections and this discovery file; serving the
 * file is one of the two, and the sections have not landed.
 */
export const NODE_CONFORMANCE = ["R", "W"];

/**
 * Where the complete standards live, in the rendered documentation viewer.
 * Machine-readable answer to "link to the complete specifications, and how
 * they relate to this project" — a reader that finds the node finds the texts
 * it is conforming to.
 */
export const SPEC_LINKS = {
  drsw: "/docs/#docs%2FWORKSPACE-PROTOCOL.md",
  drpl: "/docs/#docs%2FPIPELINE-LANGUAGE.md",
  rationale: "/docs/#docs%2FSTACKLESS-RESEARCH.md",
  // The machine-readable payload schema is NOT served from this origin — the
  // docs corpus carries Markdown only — so it points at the public repository
  // the site is deployed from. A link into the viewer would open an empty
  // reader, which is worse than an off-site link that resolves.
  schema:
    "https://raw.githubusercontent.com/kristerhedfors/Deepresearch.se/main/docs/schemas/drsw-payload-1.schema.json",
};

/**
 * The discovery document for this node.
 * @param {string} origin the request's origin, e.g. "https://deepresearch.se"
 * @returns {Record<string, unknown>}
 */
export function drswManifest(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  return {
    drsw: 1,
    node: {
      name: "DeepResearch.Se/cure",
      operator: base.replace(/^https?:\/\//, ""),
      software: "github.com/kristerhedfors/Deepresearch.se",
    },
    portal: NODE_PORTAL,
    kinds: [{ kind: NODE_KIND, v: [NODE_KIND_V] }],
    sections: NODE_SECTIONS,
    // The two upstream services a Se/cure workspace can carry a borrowed,
    // metered allowance for (src/server-token.js SERVER_TOKEN_SERVICES).
    grantTypes: [{ issuer: base, types: ["web", "api", "server-token"] }],
    conformance: NODE_CONFORMANCE,
    spec: SPEC_LINKS,
    // Experimental, and the file should say so where a machine can read it:
    // this is a research artifact, not a ratified standard with a registry.
    status: "experimental",
  };
}

/**
 * `GET /.well-known/drsw.json`. Cached briefly — the document is static in
 * practice but must follow a deploy that changes it without a purge.
 * @param {string} origin
 * @returns {Response}
 */
export function drswManifestResponse(origin) {
  return new Response(JSON.stringify(drswManifest(origin), null, 2) + "\n", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      // Discovery is meant to be read by other nodes' client code.
      "access-control-allow-origin": "*",
    },
  });
}

// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// The discovery documents and the redirect allowlist (src/oauth-metadata.js).
//
// These assertions look pedantic and are not: every one of them corresponds to
// a documented way a real connector fails. A missing metadata field makes a
// client silently pick a registration path we did not intend; a redirect that
// matches too loosely hands an authorization code to the wrong party; one that
// matches too strictly fails with an error the user cannot act on.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCOPE,
  OAUTH_SCOPES,
  REDIRECT_ALLOWLIST,
  authorizationServerMetadata,
  isLoopbackRedirect,
  issuerFor,
  protectedResourceMetadata,
  redirectAllowed,
  resourceMetadataUrl,
  wwwAuthenticateValue,
} from "./oauth-metadata.js";

// ---- the redirect allowlist -------------------------------------------------

test("both hosted clients' callbacks are allowed", () => {
  // Claude covers claude.ai web, Desktop, mobile and Cowork with one callback.
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback"), true);
  // ChatGPT's connector platform, plus the backend-api form integrators report.
  assert.equal(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(
    redirectAllowed("https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback"),
    true,
  );
});

test("the allowlist is data, so adding a client is an entry rather than an edit", () => {
  assert.ok(Array.isArray(REDIRECT_ALLOWLIST));
  assert.ok(REDIRECT_ALLOWLIST.length >= 3, "Claude plus both ChatGPT forms");
  for (const uri of REDIRECT_ALLOWLIST) {
    assert.ok(uri.startsWith("https://"), `${uri} must be https`);
    assert.equal(redirectAllowed(uri), true, `${uri} must pass its own allowlist`);
  }
});

test("loopback matches with the port ignored, as RFC 8252 requires", () => {
  // Claude Code binds an ephemeral port per session, so the port cannot be
  // part of the comparison — but the host and path still are.
  assert.equal(redirectAllowed("http://localhost:3118/callback"), true);
  assert.equal(redirectAllowed("http://127.0.0.1:51234/callback"), true);
  assert.equal(redirectAllowed("http://localhost/callback"), true);
  assert.equal(redirectAllowed("http://127.0.0.1/callback"), true);
});

test("loopback matching does not become a hole", () => {
  // The failure mode this guards: a matcher loose enough to accept any host
  // that merely CONTAINS a loopback name, or any path on a loopback host,
  // hands an authorization code to whatever bound that port.
  assert.equal(redirectAllowed("http://localhost:3118/steal"), false);
  assert.equal(redirectAllowed("http://localhost.evil.com/callback"), false);
  assert.equal(redirectAllowed("http://evil.com/callback"), false);
  assert.equal(redirectAllowed("https://localhost/callback"), false, "http only, per RFC 8252");
  assert.equal(redirectAllowed("http://127.0.0.2/callback"), false);
  assert.equal(redirectAllowed("http://[::1]/callback"), false);
  // A query or fragment smuggled onto an otherwise-valid loopback redirect.
  assert.equal(redirectAllowed("http://localhost:3118/callback?next=https://evil.com"), false);
  assert.equal(redirectAllowed("http://localhost:3118/callback#x"), false);
});

test("a near-miss on a hosted callback is refused, not fuzzily accepted", () => {
  // `resource`/redirect comparisons are exact by specification. These are the
  // shapes a typo or a hostile lookalike actually takes.
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback/"), false);
  assert.equal(redirectAllowed("https://claude.ai.evil.com/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("https://evil.com/?x=https://claude.ai/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("http://claude.ai/api/mcp/auth_callback"), false, "https only");
});

test("garbage in is false, never a throw", () => {
  for (const bad of [null, undefined, "", "not a url", 42, {}, []]) {
    assert.equal(redirectAllowed(/** @type {any} */ (bad)), false);
  }
  assert.equal(isLoopbackRedirect("::::"), false);
});

// ---- protected-resource metadata (RFC 9728) ---------------------------------

test("protected-resource metadata names the resource and exactly one issuer", () => {
  const doc = protectedResourceMetadata("https://mcp.deepresearch.se", "https://deepresearch.se");
  // `resource` must equal the URL the user typed into the client's dialog,
  // character for character — which is why the advertised endpoint is one
  // canonical form (the bare origin).
  assert.equal(doc.resource, "https://mcp.deepresearch.se");
  // Both clients take the FIRST authorization server and never fall back, so
  // listing more than one would be a silent trap.
  assert.deepEqual(doc.authorization_servers, ["https://deepresearch.se"]);
  assert.equal(doc.authorization_servers.length, 1);
  assert.deepEqual(doc.scopes_supported, [...OAUTH_SCOPES]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
});

test("the resource metadata URL is where the 401 points", () => {
  assert.equal(
    resourceMetadataUrl("https://mcp.deepresearch.se"),
    "https://mcp.deepresearch.se/.well-known/oauth-protected-resource",
  );
});

test("a well-known URI is origin-relative even when the resource carries a path", () => {
  // The regression this pins was found by probing a local Worker, not here: a
  // preview or local origin has no `mcp.` host, so its resource is
  // `<origin>/mcp` — and appending to that produced
  // `…/mcp/.well-known/oauth-protected-resource`, which 404s. A client that
  // follows the pointer finds nothing and the connection dies at step one.
  assert.equal(
    resourceMetadataUrl("http://127.0.0.1:8788/mcp"),
    "http://127.0.0.1:8788/.well-known/oauth-protected-resource",
  );
  assert.equal(
    resourceMetadataUrl("https://abc.workers.dev/mcp"),
    "https://abc.workers.dev/.well-known/oauth-protected-resource",
  );
  // Same for the documentation link the document advertises.
  const doc = protectedResourceMetadata("http://127.0.0.1:8788/mcp", "http://127.0.0.1:8788");
  assert.equal(doc.resource_documentation, "http://127.0.0.1:8788/connect/");
  // `resource` itself is NOT normalized: it must stay exactly the URL the
  // user typed, path and all.
  assert.equal(doc.resource, "http://127.0.0.1:8788/mcp");
});

test("an unparseable resource degrades rather than throwing", () => {
  assert.equal(
    resourceMetadataUrl("not a url"),
    "not a url/.well-known/oauth-protected-resource",
  );
});

// ---- authorization-server metadata (RFC 8414) -------------------------------

test("the two fields that select CIMD are both present", () => {
  // Miss either one and the client silently falls back to Dynamic Client
  // Registration, which registers a fresh client on every connection.
  const doc = authorizationServerMetadata("https://deepresearch.se");
  assert.equal(doc.client_id_metadata_document_supported, true);
  assert.ok(
    doc.token_endpoint_auth_methods_supported.includes("none"),
    "CIMD authenticates as a public client at the token endpoint",
  );
});

test("S256 is advertised, because the spec requires a client to be able to check", () => {
  const doc = authorizationServerMetadata("https://deepresearch.se");
  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.ok(!doc.code_challenge_methods_supported.includes("plain"));
});

test("the advertised grants are the two that exist, and no registration endpoint", () => {
  const doc = authorizationServerMetadata("https://deepresearch.se");
  assert.deepEqual(doc.grant_types_supported, ["authorization_code", "refresh_token"]);
  // client_credentials is unsupported by both vendors: every connection needs
  // user consent. Advertising it would invite a grant we refuse.
  assert.ok(!doc.grant_types_supported.includes("client_credentials"));
  assert.deepEqual(doc.response_types_supported, ["code"]);
  // No registration_endpoint: CIMD is the intended path, and advertising DCR
  // is what makes a client choose it.
  assert.equal("registration_endpoint" in doc, false);
});

test("endpoints hang off the issuer that is passed in", () => {
  const doc = authorizationServerMetadata("https://example.test");
  assert.equal(doc.issuer, "https://example.test");
  assert.equal(doc.authorization_endpoint, "https://example.test/oauth/authorize");
  assert.equal(doc.token_endpoint, "https://example.test/oauth/token");
});

test("offline_access is offered, because that is how a client asks for a refresh token", () => {
  const doc = authorizationServerMetadata("https://deepresearch.se");
  assert.ok(doc.scopes_supported.includes("offline_access"));
  assert.ok(DEFAULT_SCOPE.includes("offline_access"));
});

// ---- the WWW-Authenticate challenge -----------------------------------------

test("the challenge carries the resource_metadata pointer", () => {
  const v = wwwAuthenticateValue("https://mcp.deepresearch.se/.well-known/oauth-protected-resource");
  assert.match(v, /^Bearer /);
  assert.match(v, /resource_metadata="https:\/\/mcp\.deepresearch\.se\/\.well-known\/oauth-protected-resource"/);
  // Without this pointer a client probes well-known paths and, failing that,
  // reports "couldn't reach the MCP server" — a network error for what is
  // actually a discovery problem.
});

test("a scope hint rides along when we have one", () => {
  const v = wwwAuthenticateValue("https://x.test/.well-known/oauth-protected-resource", "research");
  assert.match(v, /scope="research"/);
  const bare = wwwAuthenticateValue("https://x.test/.well-known/oauth-protected-resource");
  assert.ok(!bare.includes("scope="), "no scope means: use what the metadata advertises");
});

// ---- issuer derivation ------------------------------------------------------

test("production splits the hosts: resource on mcp., authorization server on the apex", () => {
  assert.equal(issuerFor(new URL("https://mcp.deepresearch.se/")), "https://deepresearch.se");
  assert.equal(issuerFor(new URL("https://mcp.deepresearch.se/mcp")), "https://deepresearch.se");
});

test("a preview or local run issues from its own origin", () => {
  // No host split exists there, so the whole flow stays on one origin — which
  // is what makes it testable without a second deployment.
  assert.equal(issuerFor(new URL("http://localhost:8787/mcp")), "http://localhost:8787");
  assert.equal(
    issuerFor(new URL("https://abc-deepresearch-se.someone.workers.dev/mcp")),
    "https://abc-deepresearch-se.someone.workers.dev",
  );
  // A bare two-label `mcp.` host has no parent to promote to, so it keeps its
  // own origin rather than issuing from a public suffix.
  assert.equal(issuerFor(new URL("https://mcp.test/")), "https://mcp.test");
});

test("the apex issues for itself", () => {
  assert.equal(issuerFor(new URL("https://deepresearch.se/rver")), "https://deepresearch.se");
});

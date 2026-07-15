import test from "node:test";
import assert from "node:assert/strict";
import {
  grantFlagEnabled,
  grantLive,
  normalizeSearchBackend,
  parseProjectPath,
  parsePublicationRef,
  wmHtml,
} from "./drc-page-core.js";

test("grantLive: token + unexpired + quota-remaining all required", () => {
  const now = 1_000;
  // live: token, future expiry, remaining>0
  assert.equal(grantLive({ token: "t", expiresAt: 2_000, remaining: 3 }, now), true);
  // live: remaining absent = unmetered/not-yet-spent
  assert.equal(grantLive({ token: "t", expiresAt: 2_000 }, now), true);
  assert.equal(grantLive({ token: "t", expiresAt: 2_000, remaining: null }, now), true);
  // dead: no token
  assert.equal(grantLive({ expiresAt: 2_000, remaining: 3 }, now), false);
  assert.equal(grantLive({ token: "", expiresAt: 2_000 }, now), false);
  // dead: expired
  assert.equal(grantLive({ token: "t", expiresAt: 500, remaining: 3 }, now), false);
  // dead: quota used up
  assert.equal(grantLive({ token: "t", expiresAt: 2_000, remaining: 0 }, now), false);
  // dead: nothing at all
  assert.equal(grantLive(null, now), false);
  assert.equal(grantLive(undefined, now), false);
  // string forms coerce (localStorage-round-tripped numbers)
  assert.equal(grantLive({ token: "t", expiresAt: "2000", remaining: "1" }, now), true);
});

test("grantFlagEnabled: default ON, off only on an explicit 0", () => {
  assert.equal(grantFlagEnabled(null), true); // unset → ON
  assert.equal(grantFlagEnabled("1"), true);
  assert.equal(grantFlagEnabled("0"), false);
  assert.equal(grantFlagEnabled("anything-else"), false); // only "1" is ON
});

test("normalizeSearchBackend: known backend, trimmed URL/key, clamped results", () => {
  assert.deepEqual(normalizeSearchBackend(null), { backend: "grant", baseUrl: "", key: "", results: 6 });
  assert.deepEqual(normalizeSearchBackend(undefined), { backend: "grant", baseUrl: "", key: "", results: 6 });
  // unknown backend → the default grant path
  assert.equal(normalizeSearchBackend({ backend: "nope" }).backend, "grant");
  assert.equal(normalizeSearchBackend({ backend: "searxng" }).backend, "searxng");
  assert.equal(normalizeSearchBackend({ backend: "exa_compatible" }).backend, "exa_compatible");
  // URL: trimmed + trailing slashes stripped
  assert.equal(normalizeSearchBackend({ baseUrl: "  https://s.example/  " }).baseUrl, "https://s.example");
  assert.equal(normalizeSearchBackend({ baseUrl: "https://s.example///" }).baseUrl, "https://s.example");
  // key trimmed
  assert.equal(normalizeSearchBackend({ key: "  abc  " }).key, "abc");
  // results clamped 1..20, rounded; non-positive/garbage → 6
  assert.equal(normalizeSearchBackend({ results: 0 }).results, 6);
  assert.equal(normalizeSearchBackend({ results: -3 }).results, 6);
  assert.equal(normalizeSearchBackend({ results: "x" }).results, 6);
  assert.equal(normalizeSearchBackend({ results: 100 }).results, 20);
  assert.equal(normalizeSearchBackend({ results: "8" }).results, 8);
  assert.equal(normalizeSearchBackend({ results: 3.7 }).results, 4);
});

test("parseProjectPath: /my/ and /free/ project refs", () => {
  assert.equal(parseProjectPath("/my/project-abc123"), "project-abc123");
  assert.equal(parseProjectPath("/free/project-xyz"), "project-xyz");
  assert.equal(parseProjectPath("/MY/project-abc"), "project-abc"); // case-insensitive prefix
  assert.equal(parseProjectPath("/my/project-abc/extra"), "project-abc"); // stops at the ref
  assert.equal(parseProjectPath("/cure/something"), null);
  assert.equal(parseProjectPath("/my/notaproject"), null);
  assert.equal(parseProjectPath(""), null);
  assert.equal(parseProjectPath(null), null);
});

test("parsePublicationRef: /cure/<slug> path vs ?continue= legacy", () => {
  assert.deepEqual(parsePublicationRef("/cure/my-slug", ""), { slug: "my-slug", fromPath: true });
  // "workspace" is a RESERVED word — the secure-workspaces page, never a replay.
  assert.equal(parsePublicationRef("/cure/workspace", ""), null);
  assert.equal(parsePublicationRef("/cure/WORKSPACE", ""), null);
  assert.equal(parsePublicationRef("/cure/", "?continue=workspace"), null);
  assert.deepEqual(parsePublicationRef("/cure/AB-12", ""), { slug: "AB-12", fromPath: true });
  // legacy ?continue= handoff, not from the path
  assert.deepEqual(parsePublicationRef("/cure/", "?continue=legacy-slug"), {
    slug: "legacy-slug",
    fromPath: false,
  });
  // path takes precedence when both present
  assert.deepEqual(parsePublicationRef("/cure/pathwins", "?continue=other"), {
    slug: "pathwins",
    fromPath: true,
  });
  // rejects an over-long or empty slug
  assert.equal(parsePublicationRef("/cure/" + "a".repeat(81), ""), null);
  assert.equal(parsePublicationRef("/cure/", ""), null);
  assert.equal(parsePublicationRef("/other", "?continue=bad slug!"), null);
  assert.equal(parsePublicationRef(null, null), null);
});

test("wmHtml escapes markup first, then tightens the wordmark slash", () => {
  assert.equal(wmHtml("Se/cure ready"), 'Se<span class="sl">/</span>cure ready');
  assert.equal(wmHtml("a Se/rver feature"), 'a Se<span class="sl">/</span>rver feature');
  // Escaping happens BEFORE the wordmark wrap, so injected markup stays inert.
  assert.equal(wmHtml("<b>x</b> & y"), "&lt;b&gt;x&lt;/b&gt; &amp; y");
  // Case-insensitive wordmark match, and unrelated slashes untouched.
  assert.equal(wmHtml("SE/CURE"), 'SE<span class="sl">/</span>CURE');
  assert.equal(wmHtml("a/b"), "a/b");
});

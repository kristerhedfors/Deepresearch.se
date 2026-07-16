import test from "node:test";
import assert from "node:assert/strict";
import {
  depthPosForTier,
  depthTierForPos,
  disclosureText,
  phaseChannel,
  grantFlagEnabled,
  grantLive,
  normalizeSearchBackend,
  parseProjectPath,
  parsePublicationRef,
  providerVisibilityNote,
  serverTokenLive,
  serverTokenService,
  unlockCelebrationSize,
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

test("depthTierForPos: four even bands, garbage reads as standard", () => {
  // Band edges: [0,25) brief, [25,50) standard, [50,75) extended, [75,100] full.
  assert.equal(depthTierForPos(0).id, "brief");
  assert.equal(depthTierForPos(24).id, "brief");
  assert.equal(depthTierForPos(25).id, "standard");
  assert.equal(depthTierForPos(37).id, "standard"); // the markup's default value
  assert.equal(depthTierForPos(49).id, "standard");
  assert.equal(depthTierForPos(50).id, "extended");
  assert.equal(depthTierForPos(74).id, "extended");
  assert.equal(depthTierForPos(75).id, "full");
  assert.equal(depthTierForPos(100).id, "full");
  // Every tier carries a label and a what-it-steers description.
  for (const p of [0, 30, 60, 90]) {
    assert.ok(depthTierForPos(p).label.length > 0);
    assert.ok(depthTierForPos(p).desc.length > 0);
  }
  // Garbage/NaN/negative reads as standard — the pipeline's own fallback.
  assert.equal(depthTierForPos(NaN).id, "standard");
  assert.equal(depthTierForPos(-5).id, "standard");
  assert.equal(depthTierForPos("x").id, "standard");
});

test("depthPosForTier: each band's center, round-tripping through depthTierForPos", () => {
  for (const id of ["brief", "standard", "extended", "full"]) {
    assert.equal(depthTierForPos(depthPosForTier(id)).id, id);
  }
  // Unknown ids restore to the standard band — same fallback as everywhere.
  assert.equal(depthTierForPos(depthPosForTier("bogus")).id, "standard");
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
  // "help" is RESERVED too — the Se/cure documentation page at /cure/help.
  assert.equal(parsePublicationRef("/cure/help", ""), null);
  assert.equal(parsePublicationRef("/cure/HELP", ""), null);
  assert.equal(parsePublicationRef("/cure/", "?continue=help"), null);
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

// ---- the per-task ONLINE/OFFLINE symbol grammar (SYMBOL-LANGUAGE.md §6) ----

test("phaseChannel: on-device phases are local, network phases online, unknown defaults ONLINE", () => {
  for (const p of ["sandbox", "clarify", "introspect", "_note"])
    assert.equal(phaseChannel(p), "local", p);
  for (const p of ["triage", "search", "harvest", "gap", "synth", "validate", "answer", "source", "recall"])
    assert.equal(phaseChannel(p), "online", p);
  // Over-disclosing is the safe failure: a NEW phase wears the balloon until
  // someone proves it never crosses the network.
  assert.equal(phaseChannel("future-phase"), "online");
  assert.equal(phaseChannel(undefined), "online");
});

test("disclosureText: local phases carry no notice", () => {
  assert.equal(disclosureText("sandbox"), "");
  assert.equal(disclosureText("clarify", { provider: "OpenAI" }), "");
});

test("disclosureText: provider phases name the provider and the own-key path", () => {
  for (const p of ["triage", "harvest", "synth", "validate", "answer", "source", "gap"]) {
    const t = disclosureText(p, { provider: "OpenAI", viaProxy: false });
    assert.match(t, /OpenAI/, p);
    assert.match(t, /your own API key/, p);
    assert.match(t, /server was not involved/i, p);
  }
});

test("disclosureText: the borrowed proxy is disclosed as the one server-touching path", () => {
  const t = disclosureText("synth", { provider: "Berget (borrowed)", viaProxy: true });
  assert.match(t, /THROUGH the DeepResearch\.Se server/);
  assert.match(t, /Berget/);
  assert.match(t, /metered/i);
});

test("disclosureText: search discloses query-only, per route", () => {
  const grant = disclosureText("search", { search: "grant" });
  assert.match(grant, /Only the search QUERY/);
  assert.match(grant, /Exa/);
  assert.match(grant, /grant/);
  assert.match(grant, /conversation itself never left/i);
  const self = disclosureText("search", { search: "self" });
  assert.match(self, /Only the search QUERY/);
  assert.match(self, /configured yourself/);
  assert.match(self, /No DeepResearch\.Se server/);
});

test("disclosureText: recall names the embeddings provider and the local index", () => {
  const t = disclosureText("recall", { provider: "OpenAI", embedProvider: "Groq" });
  assert.match(t, /Groq/);
  assert.match(t, /embedding/i);
  assert.match(t, /index never leaves/i);
});

test("disclosureText: unknown online phases still disclose", () => {
  const t = disclosureText("future-phase", { provider: "OpenAI" });
  assert.match(t, /left your browser/);
});

test("disclosureText: a local model keeps the conversation on the user's machine", () => {
  for (const p of ["triage", "synth", "answer"]) {
    const t = disclosureText(p, { provider: "Local", local: true });
    assert.match(t, /YOUR OWN machine/i, p);
    assert.match(t, /never left your device/i, p);
    // the own-API-key wording would be a lie here
    assert.doesNotMatch(t, /your own API key/, p);
  }
});

test("providerVisibilityNote: the standing model-picker disclosure per provider kind", () => {
  // No pick yet → nothing to say (the line stays hidden).
  assert.equal(providerVisibilityNote(""), "");
  assert.equal(providerVisibilityNote(null), "");
  // A remote provider: they can read; this site's server can't.
  const openai = providerVisibilityNote("openai", "OpenAI");
  assert.match(openai, /OpenAI/);
  assert.match(openai, /they can read them/i);
  assert.match(openai, /server can't/i);
  // An unknown id still discloses, using the id itself.
  assert.match(providerVisibilityNote("groq"), /groq/);
  // The local provider: the strongest true statement.
  const local = providerVisibilityNote("local", "Local (Ollama / LM Studio / llama.cpp)");
  assert.match(local, /nothing leaves this device/i);
  assert.doesNotMatch(local, /can read them/i);
  // The on-device tier: same strongest statement, in-browser wording.
  const ondevice = providerVisibilityNote("ondevice", "On-device");
  assert.match(ondevice, /nothing leaves this device/i);
  assert.match(ondevice, /inside this browser/i);
  assert.doesNotMatch(ondevice, /can read them/i);
  // The borrowed proxy: the one server-touching path, named as such.
  const proxy = providerVisibilityNote("proxy");
  assert.match(proxy, /through this site's server/i);
  assert.match(proxy, /Berget/);
});

test("unlockCelebrationSize: ~72% of the short viewport side, clamped, garbage-safe", () => {
  // A phone: the short side (width) scales.
  assert.equal(unlockCelebrationSize(390, 844), Math.round(390 * 0.72));
  // A desktop: the short side (height) scales, capped at 760.
  assert.equal(unlockCelebrationSize(1920, 1080), 760);
  // A tiny viewport still draws a readable umbrella.
  assert.equal(unlockCelebrationSize(200, 300), 220);
  // Garbage in → the safe default, never NaN.
  assert.equal(unlockCelebrationSize(NaN, undefined), 320);
  assert.equal(unlockCelebrationSize(-5, 0), 320);
});

test("serverTokenService: finds one permission's view; null for absent/garbage", () => {
  const g = { token: "jwt", expiresAt: 2_000, services: [{ svc: "web", quota: 25, remaining: 5 }, { svc: "api", quota: 40, remaining: 0 }] };
  assert.equal(serverTokenService(g, "web").remaining, 5);
  assert.equal(serverTokenService(g, "api").quota, 40);
  assert.equal(serverTokenService(g, "projects"), null); // no such permission — ever
  assert.equal(serverTokenService(null, "web"), null);
  assert.equal(serverTokenService({ services: "web" }, "web"), null);
});

test("serverTokenLive: per-permission liveness — one permission dry never kills the other", () => {
  const now = 1_000;
  const g = { token: "jwt", expiresAt: 2_000, services: [{ svc: "web", quota: 25, remaining: 0 }, { svc: "api", quota: 40, remaining: 7 }] };
  assert.equal(serverTokenLive(g, "web", now), false); // exhausted
  assert.equal(serverTokenLive(g, "api", now), true); // still live
  // Absent remaining counts as available (not yet spent), like grantLive.
  assert.equal(serverTokenLive({ token: "j", expiresAt: 2_000, services: [{ svc: "web", quota: 5 }] }, "web", now), true);
  // Expiry, missing token, missing service, garbage — all dead.
  assert.equal(serverTokenLive({ ...g, expiresAt: 500 }, "api", now), false);
  assert.equal(serverTokenLive({ ...g, token: "" }, "api", now), false);
  assert.equal(serverTokenLive(g, "nope", now), false);
  assert.equal(serverTokenLive(null, "web", now), false);
});

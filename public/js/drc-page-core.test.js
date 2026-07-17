import test from "node:test";
import assert from "node:assert/strict";
import {
  grantFlagEnabled,
  grantLive,
  grantMeterLine,
  normalizeSearchBackend,
  parseProjectPath,
  parsePublicationRef,
  privacyNoticeLines,
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

// ---- the privacy notice (owner directive, 2026-07-16) ----------------------

test("privacyNoticeLines: always leads with browser-local storage (after any workspace line)", () => {
  const lines = privacyNoticeLines();
  assert.ok(lines.length >= 3);
  assert.match(lines[0], /rest sealed in THIS browser/i);
  assert.match(lines[0], /server stores none/i);
});

test("privacyNoticeLines: own-key provider calls name the provider and the direct path", () => {
  const lines = privacyNoticeLines({ provider: "OpenAI" });
  const model = lines.find((l) => l.startsWith("Model calls:"));
  assert.match(model, /OpenAI/);
  assert.match(model, /your own API key/);
  assert.match(model, /server is not involved/i);
});

test("privacyNoticeLines: the borrowed LLM allowance is disclosed as the one server-touching path", () => {
  const lines = privacyNoticeLines({ provider: "Berget (borrowed)", viaProxy: true, grantsConnected: true });
  const model = lines.find((l) => l.startsWith("Model calls:"));
  assert.match(model, /THROUGH the DeepResearch\.Se server/);
  assert.match(model, /Berget/);
  assert.match(model, /metered/i);
  // Borrowed allowances get their own governance line, with the off switch.
  const grants = lines.find((l) => /Borrowed allowances/.test(l));
  assert.match(grants, /pause or revoke/i);
  assert.match(grants, /Settings/);
});

test("privacyNoticeLines: a local/on-device model keeps the conversation on the user's machine", () => {
  const lines = privacyNoticeLines({ provider: "Local", local: true });
  const model = lines.find((l) => l.startsWith("Model calls:"));
  assert.match(model, /YOUR OWN machine/i);
  assert.match(model, /never leaves your device/i);
  // the own-API-key wording would be a lie here
  assert.doesNotMatch(model, /your own API key/);
});

test("privacyNoticeLines: the web-search line follows the route", () => {
  const grant = privacyNoticeLines({ search: "grant" }).find((l) => l.startsWith("Web search:"));
  assert.match(grant, /only the search QUERY/i);
  assert.match(grant, /Exa/);
  assert.match(grant, /conversation itself never leaves/i);
  const self = privacyNoticeLines({ search: "self" }).find((l) => l.startsWith("Web search:"));
  assert.match(self, /only the search QUERY/i);
  assert.match(self, /configured yourself/);
  assert.match(self, /No DeepResearch\.Se server/);
  const off = privacyNoticeLines({ search: "off" }).find((l) => l.startsWith("Web search:"));
  assert.match(off, /off/);
  assert.match(off, /no search query leaves/i);
  // unknown/absent route reads as off — never claims a send that may not happen
  const absent = privacyNoticeLines({}).find((l) => l.startsWith("Web search:"));
  assert.match(absent, /off/);
});

test("privacyNoticeLines: recall appears only with an embeddings provider, and names it", () => {
  const withRecall = privacyNoticeLines({ embedProvider: "OpenAI" });
  const recall = withRecall.find((l) => l.startsWith("Project recall:"));
  assert.match(recall, /OpenAI/);
  assert.match(recall, /index never leaves/i);
  assert.equal(
    privacyNoticeLines({}).find((l) => l.startsWith("Project recall:")),
    undefined,
  );
});

test("privacyNoticeLines: a shared workspace leads the notice, named or not", () => {
  const named = privacyNoticeLines({ workspaceName: "research kit" });
  assert.match(named[0], /shared secure workspace link/);
  assert.match(named[0], /research kit/);
  assert.match(named[0], /never reach any server/i);
  const unnamed = privacyNoticeLines({ workspaceName: true });
  assert.match(unnamed[0], /shared secure workspace link/);
  assert.doesNotMatch(unnamed[0], /“/);
  // no workspace → no workspace line
  assert.doesNotMatch(privacyNoticeLines({})[0], /workspace/i);
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

test("grantMeterLine: the one status-line wording both borrowed-capability rows share", () => {
  assert.equal(grantMeterLine("🔎 Web search", { quota: 25, remaining: 3 }, true), "🔎 Web search: 3 of 25 left");
  // Absent remaining = not yet spent → the full quota shows.
  assert.equal(grantMeterLine("🤖 LLM API (Berget)", { quota: 40 }, true), "🤖 LLM API (Berget): 40 of 40 left");
  assert.equal(grantMeterLine("🔎 Web search", { quota: 25, remaining: 0 }, false), "🔎 Web search: used up / expired");
});

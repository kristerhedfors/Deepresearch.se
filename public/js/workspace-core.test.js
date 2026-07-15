// Secure workspaces' pure core (public/js/workspace-core.js): the hacka.re-
// cloned link mechanism — the [salt(10)][nonce(10)][cipher] base64url blob,
// the 8192-round iterative-SHA-512 KDF, the dual-key property (link key opens
// the blob; the master key is independent and never transmitted), the
// namespace-from-blob derivation, fragment parsing, and the payload
// build/apply/validate round-trip. WebCrypto is a Node global, so this runs
// unmodified.
import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_KIND,
  WORKSPACE_V,
  applyWorkspacePayload,
  buildWorkspacePayload,
  bytesToHex,
  deriveLinkKey,
  deriveMasterKeyHex,
  generateWorkspacePassword,
  isWorkspacePath,
  openWorkspace,
  parseWorkspaceHash,
  sealWorkspace,
  validateWorkspacePayload,
  workspaceLink,
  workspaceNamespace,
} from "./workspace-core.js";
import { b64urlDecode, b64urlEncode } from "./proxy-bundle.js";

const PAYLOAD = {
  v: WORKSPACE_V,
  kind: WORKSPACE_KIND,
  name: "Team research space",
  keys: { openai: "sk-test-123" },
  providerId: "openai",
  model: "gpt-5.6-luna",
  settings: { research: true, bashLite: false },
  conversations: [{ title: "Hello", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hej" }] }],
  grants: { ws: "wsk1.payload.sig", proxy: [{ svc: "web", token: "prg1.a.b" }] },
};

test("sealWorkspace → openWorkspace round-trips a full payload", async () => {
  const blob = await sealWorkspace(PAYLOAD, "correct horse");
  assert.equal(typeof blob, "string");
  assert.match(blob, /^[A-Za-z0-9_-]+$/, "the blob is URL-safe base64 with no padding");
  const opened = await openWorkspace(blob, "correct horse");
  assert.ok(opened);
  assert.deepEqual(opened.payload, PAYLOAD);
  assert.match(opened.masterKeyHex, /^[0-9a-f]{64}$/);
});

test("the blob carries the hacka.re wire format: salt(10) + nonce(10) + ciphertext", async () => {
  const blob = await sealWorkspace({ v: 1, kind: WORKSPACE_KIND }, "pw");
  const bytes = b64urlDecode(blob);
  // plaintext is at least {"v":1,"kind":"drc-workspace"} (28 chars) + 16-byte GCM tag
  assert.ok(bytes.length >= 10 + 10 + 16 + 20);
  // Two seals of the same payload differ in their first 20 bytes (fresh salt+nonce).
  const other = b64urlDecode(await sealWorkspace({ v: 1, kind: WORKSPACE_KIND }, "pw"));
  assert.notDeepEqual([...bytes.slice(0, 20)], [...other.slice(0, 20)]);
});

test("openWorkspace fails soft to null: wrong password, tampered blob, garbage, truncation", async () => {
  const blob = await sealWorkspace(PAYLOAD, "right");
  assert.equal(await openWorkspace(blob, "wrong"), null);
  // Flip one ciphertext byte — GCM authentication must reject it.
  const bytes = b64urlDecode(blob);
  bytes[bytes.length - 1] ^= 0x01;
  assert.equal(await openWorkspace(b64urlEncode(bytes), "right"), null);
  assert.equal(await openWorkspace("not base64 at all!!!", "right"), null);
  assert.equal(await openWorkspace("AAAA", "right"), null); // smaller than headers + tag
  assert.equal(await openWorkspace("", "right"), null);
});

test("the KDF is deterministic and salt-sensitive (8192-round iterative SHA-512)", async () => {
  const salt = new Uint8Array(10).fill(7);
  const a = await deriveLinkKey("pw", salt);
  const b = await deriveLinkKey("pw", salt);
  assert.equal(bytesToHex(a), bytesToHex(b));
  assert.equal(a.length, 32);
  const otherSalt = new Uint8Array(10).fill(8);
  assert.notEqual(bytesToHex(await deriveLinkKey("pw", otherSalt)), bytesToHex(a));
  assert.notEqual(bytesToHex(await deriveLinkKey("pw2", salt)), bytesToHex(a));
});

test("dual-key: the master key is nonce-dependent and independent of the link key", async () => {
  const salt = new Uint8Array(10).fill(1);
  const nonce = new Uint8Array(10).fill(2);
  const master = await deriveMasterKeyHex("pw", salt, nonce);
  assert.match(master, /^[0-9a-f]{64}$/);
  // Deterministic — same link + password re-derives the same master key.
  assert.equal(await deriveMasterKeyHex("pw", salt, nonce), master);
  // Not equal to the link key for the same password + salt.
  assert.notEqual(master, bytesToHex(await deriveLinkKey("pw", salt)));
  // A different nonce (same password + salt) yields a different master key.
  assert.notEqual(await deriveMasterKeyHex("pw", salt, new Uint8Array(10).fill(3)), master);
});

test("workspaceNamespace: deterministic 8-hex-char id from the blob, blob-sensitive", async () => {
  const blob = await sealWorkspace(PAYLOAD, "pw");
  const ns = await workspaceNamespace(blob);
  assert.match(ns, /^[0-9a-f]{8}$/);
  assert.equal(await workspaceNamespace(blob), ns);
  assert.notEqual(await workspaceNamespace(blob + "x"), ns);
});

test("generateWorkspacePassword: alphanumeric, default 12 chars, unique", () => {
  const a = generateWorkspacePassword();
  const b = generateWorkspacePassword();
  assert.match(a, /^[A-Za-z0-9]{12}$/);
  assert.notEqual(a, b);
  assert.match(generateWorkspacePassword(20), /^[A-Za-z0-9]{20}$/);
});

test("workspaceLink + parseWorkspaceHash round-trip; the blob rides the anchor", () => {
  const link = workspaceLink("https://deepresearch.se", "AbC-_123");
  assert.equal(link, "https://deepresearch.se/cure/workspace#w=AbC-_123");
  assert.equal(parseWorkspaceHash(link), "AbC-_123");
  assert.equal(parseWorkspaceHash("#w=AbC-_123"), "AbC-_123");
  assert.equal(parseWorkspaceHash("w=AbC-_123"), "AbC-_123");
  assert.equal(parseWorkspaceHash("#other=1&w=Zz9"), "Zz9");
  assert.equal(parseWorkspaceHash("#ws=notthis"), null);
  assert.equal(parseWorkspaceHash(""), null);
  assert.equal(parseWorkspaceHash(null), null);
  // A trailing-slash origin doesn't double the slash.
  assert.equal(workspaceLink("https://deepresearch.se/", "x"), "https://deepresearch.se/cure/workspace#w=x");
});

test("isWorkspacePath recognizes only the workspace page", () => {
  assert.equal(isWorkspacePath("/cure/workspace"), true);
  assert.equal(isWorkspacePath("/cure/workspace/"), true);
  assert.equal(isWorkspacePath("/cure/workspaces"), false);
  assert.equal(isWorkspacePath("/cure/some-slug"), false);
  assert.equal(isWorkspacePath("/cure"), false);
  assert.equal(isWorkspacePath(null), false);
});

test("validateWorkspacePayload accepts the full and the minimal shape, rejects malformed ones", () => {
  assert.equal(validateWorkspacePayload(PAYLOAD), true);
  assert.equal(validateWorkspacePayload({ v: WORKSPACE_V, kind: WORKSPACE_KIND }), true);
  assert.equal(validateWorkspacePayload(null), false);
  assert.equal(validateWorkspacePayload({ v: 2, kind: WORKSPACE_KIND }), false);
  assert.equal(validateWorkspacePayload({ v: WORKSPACE_V, kind: "other" }), false);
  assert.equal(validateWorkspacePayload({ ...PAYLOAD, keys: [] }), false);
  assert.equal(validateWorkspacePayload({ ...PAYLOAD, conversations: [{ messages: [{ role: 1 }] }] }), false);
  assert.equal(validateWorkspacePayload({ ...PAYLOAD, grants: { proxy: [{ svc: "nope", token: "t" }] } }), false);
  assert.equal(validateWorkspacePayload({ ...PAYLOAD, grants: { ws: 42 } }), false);
});

test("buildWorkspacePayload projects only the selected sections", () => {
  const state = {
    keys: { openai: " sk-x ", groq: "", berget: "sk_ber_1" },
    providerId: "openai",
    model: "gpt-5.6-sol",
    research: false,
    bashLite: true,
    developerMode: false,
    searchBackend: { backend: "searxng", baseUrl: "https://sx.example", key: "", results: 6 },
    conversations: [
      { id: "c1", title: "T", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a", extra: 1 }] },
      { id: "c2", messages: [] },
    ],
  };
  const everything = buildWorkspacePayload(state, {
    keys: true,
    settings: true,
    conversations: true,
    grants: { ws: "wsk1.t.s", proxy: [{ svc: "api", token: "prg1.x.y" }, { svc: "bad", token: "" }] },
    name: "N",
    note: "Welcome!",
  });
  assert.equal(validateWorkspacePayload(everything), true);
  assert.deepEqual(everything.keys, { openai: "sk-x", berget: "sk_ber_1" }); // trimmed, empties dropped
  assert.equal(everything.providerId, "openai");
  assert.deepEqual(everything.settings.searchBackend.backend, "searxng");
  assert.equal(everything.conversations.length, 2);
  // messages are reduced to bare {role, content}
  assert.deepEqual(everything.conversations[0].messages[1], { role: "assistant", content: "a" });
  assert.deepEqual(everything.grants, { ws: "wsk1.t.s", proxy: [{ svc: "api", token: "prg1.x.y" }] });

  const minimal = buildWorkspacePayload(state, {});
  assert.deepEqual(minimal, { v: WORKSPACE_V, kind: WORKSPACE_KIND });
  const noKeys = buildWorkspacePayload({ keys: {} }, { keys: true });
  assert.equal(noKeys.keys, undefined);
});

test("applyWorkspacePayload merges into a DRC state and hands back the grants", () => {
  const state = {
    keys: { groq: "gsk_old" },
    providerId: null,
    model: null,
    research: true,
    conversations: [{ id: "mine", messages: [{ role: "user", content: "existing" }] }],
  };
  const { grants, note, name } = applyWorkspacePayload(state, PAYLOAD);
  assert.equal(state.keys.openai, "sk-test-123");
  assert.equal(state.keys.groq, "gsk_old"); // untouched — only carried fields overwrite
  assert.equal(state.providerId, "openai");
  assert.equal(state.model, "gpt-5.6-luna");
  assert.equal(state.bashLite, false);
  assert.equal(state.conversations.length, 2); // appended, never clobbered
  assert.equal(state.conversations[0].id, "mine");
  assert.notEqual(state.conversations[1].id, undefined); // fresh id assigned
  assert.deepEqual(state.conversations[1].messages, PAYLOAD.conversations[0].messages);
  assert.deepEqual(grants, { ws: "wsk1.payload.sig", proxy: [{ svc: "web", token: "prg1.a.b" }] });
  assert.equal(note, null);
  assert.equal(name, "Team research space");
});

test("build → seal → open → apply: the whole share flow end to end", async () => {
  const source = {
    keys: { berget: "sk_ber_team" },
    providerId: "berget",
    model: "mistral-small",
    research: true,
    bashLite: false,
    developerMode: false,
    searchBackend: { backend: "grant", baseUrl: "", key: "", results: 6 },
    conversations: [{ id: "x", title: "Prior work", messages: [{ role: "user", content: "context" }] }],
  };
  const payload = buildWorkspacePayload(source, { keys: true, settings: true, conversations: true, name: "Handoff" });
  const password = generateWorkspacePassword();
  const blob = await sealWorkspace(payload, password);
  const link = workspaceLink("https://deepresearch.se", blob);
  const parsed = parseWorkspaceHash(link);
  assert.equal(parsed, blob);
  const opened = await openWorkspace(parsed, password);
  assert.ok(opened);
  assert.equal(validateWorkspacePayload(opened.payload), true);
  const target = { keys: {}, conversations: [] };
  const applied = applyWorkspacePayload(target, opened.payload);
  assert.equal(target.keys.berget, "sk_ber_team");
  assert.equal(target.conversations.length, 1);
  assert.equal(applied.name, "Handoff");
});

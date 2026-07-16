import test from "node:test";
import assert from "node:assert/strict";
import { handlePubGet, handlePubWrite, pubSlugOk, validatePublication } from "./pub.js";

function mockBucket() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v ? { body: v.body, customMetadata: v.meta } : null;
    },
    async put(key, body, opts) {
      store.set(key, { body, meta: opts?.customMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, customMetadata: v.meta }));
      return { objects, truncated: false };
    },
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };

const goodBody = () => ({
  title: "Secure your cloud storage",
  description: "A deep-research replay.",
  model: "mistralai/Mistral-Small",
  createdAt: 1720000000000,
  messages: [
    { role: "user", content: "How do I secure cloud storage?" },
    { role: "assistant", content: "**Start with encryption at rest.**" },
  ],
});

test("pubSlugOk: lowercase words with hyphens, dot-free", () => {
  assert.equal(pubSlugOk("your-cloud-storage"), true);
  assert.equal(pubSlugOk("a"), true);
  assert.equal(pubSlugOk("Your-Cloud"), false);
  assert.equal(pubSlugOk("has.dot"), false);
  assert.equal(pubSlugOk("-leading"), false);
  assert.equal(pubSlugOk("a".repeat(81)), false);
  assert.equal(pubSlugOk(""), false);
  // "workspace" is RESERVED for the secure-workspaces page at /cure/workspace.
  assert.equal(pubSlugOk("workspace"), false);
  assert.equal(pubSlugOk("workspace-security"), true); // only the exact word is reserved
  // "help" is RESERVED for the Se/cure documentation page at /cure/help.
  assert.equal(pubSlugOk("help"), false);
  assert.equal(pubSlugOk("help-me-research"), true); // only the exact word is reserved
});

test("validatePublication normalizes the frozen-session shape", () => {
  const ok = validatePublication(goodBody());
  assert.ok("pub" in ok);
  assert.equal(ok.pub.title, "Secure your cloud storage");
  assert.equal(ok.pub.messages.length, 2);

  assert.match(validatePublication(null).error, /JSON body/);
  assert.match(validatePublication({ messages: [] }).error, /title/);
  assert.match(validatePublication({ title: "t", messages: [] }).error, /messages/);
  assert.match(
    validatePublication({ title: "t", messages: [{ role: "system", content: "x" }] }).error,
    /role user\|assistant/,
  );
  assert.match(validatePublication({ title: "t", messages: [{ role: "user", content: "" }] }).error, /content/);
});

test("publish → public read → index → unpublish round-trip", async () => {
  const env = { STORAGE: mockBucket() };

  const putReq = new Request("https://x/api/pub/your-cloud-storage", {
    method: "PUT",
    body: JSON.stringify(goodBody()),
  });
  const put = await handlePubWrite(putReq, env, log, "your-cloud-storage");
  assert.equal(put.status, 200);
  assert.equal((await put.json()).url, "/cure/your-cloud-storage");

  const get = await handlePubGet(env, "your-cloud-storage");
  assert.equal(get.status, 200);
  const pub = await get.json();
  assert.equal(pub.title, "Secure your cloud storage");
  assert.equal(pub.messages[1].role, "assistant");

  const index = await handlePubGet(env, null);
  const list = (await index.json()).publications;
  assert.equal(list.length, 1);
  assert.deepEqual(
    { slug: list[0].slug, title: list[0].title },
    { slug: "your-cloud-storage", title: "Secure your cloud storage" },
  );

  const del = await handlePubWrite(new Request("https://x", { method: "DELETE" }), env, log, "your-cloud-storage");
  assert.equal(del.status, 204);
  assert.equal((await handlePubGet(env, "your-cloud-storage")).status, 404);
});

test("bad slugs and bad bodies are rejected; missing storage is a 503", async () => {
  const env = { STORAGE: mockBucket() };
  const bad = await handlePubWrite(
    new Request("https://x", { method: "PUT", body: JSON.stringify(goodBody()) }),
    env,
    log,
    "Has.Dot",
  );
  assert.equal(bad.status, 400);
  const badBody = await handlePubWrite(
    new Request("https://x", { method: "PUT", body: JSON.stringify({ title: "t", messages: "no" }) }),
    env,
    log,
    "ok-slug",
  );
  assert.equal(badBody.status, 400);
  assert.equal((await handlePubGet({}, "ok-slug")).status, 503);
  assert.equal((await handlePubGet(env, "no.slug")).status, 400);
  assert.equal((await handlePubGet(env, "absent-slug")).status, 404);
});

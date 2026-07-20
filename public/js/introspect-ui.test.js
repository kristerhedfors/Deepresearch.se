// Node tests for the introspection UI's ROUTING accessors — the two
// functions stream.js consults to decide whether an introspection send goes
// browser-direct on the user's key (private) or through the server (remote).
// The rest of introspect-ui.js is DOM/browser glue (verified live); these two
// are pure over localStorage + the drc-providers registry, so a localStorage
// stub is enough to exercise the real decision logic. The module body touches
// no DOM at import time (all of it is inside functions), so it imports clean.

import { test } from "node:test";
import assert from "node:assert/strict";

// A minimal synchronous localStorage stub, installed before the import so the
// module's accessors see it.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { privateIntrospectionRoute, introspectionRemoteModel, introspectionRouteLabel, initIntrospectUi } =
  await import("./introspect-ui.js");

function setChoice(v) {
  store.set("dr_introspect_choice", v);
}
function setKeys(obj) {
  store.set("dr_introspect_keys", JSON.stringify(obj));
}

test("privateIntrospectionRoute: null unless a private choice AND its key are both present", () => {
  store.clear();
  assert.equal(privateIntrospectionRoute(), null); // nothing chosen
  setChoice("p:openai:gpt-5.6-sol");
  assert.equal(privateIntrospectionRoute(), null); // chosen, but no key stored
  setKeys({ openai: "sk-abc" });
  assert.deepEqual(privateIntrospectionRoute(), {
    providerId: "openai",
    apiKey: "sk-abc",
    model: "gpt-5.6-sol",
    label: "OpenAI",
  });
});

test("privateIntrospectionRoute: a server choice is NOT a private route", () => {
  store.clear();
  setChoice("s:mistral-small");
  setKeys({ openai: "sk-abc" });
  assert.equal(privateIntrospectionRoute(), null);
});

test("privateIntrospectionRoute: unknown provider id yields null (no matching registry entry)", () => {
  store.clear();
  setChoice("p:nope:some-model");
  setKeys({ nope: "x" });
  assert.equal(privateIntrospectionRoute(), null);
});

test("introspectionRemoteModel: the picked remote model, else empty", () => {
  store.clear();
  assert.equal(introspectionRemoteModel(), "");
  setChoice("s:mistral-small");
  assert.equal(introspectionRemoteModel(), "mistral-small");
  setChoice("p:openai:gpt-5.6-sol");
  assert.equal(introspectionRemoteModel(), ""); // a private choice is not a remote model
});

// The composer-row chip's label (app.js #introroute) — the same routing
// decision the two accessors above make, worded for a small pill.
test("introspectionRouteLabel: DRS tier reflects the stored route", () => {
  initIntrospectUi({ tier: "drs" });
  store.clear();
  assert.equal(introspectionRouteLabel(), "☁ Server"); // nothing chosen yet
  setChoice("s:mistral-small");
  assert.equal(introspectionRouteLabel(), "☁ mistral-small"); // explicit remote pick
  setChoice("p:openai:gpt-5.6-sol");
  setKeys({ openai: "sk-abc" });
  assert.equal(introspectionRouteLabel(), "🔒 OpenAI"); // private route, key present
  setChoice("p:openai:gpt-5.6-sol"); // chosen but the key was never saved
  setKeys({});
  assert.equal(introspectionRouteLabel(), "☁ Server"); // falls back — no key, no route
});

test("introspectionRouteLabel: DRC (secure) tier is fixed — every call is already private", () => {
  initIntrospectUi({ tier: "drc" });
  store.clear();
  assert.equal(introspectionRouteLabel(), "🔒 Private");
  setChoice("s:mistral-small"); // no picker on this tier — a stray value changes nothing
  assert.equal(introspectionRouteLabel(), "🔒 Private");
  initIntrospectUi({ tier: "drs" }); // restore default for any test file run after this one
});

// RUN-AS (src/run-as.js): the break-glass identity picker. These pin the two
// properties that make it safe to ship on a live site — every form it can
// resolve is equal or LESSER privilege, and an unrecognized spec resolves to
// NOTHING (the caller falls back to plain break-glass) rather than to a
// surprise identity.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_AS_ID_PREFIX,
  applyLocalRunAs,
  parseRunAs,
  runAsSpecFromUid,
  runAsUid,
  runAsView,
  sanitizeName,
  syntheticIdentity,
} from "./run-as.js";

const ADMIN = { id: "admin", role: "admin", email: null, name: "Admin", isSecretAdmin: true };

test("parseRunAs recognizes exactly the four forms", () => {
  assert.deepEqual(parseRunAs("admin"), { kind: "admin" });
  assert.deepEqual(parseRunAs("ADMIN"), { kind: "admin" });
  assert.deepEqual(parseRunAs("user"), { kind: "user" });
  assert.deepEqual(parseRunAs("test:alice"), { kind: "test", name: "alice" });
  assert.deepEqual(parseRunAs("Bob@Example.SE"), { kind: "account", ref: "bob@example.se", byId: false });
  assert.deepEqual(parseRunAs("#42"), { kind: "account", ref: "42", byId: true });
});

test("parseRunAs returns null for anything it does not recognize", () => {
  for (const bad of ["", null, undefined, "   ", "root", "#abc", "test:", "x".repeat(200)]) {
    assert.equal(parseRunAs(bad), null, `should not resolve: ${JSON.stringify(bad)}`);
  }
});

test("sanitizeName slugs a persona name and bounds it", () => {
  assert.equal(sanitizeName("  Alice Andersson "), "alice-andersson");
  assert.equal(sanitizeName("a/b\\c"), "a-b-c");
  assert.equal(sanitizeName("--x--"), "x");
  assert.ok(sanitizeName("y".repeat(200)).length <= 40);
});

test("run-as NEVER escalates: user and test personas drop admin", () => {
  const asUser = applyLocalRunAs({ kind: "user" }, ADMIN);
  assert.equal(asUser.role, "user");
  assert.equal(asUser.isSecretAdmin, undefined, "the admin surfaces must refuse it");
  const persona = applyLocalRunAs({ kind: "test", name: "alice" }, ADMIN);
  assert.equal(persona.role, "user");
  assert.equal(persona.isSecretAdmin, undefined);
  // `admin` is the identity break-glass already had — no change of privilege.
  const asAdmin = applyLocalRunAs({ kind: "admin" }, ADMIN);
  assert.equal(asAdmin.role, "admin");
  assert.equal(asAdmin.isSecretAdmin, true);
  // The account form needs D1 and is resolved by auth.js, not here.
  assert.equal(applyLocalRunAs({ kind: "account", ref: "a@b.se", byId: false }, ADMIN), null);
});

test("synthetic personas are distinct, stable, and honestly labelled", () => {
  const a = syntheticIdentity("alice");
  const b = syntheticIdentity("bob");
  assert.notEqual(a.id, b.id, "two personas must be two identities (own pool, own consent)");
  assert.equal(a.id, RUN_AS_ID_PREFIX + "alice");
  assert.deepEqual(syntheticIdentity("Alice"), a, "the same name is the same persona");
  assert.equal(a.synthetic, true);
  assert.match(a.email, /@run-as\.test$/, "never looks like a real mailbox");
  assert.equal(a.role, "user");
});

test("the cookie uid round-trips any spec, including emails (dots and all)", () => {
  for (const spec of ["user", "test:alice", "bob@example.se", "#42"]) {
    const uid = runAsUid(spec);
    assert.ok(!uid.includes("."), "the session cookie is dot-delimited — the uid must not add one");
    assert.equal(runAsSpecFromUid(uid), spec);
  }
  assert.equal(runAsSpecFromUid("admin"), null);
  assert.equal(runAsSpecFromUid("u.7.123.sig"), null);
});

test("runAsView exposes the persona without leaking the D1 row", () => {
  const v = runAsView({ id: "7", role: "user", email: "bob@x.se", name: "Bob", user: { id: 7, secret: "nope" } });
  assert.deepEqual(v, { id: "7", role: "user", email: "bob@x.se", name: "Bob", synthetic: false, runAs: null });
});

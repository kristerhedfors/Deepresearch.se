// Unit suite for the agent-registry loading seam (src/agent-registry.js): the
// per-binding cache and the "only load when routing could differ" guard.
//
// The guard is the reason a plain Deep Research turn costs nothing extra for
// registry-driven routing. The snapshot is several megabytes; a request with no
// mode flag and no capability knob can only ever resolve to `normal`, so paying
// to learn that would be a regression on the commonest path in the product.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadAgentRegistry, routingNeedsRegistry } from "./agent-registry.js";
import { SNAPSHOT_PATH } from "../public/js/introspect-core.js";
import { AGENTS_PATH } from "../public/js/agent-spec-core.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A fake ASSETS binding serving a snapshot that carries the real registry. */
function fakeAssets(counter = { n: 0 }) {
  const agents = readFileSync(join(repoRoot, AGENTS_PATH), "utf8");
  return {
    _calls: counter,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith(SNAPSHOT_PATH)) return new Response("nope", { status: 404 });
      counter.n++;
      return new Response(JSON.stringify({ files: [{ p: AGENTS_PATH, t: agents }] }), { status: 200 });
    },
  };
}

test("the registry loads once per binding and is served from cache after that", async () => {
  const calls = { n: 0 };
  const env = { ASSETS: fakeAssets(calls) };
  const first = await loadAgentRegistry(env);
  assert.ok(first?.agents?.length, "loads the registry");
  assert.equal(calls.n, 1);
  const second = await loadAgentRegistry(env);
  assert.equal(second, first, "same object, no second fetch");
  assert.equal(calls.n, 1);

  // A DIFFERENT binding is a different cache entry — one env can never be
  // served another's registry, which a bare module-scope variable would do.
  const otherCalls = { n: 0 };
  const other = await loadAgentRegistry({ ASSETS: fakeAssets(otherCalls) });
  assert.ok(other?.agents?.length);
  assert.equal(otherCalls.n, 1);
});

test("every failure path degrades to null, never a throw", async () => {
  assert.equal(await loadAgentRegistry(undefined), null);
  assert.equal(await loadAgentRegistry({}), null); // no binding
  assert.equal(await loadAgentRegistry({ ASSETS: {} }), null); // binding without fetch
  // A 404, a throw, and a body that is not a snapshot.
  assert.equal(await loadAgentRegistry({ ASSETS: { fetch: async () => new Response("x", { status: 404 }) } }), null);
  assert.equal(await loadAgentRegistry({ ASSETS: { fetch: async () => { throw new Error("boom"); } } }), null);
  assert.equal(await loadAgentRegistry({ ASSETS: { fetch: async () => new Response("{}", { status: 200 }) } }), null);
  // A failed load is NOT cached: the next request retries rather than the
  // isolate being poisoned for its whole life by one transient asset error.
  let ok = false;
  const flaky = {
    ASSETS: {
      fetch: async () => ok
        ? new Response(JSON.stringify({ files: [{ p: AGENTS_PATH, t: readFileSync(join(repoRoot, AGENTS_PATH), "utf8") }] }), { status: 200 })
        : new Response("down", { status: 503 }),
    },
  };
  assert.equal(await loadAgentRegistry(flaky), null);
  ok = true;
  assert.ok((await loadAgentRegistry(flaky))?.agents?.length, "recovers on the next call");
});

test("routingNeedsRegistry keeps the plain Deep Research turn off the load path", () => {
  // Nothing to resolve: no knob, no flag → always `normal`.
  assert.equal(routingNeedsRegistry({}, false), false);
  assert.equal(routingNeedsRegistry({ web_search: true, incognito: true }, false), false);
  assert.equal(routingNeedsRegistry(undefined, false), false);
  // The knob alone can route to introspection, so it needs the registry.
  assert.equal(routingNeedsRegistry({}, true), true);
  // A mode flag needs it even from a knob-off caller — so the registry, not a
  // pre-check, is what refuses the ungranted capability.
  for (const flag of ["sdk_mode", "orchestrator_mode", "outrospection_mode"]) {
    assert.equal(routingNeedsRegistry({ [flag]: true }, false), true, flag);
    assert.equal(routingNeedsRegistry({ [flag]: "yes" }, false), false, `${flag} must be a strict boolean`);
  }
  // An ADDRESSED agent is the third way routing can differ. Naming one needs
  // the registry — including a name that turns out not to exist, so that
  // "unknown id" and "id you may not have" are indistinguishable from outside.
  assert.equal(routingNeedsRegistry({ agent: "under-construction" }, false), true);
  assert.equal(routingNeedsRegistry({ agent: "ghost" }, false), true);
  // …but an empty or non-string one is no address at all, and must not drag the
  // multi-megabyte snapshot onto the commonest path.
  for (const agent of ["", "   ", null, 0, false, 7, {}, []]) {
    assert.equal(routingNeedsRegistry({ agent }, false), false, `agent=${JSON.stringify(agent)} is not an address`);
  }
});

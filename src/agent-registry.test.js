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
import { loadAgentRegistry } from "./agent-registry.js";
// routingNeedsRegistry moved to the shared mode table with the rest of the mode
// logic (public/js/chat-mode-core.js, re-exported by src/chat-modes.js).
import { routingNeedsRegistry } from "./chat-modes.js";
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
  // Nothing to resolve: mode `normal` with no addressed agent → always the
  // research agent, so the multi-megabyte snapshot must stay off the path.
  assert.equal(routingNeedsRegistry({}, "normal"), false);
  assert.equal(routingNeedsRegistry({ web_search: true, incognito: true }, "normal"), false);
  assert.equal(routingNeedsRegistry(undefined, "normal"), false);
  // Any non-normal mode can route somewhere else, so it needs the registry. The
  // MODE is what is asked here, not the raw flags — chat.js resolves those into
  // the mode before routing starts (chat-mode-core.js resolveBodyChatMode), so a
  // flag on a request that resolved to `normal` is already spent.
  for (const mode of ["introspection", "sdk", "orchestrator", "outrospection", "models"]) {
    assert.equal(routingNeedsRegistry({}, mode), true, mode);
  }
  assert.equal(routingNeedsRegistry({ sdk_mode: true }, "normal"), false);
  // An ADDRESSED agent is the other way routing can differ. Naming one needs
  // the registry — including a name that turns out not to exist, so that
  // "unknown id" and "id you may not have" are indistinguishable from outside.
  assert.equal(routingNeedsRegistry({ agent: "under-construction" }, "normal"), true);
  assert.equal(routingNeedsRegistry({ agent: "ghost" }, "normal"), true);
  // …but an empty or non-string one is no address at all, and must not drag the
  // multi-megabyte snapshot onto the commonest path.
  for (const agent of ["", "   ", null, 0, false, 7, {}, []]) {
    assert.equal(routingNeedsRegistry({ agent }, "normal"), false, `agent=${JSON.stringify(agent)} is not an address`);
  }
});

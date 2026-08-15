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
import { DEFAULT_CHAT_MODE, routingNeedsRegistry } from "./chat-modes.js";
import { SOURCE_CARRYING_MODES } from "../public/js/chat-mode-core.js";
import { defaultAgentForMode } from "./agent-spec.js";
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

test("routingNeedsRegistry says yes to everything, because every mode is a domain now", () => {
  // This used to be the load-path SHORTCUT: mode `normal` with no addressed
  // agent always resolved to the general research agent, so paying a
  // multi-megabyte snapshot read to learn that was pure cost on the commonest
  // path, and the answer was `false`.
  //
  // The general agent went on 2026-08-13 and took the premise with it. Every
  // mode names a domain, and a domain is ENFORCED by the resolved capability —
  // capHasContext decides whether the literature legs run, whether host
  // intelligence runs, whether street imagery runs. A request that skipped the
  // registry would resolve a null capability, and a null capability is the
  // unrestricted platform default: Deep Science would quietly stop being
  // literature-only. So the shortcut is gone, and what replaced it is a cheaper
  // artifact (AGENTS_REGISTRY_PATH) plus the per-isolate cache.
  for (const mode of ["science", "cyber", "introspection", "sdk", "orchestrator", "outrospection", "models"]) {
    assert.equal(routingNeedsRegistry({}, mode), true, mode);
  }
  // The default mode is not special any more — that is the whole point.
  assert.equal(routingNeedsRegistry({}, DEFAULT_CHAT_MODE), true);
  assert.equal(routingNeedsRegistry(undefined, undefined), true);
  assert.equal(routingNeedsRegistry({ agent: "under-construction" }, "science"), true);
  assert.equal(routingNeedsRegistry({ agent: "" }, "science"), true);
});

// Which modes carry the source snapshot is stated TWICE: as a hand-written
// mode list (chat-mode-core.js SOURCE_CARRYING_MODES, which chat.js turns into
// state.introspection and enrichment.js gates the introspect row on) and as
// each agent's declared `capability.context`. Every other context block in the
// registry was converted to the declaration on 2026-08-13 — owasp,
// ancient-samples, scholar-metrics, entity-method, and the extension blocks all
// gate on capHasContext — and this one was left behind. It had already drifted:
// `outrospection` and `models` were in the list and declared nothing.
//
// The list stays (it is the fail-soft path when no agent resolves, and /help
// nulls the capability deliberately), so what is pinned is that the two agree.
// "When a copy is forced, pin it" — the oauth-store.js DDL precedent.
test("SOURCE_CARRYING_MODES agrees with what the agents declare", () => {
  const registry = JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));
  const declares = (mode) => {
    const context = defaultAgentForMode(registry, mode)?.capability?.context;
    return Array.isArray(context) && context.includes("source-snapshot");
  };
  for (const mode of SOURCE_CARRYING_MODES) {
    assert.equal(declares(mode), true, `${mode} carries the source snapshot but its agent does not declare it`);
  }
  // …and the other direction: an agent that declares it must be in the list,
  // or the declaration is a promise the request path never keeps.
  for (const agent of registry.agents) {
    const context = agent?.capability?.context;
    if (!Array.isArray(context) || !context.includes("source-snapshot")) continue;
    const mode = (registry.defaults || []).find((d) => d.agent === agent.id)?.mode;
    if (!mode) continue; // not a mode default — nothing routes to it by mode
    assert.ok(SOURCE_CARRYING_MODES.includes(mode), `${agent.id} declares source-snapshot but mode ${mode} does not carry it`);
  }
});

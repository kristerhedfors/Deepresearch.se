// Unit tests for the extension registry (src/extensions.js) — the clean cut
// between the platform core and the third-party services woven into research.
//
// Two jobs here. The first half tests the SEAM: that the registry's five
// hooks behave, and that the wire names shipped to clients and the chat log
// survived the move. The second half is the GUARD — a mechanical check that
// the core modules have not started naming a service again, which is the only
// thing that keeps this separation from quietly rotting back.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CONTEXT_BLOCKS } from "./agent-spec.js";
import { enrichmentApplies } from "./enrichment.js";
import {
  EXTENSIONS,
  emptyExtensionState,
  extensionAvailability,
  extensionCapabilities,
  extensionEnrichments,
  extensionLogMeta,
  extensionPayloadExtras,
  extensionSettingDefaults,
  extensionSettingSpecs,
  getExtension,
  resolveExtensionState,
} from "./extensions.js";

describe("registry shape", () => {
  test("every extension declares the full descriptor contract", () => {
    assert.ok(EXTENSIONS.length > 0);
    for (const e of EXTENSIONS) {
      assert.equal(typeof e.id, "string", `${e.id}: id`);
      assert.equal(typeof e.label, "string", `${e.id}: label`);
      assert.equal(typeof e.resolveState, "function", `${e.id}: resolveState`);
      assert.equal(typeof e.enabled, "function", `${e.id}: enabled`);
      assert.equal(typeof e.run, "function", `${e.id}: run`);
      assert.equal(typeof e.logMeta, "function", `${e.id}: logMeta`);
      assert.equal(typeof e.setting.key, "string", `${e.id}: setting.key`);
      assert.equal(typeof e.setting.availability, "string", `${e.id}: setting.availability`);
      assert.equal(typeof e.setting.secret, "string", `${e.id}: setting.secret`);
      assert.equal(typeof e.setting.available, "function", `${e.id}: setting.available`);
      assert.ok(e.setting.unavailableError, `${e.id}: unavailableError`);
      assert.equal(typeof e.capability.order, "number", `${e.id}: capability.order`);
      assert.ok(e.capability.text, `${e.id}: capability.text`);
      // Seam 6 (2026-08-13): which agent may reach this extension at all.
      assert.equal(typeof e.contextBlock, "string", `${e.id}: contextBlock`);
    }
  });

  test("every contextBlock is a real entry in the AgentSpec vocabulary", () => {
    // The declaration side of seam 6 has to be selectable by a spec, or the
    // extension is unreachable by construction: capHasContext compares against
    // whatever the spec listed, and validateCapability only admits CONTEXT_BLOCKS
    // keys. A typo here would switch the extension off for every agent and
    // nothing else in the suite would notice.
    for (const e of EXTENSIONS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CONTEXT_BLOCKS, e.contextBlock),
        `${e.id}: contextBlock "${e.contextBlock}" is not a CONTEXT_BLOCKS id`,
      );
      // Both of today's extensions reach a third party from the server, so the
      // block they select must be server-only — a client-tier agent declaring
      // it would be rejected by validateCapability, which is the right answer.
      assert.equal(CONTEXT_BLOCKS[e.contextBlock].serverOnly, true, `${e.id}: ${e.contextBlock} must be serverOnly`);
    }
  });

  test("ids, knob keys and capability positions are unique", () => {
    const unique = (xs) => new Set(xs).size === xs.length;
    assert.ok(unique(EXTENSIONS.map((e) => e.id)), "ids");
    assert.ok(unique(EXTENSIONS.map((e) => e.setting.key)), "setting keys");
    assert.ok(unique(EXTENSIONS.map((e) => e.setting.availability)), "availability keys");
    assert.ok(unique(EXTENSIONS.map((e) => e.capability.order)), "capability orders");
    // One extension per context block: two extensions behind one declaration
    // would make the exclusivity guard (src/cyber-exclusivity.test.js) unable
    // to say which capability an agent actually gained.
    assert.ok(unique(EXTENSIONS.map((e) => e.contextBlock)), "context blocks");
  });

  test("getExtension resolves by id and is null for anything else", () => {
    assert.equal(getExtension("shodan")?.id, "shodan");
    assert.equal(getExtension("maps")?.id, "maps");
    assert.equal(getExtension("nope"), null);
  });

  // The wire names the client and the chat_logs rows depend on. They are
  // shipped contracts: the extension cut moved the CODE, never these strings.
  test("the shipped knob/availability wire names are unchanged", () => {
    assert.deepEqual(extensionSettingDefaults(), { shodan_mcp: false, google_maps: false });
    assert.deepEqual(
      extensionSettingSpecs().map((s) => [s.id, s.key, s.availability]),
      [
        ["shodan", "shodan_mcp", "shodan"],
        ["maps", "google_maps", "google_maps"],
      ],
    );
  });
});

describe("settings seam", () => {
  test("availability needs both the backing secret and a user row", () => {
    assert.deepEqual(extensionAvailability({}, true), { shodan: false, google_maps: false });
    assert.deepEqual(extensionAvailability({ SHODAN_API_KEY: "k" }, true), {
      shodan: true,
      google_maps: false,
    });
    assert.deepEqual(extensionAvailability({ GOOGLE_MAPS_API_KEY: "k" }, true), {
      shodan: false,
      google_maps: true,
    });
    // No D1 user row (break-glass): nothing is available, secrets or not.
    assert.deepEqual(
      extensionAvailability({ SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k" }, false),
      { shodan: false, google_maps: false },
    );
  });

  test("payload extras ride only when the extension is available", () => {
    const env = { GOOGLE_MAPS_API_KEY: "main", GOOGLE_MAPS_EMBED_KEY: "embed" };
    assert.deepEqual(extensionPayloadExtras(env, { google_maps: true }), { maps_embed_key: "embed" });
    assert.deepEqual(extensionPayloadExtras(env, { google_maps: false }), { maps_embed_key: "" });
  });
});

describe("per-request state seam", () => {
  test("one namespaced slice per extension, every one off by default", () => {
    const ext = emptyExtensionState();
    assert.deepEqual(Object.keys(ext).sort(), ["maps", "shodan"]);
    for (const e of EXTENSIONS) assert.equal(ext[e.id].on, false, e.id);
    assert.equal(ext.shodan.count, 0);
    assert.equal(ext.maps.count, 0);
  });

  test("an extension reads its body fields only when it is enabled", () => {
    const body = {
      street_view_pov: { panoId: "abc", lat: 59.4, lng: 17.9, heading: 90, pitch: 0, fov: 90 },
      map_view: { lat: 59.65, lng: 17.12, zoom: 16.6 },
      user_location: { lat: 59.33, lng: 18.06 },
    };
    const off = resolveExtensionState(body, { maps: false });
    assert.equal(off.maps.pov, null);
    assert.equal(off.maps.view, null);
    assert.equal(off.maps.userLocation, null);

    const on = resolveExtensionState(body, { maps: true });
    assert.equal(on.maps.on, true);
    assert.equal(on.maps.pov.panoId, "abc");
    assert.deepEqual(on.maps.view, { lat: 59.65, lng: 17.12, zoom: 17 }); // sanitized
    assert.deepEqual(on.maps.userLocation, { lat: 59.33, lng: 18.06, zoom: 17 });
  });

  test("a missing or junk body is tolerated (never throws into the request)", () => {
    for (const body of [undefined, null, {}, { map_view: "nonsense" }]) {
      const ext = resolveExtensionState(body, { shodan: true, maps: true });
      assert.equal(ext.maps.view, null);
      assert.equal(ext.shodan.on, true);
    }
  });
});

describe("enrichment seam", () => {
  // The gate as the RUNNER applies it: the knob (this extension's slice of
  // state.ext) AND the agent's declaration (its contextBlock). The two halves
  // live on different fields of the entry, so asserting `enabled` alone would
  // go green with the capability half deleted — which is the hole the
  // "knob AND declaration" test below exists to close.
  const applies = (entry, state) => enrichmentApplies(entry, state);
  // The capability an agent declaring every extension's block would carry.
  const allBlocks = { context: EXTENSIONS.map((e) => e.contextBlock) };

  test("an extension is enabled only when its own slice says so", () => {
    const entries = extensionEnrichments();
    assert.deepEqual(entries.map((e) => e.id), ["shodan", "maps"]);
    const state = { ext: resolveExtensionState({}, { shodan: true }), capability: allBlocks };
    assert.equal(applies(entries.find((e) => e.id === "shodan"), state), true);
    assert.equal(applies(entries.find((e) => e.id === "maps"), state), false);
  });

  test("the knob AND the agent's declaration are both required (seam 6)", () => {
    // The knob is the ACCOUNT's consent to reach a third party; the context
    // block is WHICH AGENT may use it. Either alone must reach nothing — that
    // is the whole content of the 2026-08-13 change, and without this test the
    // capability half could be deleted and every other assertion here would
    // still pass.
    const both = { ext: resolveExtensionState({}, { shodan: true, maps: true }), capability: allBlocks };
    const knobOnly = { ext: resolveExtensionState({}, { shodan: true, maps: true }) };
    const capOnly = { ext: emptyExtensionState(), capability: allBlocks };
    for (const entry of extensionEnrichments()) {
      assert.equal(applies(entry, both), true, `${entry.id}: knob + declaration`);
      assert.equal(applies(entry, knobOnly), false, `${entry.id}: knob without declaration`);
      assert.equal(applies(entry, capOnly), false, `${entry.id}: declaration without knob`);
    }
    // …and a declaration selects only its own extension.
    for (const e of EXTENSIONS) {
      const state = { ext: resolveExtensionState({}, { shodan: true, maps: true }), capability: { context: [e.contextBlock] } };
      for (const entry of extensionEnrichments()) {
        assert.equal(applies(entry, state), entry.id === e.id, `${e.contextBlock} → ${entry.id}`);
      }
    }
  });

  test("a state with no ext bag at all leaves every extension off", () => {
    // The safety net for any channel that builds state by hand: an absent bag
    // must read as "nothing enabled", never throw. Same for an absent or junk
    // capability — the narrowing direction, so a request that never consulted
    // the agent registry reaches no third party rather than every one.
    for (const entry of extensionEnrichments()) {
      assert.equal(applies(entry, {}), false, entry.id);
      assert.equal(applies(entry, { ext: {} }), false, entry.id);
      const on = resolveExtensionState({}, { shodan: true, maps: true });
      for (const capability of [undefined, null, {}, { context: [] }, { context: "host-intel" }, { context: ["source-snapshot"] }]) {
        assert.equal(applies(entry, { ext: on, capability }), false, `${entry.id}: ${JSON.stringify(capability)}`);
      }
    }
  });
});

describe("logging seam", () => {
  test("the chat_logs meta keys are the shipped ones", () => {
    const state = { ext: emptyExtensionState() };
    state.ext.shodan.count = 3;
    state.ext.shodan.intent = "latest-host";
    state.ext.maps.count = 1;
    state.ext.maps.intent = "matched";
    assert.deepEqual(extensionLogMeta(state), {
      shodan_hosts: 3,
      shodan_intent: "latest-host",
      google_maps: 1,
      maps_intent: "matched",
    });
  });

  test("an extension that never ran contributes no routing trace", () => {
    // maps_intent / shodan_intent must stay undefined so JSON.stringify drops
    // the key — an absent trace, not a fabricated one. That is what makes a
    // zero counter readable: `shodan_hosts: 0` WITHOUT `shodan_intent` means
    // the knob was off; with it, the runner ran and matched nothing.
    const meta = extensionLogMeta({ ext: emptyExtensionState() });
    assert.equal(meta.maps_intent, undefined);
    assert.equal(meta.shodan_intent, undefined);
    assert.equal(meta.shodan_hosts, 0);
    const round = JSON.parse(JSON.stringify(meta));
    assert.equal("maps_intent" in round, false);
    assert.equal("shodan_intent" in round, false);
  });
});

describe("capabilities seam", () => {
  test("each extension claims a numbered position in the grounded list", () => {
    const caps = extensionCapabilities();
    assert.equal(caps.length, EXTENSIONS.length);
    for (const c of caps) {
      assert.ok(c.order >= 1);
      // Every capability line states where the user turns it on or off —
      // the whole point of the grounded note.
      assert.match(c.text, /TURN ON\/OFF/);
    }
  });

  test("every capability line names the AGENT as well as the knob", () => {
    // The knob stopped being the whole answer on 2026-08-13. A line that still
    // said only "Account panel → Settings" would send a user who switched the
    // knob on to an agent that cannot run the lookup, and the grounded note
    // exists precisely so this answer is not guesswork.
    for (const c of extensionCapabilities()) {
      assert.match(c.text, /WHERE: the Cyber agent/);
      assert.match(c.text, /Both are needed/);
    }
  });

  test("the list is filtered to what the ANSWERING agent can reach", () => {
    // The other half of the gate. Without this an agent that cannot run a host
    // lookup would still carry a numbered line telling it that it can, and
    // src/prompts.js's capabilityList would be the one place left lying about
    // the roster.
    for (const e of EXTENSIONS) {
      const only = extensionCapabilities({ context: [e.contextBlock] });
      assert.deepEqual(only, [{ ...e.capability }], `${e.contextBlock} selects exactly its own line`);
    }
    for (const capability of [null, {}, { context: [] }, { context: ["source-snapshot"] }]) {
      assert.deepEqual(extensionCapabilities(capability), [], JSON.stringify(capability));
    }
    // Omitted entirely — the MCP channel, a sub-agent, a test — is the
    // unfiltered list, exactly what those callers described before the filter.
    assert.equal(extensionCapabilities().length, EXTENSIONS.length);
    assert.equal(extensionCapabilities(undefined).length, EXTENSIONS.length);
  });
});

// ---- the guard --------------------------------------------------------------
// The separation is only real if it is enforced. These modules ARE the agent
// architecture: the request handler, the pipeline and its phase inputs, the
// enrichment runner, request validation, the knob store, the prompt builder,
// the MCP channel, the shared types. None of them may reference a
// third-party integration in CODE — only extensions.js may, and only it is
// imported by the rest.
//
// Prose is exempt on purpose: a comment saying "this moved to
// maps-enrichment.js" is a useful signpost, and banning it would push people
// toward vaguer comments rather than better boundaries. What is banned is a
// core module *reaching for* a service.
const CORE_MODULES = [
  "src/chat.js",
  "src/pipeline.js",
  "src/pipeline-standard.js",
  // The model-driven engine. It is here for a specific trap: a research tool's
  // NAME is a service's name — the imagery tool matches SERVICE_TOKENS'
  // /street[_ ]?view/i all by itself — so an engine that enumerated its toolbox
  // would name integrations in the one place that decides what a run may reach.
  // It reaches tool names only through the tool registry, which is deliberately
  // NOT in this list (asserted from the other side, in that registry's suite).
  "src/agentic.js",
  "src/pipeline-inputs.js",
  "src/enrichment.js",
  "src/validation.js",
  "src/settings.js",
  "src/prompts.js",
  "src/mcp.js",
  "src/types.d.ts",
  "src/triage.js",
  "src/conversation.js",
  "src/budget.js",
  "src/billing.js",
  "src/model-routing.js",
  "src/search-sources.js",
];

// Every service token that must not appear in core code. Deliberately broad:
// module names, identifiers, secrets, hosts, and the wire vocabulary each
// integration owns.
const SERVICE_TOKENS = [
  /shodan/i,
  /googlemaps/i,
  /google[_ -]?maps/i,
  /street[_ ]?view/i,
  /maps\.google/i,
  /SHODAN_API_KEY/,
  /GOOGLE_MAPS/,
];

/** Strips // line comments, block comments and JSDoc, leaving only code. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      // Naive but sufficient here: no core module has a `//` inside a string
      // literal on a line that also carries a service token.
      const at = line.indexOf("//");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

describe("core purity", () => {
  test("no core module references a third-party integration in code", () => {
    /** @type {string[]} */
    const offenders = [];
    for (const file of CORE_MODULES) {
      const code = codeOnly(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
      code.split("\n").forEach((line, i) => {
        for (const token of SERVICE_TOKENS) {
          if (token.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      "A core module names a third-party service. Register it in src/extensions.js " +
        "and reach it through the registry's hooks instead:\n" + offenders.join("\n"),
    );
  });

  test("only the registry imports an integration's modules", () => {
    // The import graph is the load-bearing half of the cut: if no core module
    // imports shodan*.js / googlemaps*.js / maps-enrichment.js, then deleting
    // an integration cannot break the core, whatever the comments say.
    const integrationModules = /from\s+"\.\/(shodan|googlemaps|maps-enrichment)[\w-]*\.js"/;
    for (const file of CORE_MODULES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      assert.equal(
        integrationModules.test(src),
        false,
        `${file} imports an integration module directly — go through src/extensions.js`,
      );
    }
  });

  test("the enrichment runner reaches its integrations only via the registry", () => {
    const src = readFileSync(new URL("../src/enrichment.js", import.meta.url), "utf8");
    const imports = [...src.matchAll(/from\s+"(\.\/[\w.-]+)"/g)].map((m) => m[1]);
    // extensions.js is the ONLY door to a third-party integration. The rest are
    // CORE enrichments, which the registry has always been allowed to import
    // directly: introspection reads this repo's own committed snapshot,
    // models-agent.js is the Models agent's own mode behaviour over this
    // platform's own model landscape — the same standing this project already
    // gives the Hub as a core SEARCH SOURCE (src/search-sources.js) — and
    // aadr.js reads a corpus artifact built into this deployment. None has a
    // knob, a per-request state slice, or an extension descriptor, which is the
    // registry's own test for membership (see CORE_ENRICHMENTS).
    //
    // agent-spec.js is not an enrichment at all: it is the capability reader
    // the aadr entry is GATED on, and importing it is what lets an enrichment
    // be switched on by an agent spec instead of by a mode flag.
    //
    // scholar-metrics.js joins them on the same footing (2026-07-31). It is the
    // Deep Science agent's own mode behaviour over the peer-reviewed record —
    // no knob, no secret, no per-request state slice, no extension descriptor —
    // and the venue table it reads is a build artifact in this deployment. Its
    // one outbound call goes to a page Google's robots.txt explicitly allows;
    // that makes it a research SOURCE like Europe PMC and arXiv, which this
    // project has always treated as core, not a third-party integration bolted
    // onto a message the way Maps and Shodan are.
    //
    // image-read.js joins them on the same footing (phase 0, the vision pass
    // that transcribes an attached picture before triage plans anything). It
    // reaches no third party of its own: the one call it makes goes to the
    // SAME provider that is already answering this turn, through the same
    // provider registry every phase uses — no knob, no secret, no
    // per-request state slice, no extension descriptor.
    //
    // person-research.js is the easiest of all to justify: it reaches nothing
    // at all. No model call, no asset, no network — a regex pair and a constant
    // block of METHOD. There is no service for invariant 7 to be about; naming
    // a company register in a checklist is not integrating with one, and
    // actually searching stays the ordinary pipeline's job.
    //
    // entity-research.js is its sibling and stands on exactly the same ground:
    // a regex pair and a constant block of method, reaching nothing. It names
    // TIBER-EU and MITRE ATT&CK the way the person block names a company
    // register — as vocabulary a report is written in, not as a service anyone
    // integrates with. Note in particular that it is NOT the Shodan extension's
    // core half: an attack-surface question can reach both, but this module has
    // no knob, no secret, no state slice and no descriptor, and it would behave
    // identically in a deployment where Shodan had never been registered.
    //
    // conversation.js is the odd entry and the only one that is not an
    // enrichment: the registry reads lastUserText to record what a `method`
    // row appended (feedback #65), so the query-planning phases can plan
    // without it. It is this repo's own message-shape helper — no service, no
    // knob, no network — and the alternative was asking every runner to hand
    // its block back, which would have put the same knowledge in nine places
    // instead of one.
    //
    // owasp-context.js is the newest entry (2026-08-13) and the least arguable:
    // it reads a committed corpus of a PUBLIC STANDARD out of this deployment's
    // own assets — no knob, no secret, no per-request state slice, no extension
    // descriptor, and no outbound connection of any kind. It was a branch
    // inside introspect.js until the roster change made "which agent may reach
    // the standard" a question the introspection MODE could not answer.
    assert.deepEqual(imports, [
      "./aadr.js", "./agent-spec.js", "./conversation.js", "./entity-research.js", "./extensions.js",
      "./image-read.js", "./introspect.js", "./models-agent.js", "./owasp-context.js",
      "./person-research.js", "./scholar-metrics.js",
    ]);
  });
});

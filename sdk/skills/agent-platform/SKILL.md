---
name: agent-platform
description: >-
  Load when working on the AGENT PLATFORM — defining, previewing, testing or
  sharing an "agent" (a flavour of the Se/cure + Se/rver platform) through the SDK:
  the AgentSpec schema (an agent is DEFINED by its chat-input-pane controls, its
  intro + loading animations, its colour theme, its seed example questions, and
  the default quota a minted share-link token carries), the closed control
  vocabulary, sdk/AGENTS.json (the four shipped agents research / secure /
  under-construction / agent-builder), the pure core public/js/agent-spec-core.js
  (server façade src/agent-spec.js; sdk/pair-cli.mjs re-exports it), the composer
  renderer + the visual proof (scripts/agent-proof.mjs / proveComposer), example
  generation, and share-link token minting. Also the Agent Builder mode (the
  renamed SDK mode) that builds new agents. Companion to pair-studio (the build
  loop) and grant-bridge (the minted token).
---

# Agent platform — an agent IS its chat-input pane

The **agent platform** makes "an agent" a first-class, **declarative** thing in
the SDK. An agent is a *flavour* of the Se/cure + Se/rver platform, and it is
**defined by five things a user can see and change**:

1. its **chat-input-pane controls** — which affordances hang off the composer
   (a model picker, a research-depth slider, web-search / incognito toggles,
   attachments, a mode picker …);
2. its **intro animation** and its **loading animation**;
3. its **colour theme** (a small set of CSS custom properties);
4. its **example questions** (seed + on-demand generation);
5. the **default quota** a minted share-link **token** carries (credits).

Deriving a new agent is **copy one spec, change those fields, validate**. The
four this project ships are the reference specs; they exist to be copied.

## Capability class & tier story

Class **X** (shared substrate). The logic is ONE pure core,
`public/js/agent-spec-core.js`, re-exported by the server façade
`src/agent-spec.js` and by `sdk/pair-cli.mjs` (PA-7 — no hand-mirrored copies).
It is I/O-free and Node-tested (`public/js/agent-spec-core.test.js`), so the
browser preview, the Worker (Agent Builder mode + share-link minting), the CLI,
and the visual proof all resolve agents the same way.

The definition layer is tier-neutral; a spec's `platform` field (`client` /
`server`) picks the tier, exactly the two **platform types** from `pair-studio`.

## PA contracts it carries

- **PA-8 / PA-9 (the bridge discipline, fail-safe metering).** A minted
  share-link is a bounded, disclosed, revocable **token** carrying the spec's
  `quota`; no meter backend → no spend. The token authorises upstream API
  access only, never the server tier's own data (`grant-bridge`).
- **PA-4 (the privacy split).** A `client`-platform agent (e.g. `secure`) must
  keep the structural promise: provider calls browser-direct, no server in the
  data path, secrets never logged. The spec cannot opt a client agent into a
  server data path — the platform type is the boundary.
- **PA-6 (language parity).** Any deterministic gate an agent adds (intent
  routing, example seeds) takes Swedish + English with equal breadth.
- **PA-5 (no build step).** The specs are plain JSON; the renderer is plain
  string/DOM; no transpilation.

## The AgentSpec shape

One entry in `sdk/AGENTS.json` (`{ agents: [ … ] }`):

```jsonc
{
  "id": "research",              // lowercase slug, unique
  "name": "Research",            // display name
  "tagline": "…", "description": "…",
  "platform": "server",          // "client" | "server"  (the tier / platform type)
  "tier": "Se/rver",             // branding label (display only)
  "derivesFrom": "baseplate",    // which agent/base this was copied from (provenance)
  "mode": "normal",              // chat mode: normal | introspection | agent-builder
  "theme": { "--agent-accent": "#3b82f6", … },   // CSS custom properties
  "intro":   { "kind": "fade", "durationMs": 400 },
  "loading": { "kind": "pipeline-phases", "messages": ["Triaging…", …] },
  "controls": [                  // the chat-input pane — ORDER is render order
    { "type": "prompt-input", "placeholder": "Ask…" },
    { "type": "model-select", "providers": "all", "allowLocal": false },
    { "type": "depth-slider", "min": 0, "max": 3, "default": 1, "ticks": ["Quick","Standard","Deep","Exhaustive"] },
    { "type": "toggle", "id": "web_search", "label": "Web search", "default": true },
    { "type": "attachments", "max": 5 },
    { "type": "mode-select", "modes": ["normal","introspection","agent-builder"] },
    { "type": "send-button" }
  ],
  "examples": ["…"], "generateExamples": true,
  "quota": { "window": "day", "requests": 50, "credits": null, "note": "…" }
}
```

**The control vocabulary is CLOSED** (`CONTROL_REGISTRY` in the core): a spec may
only use `prompt-input`, `send-button`, `model-select`, `depth-slider`,
`toggle`, `mode-select`, `attachments`. Each type declares its default fields
and which **request field it drives** (`depth-slider` → `depth`, a `toggle` →
the flag named by its `id`, …). Closing the vocabulary is what lets a renderer —
and the visual proof — know every shape it must draw.

## Build plan (from scratch)

1. **Core.** `agent-spec-core.js`: the `CONTROL_REGISTRY`, `validateAgentSpec` /
   `validateAgentRegistry`, `resolveControl(s)` / `resolveTheme` / `resolveQuota`
   / `resolveExamples`, `composerModel` + `composerMarkup` + `controlMarkup`
   (the pure renderer), `proveComposer` (the proof check), `agentsFromSnapshot`
   (load from the committed source snapshot, like `manifestFromSnapshot`), and
   the text renderers. Façade it from `src/agent-spec.js`; re-export from the CLI.
2. **Specs.** `sdk/AGENTS.json` with the shipped agents. Validate:
   `node sdk/pair-cli.mjs validate` (it now checks agents too) and `npm test`.
3. **CLI.** `pair-cli.mjs agents` / `agent <id>`.
4. **Preview + proof.** `public/agents/preview.html` + `public/js/agent-preview.js`
   (the live human preview — render the composer, run example questions, mint a
   share link); `scripts/agent-proof.mjs` (render every agent's composer and
   assert every declared control appears — the machine gate + an eyeball
   gallery). Both build from the SAME `composerMarkup`.
5. **Agent Builder mode.** Rename SDK mode's user-facing label to "Agent
   Builder" (the internal `sdk` mode id / routes stay). Its purpose is building
   NEW agents by distilling the Se/cure tier.
6. **Share-link minting.** On "create a link", mint a token carrying the
   spec's quota — bounded, disclosed, revocable, fail-safe. Do it **by the
   book**: reuse the existing Se/rver-token subsystem (`src/server-grants.js`
   `mintServerTokenGrant` → `src/server-token.js` one HS256 JWT + one D1
   `server_tokens` row per permission). The ONLY new code is the pure adapter
   `agentTokenGrantParams` (spec → `{services, quotas, ttlHours}`, perms in the
   closed `web`/`api` vocabulary) and the admin endpoint `src/agent-link.js`
   (`POST /api/admin/agent-link`). No new crypto, no new meter — so the
   SERVER-TOKEN GUARANTEE (upstream APIs only, never data, never a login) holds
   for free.

## Reference implementation (this repo)

| Piece | File |
|---|---|
| The four shipped agents | `sdk/AGENTS.json` |
| Pure core | `public/js/agent-spec-core.js` (+ tests `…test.js`) |
| Server façade | `src/agent-spec.js` |
| CLI commands | `sdk/pair-cli.mjs` (`agents`, `agent <id>`) |
| Live preview | `public/agents/preview.html`, `public/js/agent-preview.js` |
| Visual proof | `scripts/agent-proof.mjs`, `proveComposer` |
| Share-link mint | `src/agent-link.js` (`POST /api/admin/agent-link`), `agentTokenGrantParams` → `src/server-grants.js` |
| Full docs | `docs/AGENT-PLATFORM.md` |

## Acceptance checklist

- [ ] `node sdk/pair-cli.mjs validate` OK (modules **and** agents).
- [ ] `npm test` green (`agent-spec-core.test.js`), including `proveComposer`
      for every shipped agent.
- [ ] `node scripts/agent-proof.mjs` PASS + writes the composer gallery.
- [ ] Deriving a new agent = copy one spec, change fields, re-validate — no code
      change.
- [ ] `POST /api/admin/agent-link` mints a standard Se/rver token whose JWT
      verifies and whose D1 meter rows carry the spec's quota
      (`src/agent-link.test.js`) — reusing the existing subsystem, no new
      crypto/meter (PA-8/PA-9).
- [ ] A `client`-platform agent keeps the Se/cure privacy posture (PA-4).

## Pitfalls

- **Don't add a control type ad hoc.** Extend `CONTROL_REGISTRY` (with its
  `drives` field + defaults) and the renderer + the proof in the SAME change,
  or the vocabulary stops being closed and the proof can't check it.
- **Editing `sdk/AGENTS.json` or the core is a tracked-text change** — it rides
  the source snapshot, so regenerate the introspection artifacts (`npm run
  bundle` and friends) and run `npm test` before pushing, like any `sdk/` edit.
- **The quota is fail-safe, not fail-soft.** A share link with no working meter
  grants nothing (PA-9) — contrast the pipeline's fail-soft helper phases.

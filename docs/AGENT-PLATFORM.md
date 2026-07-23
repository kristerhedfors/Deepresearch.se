# The Agent Platform

**Build complete agents through the SDK — define them, preview them, prove
them, and share them.** This is the top of a three-level documentation tree.
Read this page for the whole picture; follow the links down to the subsystem
docs and then to the source; and use the **"ask the source"** links (§8) to
put any question straight to the introspection agent, which answers from the
project's own code.

> **Status (2026-07-23):** the definition layer, the four shipped agents, the
> composer renderer, the visual proof, the CLI, the live preview surface, and
> the metered share-link **mint** are **wired and tested**. The mint reuses the
> existing Se/rver-token subsystem verbatim (no new crypto, no new meter — §7).
> The project is experimental research into how far a useful assistant can be
> pushed toward *provable* privacy, not a finished product.

---

## 1. What an agent is

An **agent** is a *flavour* of this site's Se/cure + Se/rver pair — and it is
**defined by five things you can see and change**:

1. its **chat-input-pane controls** — which affordances hang off the composer:
   a model picker, a research-depth slider, web-search / incognito toggles,
   attachments, a mode picker;
2. its **intro animation** and its **loading animation**;
3. its **colour theme**;
4. its **example questions** (a seed set, plus on-demand generation);
5. the **default quota** a minted share-link **token** carries (its credits).

That is the whole idea: **an agent IS its chat-input pane** (plus its
animations, theme, examples and quota). Everything else — the pipeline, the
providers, the privacy posture — it inherits from the pair. So **deriving a new
agent is: copy one spec, change those five things, validate.** No code change.

## 2. The four agents we ship

Each is one entry in [`sdk/AGENTS.json`](../sdk/AGENTS.json) — reference specs
that exist to be copied:

| Agent | Tier | What it is |
|---|---|---|
| **Research** | Se/rver | The full signed-in deep-research assistant (renamed from "Server"). The whole pipeline, the full model catalog, cloud storage, quotas. |
| **Secure** | Se/cure | The never-cloud tier — runs wholly in your browser, server in no data path, sealed local state. |
| **Under Construction** | Se/cure | A placeholder — the minimal viable agent (composer + send + an honest notice). The template you copy to start a new one. |
| **Agent Studio** | Se/rver | The mode that *builds* agents (renamed from "SDK mode"): describe a flavour, it distils this site into it and publishes it live. |

The **Agent Studio** is where the platform folds back on itself — it is the
[`pair-studio`](../sdk/skills/pair-studio/SKILL.md) module made real: prompt →
generate in the VM → preview → publish at `/app/<slug>/`.

## 3. The AgentSpec

One agent, as JSON. The full field reference and the closed control vocabulary
live in the [`agent-platform` skill](../sdk/skills/agent-platform/SKILL.md);
the short version:

```jsonc
{
  "id": "research", "name": "Research", "tagline": "…",
  "platform": "server",              // "client" | "server" — the tier
  "mode": "normal",                  // normal | introspection | agent-builder
  "theme": { "--agent-accent": "#3b82f6", … },
  "intro":   { "kind": "fade" },
  "loading": { "kind": "pipeline-phases", "messages": ["Triaging…", …] },
  "controls": [                       // the chat-input pane — ORDER is render order
    { "type": "prompt-input", "placeholder": "Ask…" },
    { "type": "model-select" },
    { "type": "depth-slider", "min": 0, "max": 3, "default": 1, "ticks": ["Quick","Standard","Deep","Exhaustive"] },
    { "type": "toggle", "id": "web_search", "label": "Web search", "default": true },
    { "type": "attachments" },
    { "type": "mode-select", "modes": ["normal","introspection","agent-builder"] }
  ],
  "examples": ["…"], "generateExamples": true,
  "quota": { "window": "day", "requests": 50, "credits": null }
}
```

**The control vocabulary is closed** (`prompt-input`, `send-button`,
`model-select`, `depth-slider`, `toggle`, `mode-select`, `attachments`). Each
type declares its default fields and which **request field it drives** — a
`depth-slider` drives `depth`, a `toggle` drives the flag named by its `id`.
Closing the vocabulary is what lets one renderer draw any agent's composer, and
lets the visual proof (§5) check every declared control actually appears.

The one implementation is the pure core
[`public/js/agent-spec-core.js`](../public/js/agent-spec-core.js) (server
façade [`src/agent-spec.js`](../src/agent-spec.js); the CLI re-exports it) —
`validateAgentSpec`, `resolveControls`, `resolveTheme`, `resolveQuota`,
`resolveExamples`, and the `composerMarkup` renderer. It is I/O-free and
Node-tested ([`agent-spec-core.test.js`](../public/js/agent-spec-core.test.js)).

## 4. Deriving your own agent

1. Copy an entry in `sdk/AGENTS.json` and give it a new `id`.
2. Change the five defining things — controls, animations, theme, examples,
   quota — and set `derivesFrom` to the agent you copied (provenance).
3. Validate: `node sdk/pair-cli.mjs validate` (checks agents too) and
   `npm test`. Inspect it: `node sdk/pair-cli.mjs agent <id>`.
4. Prove it renders: `node scripts/agent-proof.mjs` (§5).

That is the whole loop — a new agent is data, not code. The **Agent Studio**
mode does this same thing from a natural-language prompt, distilling the Se/cure
source into the new flavour and publishing it live.

## 5. Visual proof-driven testing

You declare which controls appear in the chat-input pane; the proof **renders
every agent's composer from its spec and asserts every declared control is
there**. Two forms:

- **The machine gate** — [`scripts/agent-proof.mjs`](../scripts/agent-proof.mjs)
  renders all four composers, prints a pass/fail row per agent, and exits
  non-zero if any declared control is missing. `proveComposer()` is the same
  check, pinned in the test suite so `npm test` fails on a regression.
- **The eyeball artifact** — the same script writes a self-contained HTML
  gallery of the four composers (theme, controls, intro/loading markers, example
  strips) you open in a browser.

Because the proof and the live composer both build from the *same*
`composerMarkup`, what the proof asserts is exactly what a user sees.

## 6. Preview + example questions

The preview surface ([`public/agents/preview.html`](../public/agents/preview.html)
+ [`public/js/agent-preview.js`](../public/js/agent-preview.js)) loads the
registry from the committed source snapshot (the same artifact introspection
and the Agent Studio plan from), renders each agent's composer, and lets you:

- **ask an example question** — each seed example is a chip that opens the real
  agent composer with the question prefilled (a §8-style deep-link);
- **generate more examples** — `exampleGenPrompt()` builds the prompt that asks
  the answer model for fresh questions in the agent's style;
- **see the share-link quota** the agent would mint (§7).

## 7. Sharing an agent as a link (quota + credits)

Creating an agent **as a link** mints a **token** carrying the agent's default
**quota/credits** — bounded, disclosed, revocable, fail-safe. This is wired
**by the book**: it reuses the pair's existing **Se/rver-token** subsystem
verbatim — no new crypto, no new meter.

- `agentTokenGrantParams(agent)` (pure) maps the spec to the subsystem's
  arguments: the upstream `services` in the **closed** permission vocabulary
  (`api` = LLM, `web` = search — [`src/server-token.js`](../src/server-token.js)
  `SERVER_TOKEN_SERVICES`), the per-service `quotas` (the spec's credits, else
  its request count), and the `ttlHours` from the quota window.
- `POST /api/admin/agent-link` ([`src/agent-link.js`](../src/agent-link.js),
  admin-gated like the existing shareable mint) loads the agent from the source
  snapshot and calls `mintServerTokenGrant()` — which signs one standard HS256
  **JWT** ([`mintServerToken`](../src/server-token.js)) and creates one D1
  `server_tokens` meter row per permission. Optional `ttlHours` / `quotas` in
  the body override the spec defaults ("go by default, or choose the credits").
- The response includes the JWT and a shareable `link` (`/cure?st=<token>`) —
  the same mechanism the admin server-token mint uses.

Because it *is* a Se/rver token, it carries **THE SERVER-TOKEN GUARANTEE**
unchanged — **PA-8** (bridge discipline) and **PA-9** (fail-safe metering) in
[`sdk/DESIGN.md`](../sdk/DESIGN.md), full model in
[`docs/SERVER-TOKENS.md`](./SERVER-TOKENS.md):

- the token authorises **upstream API access only** — never the Se/rver tier's
  own data, and never a login;
- every use decrements an **atomic meter row**; no meter backend → no spend;
- the link is **revocable** (delete the meter row) and **time-limited**.

So a shared agent link runs on exactly the credits you defined for it, and not
a request more. This is the one place the platform touches money and quota, and
it fails **safe**, not soft (contrast the pipeline's helper phases, which fail
soft — PA-2).

## 8. Ask the source (introspection deep-links)

Every claim on this page is answerable from the code. These links open the site
in **introspection mode** with the question prefilled — the introspection agent
answers from the project's own source
([mechanism](../public/js/deeplink-core.js): `/?mode=introspection&ask=…`):

- [How is an agent defined in the SDK?](/?mode=introspection&ask=How%20is%20an%20agent%20defined%20by%20its%20chat-input-pane%20controls%2C%20theme%20and%20animations%20in%20agent-spec-core.js%20and%20sdk%2FAGENTS.json%3F)
- [What is the closed control vocabulary and what does each control drive?](/?mode=introspection&ask=What%20is%20the%20closed%20control%20vocabulary%20in%20CONTROL_REGISTRY%20and%20which%20request%20field%20does%20each%20control%20drive%3F)
- [How does the visual proof assert a composer renders every declared control?](/?mode=introspection&ask=How%20does%20proveComposer%20and%20scripts%2Fagent-proof.mjs%20assert%20every%20declared%20control%20renders%3F)
- [How does a shared agent link mint a metered quota token?](/?mode=introspection&ask=How%20does%20a%20shared%20agent%20link%20mint%20a%20metered%20token%20with%20the%20spec%20quota%2C%20per%20the%20server-token%20bridge%20and%20PA-8%2FPA-9%3F)
- [How do the composer deep-links prefill the introspection agent?](/?mode=introspection&ask=How%20does%20parseComposerDeepLink%20in%20deeplink-core.js%20prefill%20the%20composer%20and%20select%20the%20mode%3F)
- [How do I derive a new agent from an existing one?](/?mode=introspection&ask=How%20do%20I%20derive%20a%20new%20agent%20by%20copying%20a%20spec%20in%20sdk%2FAGENTS.json%2C%20and%20how%20is%20it%20validated%3F)

## 9. Where this sits in the documentation

- **Up:** [`docs/DISTILLSDK.md`](./DISTILLSDK.md) — the whole SDK; the agent
  platform is its layer-6 `agent-platform` module.
- **Across:** [`docs/SERVER-TOKENS.md`](./SERVER-TOKENS.md) (the share-link
  token), [`docs/PRIVACY-MODEL.md`](./PRIVACY-MODEL.md) (what a client-tier
  agent must uphold), [`docs/SYMBOL-LANGUAGE.md`](./SYMBOL-LANGUAGE.md) (the
  branding a theme carries).
- **Down:** the [`agent-platform` skill](../sdk/skills/agent-platform/SKILL.md)
  (build plan + acceptance), the pure core
  [`agent-spec-core.js`](../public/js/agent-spec-core.js), and the specs
  themselves in [`sdk/AGENTS.json`](../sdk/AGENTS.json).
- **Code map:** [`docs/CODE-LAYOUT.md`](./CODE-LAYOUT.md) lists every module the
  platform adds.

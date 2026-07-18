---
name: sdk-mode
description: Load when working on SDK MODE — the green "lovable experience" entry in the chat-mode dropdown (Normal / Introspection / SDK / SWE) that designs and BUILDS a self-contained web app with the Agent-Pair SDK and publishes it live at /app/<slug>/ — or on its khaki sibling SWE MODE (prompt a new instance of Se/cure), or when touching public/js/sdk-core.js (buildSdkContextBlock / buildSweContextBlock), src/sdk-tools.js, src/build-pub.js, pipeline.js runSdkBuild + BUILD_FLAVORS, the sdk_mode/swe_mode/build_slug chat fields, the /mcp sdk_* tools, public/js/chat-mode.js, the mode dropdown (#modesel), or the green sdk-mode / khaki swe-mode themes. Also load when a published /app/<slug>/ build misbehaves or the mode dropdown/theming regresses.
---

# SDK mode — the "lovable experience" (2026-07-18)

The third entry in the chat-mode dropdown: the user DESCRIBES an app, the
model DESIGNS + BUILDS it with the Agent-Pair SDK (`sdk/` — manifest +
skills), and the pipeline PUBLISHES the files at a live, shareable
`/app/<slug>/` URL. Green is the mode's color (the composer pane + the
`sdk studio` header tag), as titanium white is introspection's.

## SWE mode — the khaki sibling (2026-07-18)

The FOURTH dropdown entry, `swe` — "prompt a new instance of Se/cure in a
different shape or form". It is SDK mode's build/publish machinery with a
different *flavor*: instead of the Agent-Pair SDK catalog, it seeds the build
with the deployed **Se/cure** source (`public/cure/*`, `public/js/drc-*.js`,
`sdk/skills/secure-tier/SKILL.md`) and instructs the model to build a
client-side, never-cloud research app that upholds Se/cure's privacy
invariants. Khaki is its color (the composer pane echoes Se/cure's `#c3b091`;
the `swe studio` header tag). It shares EVERYTHING structural with SDK mode —
same `/app/<slug>/` publish, same `build_slug` iteration, same
capability gate (`developer_mode`), same tool/deterministic split — so the two
run through ONE `runSdkBuild(ctx, flavor)` keyed by `BUILD_FLAVORS.{sdk,swe}`
(src/pipeline.js). The only per-flavor differences: the system prompts
(`sweBuildPrompt` / `sweBuildToolPrompt` in src/prompts.js), the context block
(`buildSweContextBlock` in sdk-core.js — no manifest; points at the Se/cure
source), the tool set (SWE drops SDK_TOOLS, keeps the snapshot readers +
BUILD_TOOLS so the model reads the real Se/cure source), and the step labels.
Client wiring mirrors SDK exactly: `swe` in `CHAT_MODES`, the `swe-mode` root
class, `payload.swe_mode`, chat.js `sweOn` gating (SDK wins if both flags
arrive) + `sweMode` state + `swe` chat_logs meta. When extending either build
mode, prefer editing the shared runner/flavor over forking a third path.

## The mode dropdown (client)

- `public/js/chat-mode.js` — the pure state module (Node-tested):
  `dr_chat_mode` ∈ normal | introspection | sdk in localStorage, layered OVER
  the server `developer_mode` capability knob (dev-mode.js keeps owning the
  `dr_dev_mode` knob cache). Exactly one root theme class per mode:
  `dev-mode` (titanium) for introspection, `sdk-mode` (green) for sdk.
- First paint: the inline `<script data-devtheme>` in `public/index.html`
  applies the class at PARSE time from the cache. **Editing that script
  requires recomputing THEME_BOOT_HASH in `src/security-headers.js`** (the
  command is in its comment).
- TWO surfaces pick the mode, sharing chat-mode.js state: the composer
  `#modesel` (index.html, wired in app.js) AND the **Settings-panel Chat mode
  dropdown** (`account-views.js` `settingSelectRow` / `wireModeKnob`, which
  REPLACED the old Introspection on/off switch — owner directive 2026-07-18).
  Both pick from Normal / Introspection / SDK / SWE; picking a non-Normal mode
  flips the `developer_mode` knob on via PUT /api/settings (Normal flips it
  off), fail-soft — break-glass has it implicitly and its PUT refuses; theme
  applies anyway. `loadSettings().then` reconciles: knob off elsewhere →
  stored pick downgrades to normal (`reconcileChatMode`). `wireModeKnob`
  syncs `#modesel` and routes through `applyChatModeTheme`, so both dropdowns,
  the theme class, and the caches stay consistent.
- Per-send fields (`stream.js buildChatPayload`): normal →
  `developer_mode:false` (the existing off-only override — a knob-on account
  still gets plain web research); sdk → `sdk_mode:true` (+ `build_slug` when
  the conversation already published); swe → `swe_mode:true` (+ `build_slug`);
  introspection → nothing extra.

## The server flow

- `src/chat.js`: `sdk_mode` is honored only when `developerModeEnabled`
  grants the capability (a client can't acquire a mode the knob doesn't
  grant); `build_slug` is validated (`buildSlugOk`). State carries
  `sdkMode`/`buildSlug`/`userId`; the chat_logs meta records `sdk: 1` and
  `build: {slug,url,files,bytes}`.
- `src/pipeline.js` `runSdkBuild` (routed FIRST in runPipeline — SDK mode
  takes the whole answer phase; no triage, no web search):
  1. **Native tool path** (`runSdkBuildTools` — invariant 1's authorized
     exception, same gate as introspection: Anthropic answer model + key +
     no images). Tools: `INTROSPECTION_TOOLS` (read the deployed snapshot —
     the SDK skills live at `sdk/skills/<id>/SKILL.md`), `SDK_TOOLS`
     (sdk_list_modules/sdk_show_module/sdk_plan/sdk_validate over the
     snapshot's `sdk/MANIFEST.json`), and `BUILD_TOOLS` (`write_file` stages
     into a Map; `publish_app` publishes). `MAX_SDK_TOOL_ROUNDS = 12`.
     If files were staged but publish_app never ran, the pipeline
     auto-publishes (the live-URL promise must not hinge on the model's
     last call), and appends a "Try it live" link if the reply lacks it.
  2. **Deterministic fallback** (`runSdkBuildDeterministic`, any catalog
     model, also the tool path's fail-soft catch): one streamed completion
     (`sdkBuildPrompt`) emitting the `FILE: path` + fenced-block convention;
     `parseFileBlocks` collects, `publishBuild` publishes, the URL is
     emitted as an extra chunk. The SDK context block
     (`buildSdkContextBlock`) teaches the convention and carries the module
     catalog; it is appended to the conversation the way the introspection
     block is.
- The `build` SSE event `{type:"build", slug, url, files, title}` tells the
  client the slug; stream.js remembers it per conversation (persisted in the
  history record as `buildSlug`) and sends it back so iterations keep the
  URL. Forward-compatible — old clients ignore it (sse-protocol skill).

## Publishing — src/build-pub.js

- R2 keys `build/<slug>/meta` + `build/<slug>/f/<path>` in the same STORAGE
  bucket as pub.js. `publishBuild` re-validates every file (defense in
  depth), requires `index.html`, enforces the caps
  (`MAX_BUILD_FILES`/`MAX_BUILD_FILE_BYTES`/`MAX_BUILD_TOTAL_BYTES` in
  sdk-core.js), prunes files dropped since the last publish, and enforces
  slug OWNERSHIP (meta.owner = userId) — a foreign `build_slug` silently
  mints a fresh slug instead of overwriting someone else's app.
- Serving: `GET /app/<slug>/<path>` is PUBLIC (routed pre-auth in index.js —
  NOT `/build/`, which is the About page). **Every response carries
  `Content-Security-Policy: sandbox allow-scripts …` — the published page
  runs in an OPAQUE ORIGIN**: no cookies, no localStorage, no credentialed
  same-origin fetch, so generated (or malicious) HTML cannot act as the
  signed-in visitor even on the site's own hostname. `allow-same-origin` is
  DELIBERATELY absent — do not add it. Generated apps must therefore be
  self-contained and use in-memory state only (the prompts say so).
- Unpublish: admin-only `DELETE /api/build/<slug>`.

## The shared pure core — public/js/sdk-core.js

One implementation (the bash-core/introspect-core pattern) behind FOUR
consumers: the `sdk/pair-cli.mjs` CLI (re-exports it — its historical import
surface is pinned by `sdk/pair-cli.test.mjs`), the Worker (`src/sdk-tools.js`
façade), the pipeline, and the `/mcp` sdk_* tools. The manifest is read from
the COMMITTED source snapshot (`manifestFromSnapshot`) — by construction the
deployed manifest, no drift window. Do not re-implement a helper in a
consumer; extend the core. Unit suite: `public/js/sdk-core.test.js`.

## MCP + sandbox access ("limit what has to go through bash")

- `POST /mcp` `tools/list` now returns `deep_research` + the four `sdk_*`
  tools (`SDK_MCP_TOOLS` in src/mcp.js — MCP wants `inputSchema`, the shared
  defs carry Anthropic's `input_schema`; the mapping is at the export).
  External agents plan against the SDK directly instead of booting the
  in-browser VM to run pair-cli.
- The sandbox path still exists: in dev/SDK mode the source mounts at /src,
  so `node /src/sdk/pair-cli.mjs …` works in-guest when the image ships
  node (bashAgentPrompt teaches this, with a cat/grep fallback).

## Verification

- Unit: `sdk-core.test.js`, `build-pub.test.js`, `chat-mode.test.js`,
  `mcp.test.js` (5 tools), plus the pair-cli suite.
- STILL OWED (live-verify discipline): a real SDK-mode round trip on the
  deployed site — pick SDK in the dropdown (green pane + `sdk studio` tag),
  "build me a todo app", confirm the build steps stream, the reply carries
  `/app/<slug>/`, the URL renders the app (and check the response CSP header
  is the sandbox one), then an iteration message republishes the SAME slug.
  Also the deterministic path on a non-Anthropic model (FILE blocks →
  published), and `/mcp` tools/call `sdk_plan` end to end.

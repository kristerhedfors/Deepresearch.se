---
name: sdk-mode
description: Load when working on SDK MODE — the green "lovable experience" entry in the chat-mode dropdown (Normal / Introspection / SDK) that DISTILLS this site (above all the client-side Se/cure tier) into a new self-contained-web-app FLAVOUR with DistillSDK and publishes it live at /app/<slug>/ — or when touching public/js/sdk-core.js (buildSdkContextBlock / SECURE_SOURCE_REFS), src/sdk-tools.js, src/build-pub.js, pipeline.js runSdkBuild, the sdk_mode/build_slug chat fields, the /mcp sdk_* tools, public/js/chat-mode.js, the mode dropdown (#modesel), or the green sdk-mode theme. Also load when a published /app/<slug>/ build misbehaves or the mode dropdown/theming regresses.
---

# SDK mode — the "lovable distiller" (2026-07-18; SWE folded in 2026-07-19)

The third entry in the chat-mode dropdown: the user DESCRIBES a FLAVOUR to
distill from this site — above all the client-side **Se/cure** tier — the model
DESIGNS + BUILDS it with DistillSDK (`sdk/` — manifest + skills) plus the
deployed Se/cure source, and the pipeline PUBLISHES the files at a live,
shareable `/app/<slug>/` URL. Green is the mode's color (the composer pane + the
`sdk studio` header tag), as titanium white is introspection's.

> **Named "Agent Builder" in the UI (2026-07-23).** The dropdown option, the
> account-settings label, and the plant greeter now read **Agent Builder** —
> distilling this site into a new agent is the mode's purpose. The **mode id
> stays `sdk`** and every internal name here (SDK mode, DistillSDK, `sdk_*`
> tools, `sdk-mode` theme class) is unchanged. The agents this mode builds are
> defined declaratively by the **agent-platform** SDK module (`sdk/AGENTS.json`,
> `docs/AGENT-PLATFORM.md`) — an agent IS its chat-input-pane controls, theme,
> animations, examples and share-link quota.

## The plant identity + the mode-theme registry (2026-07-19)

SDK mode is not just a green pane — it has its own **symbol** in the site's
symbol language (`docs/SYMBOL-LANGUAGE.md` §7). SDK mode GROWS a new flavour, so
its symbol is a **plant**:

- **The waiting symbol** — `public/js/plant-spinner.js` (`mountPlantSpinner`),
  the sibling of the balloon (`balloon-spinner.js`) and umbrella
  (`umbrella-spinner.js`) spinners: a seed **hits the ground, gets planted**,
  boomerangs a settled sprout while working, and only the completion finale
  **grows it out** into a **GREEN ✓** (`--check-green`). It reuses the umbrella
  spinner's boomerang/finale clocks and exports a shared `drawPlantFigure`
  renderer. Which spinner a loading slot mounts is decided by
  `public/js/mode-spinner.js` off the current mode (`turns.js` / `activity.js`
  now call `mountModeSpinner`, not `mountBalloonSpinner`).
- **The character** — `public/js/sdk-plant.js` (`showSdkPlantGreeter`), SPROUT:
  the ghost/balloon/TIN counterpart, a one-shot greeter shown the first time a
  user enters SDK mode (dynamically imported in `app.js`, once per browser),
  drawn with the SAME `drawPlantFigure` so the character and the waiting symbol
  are one plant.
- **The registry** — `public/js/mode-theme.js` codifies each mode's
  distinguishing axes (root class, accent, ✓ color, `spinner`, `character`,
  `panel`) as one descriptor per mode. This is the SCHEMA "the goal of SDK mode
  itself — creating new themes of this kind" fills: a distilled flavour can
  define its own mode-theme descriptor (color theme + spinner + character +
  side-panel flavour), and the same wiring lights it up. The history drawer is
  flavoured per mode via `[data-mode]` on `#historysidebar` (`history-ui.js`).

Unit suites: `plant-spinner.test.js`, `mode-theme.test.js`, `sdk-plant.test.js`.
Verification still owed (live-verify): pick SDK in the dropdown and confirm the
plant spinner grows into a green ✓ on a step, and SPROUT greets on first entry.

## Distilling Se/cure into flavours (the merged SWE capability)

SDK mode's core purpose is to distill the original site into different
flavours. The DistillSDK catalog is the METHOD (it describes this site's
Se/cure + Se/rver pair as buildable modules with skill playbooks), and the
deployed **Se/cure** source (`public/cure/*`, `public/js/drc-*.js`,
`sdk/skills/secure-tier/SKILL.md` — the list is `SECURE_SOURCE_REFS` in
sdk-core.js) is the ORIGINAL the model studies and reshapes. Most builds are a
reshaped Se/cure: a minimal single-purpose research client, a themed/domain
variant, a stripped-down single-file build, a different UI. When a flavour keeps
Se/cure's client-side, browser-direct nature the model must UPHOLD its privacy
invariants (no server in the data path; provider calls browser→provider on the
user's own key; secrets never leave the device or hit a log; third-party
requests carry the minimum) — `buildSdkContextBlock` and the `sdkBuild*` prompts
spell this out, and the model states the built flavour's privacy posture in the
reply. (History: a separate khaki **SWE mode** — "build a new instance of
Se/cure" — shipped 2026-07-18 as a fourth dropdown entry and was folded into SDK
mode on 2026-07-19 as redundant; the merge kept its Se/cure-distillation framing
and privacy invariants inside SDK mode, and removed the `swe` mode, `swe-mode`
theme, `swe_mode` field, `buildSweContextBlock`, `sweBuild*` prompts, and the
`BUILD_FLAVORS` indirection — there is now ONE `runSdkBuild(ctx)`.) The tool
set is the snapshot readers (read the real Se/cure source) + `SDK_TOOLS`
(plan against the manifest) + `BUILD_TOOLS`. When extending the build mode,
edit the single `runSdkBuild`/`sdkBuild*`/`buildSdkContextBlock` path.

**Source is GATHERED deterministically, not left to the model to discover
(2026-07-19).** `runSdkBuild` calls `buildSecureSourceDigest(snapshot)`
(sdk-core.js) and passes the result into `buildSdkContextBlock({ secureDigest })`
on BOTH paths, so a bounded (~30 KB / `SECURE_DIGEST_BUDGET`) digest of the
ACTUAL `SECURE_SOURCE_REFS` files rides the conversation. Each ref is reduced to
a `sourceSkeleton` (JS top-level declarations + section headers, CSS selectors +
`:root` custom properties, HTML landmark/`id=` tags; Markdown → head excerpt),
fairly shared across files so a big early file (drc.js) can't starve the small
trailing ones (drc-store.js). This exists because before it, the model only ever
saw a *list of paths* — the deterministic fallback has no read tools, so it
distilled from nothing, and the tool path could burn its rounds/time re-reading
before reaching any real source (a live `claude-sonnet-5` run read only two
`SKILL.md` files, then the stream dropped mid-build → the ugly FILE-block
fallback). The digest is the floor; the tool path still `read_file`s a listed
path for detail the skeleton omits. Verify a change to it against the real
snapshot, not just the fixture — `buildSecureSourceDigest(realSnapshot)` must
show live signatures/`:root` vars.

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
  Both pick from Normal / Introspection / SDK; picking a non-Normal mode
  flips the `developer_mode` knob on via PUT /api/settings (Normal flips it
  off), fail-soft — break-glass has it implicitly and its PUT refuses; theme
  applies anyway. `loadSettings().then` reconciles: knob off elsewhere →
  stored pick downgrades to normal (`reconcileChatMode`). `wireModeKnob`
  syncs `#modesel` and routes through `applyChatModeTheme`, so both dropdowns,
  the theme class, and the caches stay consistent.
- Per-send fields (`stream.js buildChatPayload`): normal →
  `developer_mode:false` (the existing off-only override — a knob-on account
  still gets plain web research); sdk → `sdk_mode:true` (+ `build_slug` when
  the conversation already published); introspection → nothing extra.

## The showcase gallery (client — the SDK build-idea library)

`public/js/sdk-showcase.js` is a curated, grouped catalog of **single-shot
chatbot build briefs** — each a ready-to-send SDK prompt sized for the
reference model **Claude Sonnet 5** (`SHOWCASE_REF`, kept in sync with the
Anthropic catalog id). It renders into the LEFT library pane (the history
drawer, `#sdkshowcase` in index.html) **only when the chat mode is SDK**:
`history-ui.js` calls `renderShowcase()` in its `refresh()`, gated on
`cachedChatMode() === "sdk"`, so the same drawer is history in Normal/
Introspection and a build-idea library in SDK mode (green cards, matching the
composer pane + `sdk studio` tag). Picking a card calls app.js's
`onShowcasePick`, which prefills the composer with the brief (switching to SDK
mode defensively) and closes the drawer — the user still presses send, so it
stays a real *single shot*. The module is pure/Node-tested
(`sdk-showcase.test.js`) except the one guarded DOM export
`renderShowcaseGallery`. To ADD a showcase, append an item (stable slug id,
one-line blurb, a 1–2 sentence build brief ending on the client-side reminder)
to the right group in `SDK_SHOWCASE` — don't renumber existing ids.

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

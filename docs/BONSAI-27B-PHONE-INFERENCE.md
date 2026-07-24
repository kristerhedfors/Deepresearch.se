# Bonsai 27B — phone-local inference for DeepResearch.**Se/cure** (integration plan)

Status: **PR 2 IMPLEMENTED** (2026-07-16; §11's slicing — the engine, knob,
consent popup, OPFS download manager, provider seam, and timeout overrides
are live behind the Se/cure settings knob). **Se/rver integration ADDED**
(2026-07-24, owner request — §12: the same engine surfaced in the signed-in
app). One reality-driven refinement vs
§6: the catalog is data-driven (`public/js/ondevice-core.js`) because the
27B's ONNX browser conversion is not yet published — Bonsai 8B (1.11 GiB
q1f16) and 1.7B (278 MB q1) work today, and the pre-wired 27B entry lights
up the day `onnx-community/Bonsai-27B-ONNX` ships; the consent popup
therefore opens per-model from its Download button (exact live-computed
size in the button label, UX-4) rather than from the switch itself, which
only reveals the section. It realizes milestone **M4** of
`docs/FOREVERAGENT-TRAJECTORY.md` (in-browser inference) and closes gaps
**R11/R12** of `docs/FOREVERAGENT-GAP-ANALYSIS.md`, with a concrete model that
finally makes M4 worth shipping: a 27B-class model that fits on a phone.

## 1. What shipped upstream (2026-07-14) and why it matters here

**PrismML Bonsai 27B** — 1-bit and ternary quantizations of Qwen3.6-27B,
Apache 2.0, released 2026-07-14:

| Variant | Size on disk | Quality vs FP16 | Notes |
|---|---|---|---|
| 1-bit (binary, {-1,+1}, FP16 scale per 128 weights ⇒ 1.125 bit/param) | **3.9 GB** (GGUF Q1_0: 3.53 GiB) | ~89.5% | the phone target |
| Ternary | 5.9 GB (GGUF Q2_0: 6.66 GiB) | ~94.6% | laptop/desktop target |

- 262K-token context upstream (browser-realistic: 8–32K), multimodal (vision
  needs an extra ~0.9 GiB `mmproj` — **deferred**, see §9), built-in
  Qwen-style reasoning with token budgets.
- **Browser inference is real, today**: the WebML community ships custom
  1-bit WGSL matmul kernels (XOR + popcount, fused dequant, 4-bit KV cache)
  for Transformers.js/WebGPU — live demo Spaces (`webml-community/bonsai-webgpu`).
  Reported ~8–30 tok/s in-browser depending on GPU; ~11 tok/s native on an
  iPhone 17 Pro. RAM guidance: 6 GB minimum, 8 GB recommended incl. KV cache.
- Platform reality: **Android Chrome works**; **iOS Safari is experimental**
  (WebGPU present since iOS 18 but limits are tight). Desktop
  Chrome/Edge 113+ and recent Safari work.

Why it belongs in this project: it is the logical endpoint of the privacy
mission. The `local` provider (2026-07-15) already removed the third party
when the user runs Ollama on their own machine; Bonsai-in-the-browser removes
the *other machine*. A phone user gets deep research where **no request ever
leaves the device**. That is stronger than every existing tier, and it
demonstrably answers the project's research question ("how far can a real
research assistant be pushed toward provable privacy").

## 2. Placement: a Se/cure (DRC) feature, zero new server surface

Everything runs in `public/` on the `/cure` tier. The Worker's only changes
are `src/assets.js` public-allowlist entries for the new modules/vendor files
(the module-graph 401 rule — `assets.test.js` enforces it). No new API, no
new invariant-4 exception: the server is not in the data path, not even for
the weights (they come from Hugging Face's CDN, or optionally a self-hosted
mirror later).

`/cure` is already served **cross-origin-isolated unconditionally**
(`src/index.js` gives the DRC page `{coep:true}`; COOP is site-wide
`same-origin`), so `SharedArrayBuffer`/threads are available with no extra
work. The CheerpX sandbox already banks on this. One consequence: with
COEP `require-corp`, weight downloads must be plain `fetch(…, {mode:"cors"})`
— huggingface.co serves permissive CORS, so this works; it just rules out
no-cors tricks.

## 3. Runtime choice: Transformers.js + the WebML 1-bit kernels, vendored

**Recommendation: `@huggingface/transformers` (Transformers.js) with the
WebGPU backend**, the runtime the official Bonsai browser demos use and the
one that ships the community 1-bit WGSL kernels. WebLLM is the fallback
candidate if the kernel story moves there; the seam below is
runtime-agnostic so swapping stays cheap.

Per **invariant 7** (trajectory §2): the runtime is **vendored** under
`public/vendor/transformers/` with SHA-256 pins recorded in a code comment —
the `public/vendor/xterm/` block in `sandbox.js` is the worked template.
That includes the ONNX-Runtime-Web `.wasm`/`.mjs` payloads it loads at init
(they must not be runtime CDN fetches, both for supply-chain honesty and
because COEP would bite). CheerpX's stays-on-CDN exception is a license
question specific to Leaning Tech; it does not extend here.

The engine runs in a **Web Worker** (gap-analysis guidance): prompt
processing at phone speeds would otherwise freeze the UI for minutes.
Main-thread fallback only if a target browser lacks worker WebGPU.

## 4. The seam: an `engine` provider, adapt-at-the-wire

New module `public/js/bonsai-engine.js` (+ its worker) exposing three
callables mirroring what the pipeline already consumes:

- `engineChatStream(model, messages, opts)` → an SSE-shaped
  `Response` built from a `ReadableStream` that re-emits engine tokens as
  OpenAI-style `data: {"choices":[{"delta":…}]}` lines. This is the
  **anthropic.js pattern** — adapt at the wire so `readStream`, the stall
  guard, and every downstream consumer work unchanged.
- `engineCompleteJson(model, messages, opts)` → non-streaming completion with
  the existing lenient JSON extraction.
- `engineAvailable()` / `engineModelState()` → capability + cache state
  (§6, §7).

Registration follows the **`proxyLlmProvider` template** (built on demand,
not in `DRC_PROVIDERS`): a `bonsaiLocalProvider()` object whose wire fns call
the engine instead of `fetch`, surfaced by `refreshModels()` as an unshifted
group ("📱 On-device — this phone") gated on the knob + capability probe, and
passed at send time via the existing `providerOverride` branch.
`runDrcResearch` stays provider-agnostic. Concretely `drcChatStream`/
`drcCompleteJson` grow one branch: `if (provider.engine) return provider.engine.…` —
everything else is untouched.

Split-model routing collapses exactly like the `local` provider:
`jsonModel: null` ⇒ planning phases run on Bonsai itself. Qwen3.6's
instruction-following plus the existing lenient extraction and fail-soft
normalizers (`normalizeTriage` etc.) are the safety net. Bonsai's Qwen-style
`<think>…</think>` reasoning output must be stripped before JSON extraction
and before the visible answer (v1: strip; later: surface as activity).

## 5. The switch (default OFF — the bandwidth guarantee)

Sealed-state field `state.onDeviceModel` (`drc-core.js`): bump
`DRC_STATE_V` → 5, additive `migrateDrcState` default `false`, lenient
`validateDrcState`. **The frozen HKDF info strings do not change.**

Settings drawer (`public/cure/index.html` + `drc.js`): a `.settings-item`
toggle following the `#bashlite` pattern — "On-device model (Bonsai 27B)" with
sub-text "Runs research entirely on this device. One-time ~3.9 GB download."
Reflect on open, `change` listener persists via `saveState()`.

Nothing downloads, probes, or even imports the engine module while the knob
is off. The vendor payload is behind a dynamic `import()` exactly like
CheerpX in `sandbox.js`, so visitors who never opt in pay zero bytes for the
feature. That is the point of the switch.

## 6. The consent popup (the ~4 GB notice)

Flipping the toggle ON does **not** start the download. It opens a
dedicated confirm modal (`#bonsaipop`, a sibling of `#drspop` but with
explicit buttons, since UX-1 dismissal alone must not be interpretable as
consent):

- States plainly: **"This downloads the model once (~3.9 GB) and stores it
  on this device."** Plus: current free storage from
  `navigator.storage.estimate()`, a Wi-Fi recommendation (and, where
  `navigator.connection` exists, an explicit cellular warning), and the
  device-support verdict from the capability probe (§7).
- Buttons: **"Download 3.9 GB"** and **"Not now"**. Cancel/outside-tap
  reverts the toggle. Only the explicit button starts the fetch.
- While downloading: a progress row in Settings (percent + bytes, driven by
  the download manager's progress events), resumable, with cancel.
- Once cached: the row becomes "Bonsai 27B · 3.9 GB on this device ·
  **Delete**" — deletion is one tap and frees the storage (the reversal
  belongs next to the consent).
- Register the new interaction as a numbered entry in the **ux-conventions**
  skill.

## 7. Weights: download manager + storage

New module `public/js/model-cache.js` (pure planning core Node-tested):

- **OPFS** directory `models/bonsai-27b-1bit/` — real file handles and
  streaming writes fit a 3.9 GB artifact; no structured-clone copies.
  Deliberately does **not** import `public/js/opfs.js` (that module statically
  drags DRS-only imports — history-store/rag/settings — into whatever graph
  imports it; a fresh, tiny OPFS helper keeps the /cure module graph clean).
- Resumable HTTP **range requests** against the pinned Hugging Face repo
  revision, per-file **SHA-256 verification** before a file is marked good,
  `navigator.storage.estimate()` preflight, `persist()` request to reduce
  eviction risk.
- Transformers.js is pointed at this cache (custom cache / `env` hooks)
  instead of its default Cache-API cache, so there is exactly **one**
  disclosed storage location, one delete button, and no silent second copy.
- Weights are public model files (not user data), so plaintext at rest is
  correct (no conflict with invariant 4; nothing about the user is in them).

## 8. Capability gating + the slow-model contract

**Probe** (pure, testable): `navigator.gpu` → `requestAdapter()` → check
`maxBufferSize`/`maxStorageBufferBindingSize` against kernel needs, plus a
`navigator.deviceMemory` heuristic (<6 GB ⇒ warn/deny). Verdicts: `ok` /
`marginal` (allowed, warned) / `unsupported` (toggle shows "this device can't
run it" instead of failing silently — on-device-trace lesson: self-explaining
states).

**Timeout adjustments** — the exploration pass identified the exact breakage
points for a ~5–15 tok/s model, all fixed by per-provider overrides rather
than global changes:

| Guard | Today | Change |
|---|---|---|
| `drcCompleteJson` | hard `AbortSignal.timeout(45_000)` | `provider.jsonTimeoutMs` override (engine: 300 s) — **the most likely breakage**, every planning phase uses it |
| `readStream` idle | `STREAM_IDLE_MS = 90_000` between chunks | `provider.streamIdleMs` (engine: 240 s) — phone prompt-processing can exceed 90 s before the first token; better: the engine emits a keepalive status line while prefilling |
| Harvest fan-out | `Promise.all` parallel sub-questions | `provider.serialize: true` ⇒ run harvest sequentially (one GPU; parallel decode is net slower) and let the existing budget logic shrink the sub-question count |
| Embeddings | OpenAI-only `embed` | unchanged in v1 (no on-device RAG embeddings yet — §9) |

All phases keep the fail-soft contract: a tripped engine phase degrades the
research, never errors the chat.

## 9. Deferred (explicitly out of v1)

- **Vision** (the ~0.9 GiB `mmproj`): separate opt-in download later.
- **On-device embeddings** (gap R12): a ~30 MB Transformers.js embedding
  model would give the fully-local tier RAG too — natural phase 2, same
  consent pattern (sizes disclosed, opt-in).
- **Ternary variant** (5.9 GB, +5pp quality): a laptop-class choice in the
  same dropdown group later; one model keeps v1 simple.
- **Self-hosted weight mirror** (R2): only if HF CDN reliability/CORS becomes
  a problem; costs bandwidth and adds a server touchpoint that v1 avoids.

## 10. Testing & rollout ladder

1. **Unit (Node)**: state migration v4→v5; the SSE-synthesis adapter through
   the real `readStream`; download-manager planning (range math, resume,
   hash-mismatch handling); capability-verdict logic; `<think>`-stripping;
   provider-override routing — all pure cores, mock engine.
2. **`npm test` + typecheck green**, incl. regenerated introspection/docs
   artifacts (`npm run bundle`, `bundle:docs`, …) and the `assets.test.js`
   module-graph allowlist.
3. **Live-verify** (the real bug source): desktop Chrome first (fast GPU,
   same code path), then Android Chrome mid-range, then iOS Safari 18+
   (expect `marginal`/`unsupported` verdicts to exercise the messaging).
4. **Owner device pass** via a `docs/test-requests/<branch>.json` file
   (request-testing skill): toggle → popup wording → download+resume →
   a full research run on-device → delete-model → re-download.
5. **Bench**: one rubric-bench battery with Bonsai as the answer model
   (desktop WebGPU) appended to `tests/EVAL-BENCH-FINDINGS.md`, so the
   ~89.5%-of-FP16 claim gets a local number before anyone relies on it.

## 11. Suggested PR slicing

1. **PR 1 — plan** (this document).
2. **PR 2 — engine + knob + consent**: vendored runtime, `bonsai-engine.js`
   worker, `model-cache.js`, provider seam + dropdown group, sealed-state v5,
   settings toggle, `#bonsaipop`, allowlist entries, unit tests. Desktop
   Chrome verified live.
3. **PR 3 — phone hardening**: per-provider timeout overrides, harvest
   serialization, prefill keepalive, capability verdict UX, Android/iOS
   verification, test-request file.
4. **PR 4+ (optional)**: embeddings, vision, ternary.

## 12. Se/rver integration (2026-07-24, owner request)

The owner asked for the on-device models in Se/rver too, not just Se/cure.
The §2 placement ("a Se/cure feature, zero new server surface") is
superseded for SCOPE but kept for MECHANISM: the Se/rver integration adds no
new API and no new invariant-4 exception (the engine modules and the vendored
runtime were already public for the /cure graph, and the worker-script COEP
serving is path-based, not tier-based). It does need ONE server-side follow-up
(2026-07-24, see below): the DRS app *shell* must become cross-origin isolated
for on-device devices, which `/cure` already is unconditionally but `/rver`
was not.

**The cross-origin-isolation fix (the shell, not the worker scripts).** The
first Se/rver cut shipped the dropdown group, downloads, and the local answer
route but MISSED that the DRS *page* wasn't isolated: `/cure` is served
`{coep:true}` always, but `/rver` gets COEP only when the bash_lite SERVER
setting is on (`src/index.js`). A user who enabled on-device but not the
sandbox therefore got a NON-isolated shell — `SharedArrayBuffer` absent, so
the ONNX runtime's nested pthread workers can't start and inference silently
fails; and on WebKit (which checks COEP across the whole worker graph) the
engine wouldn't even list cached models, so downloaded weights never surfaced
in the composer dropdown ("downloads but doesn't show up in the dropdown").
The knob is per-device localStorage, so it can't ride the bash_lite setting;
instead `setOnDeviceEnabled` mirrors it into a `dr_ondevice` cookie, and
`src/assets.js onDeviceIsolationWanted(request)` (the ONE new `assets.js`
export) ORs it into the shell's COEP decision so `/rver` is served isolated
for on-device devices too. Enabling the knob reloads into the isolated shell
(the `isolateForSandbox` self-heal, mirroring `wireSandboxKnob`), and the
first-paint / bfcache self-heals in `app.js` now fire for `onDeviceEnabled()`
as well. Same accepted trade as the sandbox: the only casualty of
`require-corp` is the keyless Street View embed IFRAME.

What ships, per file:

- `public/js/ondevice-drs.js` — the DRS glue: the browser-local
  `dr_ondevice` knob (deliberately localStorage, NOT `/api/settings` — the
  weights live in ONE device's OPFS, so an account-wide flag would light up
  dropdown groups on devices holding no weights), the gear-panel Settings
  section (per-model rows with the §6 consent inline in the row — the panel
  has no modal layer — exact live size in the Download button, "Not now" and
  navigation are a NO, cancel/resume, delete, capability verdicts), and the
  cached-model listing for the dropdown.
- `public/js/models.js` — a "📱 On-device — runs in this browser" optgroup
  listing ONLY downloaded models (a dropdown pick must never start a
  multi-GB download); values are `ondevice::<id>` via the shared
  ondevice-core.js helpers, so the two tiers cannot drift on the format.
  Server models group under "☁ Server models" only while the on-device
  group is present. With the catalog unreachable but weights cached, the
  dropdown now still renders — the offline case the tier exists for. Never
  auto-picked: without a stored selection the server default applies.
- `public/js/stream.js` — `runOnDeviceExchange`: an `ondevice::` pick runs
  the WHOLE exchange through the client-side pipeline (`runDrcResearch` +
  `onDeviceProvider()`, the maybePrivateIntrospection pattern) and never
  falls through to `/api/chat` — a silent cloud fallback would betray what
  the dropdown group promised. Checked before every other route. Attachment
  text and the dev-mode introspection block ride along; the sandbox loop
  works when the bash knob is on (which loads CheerpX — the DRS page is
  COEP-isolated whenever either the bash OR the on-device knob is on).
  Live web search, RAG retrieval, and the server enrichments are OFF
  for these sends — each is a server call; the Settings popover says so.
- Privacy note (`docs/PRIVACY-MODEL.md`): an on-device Se/rver send reaches
  no provider and writes no `chat_logs` row (there is no server request),
  while the conversation itself still persists under the tier's implicit
  encrypted cloud storage. The answering path is local; the storage rule is
  unchanged.

## Sources

- https://prismml.com/news/prismml-releases-bonsai-27b
- https://docs.prismml.com/models/bonsai-27b
- https://huggingface.co/collections/prism-ml/bonsai-27b
- https://huggingface.co/spaces/webml-community/bonsai-webgpu
- https://www.marktechpost.com/2026/07/14/prismml-releases-bonsai-27b-1-bit-and-ternary-builds-of-qwen3-6-27b-that-run-on-laptops-and-phones/
- https://essamamdani.com/blog/prismml-bonsai-27b-1-bit-27b-model-runs-phone-webgpu-july-2026

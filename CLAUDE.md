# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare. The site is a *deep research*
assistant, matching its name: `/api/chat` runs a Worker-orchestrated pipeline
(triage → search → gap check → synthesis → validation) with **no function
calling** — every phase is a direct JSON-mode or streamed call, so it is
deterministic and works on any model in the catalog. The primary LLM provider
is **Berget.ai** (OpenAI-compatible); **Anthropic (Claude)** and **OpenAI
(GPT)** are secondary, key-gated providers for answer/synthesis models
(claude-* opus/sonnet/haiku — `src/anthropic.js`; bare gpt-* —
`src/openai.js`; both dispatched via the `src/providers.js` registry; the
JSON planning phases always stay on Berget). Web search is **Exa**.

**Mission (2026-07-13):** the project is framed as **innovation and
research on the privacy capabilities of LLM applications** — how far a
real, useful research assistant can be pushed toward *provable* privacy,
and where that trades against capability. The **proof is the site itself**:
a fully open-sourced, independently verifiable **Se/cure + Se/rver pair**.
It is still experimental and nowhere near production-ready (say so; do not
frame it as a finished product). The "built over a weekend, phone-only"
origin is kept in FULL only on `/story/`, with brief non-leading pointers on
`/build/`, the landing, and the README — it is the origin, not the identity,
so don't lead with it elsewhere.

**Branding rule (2026-07-10, amended 2026-07-12 and 2026-07-13):** the two
product tiers are ALWAYS written as their full URL without the scheme, in
**CamelCase** (2026-07-12 directive), with the wordplay tail in bold:
DeepResearch.**Se/cure** (the client-side tier) and
DeepResearch.**Se/rver** (the signed-in tier) — in UI text, headers,
docs, and prompts alike (plain text drops the bold, never the full-URL
form). **Whenever the two are named together — a sentence, a list, table
columns, paired diagrams — ALWAYS put Se/cure FIRST, then Se/rver
(secure-first, 2026-07-13 directive).** A single tier named in its own
context (the app's own header, a /cure page pointing at /rver) is exempt;
the rule governs the PAIR's order. The capital tail-S makes the wordplay read as the word it hides:
**Se/cure** → "Secure", **Se/rver** → "Server". No space inside the URL.
Where running copy needs a SHORT name, use the slashed tail alone —
**Se/cure** and **Se/rver** — the included slash is the distinguishing
marker. In the rendered UI the slash is pulled in with a `.sl` span
(`margin: 0 -.12em`) so it reads even tighter — but that constant is
correct only for regular-weight text: the right tightening is
FONT-DEPENDENT (bold ink is wider — at `-.12em` the slash touches the
letters), so any new/changed `.sl` context gets its margin MEASURED, not
eyeballed, with `scripts/slash-gap.mjs` per the **slash-spacing** skill
(scoped override next to the surface's `.sl` rule; e.g. `b .sl
{ margin: 0 -.04em }` on the help page). The CamelCase is a DISPLAY
convention only: functional URLs, `href`s, `fetch`/route paths, publish
slugs, and host strings stay lowercase (`/cure`, `/rver`,
`deepresearch.se`) — the host is case-insensitive, the paths are not.
The acronyms DRC/DRS are INTERNAL names (code identifiers, CLAUDE.md,
skills, commit messages) and must not appear in user-facing copy
(2026-07-12 directive: having a third name pair confuses readers).

## Git workflow

**Always sync with the latest `origin/main` BEFORE implementing anything.**
New sessions are routinely off-sync (fresh containers, branches cut from a
stale base). A SessionStart hook (`.claude/hooks/sync-main.sh`, registered in
`.claude/settings.json`) fetches and fast-forwards automatically — read its
output at session start; if it printed a WARNING, rebase onto `origin/main`
before touching code. Re-fetch before every push. Details in the
**sync-main** skill.

**BOTH merge styles are supported (2026-07-13).** A change may land EITHER by a
pull request merged into `main`, OR by a direct branch merge / push to `main`.
Pick whichever fits — PRs when the change wants review, a direct branch merge
for routine work. Always cut work on a feature branch off the latest
`origin/main` first; a merged branch is DONE (do not keep building on it —
branch fresh from the updated `main`). See the **merge-branches** skill.

**ALWAYS watch a PR you open (owner directive, 2026-07-14).** The moment you
create a pull request, subscribe this session to it with
`subscribe_pr_activity` — do NOT wait to be asked, and do NOT merely offer.
Then follow it through per the harness's PR-activity rules: investigate every
CI failure / review comment, push a fix when you're confident and it's small,
ask via `AskUserQuestion` when it's ambiguous or architecturally significant,
and skip only genuine no-ops. Webhooks don't deliver CI *success*, new pushes,
or merge-conflict transitions, so also schedule a `send_later` self check-in
~1 h out to re-check state and re-arm silently if nothing changed. A
subscription is not finished until the PR is **merged or closed** (or the owner
says stop) — keep watching until then.

```bash
git fetch origin main
git checkout -B <feature-branch> origin/main
git add -A && git commit -m "…"
git push -u origin <feature-branch>
# then EITHER open a PR targeting main, OR merge the branch into main directly
```

> ### MERGE BARRIER — check on EVERY prompt, before any change
>
> A one-time **mass-reconciliation merge** flag lives in
> **`docs/MERGE-STATUS.json`** (`active: true/false`). It is the signal to
> ALL clients that the many pre-existing branches have been merged into `main`
> and are now stale. **Before making any change (every prompt), check it** —
> the `merge-barrier` hook does this automatically and prints a notice, but the
> rule stands regardless:
>
> **If the barrier is `active` AND your current branch does not contain the
> recorded `main_sha` (i.e. you're not following the reconciled `main`), then:
> sync to `main` and CREATE A NEW BRANCH before doing any work — do not
> continue on your old (now-merged) branch.**
>
> ```bash
> git fetch origin main
> git checkout -B <fresh-branch> origin/main   # start clean off reconciled main
> ```
>
> A session already branched off the reconciled `main` contains `main_sha`, so
> the hook stays silent for it. The owner clears the barrier by setting
> `active: false` once the fleet has reset. See the **merge-branches** skill.

> **Commit signing is NOT provisioned — pushed commits show "Unverified", and
> that is EXPECTED (TODO for the repo owner, not fixable in a session).** The
> stop-hook / GitHub will flag pushed commits as Unverified (missing signature).
> This is a known, standing gap: these remote containers ship **no `ssh-keygen`
> and no signing key material**, and the `GIT_SIGNING_KEY` / `GIT_SIGNING_EMAIL`
> environment secrets the signing hook needs (`.claude/hooks/setup-signing.sh`)
> are **not set**. Nearly all of `main`'s recent history is Unverified for the
> same reason. **Do NOT try to fix it from inside a session:** you cannot
> generate a key (no tools), you cannot re-sign an already-pushed commit without
> a force-push, and force-pushing `main` is blocked by repo rules — so
> attempting it only wastes a turn. Just ignore the Unverified warning and move
> on. Fixing it for real is an **owner action outside the session**: generate a
> dedicated ed25519 key on a real device (or an iOS shell like a-Shell), add the
> PUBLIC half to GitHub as a *Signing Key*, and put the PRIVATE half in the
> environment's `GIT_SIGNING_KEY` secret (+ `GIT_SIGNING_EMAIL` = a
> GitHub-verified address; `noreply@anthropic.com` can never verify). Once the
> secret exists, the signing hook wires it up automatically on the next session
> and future commits verify — but until then, Unverified is the normal state.

## Regression feedback loop & feature maintenance (2026-07-14 directive)

Fixes are authored by **worker sessions**, one per PR, and each worker now
**stays subscribed to its own PR** (`subscribe_pr_activity`). A GitHub **comment
on a PR wakes that PR's author-worker** — it auto-resumes with its full context.
That is the back-channel: **to reach the person who wrote a fix, comment on their
PR.** This exists because some features — the in-browser Linux **sandbox** above
all (boot hangs, "sandbox not ready", stream-stalled) — **regress repeatedly**,
so a fix is not "done" at merge; it needs an owner who keeps it working.

**The watcher/merger (this loop) also routes regressions back to authors.**
Besides merging incoming PRs, on each watch tick sweep for regressions in shipped
features — primarily `scripts/chatlogs` keyword search for the known failure
signatures (sandbox: `sandbox not ready`, `stream stalled`, `boot_stalled`,
`exec_timeout`, high `client_diag.fs.ms`) plus any live probe or user report (see
the **chat-logs**, **live-verify**, **bugreport-bugfix** skills). When a shipped
feature has broken again:

1. **Do NOT silently fix it yourself.** Identify the PR that OWNS the feature —
   the most recent merged PR touching the relevant files; its `Claude-Session:`
   trailer / `Generated by Claude Code` footer names the author-worker. Confirm
   ownership against **`docs/MAINTENANCE-OWNERS.md`** (the subsystem → owning
   PR/branch/session registry).
2. **Comment on that PR** (`mcp__github__add_issue_comment`) with a precise,
   actionable regression report: the symptom, the `chat_logs` id / `client_diag`
   counters, the exact repro (the verbatim user message + settings), which prior
   fix it regressed, and what "fixed" looks like. That comment wakes the
   author-worker, which fixes it and opens a follow-up PR — you then merge that
   PR the normal way, and the loop continues.
3. If the owning PR is closed/stale or has no responsive worker, fall back to the
   **feedback-loop** discipline (fix it yourself with a regression test) and note
   it in the registry.

**Maintenance ownership.** Keep `docs/MAINTENANCE-OWNERS.md` current: one row per
maintained subsystem → the current owning PR #, branch, author session, the
files it guards, and the failure signatures to watch. **The sandbox has a
standing maintenance owner** that must stay in the loop (subscribed) to uphold
it. When a newer fix PR for a subsystem merges, that PR becomes the owner —
update the row in the same pass. See the **feature-maintenance** skill.

## Load-bearing invariants

1. **Deterministic orchestration — NO function calling.** Every pipeline phase
   is a direct JSON-mode or streamed call, so the whole thing works across
   Berget's entire catalog, including models with unreliable tool-calling.
   Don't introduce function/tool-calling into the pipeline.
   **ONE authorized exception (owner directive, 2026-07-12):** DEVELOPER MODE's
   source investigation. When developer mode is on AND the answer model
   supports real tool use, the ANSWER model itself drives an agentic tool loop
   over the site's own source — `grep_source` / `read_file` / `list_files`
   (shared executors in `public/js/introspect-core.js`; DRS runs them
   server-side via `src/anthropic.js` `anthropicToolRun` + `src/pipeline.js`
   `runSourceResearchTools`; DRC runs them browser-side on the user's own
   provider via `public/js/drc-providers.js` `drcToolRun` + `drc-research.js`
   `runDrcSourceTools`, and ADDS a real `run_bash` tool over the CheerpX
   sandbox). This is DELIBERATE and must not be "fixed" back. It stays scoped:
   models WITHOUT tool use fall back to the deterministic source read loop, and
   the three JSON planning phases (invariant 3) never use tools — so the
   no-function-calling guarantee still holds for the whole catalog everywhere
   except this one dev-mode answer path.
2. **Helper phases fail soft, never break the request.** Search, gap check,
   validation, and every enrichment (geocode/Shodan/Maps) degrade to a lesser
   result (fewer searches, accepted draft, conversation unchanged) rather than
   erroring the chat. Both Berget calls are time-bounded so a hung backend
   can't defeat that.
3. **Split model routing.** The three JSON planning phases (triage, gap check,
   validation) always run on the fixed reliable `DEFAULT_MODEL` (Mistral Small);
   only synthesis (and direct/search-off replies) run on the user's chosen
   model — regardless of which PROVIDER serves that model (an Anthropic answer
   model still gets Berget-Mistral JSON phases). Token accounting, budgeting,
   and profiles are all split accordingly.
4. **The privacy split.** Conversations and attached-file originals rest as
   ciphertext in BOTH the browser and (if the cloud knob is on) R2 — the ONLY
   readable exceptions are RAG-indexed material and project chats, because
   retrieval needs plaintext. The encryption key is derived server-side and
   held only in memory, never at rest beside the ciphertext. The
   secret-keyed project vault (`src/vault.js` + `public/js/vault.js`) is
   the strictest tier: archives rest server-side as ciphertext under a
   user-held secret the server never sees and cannot derive. Since 2026-07-08
   (explicit product decision) the server ALSO keeps a full-visibility
   interaction log (`src/chatlog.js`, D1 `chat_logs`): every completed
   exchange's complete question, answer, and research metadata — UNLESS the
   conversation carries `incognito: true` on `/api/chat`, the
   anonymous-chat API promise that must keep suppressing the log row.
   Since 2026-07-10 the ghost BUTTON no longer toggles that flag — its new
   meaning is THE DOOR TO DRC (clicking it navigates to /cure, the
   structurally stronger anonymity); the API contract stays honored for
   any client that sends the flag. DRC — "deep research secure", the
   public CLIENT-side tier at `/cure` — extends the strict tier to a whole
   surface, structurally: no accounts, and the server is in NO data path
   at all — the browser calls the user's own CORS-capable providers
   (OpenAI, Groq, Berget — or, since 2026-07-15, the user's OWN local
   OpenAI-compatible server: Ollama / LM Studio / llama.cpp, the keyless
   `local` provider entry, with which NO third party receives the
   conversation at all) directly, runs the research pipeline client-side, and
   stores the sealed project state (chats AND the user's API keys inside)
   in the BROWSER's own storage; the server serves static files and public
   replay JSONs, so it could not log content or keys even in principle.
   Secrets never appear in any log.
   Outbound requests to third parties carry the minimum (a query, a
   coordinate, a host) — never the conversation, filename, or account
   identity.
   **TWO deliberate, bounded exceptions to "the server is in NO DRC data
   path".** The FIRST (2026-07-14 directive) is the **temporary web-search
   GRANT subsystem**
   (`src/websearch.js` + `src/websearch-key.js`; client glue in
   `public/cure/drc.js` + `public/js/drc-research.js`; admin panel in
   `public/js/admin.js`; defaults in `src/config.js`'s `websearch` block).
   A short-lived, quota-metered token (HMAC-signed with `SESSION_SECRET` under
   an independent `websearch.` namespace; the quota is a D1
   `websearch_grants` row keyed by the token's `jti`) authorizes a fixed
   number of live web searches routed through the server's Exa key — so a
   Se/cure session keeps the strong posture (own/local model, browser-local
   storage) while still getting fresh web results. It stays inside the
   minimal-outbound rule: only the search QUERY reaches the server and Exa —
   never the conversation. **TWO ways to receive a grant:** (1) the GHOST
   CROSSOVER — a signed-in Se/rver user crossing to Se/cure mints/reuses their
   own grant (authed `POST /api/websearch/grant`, offered only when the ghost
   set the intent marker, so a plain visitor never pings the server); (2) a
   SHAREABLE LINK — an admin mints a grant in the **control panel** (`/admin` →
   Web search grants) and gets a `…/cure?ws=<token>` link anyone can follow
   (`POST /api/admin/websearch`); the follower's browser reads it via public
   `POST /api/websearch/status` (non-consuming) and spends it via public
   `POST /api/websearch`. The control panel sets the DEFAULT quota/TTL, the
   master `enabled` switch, and a **global budget** ceiling on the total
   outstanding remaining across all live grants (the "entire set of quota"
   governance). It is OPT-IN (a toggle in Se/cure settings) and FAIL-SAFE
   (no D1 → no grants can be minted or metered, so there is no unmetered
   server-paid search); the public search is metered ONLY by the token+D1 row
   (an atomic `UPDATE … WHERE used < quota`), and revoking a grant (deleting
   its row) kills its link immediately.
   The SECOND (2026-07-14 directive): the **SECURE-RESEARCH-SPACE proxy BUNDLE**
   (`src/proxy.js` + `src/proxy-grant.js` + the shared bundle crypto
   `public/js/proxy-bundle.js`; client glue in `public/cure/drc.js` +
   `public/js/drc-providers.js`'s `proxyLlmProvider`; admin panel in
   `public/js/admin.js`; defaults in `src/config.js`'s `proxy` block; D1
   `proxy_grants`). It GENERALIZES the web-search grant into a whole "secure
   research space" a signed-in Se/rver user (ghost crossover) or an admin
   (shareable link) LENDS a Se/cure session: a bundle of temporary,
   account-connected proxy grants, **one per SERVICE** — `web` (proxied Exa,
   query-only, exactly like the first exception) and `api` (proxied LLM
   completions on the server's Berget key). **The `api` grant DOES route the
   conversation through the server** (an LLM call carries the prompt) — this is
   the one place a Se/cure session's *content* touches the server — so it is
   OPT-IN, quota-metered, time-limited, Berget-ONLY (bounded account exposure),
   and **clearly DISCLOSED in the Se/cure UI** ("which APIs are connected"): a
   connected-APIs banner + a Settings row + a master toggle that turns the whole
   borrowed space off. **TWO-TIER tokens** (the owner's directive): the bundle
   carries GRANT TOKENS (`prg1.…`, namespace `proxygrant.`, the "token-granting
   tokens") that travel in the URL; the client EXCHANGES each
   (`POST /api/proxy/exchange`) for a PROXY TOKEN (`prx1.…`, namespace
   `proxytoken.`) that never appears in a URL and authorizes the metered service
   (`POST /api/proxy/web`; the OpenAI-wire reverse proxy `/api/proxy/llm/*` which
   the DRC provider registry drives unchanged). **Bundle TRANSPORT:** the bundle
   is AES-256-GCM sealed; the ciphertext rides the URL query (`?rp=`,
   server-visible but opaque) and the decryption key rides the URL ANCHOR
   (`#rk=`, never sent to any server, stripped from referrers). Mint paths:
   authed `POST /api/proxy/grant` (ghost, reuse-per-user) and
   `POST /api/admin/proxy` (link). Same FAIL-SAFE posture (no D1 → 503, no
   unmetered spend), the same atomic reserve/refund meter, and per-service
   quota/TTL + a shared global `budget` ceiling governed in the control panel.
   **SECURE WORKSPACES (2026-07-15) add NO third exception:** a workspace
   link (`/cure/workspace#w=<ciphertext>` — `public/js/workspace-core.js`,
   `docs/WORKSPACE-SECURITY.md`) travels entirely in the URL FRAGMENT, which
   never reaches any server; the only server-touching things it can carry are
   the two grant families above, reused under their existing meters — plus
   the per-token quota-ADJUST control surfaces (authed
   `/api/websearch/adjust`, `/api/proxy/adjust`; admin PATCH), which move a
   grant row's allowance without changing any token in circulation.
5. **Minimal dependencies; evidence-driven exceptions.** No build step, no
   added runtime deps for the Worker/tests. Per-model overrides
   (`model-profiles.js`) and any special-casing must trace back to a reproduced
   finding, not a guess.
6. **Equal Swedish and English support in ALL deterministic intent routing**
   (explicit product expectation, 2026-07-09). Every regex gate / phrase set
   that routes behavior — street-view & maps intents, follow-up/scene
   references, relative moves and here-asks, locality corrections, quiz
   intent, and any FUTURE gate — must take Swedish forms with the same
   breadth as English (including definite forms like "gatuvyn", synonyms
   like "gatubild", and common typos, mirroring the English typo sets).
   When adding or extending a gate, add the Swedish forms AND a parity
   unit test in the same change — never English-only with Swedish "later".
   The LLM phases are language-agnostic by nature; the deterministic gates
   are where parity can drift, so that's where it is enforced (see the
   "Swedish language parity" test suite in `src/googlemaps.test.js`).

> **Plan status (current): this Cloudflare account is on Workers PAID.**
> `wrangler.toml` sets `[limits] cpu_ms = 300_000` (the Paid maximum, 5
> min of CPU time per request). The round-4 narrative (see the
> **pipeline-architecture** skill) is kept as the historical record of how the
> exceededCpu problem was found and fixed; the Free-plan constraints it
> describes are **no longer in effect**. When reasoning about a request being
> killed today, do NOT assume the old 10ms Free ceiling — CPU headroom is now
> 5 minutes (and note nearly all wall-clock here is idle fetch waiting, which
> never counted as CPU anyway), so an isolate dying is rare and not the routine
> outcome it once was.

## Code layout

Server (`src/`):

| File | Responsibility |
|---|---|
| `index.js` | Entrypoint: request id, identity gate, terms + approval gates, routing (`/api/*`, `/admin`, `/auth/google*`, `/login`, `/logout`, `/terms/accept`), sliding-cookie reissue, request logs (static-asset serving + the public allowlist live in `assets.js`; the response security headers + CSP in `security-headers.js`; the canonical-origin 301 in `canonical.js`) |
| `assets.js` | Static-asset serving (`serveAsset` — the caching policy + the cross-origin-isolation COEP shell) and `isPublicAsset` (the unauthenticated allowlist, dominated by the DRC `/cure` public module graph) — split out of the router so the entrypoint stays about routing |
| `security-headers.js` | The site-wide response security headers + the (currently opt-in) Content-Security-Policy, and `applySecurityHeaders` — the one function `index.js`'s `fetch` wraps every response with |
| `canonical.js` | The canonical-origin redirect (`canonicalRedirect` — 301 any www/http arrival to the https apex, preserving path + query): a pure leaf `index.js`'s `route` calls before anything else; carries the Firefox Focus / OAuth `redirect_uri_mismatch` institutional story |
| `auth.js` | Identity: session cookie (365 d, sliding) + admin-secrets break-glass Basic Auth (fail closed); OAuth state HMAC helpers |
| `token-crypto.js` | The shared HMAC-token crypto PRIMITIVES leaf (`b64url`/`b64urlDecode`/`toHex`/`safeEqual` + the namespaced `sign`): one implementation behind `auth.js` (toHex/safeEqual) and the `websearch-key.js`/`proxy-grant.js` token families, which each keep their OWN mint/verify (deliberately different claims) and stay mutually unforgeable via the namespace passed into `sign` |
| `google.js` | Google OIDC sign-in: state cookie, code exchange, claims validation, auto-provisioning (`ADMIN_EMAIL` → admin) |
| `login.js` | Sign-in, pending-approval, and one-time terms pages (PWAs can't answer a 401 challenge) |
| `accounts.js` | User accounts CRUD (D1; provisioned by Google sign-in, no passwords) |
| `db.js` | Optional D1 binding + lazy schema (no-op without the binding) |
| `config.js` | Global site config (D1 `config` table, admin-edited, cached ~30 s) |
| `quota.js` | Window usage accounting, quota enforcement, cost calc, usage recording, the per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, `INFLIGHT_CAP`), and the two sibling 429-payload builders `quotaBlockedResponse` (quota-window block; also imported by quiz-api/bash-api/rag) and `inflightLimitResponse` (concurrency limit) |
| `alerts.js` | Operational alerts (D1 `alerts` table): classifies caught pipeline/backend failures (Berget errors, wallet depletion) into a small stable set of alert types surfaced in the admin panel and as a notification badge — rows are upserted by `type` (a recurrence bumps `count`/`last_seen_at` and re-surfaces itself) rather than one row per occurrence; fails soft (a no-op without D1) — see the **access-control** skill |
| `user-api.js` | `/api/me` (usage vs quota) + `/api/models` (dropdown catalog) + `/api/client-error` (beacon) + `/api/client-log` (client telemetry beacon → Workers Logs; first user is the sandbox filesystem integration — see the **execution-sandbox** skill) |
| `user-messages.js` | Per-user message center (D1 `user_messages`): account-level notices (quota exhausted/restored, sign-in approved, quota changed by an admin) — structured enums + timestamps ONLY, deliberately no content column, so the feature stays inside the same zero-retention promise the privacy notice makes for conversations; "restored" isn't a separate write, it's derived at read time from the caller's CURRENT quota state (`quota.js`). Rendered by the client's `account-messages.js` |
| `settings.js` | Per-user settings (`users.settings_json`, additive column): the `server_history` cloud-storage, `shodan_mcp`, `google_maps`, `feedback_mode`, `bash_lite_mcp` (experimental execution sandbox), and `developer_mode` (introspection mode) knobs — `GET/PUT /api/settings` |
| `introspect.js` | INTROSPECTION MODE's server enrichment (the `developer_mode` knob): whenever developer mode is on it appends the site's OWN source so answers (incl. code-example requests) come from the real code, never a denial. It RETRIEVES the source chunks most relevant to the question from a committed DENSE index (`public/introspect/source-rag.json` — int8 embeddings per source chunk, `scripts/bundle-source-rag.mjs` / `npm run bundle:rag`, a per-file-hash DELTA build that only re-embeds changed files), embedding the query with Berget e5 (same model the index was built with) — so it works for ANY phrasing with NO intent regex and NO Linux VM. Plus a CLAUDE.md orientation excerpt, the full file index for strong "how are you built" asks, named files inlined by path, the **HELP layer** (introspection is ALSO the interactive help, 2026-07-16: the documentation passages relevant to the question, retrieved from the committed docs corpus/index — `scripts/bundle-docs.mjs` → `docs-corpus.json` with resolved symbol references + images rewritten to served `docs-img/` URLs, `scripts/bundle-docs-rag.mjs` → `docs-rag.json` — quoted VERBATIM so usage questions get the documentation's own structure, images and captions, while follow-ups escalate into the source; see the **help-docs** skill), and the **skills catalog** — the repo's `.claude/skills/*/SKILL.md` playbooks surfaced as a first-class listing (`skillsCatalog`/`skillsIndex`/`mentionedSkills`) so ANY answer model in EITHER tier can quote or inline a playbook by name, the same institutional knowledge Claude Code works from (the vendor-neutral root `AGENTS.md` points external agents at the same catalog). Both artifacts (the source snapshot + the rag index) are COMMITTED, served by this deploy, read back through the ASSETS binding — by construction the exact source this deploy runs. `hasSource` flips the answer prompts' capabilities line (prompts.js/pipeline.js) so the model uses the source instead of saying it isn't a coding tool. Shared pure core (chunker/int8 codec/retrieval/block builder) is `public/js/introspect-core.js`; with the sandbox knob also on the tree mounts at `/src` — see the **introspection** skill |
| `introspect-tools.js` | The native source-investigation tools' server FAÇADE: a pure re-export of the ONE shared core `public/js/introspect-core.js` — the tool schemas (`INTROSPECTION_TOOLS`) and the pure snapshot executors `grepSource`/`readFileTool`/`listFilesTool` + `runIntrospectionTool` (the `grep_source`/`read_file`/`list_files` loop DRS drives server-side via `src/anthropic.js`'s tool run and `pipeline.js`'s `runSourceResearchTools`, DRC drives browser-side). The owner-authorized invariant-1 exception (developer mode + tool-capable answer models); the core lives under `public/` for the same reason `bash-agent.js` re-exports `bash-core.js` — see the **introspection** skill |
| `bash-agent.js` | The bash-lite agent's server FAÇADE: a pure re-export of the ONE shared core `public/js/bash-core.js` — `bashIntent` (deterministic EN+SV "wants a shell" heuristic), `parseShellRequest` (the fenced ```bash convention — NO function calling), exec-result normalization/clamping, `buildShellTranscript` (the labeled synthesis block), `buildStepUserMessage` (the per-round step question both tiers send), and (client-only, not re-exported here) the exec BRIDGE's pure protocol codec — `execEnvelope`/`parseExecEnvelope` (the marker+base64 envelope incl. the RC-before-any-pipe fix), `concatChunks`/`base64ToBytes`, and `isExportablePath` (the which-guest-paths-may-leave-the-VM policy, next to `OUTBOX_PATH`) — that `sandbox.js`'s `execInSandbox`/`exportFile` drive. The core ALSO holds the OUTBOX download flow's pure side (2026-07-15, client-only — not re-exported here): ask for a file → the agent copies it into `/workspace/outbox` (`bashAgentPrompt` convention) → after the loop `sandbox.js` `collectDeliverables` lists (`outboxListCommand`/`parseOutboxListing`, capped) and exports each via the base64-through-exec round-trip → `turns.js` `renderDeliverables` attaches download chips with an add-to-project dropdown (`projects.js addFilesToProject`), and a synthetic `deliverablesRun` transcript entry tells synthesis the hand-over happened (rides the existing `shell_transcript` contract — no new API field). The core lives under `public/` because the browser can only import served modules while the Worker bundler can import from anywhere; this replaced the old hand-mirrored server/client copies (2026-07-11) — see the **execution-sandbox** skill |
| `bash-api.js` | `POST /api/bash/step`: ONE turn of the client-orchestrated bash-lite loop — asks the reliable model (via `bashAgentPrompt`) what to run next given the transcript so far; quota-gated, usage-recorded, knob-gated (`bashLiteEnabled`), fail-soft (any failure returns `done` so the client stops). The sandbox runs in the BROWSER (`public/js/sandbox.js`); the server only decides commands |
| `storage.js` | Opt-in R2 cloud storage (knob-gated writes): encrypted conversation AND project records (`/api/convos*`, `/api/projects*` — same handler), original attached files (`/api/files*`), full drain-wipe (`DELETE /api/storage` — vault objects excluded) |
| `vault.js` | The secret-keyed project vault (`/api/vault/:id`, R2 `vault/{uid}/{id}`): one CLIENT-encrypted project archive per id — key AND id both derived in the browser from a user-held secret the server never sees (`public/js/vault.js`), so a local-only project gets backup/cross-device transport as pure ciphertext; deliberately NOT `server_history`-gated (each store is its own explicit consent) and excluded from the drain-wipe |
| — (DRC has no server module) | DRC — "deep research secure", C for CLIENT-side: the public tier at `DeepResearch.Se/cure` (saved projects at `/my/project-<hash>`; `/free*` legacy aliases — all routed BEFORE the identity gate in `index.js`; the root `/` serves the promotional landing to visitors — which links /cure — and 302s signed-in arrivals to /rver). MINIMAL SERVER BY DESIGN: the Worker serves the static page (`public/cure/`) and the public replay JSONs (`pub.js`) and is in no other DRC path — model calls go directly (cross-origin) from the browser to the user's own CORS-capable providers (OpenAI, Groq, Berget — `public/js/drc-providers.js`), the deep-research flow runs client-side (`drc-research.js`), and the sealed project state rests in BROWSER-LOCAL storage (`drc-store.js`). Its remote sibling DRS — "deep research server", R for REMOTE — is the signed-in app at `/rver` (sign-in/terms redirects land there; PWA manifest starts there): everything else in this table |
| `pub.js` | Published research replays — the `DeepResearch.Se/cure/<slug>` ("deep research SECURE <slug>") surface, R2 `pub/{slug}`: frozen deep-research sessions as read-only public pages (`GET /api/pub[/:slug]` public, routed pre-auth; `PUT/DELETE /api/pub/:slug` admin-only), each opened IN PLACE by the DRC app (`/cure/<slug>` seeds a DRC conversation, so continuing on the visitor's own keys is just typing; `/?continue=<slug>` legacy) — see the **publish-research** skill |
| `grant-http.js` | The grant subsystems' shared pure PRESENTATION leaf (imports only `http.js`'s `jsonResponse`): the response fragments `websearch.js` and `proxy.js` must keep in lockstep — `budgetExceeded409`, the `adjustResultResponse` ladder, the `resolveQuotaPatch` set/±/pause clamp arithmetic, the granted-web-search result projections (`emptyWebResultResponse`/`webResultResponse`), `readTokenBody`, and the shared `QUERY_MAX`/`GRANTS_LIST_MAX`/`GRANT_DEPTH` constants. Each subsystem keeps its OWN mint/meter/adjust logic (deliberately different tables and claims); only the pure response/clamp layer lives here. Node-tested |
| `websearch-key.js` | The temporary web-search GRANT TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of `wsk1.<payload>.<hmac>` tokens (claims: `jti`, `uid`, `quota`, `iat`, `exp`) HMAC-signed with `SESSION_SECRET` under an independent `websearch.` namespace, so a grant token can never be confused with a session/state HMAC — the signed capability that lets an otherwise server-less Se/cure session run bounded web searches (invariant 4's ONE bounded exception). Node-tested |
| `websearch.js` | The web-search grant MINT subsystem + METER (D1 `websearch_grants`, keyed by the token's `jti`; defaults in `config.js`'s `websearch` block): `mintWebSearchGrant` (the shared minter — inserts a row + token, enforces the global `budget` ceiling), `grantWebSearch` (the GHOST path — reuse-the-active-`source='ghost'`-grant-per-user, so per-user Exa exposure is bounded to one quota per TTL window), `grantStatus` (non-consuming read), `adjustGrantQuota` (the secure-workspaces MINTER CONTROL, 2026-07-15: set/±/pause a live grant's quota on the D1 row — the token in circulation never changes; increases budget-checked like a mint, owner-scoped via `user_id`), `revokeGrant` (delete = instant kill). Endpoints: `handleWebSearchGrant` (AUTHED `POST /api/websearch/grant` — ghost crossover), `handleWebSearchAdjust` (AUTHED `POST /api/websearch/adjust` — the minter's self-service quota control over their own grants), `handleWebSearchStatus` (PUBLIC `POST /api/websearch/status` — a `…/cure?ws=<token>` link follower reads remaining), `handleWebSearch` (PUBLIC `POST /api/websearch` — verifies the token, atomically reserves one unit, runs Exa on the server key, refunds an empty/failed search), and `handleAdminWebSearch` (`/api/admin/websearch*` — GET list+defaults, POST mint→shareable link, PATCH /:jti quota adjust, DELETE revoke). Fail-SAFE: no D1 → 503, no unmetered server-paid search possible. Client: `public/cure/drc.js` (grant from the ghost intent marker OR a `?ws=` link + the settings toggle), `public/js/drc-research.js` (the injected `webSearch` fn → citation-aware harvest/synth), and the `/admin` → **Web search grants** panel (`public/js/admin.js`) |
| `proxy-grant.js` | The SECURE-RESEARCH-SPACE two-tier TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of the GRANT token `prg1.<payload>.<hmac>` (the bundle's "token-granting token", namespace `proxygrant.`) and the PROXY token `prx1.…` (the post-exchange working credential, namespace `proxytoken.`) — both HMAC-signed with `SESSION_SECRET`, each under its own namespace so the two tiers (and the `wsk1`/session tokens) can never be confused; claims carry `svc` (`web`/`api`). Node-tested |
| `proxy.js` | The SECURE-RESEARCH-SPACE bundle MINT subsystem + per-service METER (D1 `proxy_grants`, one row per service keyed by `jti`, grouped by `bundle_id`; defaults in `config.js`'s `proxy` block — invariant 4's SECOND bounded exception): `mintBundle` (a row + grant token per service, sealed into one encrypted bundle via `public/js/proxy-bundle.js`, global `budget` enforced), `grantBundle` (the GHOST path, reuse-per-user), `exchangeGrant` (grant token → proxy token), `proxyStatus` (non-consuming). Endpoints: AUTHED `POST /api/proxy/grant` (ghost); PUBLIC `POST /api/proxy/exchange`, `POST /api/proxy/status`, `POST /api/proxy/web` (Exa on the server key, reserve/refund), and `/api/proxy/llm/*` (an OpenAI-wire REVERSE PROXY to the server's Berget key — `/models` + a metered `/chat/completions`, so the DRC provider registry drives it unchanged; the `api` grant is the one place a Se/cure conversation reaches the server); ADMIN `/api/admin/proxy*` (GET list+defaults, POST mint→`…/cure?rp=<blob>#rk=<key>` link, PATCH /:jti per-service quota adjust, DELETE revoke a bundle); plus `adjustProxyGrantQuota` + AUTHED `POST /api/proxy/adjust` (the secure-workspaces minter control — same set/±/pause semantics as `websearch.js`'s, per service row). Fail-SAFE (no D1 → 503) and Berget-ONLY. Client: `public/cure/drc.js` (open bundle from URL, exchange, connected-APIs banner + Settings toggle), `public/js/drc-providers.js` `proxyLlmProvider`, and the `/admin` → **Secure research space grants** panel |
| `rag.js` | Document RAG: `POST /api/embed` (Berget embedding proxy, used in BOTH storage modes) + `/api/rag/*` (Vectorize index/query, R2 export copies) |
| `answers.js` | `/api/chat/answer`: TTL'd (15 min) answer recovery cache for dropped connections — ack-purged on intact delivery |
| `chatlog.js` | Full-visibility chat interaction log (D1 `chat_logs`): complete Q&A + research metadata per exchange (chat AND mcp channels), skipped for incognito; `/api/admin/chatlogs*` read API built for the agentic debugging workflow — see the **chat-logs** skill + `scripts/chatlogs`. Also the home of the shared pure log helpers `truncateForLog`/`likePattern`/`cleanStr` (the last two imported by the `testpoints.js`/`feedback.js` board validators) |
| `feedback.js` | Feedback mode's pipeline (D1 `feedback` + `feedback_messages` + `feedback_images`): per-reply user feedback entries as dialogue threads with the development agent — user CRUD (`/api/feedback*`) + the agent/operator queue (`/api/admin/feedback*`, chatlogs-style, `?format=text`) — incl. optional SCREENSHOT attachments on entries and replies (client-downscaled data URLs, one D1 row each, metadata-only in projections, served back as real images via `…/:id/images/:imgId` on both surfaces; `scripts/feedback --image` downloads one) — see the **feedback-loop** skill + `scripts/feedback` |
| `board.js` | The decision-board CORE — the one shared mechanism behind every admin panel whose choices feed an agent loop (see the **decision-boards** skill): choice-state validation (votes/score/note/priority), the priority-vs-rank orderings (admin priority = the loop's fixed work order), `reviewState`, and the `*_reviews` D1 upsert helpers — a new board implements none of this itself. THREE consumers today: the two backlog priority boards `security-risks.js` and `features.js`, plus `panels.js` — the ATTENTION board, a votes-only variant (same core, `"priority"` ordering with no priorities ever set → pure votes-desc) |
| `security-risks.js` | The security-risk review board (D1 `security_reviews`) — the reference `board.js` consumer (façade-style: its pure surface re-exports the core): a code CATALOG mirroring `SECURITY-RISKS.md` §3 (same P-ids, same order — any register edit updates it in the same commit) + the admin's votes/manual score/note and the explicit per-item PRIORITY that is the security-fix loop's fixed work order (`/api/admin/security*`, `?format=text` = the loop's input; `scripts/security`) — see the **security-posture** skill |
| `features.js` | The features/priority review board (D1 `features_reviews`) — the SECOND loop channel next to security (façade over `board.js`): a code CATALOG mirroring `FEATURES.md` §3 (same F-ids, same order, same mirror-in-one-commit discipline) + the admin's votes/EFFORT (the shared "score" field, relabelled)/note and the explicit PRIORITY that is the feature-build loop's fixed work order (`/api/admin/features*`, `?format=text` = the build loop's input; `scripts/features`; impact rank instead of severity, build order instead of fix order) — see the **feature-board** skill and `docs/DECISION-BOARD-LOOPS.md` |
| `panels.js` | The panel-SELECTION board (D1 `panels_reviews`) — a THIRD `board.js` consumer but a different KIND of loop (the ATTENTION loop, not a backlog). Its catalog items ARE the admin panels themselves; it has NO board widget — each panel header on `/admin` carries ▲/▼ thumbs and voting reshapes the admin view in place (up floats to top, net-negative collapses + sinks). Reshapes PURELY on votes: no drag, no explicit priority (reuses the core's `"priority"` ordering with none ever set → votes-desc). The votes-driven focus order (`/api/admin/panels*`, `?format=text` = the attention loop's input; `scripts/panels`) tells a Claude Code session which admin surface the owner is working on now — read it, then read that surface's own board. See the **feature-board** skill §6 |
| `testpoints.js` | The testable-interaction-points queue (D1 `test_points`): declared, linkable "try-it" points — each a `label` + a "what was fixed" `summary` + a same-origin `target` path + an ordered list of client ACTIONS (the deep-link reachability grammar: open a panel/settings-knob, prefill the composer, flip search, set the budget, pick a model, highlight an element) — plus the 👍/👎 verdict. Pure core (validation/projection/`?format=text`/`deepLink`) + `handleAdminTestpoints` (CRUD + result, admin-gated, `/api/admin/testpoints*`) + `handleTryRedirect` (the `/try/:id` deep link → 302 to `<target>?try=<id>`, home-on-miss). The banner + queue UI live in `public/js/testpoints.js` over the pure `public/js/testpoints-core.js`; `scripts/testpoints` is the producer/reader CLI — see the **testable-interaction-points** skill |
| `admin-api.js` | `/api/admin/*`: overview, users, config, chatlogs, feedback, security, features, panels, testpoints, boards |
| `admin-boards.js` | The admin-BOARDS discovery index (`GET /api/admin/boards`, `scripts/boards`): one pure static registry (`ADMIN_BOARDS`) of every Claude-fetchable admin list (security, features, panels, feedback, chatlogs) — id/purpose/api/`text_query`/orderings/`order_help`/script/skill — with a `?format=text` render that prints each board's exact fetch line. The one-call "pop up every board and act on the admin's priority order" entry point; no D1, no secrets (see the **decision-boards** skill) |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, P-3), state, SSE scaffold, usage recording (the split-billing totals — `summarizeSpend`/`exaCost` now live in the shared `billing.js`, re-exported here) |
| `mcp.js` | `POST /mcp`: exposes the deep-research pipeline AS an MCP server — the single `deep_research` tool any MCP client (Claude, Cursor) can call. Hand-rolled Streamable HTTP / JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, plus the `notifications/initialized` ack) — no dependency; routed AFTER the identity gate so MCP inherits the site's access control. Pure protocol helpers are exported at the top for `mcp.test.js`; the heavy pipeline import is DYNAMIC inside `tools/call`, and it shares `resolveJsonModel` (`model-routing.js`) and the split-billing spend math (`billing.js`) with `chat.js` |
| `pipeline.js` | The research pipeline's phase FLOW (triage → search → gap → synth → validate); iterates the source registries, never names a source |
| `pipeline-inputs.js` | The pipeline's PURE input-block builders + output parsers (`shellReplyMessages`, `notesSection`, `subquestionsSection`, `conflictsSection`, `collectConflicts`, `extractClaims`, `takeSearchBatch`) — the byte-identical-input string/data shaping split out of `pipeline.js` so the flow reads as the flow; Node-tested |
| `notes.js` | Structured research notes — the pure representation/merge logic behind the budget-gated notes-digest phase (`pipeline.js`'s `maybeDigest`, `prompts.js`'s `notesPrompt`): each note distils one factual claim tied to numbered source ids; normalizes and MERGES notes across search waves (dedupe by claim, union ids/entities) so gap-check and synthesis reason over a compact claim set instead of re-reading every highlight. Pure and never throws — a bad note is dropped, matching the pipeline's fail-soft posture |
| `triage.js` | The pipeline's JSON-hardening layer: the declared schemas for every JSON planning phase + `hardenJson`, and `normalizeTriage` (the triage-failure fallback) — pure, no I/O |
| `schema.js` | A tiny, pure, dependency-free schema validator hardening the model-JSON → pipeline boundary: `validate(shape, value)` never throws — it coerces/normalizes where it safely can and returns `{ ok, value, errors }` (combinators: string/boolean/number/stringEnum/arrayOf/object/oneOf). Sits BEHIND the existing fail-soft fallbacks (`normalizeTriage` etc. stay the last-ditch net); the integration pattern is `ok ? value : original`, so a schema miss degrades exactly as before |
| `answer-stream.js` | The answer-streaming internals behind synthesis/direct/search-off replies: `streamCompletion` (reliable-model failover), the per-model attempt loop (connect retries, idle guard, finish_reason detection), `emitChunked` |
| `search-sources.js` | The auxiliary search-source REGISTRY (HF Hub + future sources): one declarative entry per source (intent/search/service/dedup/promptNote/diversity) — the parallel-work seam (see the **add-research-source** skill) |
| `sources.js` | The cross-search source registry: URL dedup, arrival-order numbering, per-origin diversity cap (per-domain; per-OWNER for huggingface.co) + overflow backfill, the numbered digest |
| `enrichment.js` | Opt-in pre-pipeline context enrichments: the ENRICHMENTS registry (run once via `runEnrichments`, blocks appended before any model call) + the Shodan runner; the Google Maps runners live in `maps-enrichment.js` |
| `maps-enrichment.js` | The Google Maps enrichment runners — one per lookup-target shape (address/place lookup, POV & map-view captures, jumps, nearby/relocation Places searches, cross-barrier crossings, the journey view) incl. the Street View vision-describe helper; orchestrates lookups → SSE events → context blocks, dispatched by `runGoogleMapsEnrichment` |
| `quiz.js` | The inline-quiz capability's pure logic: `quizIntent` (deterministic "quiz me…" gate, EN+SV, typo-tolerant, question-count parsing; triage carries a fail-soft `quiz:true` backup flag for phrasings the regexes miss), `normalizeQuiz` (hardens the quiz-generation JSON the client renders), grade-request validation/normalization — the pipeline phase is `pipeline.js`'s `runQuizGeneration` (JSON model, fail-soft to a normal answer), the interaction runs client-side (`public/js/quiz.js`) |
| `quiz-api.js` | `POST /api/quiz/grade`: grades a quiz's free-text answers (one JSON call on `DEFAULT_MODEL`, quota-gated, usage-recorded); multiple-choice picks grade client-side from the quiz payload |
| `games.js` | The games subsystem's REGISTRY + dispatch seam (the games counterpart of `providers.js`/`search-sources.js`): one declarative entry per game (id/name/emoji/tagline/path/`available(env)`/`handle`); `GET /api/games` serves the shelf the account panel renders, `/api/games/<id>/*` dispatches to the game's handler — adding a game touches no client shelf code |
| `tokemon.js` | The Tokemon game's PURE core (Node-tested): Pokémon Gen-1 mechanics verbatim under an AI-themed skin (stat/damage/catch/escape formulas, medium-fast XP, the official type chart renamed 1:1, species stats copied from documented Gen-1 species), seeded-RNG deterministic spawning per (geocell, 15-min bucket), the turn-based battle engine, and the client-view projections (`publicSave`/`publicBattle`/`publicCreature` — the anti-cheat boundary — plus `parseLatLng`) — see the **tokemon-game** skill |
| `tokemon-data.js` | The game core's static DATA tables (Gen-1 provenance): the renamed type chart, moves, species, starters, balls/heal items, spawn/item-drop tables — re-exported through `tokemon.js`, so consumers see one surface |
| `tokemon-api.js` | The first registered game: `/api/games/tokemon/*` (dispatched via `games.js`) — save persistence (D1 `tokemon_saves`), spawn re-derivation + proximity validation, server-side battle resolution; 503s without D1. Also the street-view AR mode: `…/scene` (a Street View frame at the player's position with spawns projected INTO the imagery, via `googlemaps.js`'s edge-cached POV capture, gated on the per-user `google_maps` knob) and `…/go` (text navigation) |
| `tokemon-nav.js` | The street-view mode's PURE side (Node-tested): the bilingual text-command grammar (`parseGoCommand` — "go north 200 m" / "gå till Kungsgatan 1" / "look right", EN+SV parity per invariant 6), spherical geodesy (`destinationPoint`/`bearingBetween`), and `projectSpawns` (bearing→x, distance→y/size placement of spawns inside a Street View frame) |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution, plus the untrusted-client-input sanitizers (`resolveShellTranscript`, `sanitizeClientDiag`, `sanitizeFsSummary`) shared with `chat.js` |
| `model-routing.js` | The shared split-model-routing decision (`resolveJsonModel` — JSON planning phases stay on the fixed reliable model): a leaf module (imports nothing) so `chat.js` and `mcp.js` share ONE implementation instead of a verbatim copy |
| `billing.js` | The shared split-billing spend math for a completed request (`summarizeSpend` — the up-to-three-model-bucket token/cost totals, each priced at its own catalog rate; `exaCost` — searches at their depth-tier price plus the `/contents` fetch surcharge): a leaf module (only the pure cost primitives from `quota.js`/`budget.js`) so `chat.js` and `mcp.js` share ONE implementation instead of both re-inlining it (`mcp.js` pulls it in via its dynamic-import block so the pipeline still stays out of `mcp.test.js`) |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks — plus the report-comprehensiveness tiers (`reportTierFor`: the slider buys OUTPUT depth too, brief → standard → extended → full; the plan carries the tier and its synthesis/validation token caps, and prompts.js turns it into per-tier report structure; triage-`simple` questions are capped at the standard shape by `applyComplexityToPlan` — seam-battery evidence, EVAL-BENCH-FINDINGS 2026-07-15) |
| `model-profiles.js` | Evidence-driven per-model overrides (priors, JSON reinforcement, validation skip) |
| `berget.js` | Berget client (primary provider): streaming + JSON-mode completions (both fetch calls time-bounded — see below), model catalog (incl. raw per-token pricing) |
| `anthropic.js` | Anthropic (Claude) client — second, `ANTHROPIC_API_KEY`-gated provider: raw-fetch Messages API with an SSE adapter re-emitting Anthropic streams as OpenAI-style SSE (so `consumeChatStream` + all its guards work unchanged), static EUR-priced catalog (opus/sonnet/haiku) — see the **add-llm-provider** skill |
| `openai.js` | OpenAI (GPT) client — third, `OPENAI_API_KEY`-gated provider: raw-fetch Chat Completions; NO stream adapter (OpenAI SSE is the native wire format `consumeChatStream` parses), only pinned wire params (`max_completion_tokens`, `reasoning_effort: "none"`, `stream_options.include_usage`), static EUR-priced catalog (gpt-5.6-sol/terra/luna + gpt-5.4-mini) |
| `providers.js` | The LLM-provider dispatch seam: merged model catalog (`listChatModels`) + `chatCompletion`/`completeJson` routed by model-id namespace via the `SECONDARY_PROVIDERS` registry (`claude-*` → Anthropic, bare `gpt-*` → OpenAI, else Berget) — everything downstream is provider-agnostic |
| `exa.js` | Exa web search — the DEFAULT web-search backend. `webSearch` first resolves the configured backend (`config.js`'s `search` block) and routes a non-`exa` selection to `websearch-backends.js`, falling back to Exa on failure; the cache key carries the backend id |
| `websearch-backends.js` | The pluggable web-search BACKEND — SERVER FAÇADE over the shared pure core `public/js/websearch-backends-core.js` (the bash-core.js arrangement, so Se/rver AND Se/cure share ONE implementation): adds only the server-shaped `resolveSearchBackend` (config + `SEARCH_BACKEND_URL`/`SEARCH_BACKEND_KEY` env) + the config allowlist (`["exa", …self-hosted]`). Default `exa` keeps the site unchanged; a non-`exa` selection routes through the core (SearXNG / Exa-compatible), Exa fallback on failure; `/contents` full-text stays Exa-only. Se/rver config is the admin, server-wide `/admin` **Web search service** panel; recipes for running your own service in the **local-web-search** skill. Node-tested |
| `edge-cache.js` | Fail-soft Workers Cache (caches.default) get/put helpers — the shared cross-request result-cache mechanics behind `exa.js` and `googlemaps.js` |
| `hf.js` | Hugging Face Hub search (models/datasets/papers) — joins each search wave as citable registry sources when the question explicitly targets Hugging Face (`hfIntent`); `HUGGINGFACE_API_TOKEN` secret optional |
| `shodan.js` | Shodan host-intelligence client + target extraction (opt-in `shodan_mcp` knob) — see "Shodan host intelligence" below |
| `geocode.js` | Reverse geocoding via OpenStreetMap Nominatim: resolves a photo's GPS EXIF coordinates (extracted client-side by `public/js/exif.js`) into a human-readable place name the model and Exa can reason and search with. Server-side like every other outbound call (so it's logged and rate-limited consistently); only the coordinates cross the wire — never the filename, question, or any account/session identity. Fail-soft (returns null on any failure/timeout) |
| `googlemaps.js` | Google Maps Platform clients (Places, Street View, Static Maps, Routes) and the edge-cached lookup orchestration (opt-in `google_maps` knob) |
| `googlemaps-blocks.js` | The Maps integration's pure labeled context-block builders (POV/jump/cross-barrier/nearby/map-view/lookup/journey blocks + the keyless `mapLink`/`panoLink` helpers and `compassDir`) — Node-tested; the API key never appears here |
| `googlemaps-text.js` | The Maps integration's pure text side: deterministic address/place extraction, every intent gate (street-view, moves, here-asks, nearby/relocation, barriers, journey), locality corrections, the conversation-state recovery (`pendingRelocation`, `extractJourneyPoints`), and `pickLookup` — the ORDERED LOOKUP_MATCHERS registry (one small matcher per ask shape; the order is the spec) — all Node-tested |
| `history-key.js` | Per-user key for the client's encrypted local chat history — see "Chat history" below |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers shared across modules: `jsonResponse`, `sseResponse`, `htmlResponse`, `textResponse` (the last is the `?format=text` plain-text renderer the admin-loop board endpoints return) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer; also wires the test-queue client
`testpoints.js` — the try-it banner + queue over the pure
`testpoints-core.js`, fed the app-specific action hooks so it never
reaches into `app.js` internals — see the
**testable-interaction-points** skill), `stream.js` (conversation history + `/api/chat`
SSE send loop, autosaves to encrypted local history after every turn),
`embeds.js` (the conversation embeds registry stream.js wires via
`initEmbeds`: record/prune/size-cap of pipeline-embedded elements, quiz
interaction hooks, the persisted `embeds` list — strict-checked),
`recovery.js` (the answer-recovery polling client for server-parked
answers — `recoverAnswer`'s rolling-deadline poll loop + `ackAnswer`;
delivery of a recovered answer stays in `stream.js`),
`pending-answer.js` (the RESUME-ACROSS-RELAUNCH pointer that closes the
gap `recovery.js` can't: iOS can discard a backgrounded PWA entirely, so
a cold relaunch loses the in-memory request id `recovery.js` would poll
with — this writes a metadata-ONLY marker (conversation id, request id,
settings, timestamp; NEVER message text, and nothing for incognito
chats) so the next launch collects the answer the server finished while
the tab was gone),
`sse.js` (the pure SSE line-buffer parser `stream.js`'s read loop feeds —
Node-tested), `message-content.js` (pure builders for the outgoing
message: labeled document / image-metadata / RAG-excerpt blocks, title
derivation, history image-stripping, `splitUserContent`, plus
`conversationCopyText`/`embedRef` — the header copy-button's plain-text
"User:/Assistant:" conversation export with images, appended blocks, and
pipeline-embedded elements (Street View panorama/frames, id-numbered)
reduced to one-line references — the
Node-testable core `stream.js` orchestrates around),
`models.js` (model dropdown), `attachments.js` (pending images/docs;
the canvas downscaler itself lives in `image-downscale.js`, the shared
leaf `feedback-attach.js` — the feedback pipeline's add-a-screenshot
widget — also compresses through),
`account.js` (the account panel SHELL: `initAccountPanel`,
the shared `PanelCtx`, and the `showView` dispatcher — the views live in
`account-views.js` (summary, full usage,
games shelf + the shared building blocks: setting rows, info popovers,
notification badge, the Feedback-mode/sandbox knob rows the settings
view renders), `account-messages.js` (the message center),
`account-settings.js` (ALL configuration — the cloud-storage/Shodan/
Maps knobs plus the Feedback-mode and sandbox knobs; opened from the
summary's Settings button OR directly via the header's gear icon,
2026-07-11 directive),
`account-feedback.js` (the Feedback dialogue-threads view — thread
screenshots render as thumbnails off the per-image endpoint, and each
reply box carries the `feedback-attach.js` widget)),
`notifications.js` (the small rendering fragments — alert severity
badges, pending-user rows, the K/M `formatCount` abbreviator — genuinely
shared between `account.js`'s
message-center admin section and `admin.js`'s full notification center;
their surrounding markup differs deliberately, so only the identical
pieces live here),
`turns.js`
(bubbles/content/tools — incl. the per-reply Feedback button + modal
dialog (with screenshot attachments via `feedback-attach.js`), present
on every turn and shown via the body's `feedback-mode`
class so flipping the knob covers existing replies — plus
reconstructing a stored conversation on load), `quiz.js` (the interactive inline-quiz card a `quiz` SSE event
renders into the turn body: sequential questions with alternatives PLUS
a free-text field, local multiple-choice grading, `/api/quiz/grade` for
written answers, the score verdict/recap — answers persist via the
embeds registry, the completed summary is appended to the assistant
message in history; pure scoring/summary core Node-tested),
`activity.js` (step bars, stats, collapse, and the
Street View / map embeds; its PURE import-free logic —
`buildResearchDebugJson` (the "Copy research JSON" export of a turn's
COMPLETE response for pasting into Claude Code: the research process AND
the full resulting generation AND every error, server- or client-side),
`sanitizeResearchEvent`, `searchServiceName`, `zoomToFov`, `formatStatsLine`
— lives in `activity-core.js`, Node-tested, and is re-exported by
`activity.js` so importers are unchanged),
`imagedeck.js` (the conversation-wide IMAGE DECK: every Street View/map
frame a reply shows joins one ordered deck; clicking a thumbnail — in a
frames strip or a waypoint miniature on the interactive map — opens the
enlarged slideshow with ‹/› navigation, a mini-map of the image's
position linking to Google Maps, and a per-image chat panel whose
question continues the conversation anchored AT that image's position
via the map_view anchor; live-session only, pure registry core
Node-tested),
`introspect-ui.js` (INTROSPECTION MODE's DRS client — TIN the titanium
mascot and the private-vs-remote model picker; its routing accessors are
Node-tested, the DOM glue verified live) over the shared
`introspect-core.js` pure core (the EN+SV intent gate, the sticky
conversation-mode gate, the source-RAG chunker / int8 vector codec /
retrieval, and the capped context-block builder — the one implementation
behind `src/introspect.js` and both tiers' clients),
`markdown.js`
(sanitized rendering), `report.js` (the branded PDF report export of
an answer — lazy-injects the vendored jsPDF on first use only, so the
normal page load never pays for it), `timescale.js` (slider scale), `history-store.js`
(IndexedDB + AES-GCM: the conversation store itself — encrypted, except
project chats which rest readable because they're RAG-indexed — now also
dual-writing each record to the cloud while the knob is on),
`history-ui.js` (the left history sidebar: list/rename/delete/load),
`settings.js` (cached `/api/settings` client; `serverHistoryOn()` is the
synchronous question every storage-touching module asks), `dev-mode.js`
(developer mode's CLIENT presentation: the TITANIUM-GRAY theme — a `dev-mode`
class on the ROOT element re-pointing the nine palette variables, `:root.dev-mode`
in `css/app.css` — mirrored into a `dr_dev_mode` localStorage cache so a PWA
relaunch paints the titanium palette at first paint before `/api/settings`
answers; `app.js` applies the cache synchronously at boot then reconciles with
the server's authoritative `developer_mode`, and the developer knob flips it on
toggle — Node-tested), `sandbox-mode.js` (the SANDBOX counterpart of
`dev-mode.js`: a `dr_bash_lite` localStorage mirror of the `bash_lite_mcp` knob
so the cross-origin-isolation self-heal fires SYNCHRONOUSLY at first paint from
the cache — closing the 2026-07-13 boot-race where a send before `/api/settings`
resolved fell back to a plain web answer with no sandbox activity, chat_logs
#306 — plus the single `isolateForSandbox`/`shouldIsolate`/`clearIsolationGuard`
self-heal helper `app.js`, the knob toggle, and the `pageshow` bfcache handler
all route through; Node-tested), `balloon.js` (the Se/rver BALLOON GREETER —
the blue tier's symbol character, F-16, owner's pick 2026-07-15: the ghost's
counterpart, a little gold-and-blue balloon among clouds above the composer.
FIRST-VISIT ONLY since the round-4 directive (2026-07-15: NO persistent
figure follows the user around, on either tier): `showBalloonGreeter` is
chained onto the landing intro's `onDone` in `app.js` — never a routine
boot — swishes in, speaks a couple of pointer lines (`GREETER_LINES`: what
the tier does + the ghost button as the door to Se/cure; any tap dismisses,
UX-1), then climbs away (`departProgress`) and unmounts; burner flare +
climb + pennant per completed task via `stream.js`'s `done` event only
while on screen (a no-op afterwards), cloud swishes on ALL its transitions,
pure core Node-tested, DOM layer fail-soft/`pointer-events:none`/reduced-
motion-static — see `docs/SYMBOL-LANGUAGE.md`), `balloon-intro.js` (the
Se/rver first-visit LANDING intro — the blue tier's counterpart of /cure's
umbrella intro, deliberately FASTER (~4.1 s vs ~5.9 s, test-pinned): the logo
vortex untwists into WIRE balloons seen from above, the camera drops a full
**180°** (twice the umbrella's quarter-lap) rolling sideways as it descends —
clouds swishing up past the view, the guide's own vocabulary — and ends
looking UP from underneath at FIVE same-shape/different-size balloons, color
flooded back, baskets rigged, burners glowing in the mouths; pure timeline +
geometry core Node-tested, same watchdog/tap-to-skip/easter-egg/`anim_speed`
contract as `umbrella.js`, gated in `app.js` on first visit + reduced-motion
with `?anim=1`/`?anim=rev` as the forced replay; exports the shared
single-balloon renderer `drawBalloonFigure`), `balloon-spinner.js` (the blue
tier's WAITING SYMBOL — `mountBalloonSpinner`, the exact
`mountUmbrellaSpinner` contract, now wired in `turns.js`/`activity.js` where
the umbrella spinner used to be (the umbrella spinner remains Se/cure's, in
`cure/drc.js`): each loading slot boomerangs the balloon intro in miniature,
turning back JUST before the color revival; completion speed-runs INTO the
fully colored blue-and-gold balloon and folds it into a **BLUE ✓**
(`--check-blue`, app.css — Se/rver's counterpart of Se/cure's pink ✓);
reuses balloon-intro's timeline/renderer AND umbrella-spinner's pure
boomerang/tumble clocks, pure plan helpers Node-tested), `opfs.js`
(original attached-file bytes in OPFS), `rag.js` (client RAG: chunking,
`/api/embed` batches, the `dr_rag` IndexedDB vector store, cosine top-k,
server-index push/import), `chat-rag.js` (project-chat RAG: incremental
turn indexing as a conversation grows, the `chat-<convId>` doc ids, the
sibling-chat retrieval scope, index deletion — pure text-extraction core
Node-tested), `sync.js` (bulk sync when the account knob
flips, either direction, + `pullNewer` reconciliation + the per-project
`pushProjectScope`/`drainProjectScope`), `projects.js` (project records,
file/note ingestion + indexing, the per-project knob, scope helpers),
`project-context.js` (pure builders: the project-materials block,
`projectDocIds` — Node-testable), `projects-ui.js` (the project panel:
knob at top, the vault store-with-secret section, dropzone, add-text
form, file/chat lists, header chip; plus the sidebar's
load-project-from-secret form), `vault-core.js` (the project vault's
dependency-free PURE core: the copy-safe 160-bit Crockford-base32
secret — generation, forgiving normalization — HKDF id+key derivation,
AES-256-GCM archive encrypt/decrypt, archive validation, base64
helpers; publicly served because DRC builds on it) + `vault.js` (the
DRS store/load orchestration over it, re-exporting the core: packing a
whole project — record, chats, decrypted file originals, RAG index
with vectors — into ONE blob the server only ever sees encrypted; its
static imports pull the DRS storage stack, so it must NEVER enter the
/cure module graph — public modules import `vault-core.js` instead;
pure core Node-tested). DRC's client modules — the whole public tier:
`drc-core.js` (DRC's pure core, built on `vault-core.js`: ONE master secret →
HKDF-independent public reference + blob id + blob key; the sealed
project-state archive — provider API keys live INSIDE it; the HKDF info
strings/state-kind constant are frozen pre-rename values; plus the
`.drc` encrypted BACKUP helpers (2026-07-15, Forever Agent §8 pick #1):
`drcBackupFileName` + `openDrcBackup` — the sealed blob exported as a
downloadable file and restored (file + secret) on any device, the guard
against silent localStorage eviction; import never clobbers a newer
local copy (newer state wins, the other's chats merge in — drc.js) —
Node-tested),
`drc-providers.js` (the client-side provider registry: the CORS-capable
providers ONLY — OpenAI, Groq and Berget (CORS confirmed live
2026-07-11), callable directly from the browser
with the user's key — PLUS the keyless `local` entry (2026-07-15,
Forever Agent §8 pick #2): the user's OWN OpenAI-compatible server
(Ollama / LM Studio / llama.cpp), "configured" by its base URL alone
(`configuredDrcProviders`' keyless generalization; the URL lives in the
sealed state as `localBaseUrl`, set in the /cure settings drawer with a
`GET /models` detection probe), no Authorization header sent, and with
no fixed `jsonModel` the planning phases fall back to the chosen model —
the strongest privacy mode: NO third party receives the conversation;
per-provider wire quirks, JSON mode, a fixed cheap
`jsonModel` per provider, live `/models` with a static fallback, plus
the per-provider `embed` entry + `drcEmbed` — browser-direct embeddings
on the user's key: OpenAI `text-embedding-3-small` dimension-reduced to
512, the deliberate small/fast/quota-friendly choice; Groq serves no
embeddings endpoint, so a Groq-only session runs without RAG —
Node-tested over mock HTTP), `drc-rag.js` (DRC's client-side RAG over
conversations and projects: each chat is an incrementally-indexed doc —
only not-yet-indexed turns embed, the chat-rag `srcMsgs` discipline —
and each send retrieves top-k across the project's chats (siblings in
full, the current chat only for turns outside the recent-turns window)
into a labeled context-not-instructions recall block threaded through
triage/synthesis/validation; the index — chunk text AND vectors — rests
INSIDE the sealed state, ciphertext at rest (stricter than DRS's
readable-when-indexed exception); an embedder change wipes + lazily
re-indexes; per-doc/total chunk caps sized for the localStorage quota;
pure over an injected embed fn, every call site fail-soft —
Node-tested), `drc-research.js` (the deep-research
pipeline PORTED TO THE BROWSER: triage → parallel knowledge HARVEST
(the search wave's offline counterpart — no web search, the model's
knowledge is the source pool and the prompts force that honesty) → gap
audit + one follow-up round → streamed synthesis on the chosen model →
validation with a revise-and-replace verdict via the discard_text
convention; deterministic, NO function calling, every helper phase
fail-soft — the pipeline invariants hold client-side; whole flow
Node-tested end to end against a mock provider), `drc-store.js`
(the BROWSER-LOCAL sealed-state storage adapter — localStorage rows of
ciphertext keyed by blob id, injectable backend, deliberately the seam
a future remote adapter would slot into — Node-tested), and
`drc-page-core.js` (the DRC page's import-free PURE core — the small
fragments the `/cure` DOM-wiring layer (`drc.js`) would otherwise inline
or duplicate: `grantLive`/`grantFlagEnabled` (the ONE liveness + master-
toggle check both borrowed-capability subsystems — the web-search grant
AND the proxy bundle — share), `normalizeSearchBackend` (the web-search
backend config normalizer, one definition for the sealed-state read and
the settings-form persist), the deep-link path parsers
`parseProjectPath`/`parsePublicationRef` (with "workspace" a RESERVED slug),
`wmHtml` (the escape-first
Se/cure–Se/rver wordmark-slash renderer), and the per-task symbol grammar's
`phaseChannel`/`disclosureText` (umbrella = offline, balloon = online;
the ℹ-notice disclosure text per online phase — UX-2, SYMBOL-LANGUAGE.md §6)
— Node-tested), and
`workspace-core.js` (SECURE WORKSPACES' pure core, 2026-07-15: a fully
configured Se/cure session — keys, settings, chats, borrowed grant tokens —
sealed into ONE OFFLINE LINK, `/cure/workspace#w=<ciphertext>`; the
mechanism is CLONED from github.com/kristerhedfors/hacka.re (owner
directive) — the `[salt10][nonce10][cipher]` base64url fragment, the
8192-round iterative-SHA-512 KDF, the dual-key split (link key opens the
blob; a never-transmitted master key for local at-rest use), the
namespace-from-SHA-256(blob) — with AES-256-GCM as the one substitution
(no TweetNaCl dependency); the fragment never reaches any server, embedded
grants stay quota-metered and live-administered by their minter (the
adjust endpoints above); pane wiring in `cure/drc.js`, the Se/rver minting
row in `account-settings.js`, architecture in `docs/WORKSPACE-SECURITY.md`
— Node-tested).
DRC's page is `public/cure/` (`index.html` + `drc.js` wiring +
`drc.css`, plus `umbrella.js` — the first-visit intro animation, the
logo vortex untwisting into wireframe 3D umbrellas, pure
timeline/geometry core Node-tested, replay with `?anim=1`, pace =
2.5× base × the admin's `anim_speed` config slider (public
`GET /api/anim`); the landing
page carries the sibling first-visit onboarding — the does/doesn't
pane and the ghost mascot pointing out the ghost button, inline in
`public/welcome/index.html` — see the **ui-notes** skill):
a deliberate LOOK-AND-FEEL TWIN of the main app in a KHAKI
palette (2026-07-10 directive) — the same floating glass chrome, waves,
composer, spiderweb knob and slider shapes as `css/app.css`,
self-contained since app.css is auth-served. DRS-only features (ghost,
account, attach, camera, the time slider) appear as DIMMED buttons
(`.drs`) exactly where the app has them; tapping one opens the
`#drspop` explainer pointing to `/rver`. The knob is REAL here — it
flips the client-side research phases. A left drawer (the history
sidebar mirrored) holds the local chat list and the Project panel; the
header's gear icon (between ghost and account, both tiers) opens the
settings drawer — ALL configuration: the ONE-FIELD API-key form whose
provider dropdown auto-follows the pasted key's prefix
(`detectDrcProvider`: sk-… OpenAI, gsk_… Groq, sk_ber_… Berget) plus
the sandbox knob; the ghost is the secure-tier marker in both tiers,
each its own way (2026-07-12): on the BLUE tier a glow + shimmer
sweep once every THREE minutes (the same ~4 s event in the first ~2%
of a 180 s CSS cycle since the 2026-07-15 "lower the UX animation
level" directive — app.css and the landing alike), on DRC the ghost
character's contours glow and breathe while it floats (`ghost-contour`
in drc.css, a 7.2 s breath since the same directive).
CHAT-FIRST (a visitor can type
immediately; the first send without a key gets a helpful
open-the-settings pointer, never an error wall), with a first-visit glass pane (`#intro`, doubling as the
publication shelf; the full landing at `/` / `/welcome/` links here),
an unsaved-session → save-as-project flow (the Project panel's one
submit opens OR creates a BROWSER-LOCAL project, merging this tab's
work in), and a project form that is a REAL username+password form
(`autocomplete="username"`/`current-password`, switched to
`new-password` on generate) so 1Password and Apple Passwords
save/autofill the master secret; served for `/cure/<slug>` published
replays (seeded as conversations, in place), `/my/project-<hash>` deep
links, and the `/free*` legacy aliases (`/?continue=<slug>` is the
legacy replay handoff).
Admin UI: `admin/index.html` + `js/admin.js` + `css/admin.css` (served
only to admins). Vendored libs in `vendor/` (`marked` and `DOMPurify`
for Markdown rendering + sanitizing; `jsPDF`, lazy-loaded by `report.js`
for the PDF report; `pdf.js` for parsing PDF attachments client-side;
`vendor/xterm/` — the sandbox terminal `@xterm/xterm@5.5.0` + fit addon,
vendored 2026-07-15 with SHA-256 pins recorded in `sandbox.js`, so a CDN
outage can't break the sandbox; the CheerpX engine stays a CDN load
pending its license question).

Games (`public/games/<id>/` — reached from the account panel's **Games**
view in `account.js`, which renders the shelf from `GET /api/games`, the
server-side registry in `src/games.js` — a new game appears on the shelf by
registering it, with no client shelf change). Tokemon
(`public/games/tokemon/`) is the first game: a standalone authed page —
`js/map.js` (a dependency-free slippy map over OSM raster tiles,
attribution included), `js/game.js` (movement — GPS follow, tap-to-walk,
and the TEXT-COMMAND bar posting to `…/go` — spawn polling, mode toggle,
party/bag/dex panels), `js/street.js` (street mode: renders `…/scene`'s
Street View frame with the server-projected spawn overlays inside the
imagery, turn buttons), `js/battle.js` (plays back the server's battle
event list), `js/api.js` (fetch wrappers), `tokemon.css`. All game RULES
live server-side (`src/tokemon.js`, `src/tokemon-nav.js`); the page only
presents. The
site-wide `Permissions-Policy` grants `geolocation=(self)` for this page.

## Unit tests (`src/*.test.js`, `public/js/*.test.js`)

Node's built-in test runner (`node:test` + `node:assert/strict` — no
dependency added, matching the project's minimal-dependency stance),
covering the pure logic and mockable seams that don't need a live
Berget/Exa/D1: `budget.js`
(time-tier planning, deadline grace math), `quota.js` (window
start/reset including month-boundary wraps, quota merging/clamping,
breach detection, cost calc), `model-profiles.js` (override merging,
clone-not-share of nested fields), `alerts.js` (error classification),
`conversation.js` (message/content helpers), `validation.js` (message
and image caps, model resolution), `prompts.js` (structural assertions
on every prompt builder — the anti-injection note, the independent-
source rule, the JSON-only reinforcement toggle), `chat.js`
(`quotaBlockedResponse` via its `quota.js` re-export, `resolveJsonModel`,
`summarizeSpend` via its `billing.js` re-export), `billing.js` (the shared split-billing spend
math directly: `summarizeSpend`'s three model buckets each at their own
catalog rate, `exaCost`'s depth-tier scaling + `/contents` surcharge),
`berget.js`
(`consumeChatStream`: SSE parsing + the opt-in idle/total stream guards),
`anthropic.js` (payload conversion incl. system/image handling, the
Anthropic→OpenAI SSE adapter composed through the real `consumeChatStream`,
key-gated catalog, stop-reason mapping), `openai.js` (the GPT wire params —
`max_completion_tokens`/`reasoning_effort`/`stream_options` — native SSE
through the real `consumeChatStream`, key-gated catalog, plus an in-suite
mock-HTTP smoke over `node:http`), `providers.js` (the registry routing
predicates + the catalog merge/degrade path),
`triage.js`'s `normalizeTriage` (the triage-failure fallback),
`sources.js` (the source registry: `hostnameOf`, `addSources`,
`backfillOverflowSources`, `sourceDigest` — the domain-diversity logic),
`settings.js` (`parseSettings` coercion, `storageAvailability`),
`rag.js` (`validateRagIndexPayload`, the base64⇄Float32 vector codec,
the `idOk` key-path id validator shared with `storage.js`),
`vault.js` (the project-vault endpoints against a mocked R2 bucket:
id validation, PUT/GET/DELETE round-trip, size/count caps, per-user
namespacing, and the works-with-the-knob-OFF guarantee),
`pub.js` (published research replays: slug rules incl. the dot-free
asset-collision guard, `validatePublication`, the publish → public read
→ index → unpublish round-trip against a mocked R2, storage-missing
503s),
`edge-cache.js` (the fail-soft Workers Cache get/put helpers, against a
mocked Cache API), `googlemaps.js` + `googlemaps-text.js` (block/link
builders; address/place extraction, intent gates, `pickLookup`), and
`chatlog.js` (the interaction log's pure logic: truncation markers,
inline-image scrubbing, row assembly/projection, the text rendering,
LIKE escaping), `quiz.js` (the inline-quiz pure logic: the
deterministic intent gate incl. question-count parsing, quiz-JSON
hardening, grade-request validation/normalization), and `feedback.js`
(the feedback pipeline's pure logic: create/reply validation incl.
truncation markers, screenshot-image validation/decoding/size caps, the
status lifecycle, row projection incl. image-metadata splitting, the
`?format=text` rendering incl. IMAGES lines), and `board.js` (the decision-board core:
patch/vote validation, the priority/rank orderings incl. stable-sort
tiebreaks and closed-item sinking, `reviewState` defaults, the D1
helpers' SQL shape, and the façade contract pinning that a board's
re-exported surface IS the core), and `security-risks.js` (the review
board's own logic: catalog shape/mirror discipline, the fix-order vs
severity orderings, the `?format=text` fix-loop
rendering), and `features.js` (the features/priority board's own logic:
catalog shape/mirror discipline against `FEATURES.md` §3, the build-order
vs impact orderings, the façade-is-the-core identity check, the
`?format=text` build-loop rendering), and `panels.js` (the panel-selection
board's own logic: catalog shape (one lowercase-slug entry per admin panel),
the votes-driven FOCUS ordering vs the authored default order, the
façade-is-the-core identity check, and the `?format=text` attention-loop
rendering incl. the muted flag), and `games.js` (the
games registry/dispatch seam: entry shape, shelf payload, subpath
dispatch, unknown-game 404s, no-DB degrade), and `tokemon.js` (the
game core: type-chart parity vs the official matchups, Gen-1
stat/damage/catch/escape formula checks against hand-computed values,
spawn determinism + bucket scoping, battle flow incl. catching, fleeing,
villain rewards, XP/level-up/evolution, save normalization, and the
client-view projections — IVs and the foe roster never leak — plus
`parseLatLng`), and
`tokemon-nav.js` (the street-mode pure side: the bilingual command grammar
incl. the Swedish-parity suite, geodesy round-trips, spawn projection
geometry).

Additional server suites cover the request/routing and infra seams:
`mcp.js` (the PURE JSON-RPC / MCP protocol helpers, asserted to load
WITHOUT pulling in the pipeline), `model-routing.js` (the shared
`resolveJsonModel` split-routing decision `chat.js` and `mcp.js` both
delegate to), `pipeline.js` + `pipeline-inputs.js` (the flow's pure
pieces — `normalizeTriage`, `collectConflicts`,
`isTransientConnectStatus`, and the input-block builders/parsers),
`notes.js` (note normalization + cross-wave merge + the bounded digest),
`schema.js` (the validator combinators and the coerce-or-return-original
contract), `assets.js` (the public no-auth allowlist, the caching
policy, COEP request shaping) and `security-headers.js` (the site-wide
header set + the CSP policy), `auth.js` (the session-cookie HMAC keyed
SOLELY by `SESSION_SECRET` — the no-admin-fallback security properties),
`answers.js` (the answer-recovery cache's running/lost/done projection),
`canonical.js` (the canonical-origin 301: scheme/www normalization with
path + query preserved, pass-through on the https apex),
`token-crypto.js` (the shared HMAC-token primitives: the base64url codec
round-trip, `toHex`, `safeEqual` strictness, and `sign`'s namespace
separation + fail-closed no-secret behavior),
`grant-http.js` (the grant subsystems' shared pure presentation layer:
the budget-exceeded 409, the adjust-result response ladder incl. the
per-caller not_found wording, the `resolveQuotaPatch` set/±/pause clamp,
the web-result projections, `readTokenBody`),
`websearch-key.js` (the grant token's mint→verify round-trip, the
`SESSION_SECRET`/namespace/expiry/tamper rejections) and `websearch.js`
(the mint subsystem + grant meter over an in-memory D1 fake + mocked Exa:
ghost reuse-per-user, `mintWebSearchGrant` + the global budget ceiling,
`grantStatus`/`revokeGrant`, the atomic reserve/refund, the admin
list/mint-link/revoke surface, the 400/403/429/503 status codes),
`websearch-backends.js` (the pluggable search backends' SERVER façade:
`resolveSearchBackend` env/config resolution + clamping, and the re-exported
core parsers/dispatch over a mocked fetch — its client-core sibling
`public/js/websearch-backends-core.js` covers the browser-facing
`(log, resolved, query, depth)` contract directly),
`proxy-grant.js` (the secure-research-space two-tier tokens: grant→proxy
mint/verify, the namespace separation that keeps the tiers/websearch/session
tokens distinct, and the secret/expiry/tamper rejections) and `proxy.js`
(the bundle mint subsystem + per-service meter over an in-memory D1 fake +
mocked Exa/Berget: bundle mint one-row-per-service, ghost reuse-per-user, the
grant→proxy exchange, the atomic web + LLM reserve/refund incl. the LLM
reverse-proxy models-forward/metered-completion/refund-on-error, non-consuming
status, and the admin mint-link/list/revoke surface) and (client)
`proxy-bundle.js` (the AES-GCM seal→open round-trip, wrong-key/tamper/garbage
fail-soft to null, and the shape validator), and `workspace-grants.js` — the
CROSS-subsystem secure-workspace grant-token invariants end to end, over ONE
combined in-memory D1 serving both grant tables (the token-fixed/row-metered
split under live quota adjusts, concurrency-burst overrun proofs, refund
floors, expiry boundaries incl. row-expiry-beats-token / adjust-can't-resurrect
/ expired-ghost-not-reused, budget ceilings freed by pause/expiry and
independent per subsystem, account binding with byte-identical foreign/missing
404s, the wsk1/prg1/prx1 prefix-swap forgery matrix, and the full mint → seal
→ open → hydrate → spend → minter pause/top-up → revoke workspace flow),
`history-key.js` (per-user key derivation determinism + the configured
gate), `admin-boards.js` (the boards-discovery registry shape +
`?format=text`), `testpoints.js` (the try-it queue's pure logic:
`cleanTarget` same-origin validation, the action-grammar `cleanAction`/
`validateActions` incl. unknown-drop + count cap, create/patch/result
validation, `deepLink` query/hash preservation, projection + the
`?format=text` render), `search-sources.js` (the `SEARCH_SOURCES` registry
contract, `sourcePromptNotes`, `platformDiversityKey`), and the outbound
clients' pure sides — `exa.js` (the normalized search cache key),
`hf.js` (intent detection, query/attempt planning, dedup keys, item
mappers), and `shodan.js` (target extraction + the key-gated
availability check). On the client, `pending-answer.js` covers the
resume-across-relaunch marker (metadata-only, incognito-suppressed), and
`testpoints-core.js` covers the try-it queue's client pure core
(`parseTryId`/`stripTryParam`/`deepLink`, `partitionActions` known-vs-unknown
against the client grammar, `nextOpenPoint` oldest-open selection).

Client-side pure logic gets the same treatment even though it ships as
`public/js/`, not `src/` — `exif.js` (TIFF/EXIF parsing: GPS/camera/
timestamp extraction, byte-order handling, malformed-input safety) and
`docs.js` (the docx ZIP reader + core/app property and tracked-change/
comment extraction), `rag.js`'s pure core (`chunkText` coverage/
overlap/termination properties, `cosineSim`, `topKChunks`, the vector
codec — the module is written to be import-safe outside a browser),
`project-context.js` (the project-materials block builder, doc-id
scoping, note/name normalization), `chat-rag.js`'s pure core (chat doc
ids, the appended-block-stripping turn-text extraction, the
sibling-chat scope picker), `message-content.js` (the
outgoing-message block builders — inline document, image-metadata, and
RAG-excerpt blocks incl. the project-chat variant — plus `deriveTitle`,
`stripOldImages`, `splitUserContent`, `userTexts` (the text of every user
turn, oldest first — moved here next to its consumer `asksDeviceLocation`),
and `conversationCopyText` (the
copy-conversation export: turn labeling, image/attachment references,
block-body suppression), the pure
core extracted out of `stream.js`'s send path), `balloon.js`'s pure core
(the Se/rver balloon greeter: envelope profile, hover/climb/pennant/flare
params, the deterministic swish-cloud crossing guarantees, the first-visit
pointer script + bounded-stay/departure contract), `balloon-intro.js`'s
pure core (the Se/rver landing intro: timeline mark ordering, the 180° camera
drop's monotone descent, the sideways roll's crest-and-settle, the
same-shape/five-sizes fleet contract, projection/gore-depth math, the
faster-than-the-umbrella-intro directive pinned against `umbrella.js`'s own
constants), `balloon-spinner.js`'s pure side (the blue waiting symbol: the
loop apex that never reaches the color, the finale plan's speed-run buckets
into the blue apex, style cycling — plus the sibling contract of reusing
`umbrella-spinner.js`'s boomerang clock; its `finale:"info"` ℹ and the
umbrella spinner's `check:"blue"` are the per-task channel grammar's DOM
knobs, with `stepIsLocal` in `activity-core.js` classifying Se/rver steps), `imagedeck.js`'s pure
core (the deck registry: entry validation/order, the latest-within-radius
waypoint lookup, reset scoping), `sse.js` (the SSE
line-buffer parser: partial-line carry, keepalive/`[DONE]` filtering,
malformed-JSON tolerance), `timescale.js` (the slider's position⇄seconds
curve, `fmtBudget`, and the `budgetTier` report-tier readout — its
boundaries pinned to mirror `src/budget.js`'s `reportTierFor`),
`quiz.js`'s pure core (answer verdicts,
scoring incl. ungraded free-text handling, the completed-quiz summary
block), `drc-core.js` (DRC's derivations: determinism,
format-insensitive input, independence of every derived value —
including from the vault's derivation for the same secret —
sealed-state round-trip with the API keys AND the RAG chunk text
unreadable in the stored form, v1/v2→v3 migration, state validation),
`drc-providers.js` (the
CORS-capable registry: per-provider wire quirks, JSON-mode payloads,
lenient JSON extraction, model filters, the `bergetCatalogFilter` shared
by the Berget entry AND the proxy provider, `filterAndSortModels`'s
curate-and-order-newest-first shaping, live-vs-fallback catalog over
mock HTTP, the embed config — small model, 512 dims, Groq has none —
and `drcEmbed`'s wire shape/index-ordering over mock HTTP),
`drc-rag.js` (DRC's client-side RAG: incremental chat indexing with
srcMsgs advance-on-success-only, embedder-mismatch wipe, the
recent-window exclusion for the current chat vs siblings-in-full,
recall-block rendering/bounding, per-doc + total cap eviction order),
`drc-research.js` (the client-side pipeline: triage/notes
normalizers, prompt-structure assertions incl. the offline-honesty
rules, and the FULL flow end to end against a mock provider —
phase order, parallel harvest count, client-side split model routing,
the user's key on every wire call, discard-and-replace revision,
clarify short-circuit, triage fail-soft, and the recall block threaded
into triage/synthesis/validation but never harvest), `drc-store.js` (the
browser-local storage adapter: round-trip over an injected backend,
ciphertext-only at rest, listing, quota/corruption fail-soft),
`drc-page-core.js` (the DRC page's pure core: `grantLive`'s
token/expiry/quota liveness, `grantFlagEnabled`'s default-ON master
toggle, `normalizeSearchBackend`'s backend/URL/key/results normalization,
the `parseProjectPath`/`parsePublicationRef` deep-link parsers incl. the
reserved "workspace" slug, and
`wmHtml`'s escape-then-tighten wordmark rendering),
`workspace-core.js` (secure workspaces: the seal→open round-trip incl.
wrong-password/tamper fail-soft, the hacka.re wire format, the 8192-round
KDF's determinism + salt sensitivity, the dual-key independence, the
namespace derivation, fragment/link parsing, and the payload
build→seal→open→apply flow end to end),
`public/cure/umbrella.js`'s pure core — via
`public/js/umbrella-intro.test.js` — (the DRC first-visit intro's
phase timeline and vortex→umbrella geometry: ramp
ordering/monotonicity, the quarter-circle camera projection,
twist/scallop/dome math),
`vault-core.js` — via `vault.js`'s re-exports — (secret
format/entropy/uniqueness, the forgiving normalization incl. misread
mapping and prefix stripping, the Crockford codec round-trip, HKDF
id/key derivation determinism, archive encrypt/decrypt incl. tamper
detection, archive-shape validation, the chunked base64 helpers), and
`activity.js`'s
`buildResearchDebugJson` (the copy-to-clipboard debug record: step/service
projection, per-round searches, URL-deduped sources, the full generated
`answer`, the `errored` flag + `errors` list, and the ordered timeline), and
`bash-core.js` (the bash-lite agent's SHARED pure core — the one
implementation behind the server façade `src/bash-agent.js`, the DRS driver,
and DRC: the `bashIntent` EN+SV gate incl. the Swedish-parity suite,
`parseShellRequest`, exec-result clamping, the transcript/step-message
builders, the exec bridge's marker+base64 envelope codec
(`execEnvelope`/`parseExecEnvelope` incl. the RC-before-any-pipe pin,
`concatChunks`/`base64ToBytes`, the `isExportablePath` host-read policy),
and the generic injected-step `runShellLoop` driver) plus
`bash-agent.js` (the DRS driver: `fetchShellStep` and the DRS-shaped
`runShellLoop` against a mock step endpoint + mock sandbox, and the re-export
contract pinning that its pure surface IS the core, not a mirror — the
browser VM glue in `public/js/sandbox.js` is deliberately NOT Node-testable
and carries no `@ts-check`) plus `agent-backdrop-core.js` (the agent-activity
BACKDROP's pure core — the faint page-background command/output layer that
replaced the auto-popping sandbox terminal: the ring-buffered multi-channel
transcript, the `clipToNextChannel` round-robin between agents, the
`ShellRun`→lines formatting, and the transparency-preference parse/clamp; the
DOM glue `agent-backdrop.js` is browser-only, fed from `execInSandbox`) plus
`sandbox-files.js` (the file-mounting pure
core: `sanitizeName`/`sanitizeProjName`/`projHash`, `dedupeNames`,
`applySizeCap` byte budgets, `buildManifest`, `buildSeedScript`,
`shellEscape`, and `planSourceMount` — the introspection source-mount plan:
flat ingest entries + the /src tree-building seed script — see the
**execution-sandbox** skill and `docs/SANDBOX-HOST-COMMANDS.md`) plus
`introspect-core.js` (introspection mode's SHARED pure core — the one
implementation behind the server enrichment `src/introspect.js` and both
tiers' clients: the `introspectionIntent` EN+SV gate incl. the
Swedish-parity suite, the sticky `introspectionActive` conversation gate,
snapshot validation, path-mention extraction, the capped context-block
builder, `groupIntrospectionModels`/`parseIntrospectionChoice` — the
private-vs-remote model-picker grouping — and the source-RAG core
(`chunkSourceText`/`snapshotChunks`, the scale-invariant int8 vector codec
`quantizeInt8`/`int8ToB64`/`b64ToInt8`/`cosineF32Int8`, `retrieveSourceChunks`,
`validateRagIndex`)) and `introspect-ui.test.js` (the
DRS routing accessors `privateIntrospectionRoute`/`introspectionRemoteModel`
over a localStorage stub — the rest of `introspect-ui.js` is the TIN
titanium-mascot + picker DOM glue, verified live) and
`src/introspect.test.js` (the always-inject-in-dev-mode enrichment + dense
retrieval against a mocked ASSETS binding & embed, PLUS two FRESHNESS checks
that fail `npm test`: the snapshot must match the tree (`npm run bundle`) and
the rag index's every chunk ref must still resolve against the snapshot
(`npm run bundle:rag`); see the **introspection** skill) and
`introspect-tools.test.js` (the native source-investigation tools' server
façade: the re-export contract pinning that its surface IS
`public/js/introspect-core.js`, not a mirror, and the tool schemas/executors
load without pulling in the pipeline).
These run in Node unmodified since `File`, `Blob`,
`DecompressionStream`, and `TextDecoder` are all standard Node globals
— no DOM needed for this subset of client code.

```bash
npm test            # from the repo root: node --test src/*.test.js public/js/*.test.js
npm run typecheck   # zero-build-step tsc: src/ (tsconfig.json, Workers types)
                    # + public/ (tsconfig.public.json, DOM lib) — strict,
                    # opt-in per file via // @ts-check; both must stay clean
```

This is additive to, not a replacement for, the live-verification
convention: anything touching an external provider or D1 (or, on
the client side, the DOM/`<canvas>`/pdf.js) is still verified live,
since that's where this project's actual bugs have come from
historically (see the **live-verify** skill). The root `package.json`
exists solely to run this suite and the type-checker — no build step,
dev-only dependencies (`typescript`, `@cloudflare/workers-types`);
deploy still reads `src/` and `public/` as plain JS/static assets via
`npx wrangler deploy`.

## End-to-end tests (`tests/`)

Playwright suite that runs against the **live site** using the
break-glass credentials (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env vars;
sent as an `Authorization: Basic` header on every request — the Worker
never emits a challenge, so Playwright's `httpCredentials` would not
work). Self-contained npm project of its own (`tests/package.json`) —
distinct from the root `package.json` above, which only runs the unit
suite.

```bash
cd tests && npm install && npm run fixtures   # once
npm run test:mocked   # 43 tests, free: /api/chat (and /api/embed, /api/settings) intercepted
npm run test:live     # 5 tests, real Berget tokens + one Exa run
```

- **Fixtures** are generated by `make_fixtures.py`: txt/md, a hand-built
  single-page PDF, deflated AND stored docx (with entities, tabs,
  breaks), solid-color PNGs, an over-cap txt, a rejected csv, a docx
  carrying tracked changes/comments/core-properties (`metadata.docx`,
  for `public/js/docs.js`'s metadata extraction), and a real JPEG with
  EXIF including GPS (`photo.jpg`, for `public/js/exif.js` — needs
  **Pillow** — `pip install pillow` — the one non-stdlib fixture in this
  otherwise dependency-free script; skipped with a warning, not a hard
  failure, if it isn't installed). Each text-bearing fixture carries a
  unique `*-SENTINEL-*` code.
- **mocked project**: uploads run through the real UI and the real
  client-side parsers (pdf.js, the ZIP reader, `exif.js`); assertions
  target the captured `/api/chat` request payload (sentinels, doc-block
  headers, multimodal parts, caps, truncation, extracted metadata) and
  the downloaded report PDF (attached JPEGs must appear byte-for-byte
  inside it). `api.spec.js` hits real server-side validation (400s — no
  spend).
- **live project**: serial, retried once (LLM wording varies): sentinel
  echo from parsed docs, vision reading an uploaded image + live report
  embed, one budget-capped web-search run combining Exa with a doc +
  image attachment, and a stop-mid-stream check.
- **Sandbox quirks** (encoded in `playwright.config.js`): Chromium must
  be pointed at the env's `HTTPS_PROXY` explicitly, `ignoreHTTPSErrors`
  for the re-signing CA, and `--ssl-version-max=tls1.2` because the
  proxy resets Chromium's TLS 1.3 ClientHello; the browser binary is the
  pre-installed `/opt/pw-browsers/chromium`.

The **model-matrix eval** (`tests/model-eval.mjs`, `npm run eval:models`) is a
separate data-collection tool — see the **model-eval** skill for its
methodology, the `QUERY_SETS` discipline, the `tests/MODEL-EVAL-FINDINGS.md`
ledger, and the "don't commit mid-battery" rule.

Two scored benchmarks complete the eval stool: the **rubric bench**
(`tests/eval-bench.mjs`, `npm run eval:bench`, ledger
`tests/EVAL-BENCH-FINDINGS.md`) — LLM-judged scores on ~27 fixed synthetic
questions — and the **HF bench** (`tests/hf-bench.mjs`, `npm run eval:hf`,
ledger `tests/HF-BENCH-FINDINGS.md`) — answer accuracy against external
Hugging Face question sets with gold answers, selected for low training-data
contamination vs the catalog models' cutoffs (`vtllms/sealqa`,
`google/deepsearchqa`; rows fetched from the datasets-server at run time,
never committed). Its pure helpers are unit-tested in
`tests/hf-bench-lib.test.js` (`node --test`). Same disciplines as the other
ledgers: fixed seed/judge/budget across a before/after comparison, don't
deploy mid-battery, append-only ledgers.

## Skills

Detailed guidance is split into on-demand skills under `.claude/skills/` — load
the relevant one before working in its area.

**Persist solved tasks as skills.** When a task gets solved in a session and
is likely to recur — a deployment path, a debugging workflow, an eval
procedure, an API quirk that cost real time to figure out — write (or extend)
a skill for it before the session ends, so the knowledge survives the session
instead of being re-derived next time. The **deploy** skill is the canonical
example: how deployment actually works here (git-connected auto-deploy vs
direct `wrangler deploy`, what the env's API token can and can't do, how to
verify a deploy went live) was figured out empirically and would otherwise
have to be rediscovered. Prefer extending an existing skill over creating a
near-duplicate; keep entries evidence-based (what was actually observed, not
what docs claim); and update the skill list below plus the skill's
`description` frontmatter so it gets loaded when relevant.

- **sync-main** — the fetch-latest-main-first rule: every session syncs with
  `origin/main` before implementing (the SessionStart hook automates it),
  what to do when the branch is behind or diverged, and re-fetching before
  every push.
- **merge-branches** — reconciling the repo's many unmerged feature branches
  under the PR-based workflow: telling a squash-*superseded* branch (feature
  already in `main`) from one with genuinely-new content, integrating a real
  candidate as a focused PR, and the merged-branch LEDGER
  (`docs/MERGED-BRANCHES.md`) that TAGS a branch done so no agent rebuilds on
  it — plus `scripts/check-merged-branches.mjs`, the guard that NOTIFIES the
  owner when someone pushes to an already-merged branch.
- **pr** — the one-word `pr` trigger that PREPARES the current feature branch
  for the merge-branches ("Merger") workflow: barrier + base check / rebase
  onto latest `origin/main`, regenerate the committed introspection artifacts
  if source changed, `npm test` + `npm run typecheck` green gate, commit
  pending work, push the branch, open a focused PR to `main`, and hand off to
  the owner's merge. Prepares only — never merges. Companion to sync-main
  (base current) and merge-branches (tag done + merge).
- **deploy** — how code reaches production: push-to-`main` git-connected
  auto-deploy, direct `npx wrangler deploy` (and the token's route-update
  limitation), verifying a deploy is actually live, and the
  don't-deploy-mid-battery interaction with the eval harnesses. Also the
  commit-signing / GitHub Verified-badge remediation (the container's
  managed signing wrapper, `.claude/hooks/setup-signing.sh`, the
  `GIT_SIGNING_KEY`/`GIT_SIGNING_EMAIL` environment secrets).
- **refactor-clarity** — how to refactor for clarity/modularity here without
  breaking anything: the pure-core convention this repo already follows, what
  to PRESERVE (byte-identical behavior, the load-bearing invariants, the
  institutional comments, the module-graph constraints, public import
  surfaces) and what to FOCUS on (residual pure helpers → testable companion
  modules; verbatim duplicates → leaf modules; concerns out of the untested
  entrypoint; client pure logic → an import-free core), the
  baseline→survey→extract→verify workflow, and the traps (local typedefs not
  in `types.js`, the source-snapshot freshness ordering, server-vs-client
  risk). Worked example: the 2026-07-12 `assets.js`/`security-headers.js`/
  `model-routing.js`/`pipeline-inputs.js`/`activity-core.js` pass.
- **update-docs** — the one playbook for reconciling the WHOLE documentation
  surface with the code: the inventory (CLAUDE.md, README, AGENTS.md,
  FEATURES.md, SECURITY-RISKS.md, `docs/`, the skills + their `description`
  frontmatter, the static `/help` `/build` `/story` `/architecture` `/welcome`
  pages, the committed introspection/pulse artifacts), the split between
  TEST-ENFORCED mirrors (`npm test` names the drift — the two catalogs + the
  snapshot/rag freshness) and HAND-MAINTAINED prose (grep for it — the file
  table, the skills list, the test-suite prose), the exact drift-detection
  commands, the regenerate-don't-hand-edit rule for generated artifacts, and
  the survey → detect → update → verify → commit workflow. Load for a
  docs-update pass or when adding a module/skill/feature that needs its docs row.

- **pipeline-architecture** — the research pipeline engine (`src/pipeline.js`,
  `budget.js`, `model-profiles.js`, `berget.js`): the 5 phases, split model
  routing, the time-budget/EWMA planner, per-model profiles, and the
  timeout/finish_reason/exceededCpu incident history.
- **model-eval** — the model-matrix eval harness, `QUERY_SETS`, the findings
  ledger, deciding evidence-driven `model-profiles.js` entries, and
  don't-commit-mid-battery.
- **secure-workspaces** — the shareable, completely OFFLINE Se/cure
  workspaces contained only in a link (`/cure/workspace#w=<ciphertext>`,
  mechanism cloned from github.com/kristerhedfors/hacka.re): the pure core
  `public/js/workspace-core.js`, the /cure pane + Se/rver minting row, the
  per-token quota-adjust control surfaces (self-service + admin), the
  frozen KDF constants, the URL-safe-token-tiers-only rule, and the
  reserved "workspace" slug. Architecture: `docs/WORKSPACE-SECURITY.md`.
- **quota-grant-assessment** — testing/auditing the quota-limited,
  account-bound temporary grant tokens (the secure-workspace borrowed
  capabilities): the invariant checklist (token-fixed/row-metered under live
  adjusts, concurrency overrun, refund floors, expiry, budget ceilings,
  account binding, the cross-family forgery matrix, the workspace flow end
  to end), the combined-D1-fake test technique behind
  `src/workspace-grants.test.js`, the snapshot-regeneration gotcha, and the
  extension checklist for a new grant family/service. Companion to
  secure-workspaces (the feature map); this one is the verification
  methodology.
- **storage-privacy** — chat-history encryption + key hierarchy, the
  `server_history` cloud knob, RAG documents, projects, the secret-keyed
  project vault, and the encryption-asymmetry rule (`storage.js`,
  `vault.js`, `settings.js`, `rag.js`, `history-store.js`, `sync.js`,
  `projects.js`, `public/js/vault.js`).
- **integrations** — external providers and the enrichment pattern: Berget,
  Anthropic, OpenAI, Exa, OpenStreetMap Nominatim geocoding, Shodan, Google
  Maps / Street View, Hugging Face Hub search (`berget.js`, `anthropic.js`,
  `openai.js`, `exa.js`, `geocode.js`, `shodan.js`, `googlemaps.js`,
  `hf.js`).
- **add-llm-provider** — the playbook for adding a NEW LLM provider or new
  models to the dropdown (how Anthropic and OpenAI were added): the provider
  registry seam (`providers.js`), the catalog contract, the two worked
  examples (foreign wire → SSE adapter; native wire → params only),
  split-routing/no-function-calling constraints, secrets/feature gating, and
  the validation ladder (unit tests → mock-HTTP smoke → live probe → bench).
- **tune-provider-models** — tuning new models per codified use case
  (synthesis, JSON phases, vision describe, quiz) and running their first
  eval battery: which knob lives where (provider wire config vs
  `model-profiles.js` vs priors), which harness measures which use case,
  and the evidence-before-override rule.
- **add-research-source** — the end-to-end playbook for integrating a NEW
  deep-research source (like the HF Hub was): choosing the shape
  (search-phase source vs enrichment), intent routing, the triage-prompt
  layer, API client design with empirical probing, registry/diversity
  wiring, SSE visibility via `search_done`, and the validation protocol
  (unit tests → live probes → bench A/B → ledger).
- **local-web-search** — running your OWN web-search service as an Exa
  alternative, configurable in BOTH tiers: the shared pure core
  (`public/js/websearch-backends-core.js`) behind the server façade
  (`src/websearch-backends.js`), the `search` config block, the `exa.js`
  routing + Exa fallback. **Se/rver** configures it server-wide on the
  admin `/admin` **Web search service** panel (with a live test-search);
  **Se/cure** configures it PER-USER in the `/cure` settings drawer and calls
  the self-hosted service BROWSER-DIRECT (no query touches the server; the
  config rests in the sealed state; CORS required). Plus ready-to-run recipes
  (SearXNG's JSON API, a Playwright crawler exposing an Exa-compatible API,
  and hosted/offline alternatives) and the privacy rationale (keep search
  queries off a third party — the project mission).
- **sse-protocol** — the `/api/chat` SSE event vocabulary (delta/status/done)
  and the forward-compatibility rule.
- **mcp-server** — the outbound MCP surface (`POST /mcp`, `src/mcp.js`): the
  site exposed AS a `deep_research` tool other agents (Claude, Cursor) call.
  The hand-rolled JSON-RPC 2.0 / Streamable-HTTP protocol, the pure-helpers-
  static / pipeline-dynamic-import file-layout rule, how a tool call reuses
  `chat.js`'s quota gate + split model routing + usage/billing recording,
  adding/changing a tool, and the validation ladder (`mcp.test.js` → live
  JSON-RPC probe). The strategic outbound edge from `docs/ARCHITECTURE-ROADMAP.md` §3.
- **cache-helper** — every cache layer (browser no-cache policy, the
  CSS↔JS handshake, build stamps, Cloudflare edge propagation, the
  /api/pub 60s TTL, the Workers result cache, PWA staleness) and the
  stale-site playbook — FIRST remedy: remind the user to turn on
  Cloudflare **Development Mode** in the dashboard (the API token can't;
  3-hour zone-wide edge bypass), plus the verify-what's-live-first rule.
- **live-verify** — logging & observability, Workers Logs / `wrangler tail`,
  `x-request-id` / `(ref …)` correlation, and the
  disconnect/answer-recovery/heartbeat/stall-watchdog machinery that only
  reproduces in production.
- **on-device-trace** — remote-debugging a bug that only reproduces on a
  user's real device (iOS PWA especially): the visible build stamp,
  self-explaining empty states, the CSS/JS version handshake, and the
  copyable on-device event-trace overlay, iterated over chat with the user
  as the probe — plus the iOS rendering/gesture facts the method
  established.
- **publish-research** — publishing frozen deep-research replays at
  `DeepResearch.Se/cure/<slug>` ("deep research secure <slug>" — the slug
  must complete the phrase): sourcing a session, the frozen JSON shape,
  the admin-only `PUT /api/pub/:slug`, live verification, and the
  continue-on-own-keys handoff into the DRC app (`src/pub.js`,
  `public/cure/`).
- **chat-logs** — the full-visibility chat interaction log (`src/chatlog.js`,
  D1 `chat_logs`): pulling the latest live questions/answers/errors for
  debugging (`scripts/chatlogs`, `/api/admin/chatlogs`), the ghost
  (incognito) opt-out rule, and the row shape/truncation conventions.
- **bugreport-bugfix** — the keyword-to-fix workflow for bug reports that
  are just a chat keyword ("some recent chat about X failed to do Y"):
  chatlogs keyword search, reading the meta counters, replaying the exact
  logged message through the deterministic gates, fixing at the right
  layer with the verbatim message as a regression test, and live
  verification.
- **feedback-loop** — Claude Code as the back end of Feedback mode
  (`src/feedback.js`, `scripts/feedback`, `/api/admin/feedback*`): the
  gather → decide (human-in-the-loop, EVERY entry) → act → verify →
  message-back loop over the user-feedback queue, the status lifecycle,
  the plain-language reply conventions, and running it as a standing loop.
- **feature-maintenance** — routing a REGRESSION in a shipped feature back to the
  worker who authored the fix: the PR-comment back-channel that wakes a subscribed
  author-worker, finding the owning PR, writing an actionable regression report,
  the standing sandbox maintenance owner, and keeping `docs/MAINTENANCE-OWNERS.md`
  current. The watcher/merger's regression sweep (CLAUDE.md → Regression feedback
  loop). Companion to chat-logs/live-verify/bugreport-bugfix (detect) and
  feedback-loop (fix-it-yourself fallback).
- **decision-boards** — the panel ⇄ loop mechanism behind every admin board
  where Claude Code produces the list, the admin decides over it (votes,
  manual scores, notes, an explicit priority = the loop's FIXED work
  order), and the choices feed back as loop context: the shared core
  (`src/board.js`), the catalog/façade/mirror disciplines, the admin-panel
  UX conventions (collapsed headers, tap-to-open, drag-to-priority), the
  `?format=text` + `scripts/<board>` loop-input shape, and the checklist
  for standing up a NEW board. The security board and the features board
  are the two live priority-board consumers; the feedback queue and
  chatlogs are documented variants. Data-flow diagrams:
  `docs/DECISION-BOARD-LOOPS.md`.
- **feature-board** — the SECOND priority channel (`src/features.js`,
  `FEATURES.md`, `scripts/features`, `/api/admin/features*`): running the
  FEATURE-BUILD loop (read board → fan out by priority → build a tier →
  verify → flip status → push), the mirror discipline against `FEATURES.md`
  §3, the status lifecycle (open → PARTIAL → SHIPPED / DROPPED). ALSO the
  general playbook for IMPLEMENTING A NEW LOOP / priority board — the
  nine-step checklist and the board-shape decisions (relabelled score,
  positive-palette rank, `status==="open"` is the work set, drag writes
  priority 1..N). Companion to decision-boards + `docs/DECISION-BOARD-LOOPS.md`.
- **access-control** — Google sign-in, accounts, terms + approval gates,
  sessions/PWA longevity, break-glass Basic Auth, the four-window quota model,
  the admin interface, the alerts/notification center, and D1 setup.
- **security-posture** — verifying the project's security posture against the
  living risk register (`SECURITY-RISKS.md` at the repo root: the
  public-source threat model, the priority-ordered open-fix backlog, and the
  append-only history log — update the register whenever an item is fixed):
  the secret-leak scans (incl. the shallow-clone caveat), header/CSP probes,
  per-finding greps, the provider key-cap checklist, and the commit-time
  rules keeping live user data and credentials out of the public repo. Also
  the admin review board (`src/security-risks.js`, `/admin` → Security
  risks, `scripts/security`): votes/scores/notes plus the admin-set priority
  that is the security-fix loop's FIXED work order — read the board before
  every fix round; the code catalog mirrors the register's §3 in the same
  commit.
- **ui-notes** — the client UI/UX conventions: Markdown rendering, the PDF
  report, document/image attachments + metadata extraction, floating glass
  chrome, the `/help/` `/build/` `/story/` `/architecture/` `/welcome/`
  pages, the message center, and the public (no-auth) surface.
- **slash-spacing** — deciding the space around the wordmark slash (the
  `.sl` span in Se/cure / Se/rver) PRECISELY at every point: the
  `scripts/slash-gap.mjs` ink-gap meter (true per-row glyph-ink measurement
  in headless Chromium — the margin is font/weight-dependent, never
  eyeballed), the codified gap band (floor .03em / target .06em per side),
  the scoped-override convention (`b .sl { margin: 0 -.04em }` — bold ink
  is wider, the global `-.12em` touches), and the audit table of every
  surface rendering the slash.
- **ux-conventions** — the NUMBERED REGISTRY of codified UX interaction rules
  ("when X → then Y") that must feel the same everywhere and no unit test
  catches — the behavioral companion to ui-notes' UI facts. Load before wiring
  any new interactive surface (popover / speech bubble / explainer / gesture /
  dismissal), and ADD an entry when a new UX decision is made. UX-1: speaker
  bubbles dismiss on any outside interaction while live content inside stays
  clickable — the shared popover-dismissal mechanics behind
  `wireSettingPopovers` (`account-views.js`), the web-search popover
  (`app.js`), the `#drspop` DRS explainer (`cure/drc.js`), and the TIN mascot
  bubble (`introspect-ui.js`).
- **testable-interaction-points** — the try-it queue: declaring linkable
  "test points" the moment a fix ships (a `label` + a "what was fixed"
  summary + a `target` path + deep-link ACTIONS that set the scene), running
  them from the DRS queue/banner, and recording a 👍/👎 verdict that feeds the
  next fix round (`src/testpoints.js`, `public/js/testpoints.js` +
  `testpoints-core.js`, `scripts/testpoints`, the `/try/:id` route, D1
  `test_points`). Owns the ACTION GRAMMAR — the exact boundary of what
  "reachable" means (open a panel/knob, prefill the composer, flip search, set
  the budget, pick a model, highlight an element) — and where it ends
  (navigate-then-do-by-hand; full banner on `/rver` only; admin-only). Load
  when queuing a fix for testing or touching any of those files.
- **test-feedback-loop** — the standing loop ON TOP of the try-it queue:
  serve the git test-request channel (`scripts/test-requests --mint`/`--sync`
  — mint merged workers' request files, stamp verdicts back, post each
  verdict as a comment on the owning PR), sweep decided verdicts
  (`scripts/testpoints --verdicts`), MINE EVERY NOTE
  (a 👍 note can carry a full bug report — point #3, 2026-07-15), ack by
  archiving, route each finding (feature-maintenance PR comment for owned
  subsystems / direct fix with the verbatim complaint as the regression test /
  features board for ideas), and MINT the next batch of points from the
  standing sources (worker test-request files, MAINTENANCE-OWNERS "owes"
  items, merged fix PRs, feedback resolutions, chatlogs regressions, SHIPPED
  feature flips). Load to "run the test loop" / "process the verdicts" /
  "feed new test cases in".
- **request-testing** — the WORKER side of that loop: ship your test cases
  INSIDE your PR as `docs/test-requests/<branch-slug>.json` (git is the
  transport — no admin credentials; one file per branch, so parallel workers
  never conflict), each point full try-it grammar plus `runs: N` for repeat
  confirmations; validate offline with `scripts/test-requests --validate`
  (the API's own validator). After merge the loop mints the points; each
  verdict comes back stamped into your file AND as a comment on your PR —
  which wakes you if you're subscribed (and you must be). Load when a worker
  wants its feature tried by the owner.
- **test-batches** — the STANDING library of standard test cases per pipeline
  case (`docs/test-batches/<case>.json`: direct, search, clarify, quiz,
  shodan, maps, sandbox, introspection, attachments, providers) + the
  `scripts/test-batch` CLI to `--list`/`--get`/`--validate` and shape them
  (`--extend`/`--shrink`), then feed them into either channel (`--mint` onto
  the live queue, `--to-request` into a worker's PR file). Reuses the real
  `validateTestpointCreate`, so a batch never holds a point that won't mint.
  Load to "get the test batch for X", "extend/shrink a batch", or "add a batch
  for a new pipeline capability".
- **execution-sandbox** — the EXPERIMENTAL in-browser Linux execution sandbox
  and bash-lite agent (the `bash_lite_mcp` knob, default OFF, on both DRS and
  DRC): a CheerpX WASM x86 Linux boots in the browser, a client-orchestrated
  agentic loop runs shell commands (fenced-block convention, NO function
  calling — the shared pure core `public/js/bash-core.js` behind the server
  façade `src/bash-agent.js`, plus `src/bash-api.js`, `public/js/sandbox.js`,
  and the DRS driver `public/js/bash-agent.js`), and the transcript feeds
  synthesis as ground truth. Covers the COEP cross-origin-isolation headers,
  the fail-soft contract, EN+SV intent parity, and the live browser
  verification still owed. ALSO covers MOUNTING user files into the VM
  (`public/js/sandbox-files.js` + the `sandbox.js` device mounts): the CheerpX
  device-API facts (no guest→host hypercall; DataDevice direct-bytes,
  IDBDevice-persistent-but-no-host-writeFile, WebDevice+SW), the `/workspace`
  + `/mnt/<projname>-<hash>` layout with the friendly symlink, the tiered
  ingest, overlay persistence, and the `fileProvider` seam
  (`stream.js` `buildSandboxFileProvider`). Full design +
  research: `docs/SANDBOX-HOST-COMMANDS.md`.
- **sandbox-debug** — the DEBUG SWITCH and boot-hang playbook for the execution
  sandbox: when the UI hangs on "booting sandbox"/"connecting disk…", how to turn
  verbose sandbox debugging on/off (the client `dr_sandbox_debug` toggle /
  `?sbdebug=1` / `window.__DR_SANDBOX_DEBUG`, and the server `LOG_LEVEL=debug`
  knob), the `sandbox.boot_stage` timeline vocabulary, the stall watchdog
  (`sandbox.boot_stalled`, warn-level, flushes a hang the buffered path can't),
  and reading it back via `wrangler tail` / `scripts/chatlogs`. Companion to
  execution-sandbox (the sandbox itself); this one is the observability switch.
- **introspection** — INTROSPECTION MODE and the `developer_mode` knob (both
  tiers): the committed source-snapshot artifact
  (`scripts/bundle-source.mjs` → `public/introspect/source-snapshot.json`,
  `npm run bundle`, freshness enforced by the unit suite), the shared pure
  core (`public/js/introspect-core.js` — EN+SV gate, sticky conversation
  mode, the capped context block), the DRS enrichment (`src/introspect.js`
  via the ASSETS binding), the `/src` sandbox mount
  (`planSourceMount`), and DRC's client-side counterpart — plus the
  why-no-Tier-2 decision and the allowlist/caching facts.
- **help-docs** — HELP MODE, the documentation-first layer of introspection
  (introspection is ALSO the site's interactive help, 2026-07-16): the
  committed docs corpus + dense index (`scripts/bundle-docs.mjs` →
  `public/introspect/docs-corpus.json` with per-doc titles, resolved SYMBOL
  references (file+line+GitHub link) and images copied/rewritten to
  `docs-img/`; `scripts/bundle-docs-rag.mjs` → `docs-rag.json`;
  `npm run bundle:docs` / `bundle:docs-rag`, freshness enforced by the unit
  suite — a SOURCE edit can stale it too, definition lines shift), the
  docs-first routing (usage questions answered near-verbatim from the docs,
  images + italic captions included, `isSafeDocImage` in markdown.js renders
  the same-origin doc images; follow-ups escalate into the source — the
  deeper support level, with worked examples in `HELP_DOCS_NOTE`), and both
  tiers' wiring (`retrieveHelpDocs`/`state.helpBlock` on DRS,
  `helpDocsBlockFor` on DRC).

- **tokemon-game** — the games subsystem (the `src/games.js` registry/dispatch
  seam + how to add a NEW game) and the Tokemon open-world AR game itself
  (account panel → Games): the no-invented-game-logic rule (Pokémon Gen-1
  mechanics verbatim, mapped species/moves), the pure-core/API/client split,
  deterministic spawning, and the server-authoritative battle protocol.

- **commit-analytics** — the "Project pulse" dashboard at
  `deepresearch.se/pulse` (public, linked from both tiers): three small-multiple
  charts (commits / lines / new features) over the repo's own git history, where
  the day/week/month toggle is a ZOOM level — Day shows the 24 hours of a day,
  Week the 7 days of a week, Month the weeks of a month, with a ‹ › period
  navigator — plus the skill to refresh it. Covers `scripts/build-pulse.mjs`
  (the git → `public/pulse/data.json` builder, `npm run pulse`; emits per-commit
  `{t,a,r,f}` records the page buckets client-side), how each series is counted
  (exact commit/line counts with generated-artifact exclusion; a keyword feature
  heuristic), the curate-summaries-then-commit workflow, and the `/pulse/`
  public-allowlist entry.

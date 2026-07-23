---
name: secure-tier
description: >-
  Load when building the CLIENT TIER of a platform — the wholly-in-browser
  assistant page (the Se/cure archetype): the minimal-server-by-design page,
  chat-first UX, the look-and-feel twin discipline with dimmed server-only
  affordances, the one-field API-key form with prefix auto-detect, the
  password-manager-compatible project/secret form, sealed state in
  browser-local storage, encrypted backup files, deep-link parsing with
  reserved slugs, and the module-graph pin that keeps every server-tier
  storage module out of the client tier's graph. Also load when a change to
  the client tier's page wiring, storage adapter, or public allowlist is
  under review.
---

# The client tier — a first-class product, not a demo

The client tier is the platform's proof, not its teaser (`sdk/DESIGN.md` §4:
"Why the client tier is not a demo"). The assistant runs wholly in the
browser: model calls go browser-direct to the user's own CORS-capable
providers (or their own local OpenAI-compatible server — then no third party
receives the conversation at all), the research pipeline runs client-side
under the same PA-1/2/3 invariants as the server tier's, and all state —
chats, settings, AND the provider API keys — rests sealed in browser-local
storage under a user-held secret. The server's entire involvement: static
files and public read-only replay JSON. It could not log content or keys
even in principle — that structural absence, not a policy document, is the
tier's privacy claim, and this module is where it is built and pinned.

## Capability class & tier story

Manifest class: **C — client-pure.** Layer 2; deps `baseplate-client`,
`provider-registry`, `sealed-crypto`. This module IS the client tier: it must
work served from any static host, with the platform's one worker reduced to a
file server. Its server tier story is deliberately near-empty — the worker
serves the tier's static page and the public replay JSONs, routes the tier's
paths BEFORE the identity gate, and nothing else. Bridged (class-B)
capabilities may later lend it server-metered services, but this module must
be complete and useful without any of them: bring-your-own-key chat with
sealed local projects is already the product.

## Contracts

- **PA-4 (carries, strongest form)** — the tier holds the *structural* form
  of the privacy split: keys and content sealed at rest in the browser under
  a user-held secret, nothing project-derived ever sent to the platform's server,
  and every standing/per-step disclosure states exactly what leaves the
  browser and to whom.
- **PA-1/PA-2/PA-3 (hosts)** — the client-side pipeline this page wires keeps
  deterministic orchestration, fail-soft helper phases, and split model
  routing intact in the browser; this module must not add a code path that
  bypasses them.
- **PA-5 (enforces)** — no build step: the page is plain ES modules served
  as-is, so the running code is byte-auditable against the repo.
- **PA-7 (consumes)** — the page module stays a thin wiring layer over pure,
  Node-tested cores; every fragment the DOM layer would otherwise inline goes
  into an import-free page-core module.
- **PA-8 (respects)** — the only sanctioned server crossings are grant
  tokens; this module renders their disclosure UI and master toggles but
  never calls an authenticated endpoint.

## Build plan

1. **Create the page directory** — `index.html` (markup only) + one wiring
   module + one stylesheet, under the client tree at the tier's lowercase
   path. The wiring module imports ONLY pure, Node-tested modules (the sealed
   crypto core, the provider registry, the client pipeline, the storage
   adapter, the page core) — it is DOM glue, verified live, never
   unit-tested itself. State the security posture as a comment block at the
   top of the wiring module (secret in memory only; keys inside the sealed
   state; nothing project-derived reaches the server; "no logging" is not a
   policy — there is nothing to log).
2. **Route the tier's paths BEFORE the identity gate.** In the worker's
   entrypoint, the tier's page path, its saved-project deep links, and its
   published-replay slugs are matched and served ahead of any auth check —
   the tier has no identity by definition. Serve the page for the path
   family (page, `/<page>/<slug>`, project links, legacy aliases), and 302
   the root to the tier for signed-out visitors.
3. **Add every module to the public allowlist, and pin the graph.** A single
   auth-gated module anywhere in the page's static import chain 401s for
   anonymous visitors, the whole ES-module graph fails to link, and the tier
   goes inert while the HTML still paints. Write the derived-graph test NOW:
   walk static + dynamic imports from the page's `<script src>` entries and
   assert (a) every reachable module is on the allowlist, (b) no server-tier
   storage/orchestration module is reachable — the class-C rule from
   `pair-architecture` step 5. When a server-tier module has a pure part the
   client needs, split it (core under the client tree, orchestrator
   server-side) and document "import the core, never the orchestrator" at
   the allowlist.
4. **Build the storage adapter as a seam.** One small module speaking
   get/put/delete/list-by-id over an injectable Storage-shaped backend
   (default: localStorage), rows being base64 ciphertext keyed by the
   secret-derived blob id. Fail-soft everywhere: unavailable/full storage
   returns false and the tab-memory copy stays authoritative — the UI says
   so, never throws. localStorage over IndexedDB is a legitimate judgement
   call when states are text-only (~5 MB is generous; the synchronous API
   keeps the adapter auditable at a glance). Node-test the round-trip,
   ciphertext-only-at-rest, listing, and quota/corruption fail-soft.
5. **Define the sealed state and its lifecycle** (on the sealed-crypto
   module): a versioned `{v, kind, updatedAt, keys, settings…,
   conversations, rag}` object where the provider API keys live INSIDE the
   blob. Write `emptyState()`, `validateState()` (accepts every historical
   version), and `migrateState()` (upgrades in place; absent fields read as
   safe defaults). FREEZE the derivation info strings and the state-kind
   constant the moment the first user exists — they are format constants;
   renames must never touch them.
6. **Make the flow chat-first.** A visitor can type immediately with nothing
   set up. The first send with no provider configured gets a helpful,
   clearly-badged canned reply plus the settings/key panel opened and
   focused — NEVER an error wall, and nothing typed is lost (the question
   renders as a normal bubble). A session without a saved project lives in
   tab memory only, by design; the project form seals it later.
7. **Build the look-and-feel twin.** Same chrome SHAPES as the server tier —
   glass header, composer pane, knobs, slider, drawer — in a distinct
   palette, self-contained CSS (the server tier's stylesheet is auth-served,
   so it cannot be shared). Server-only affordances (attachments, camera,
   time budget, account) render as DIMMED buttons in exactly the positions
   the server tier has them — never hidden, never broken: tapping one opens
   a small explainer popover naming the feature, saying it belongs to the
   server tier, and linking there. Keep the explainer copy in one table so
   the feature list is greppable.
8. **Build the settings drawer with the one-field key form.** One password
   input for the API key plus a provider dropdown that auto-follows the
   pasted key's PREFIX (each provider's key prefix is a registry fact:
   detect on input, set the dropdown, show "— detected: X"); unknown
   prefixes leave the dropdown to the user. Detection must obey the
   most-specific-prefix rule from the provider-registry skill — `sk-ant-…`
   (Anthropic) is inside `sk-…` (OpenAI), so a bare `sk-` pattern misroutes
   Anthropic keys to OpenAI's wire; a recognized-but-unsupported shape gets
   an honest "that's an X key — not supported here" hint, never a silent
   wrong guess. Saved keys list below with
   per-provider remove buttons and a masked display. Also here: the keyless
   local-server base-URL row, every knob, and the grant/bridge master
   toggles with their disclosure rows.
9. **Make the project form a REAL username+password form** so password
   managers adopt the secret: username field = the public project reference
   with `autocomplete="username"`, password field = the master secret with
   `autocomplete="current-password"` — switched to `"new-password"` when the
   user generates a fresh secret (that switch is what makes
   Safari/iCloud/1Password offer "save this new password" on submit). ONE
   submit does open-or-create: a sealed blob exists under the derived id →
   open it and MERGE this tab's unsaved work in (unknown conversation ids
   appended; typed keys the project lacks carried over); nothing there →
   seal the current session under the new secret. On open, replace the URL
   with the project deep link via `history.replaceState`.
10. **Add encrypted backup files.** Export = the stored ciphertext, byte for
    byte, as a downloadable file named after the public reference (which is
    deliberately not a capability, so the filename reveals nothing). Import
    = file + secret through the same derive→decrypt→validate→migrate open
    path, fail-soft to one message on wrong secret/tamper. When a local copy
    already exists, the NEWER `updatedAt` wins as the base and the other's
    conversations merge in — an import must never clobber newer local work.
    This is the standing guard against silent browser eviction of local
    storage.
11. **Write the deep-link parsers in the page core.** Pure functions for the
    saved-project path (`/…/project-<hash>` incl. legacy aliases) and the
    published-replay reference (path slug or legacy query param), with slug
    validation and RESERVED words (any sub-page the tier serves — e.g.
    `workspace`, `help`) refused by the parser AND by the publish side.
    A project link prefills the username field (so the password manager
    matches the entry) and opens the panel ready for the secret — it carries
    nothing across devices by itself; the state is browser-local. A replay
    link seeds a normal conversation in place, so "continue" is just typing
    on the visitor's own key.
12. **Extract the page core.** Every pure fragment the DOM layer would
    otherwise inline — grant liveness checks, config normalizers, the path
    parsers, wordmark rendering, per-step disclosure text — lives in ONE
    import-free leaf module with direct Node tests. The wiring layer stays
    thin and is verified live.
13. **Write the standing disclosures.** A one-line "where your words go"
    note beside the model picker (the chosen provider CAN read the
    conversation; the platform's server cannot; the local provider flips to
    "nothing leaves this device"), and per-step online/offline channel
    marking with unknown phases defaulting to ONLINE — over-disclosing is
    the safe failure for a privacy tier.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| The page (markup / wiring / styles) | `public/cure/index.html`, `public/cure/drc.js`, `public/cure/drc.css` |
| Security-posture recap + chat-first flow | `public/cure/drc.js` (header comment; `send()`'s no-key canned path) |
| Sealed state: derivations, versioning, migration, backup | `public/js/drc-core.js` (`deriveDrcProfile`, `emptyDrcState`, `migrateDrcState`, `openDrcBackup`) |
| Browser-local storage adapter (the seam) | `public/js/drc-store.js` |
| The pure page core (liveness, parsers, disclosures, wordmark) | `public/js/drc-page-core.js` |
| Dimmed server-only affordances + explainer | `public/cure/index.html` (`.drs` buttons, `#drspop`), `drc.js` (`DRS_FEATURES`, `showDrs`) |
| One-field key form + prefix auto-detect | `drc.js` (`renderKeysPanel`, `syncKeyDetection`), `public/js/drc-providers.js` (`detectDrcProvider`) |
| Password-manager project form | `public/cure/index.html` (`autocomplete="username"`/`current-password`), `drc.js` (`generateNew` → `new-password`, `unlock`, `projectOpened`) |
| Newer-state-wins backup merge | `drc.js` (`exportBackup`, `importBackup`) |
| Pre-identity-gate routing + root redirect | `src/index.js` (the wordplay URL map, all before the identity gate) |
| Public allowlist + derived module-graph pin | `src/assets.js` (`isPublicAsset`), `src/assets.test.js` ("every module reachable from the /cure page is public") |
| The server-storage-module ban (core-not-orchestrator) | `public/js/vault-core.js` vs `public/js/vault.js`; `src/assets.test.js` ("vault.js … is NOT public") |
| Reserved replay slugs (both sides) | `public/js/drc-page-core.js` (`parsePublicationRef`), `src/pub.js` (`pubSlugOk`) |
| Replay open-in-place + continue-on-own-keys | `drc.js` (`handlePublicationLink`), `src/pub.js` |
| The tier's architecture statement | `docs/ARCHITECTURE.md` §9 ("DeepResearch.Se/cure — the client-side tier") |

## Acceptance checklist

- [ ] The page works served from a plain static host (or the worker with no
      D1/R2/secrets): chat, key setup, project seal/open, backup round-trip.
- [ ] The derived module-graph test walks the real import graph from the
      page's HTML and fails `npm test` by name for any unlisted or
      server-tier import (verify by temporarily adding one).
- [ ] Sealed-state round-trip pinned in Node: keys and content unreadable in
      the stored form; wrong secret / tamper opens to null, never a crash;
      every historical state version still opens and migrates.
- [ ] Storage adapter suite green: round-trip over an injected backend,
      ciphertext-only at rest, quota/corruption fail-soft.
- [ ] Page-core suite green: path parsers (incl. reserved slugs), grant
      liveness, config normalizers, disclosure text.
- [ ] First send with no key produces the canned pointer + opened key panel
      (verified live) — never an error.
- [ ] A generated secret triggers the password manager's save offer, and a
      project deep link autofills it (verified live on a real device —
      autocomplete heuristics differ per browser).
- [ ] Backup export/import verified live: restore on a second
      browser/device, and an import over newer local state keeps the newer
      state with the backup's extra chats merged in.
- [ ] Every dimmed affordance opens its explainer; none is hidden or dead.

## Pitfalls

- **The tier goes dark as a class of bug.** Four reference incidents
  (2026-07-10 through -15) shipped an import into the `/cure` graph without
  its allowlist entry — 401 on one module, the whole graph fails to link,
  the page is inert under a painted shell. Only the derived-graph test
  catches this by construction; land it before the graph grows.
- **A server-tier import hiding one hop away.** 2026-07-11: `drc-core.js`
  imported `vault.js` for helpers, and vault.js's static chain pulled the
  whole DRS storage stack — dead tier. The fix is the core/orchestrator
  split (`vault-core.js`), documented at the allowlist.
- **Frozen constants outlive the product name.** The reference's HKDF info
  strings and state-kind constant still say "free" from the tier's earlier
  name — deliberately: they are derivation/format constants, and "cleaning
  them up" would silently break every existing secret and sealed state.
  Freeze them at first ship; rename around them forever.
- **localStorage is evictable.** iOS Safari especially may silently evict
  site data; a project's ONLY copy was one browser's localStorage. The
  `.drc` backup file exists precisely for this — build export/import with
  the tier, not after the first loss report.
- **The autocomplete switch is load-bearing.** Password managers only offer
  to save the generated secret because the field flips to
  `autocomplete="new-password"` at generation time and back to
  `current-password` after open. Verified live per browser — a refactor
  that "simplifies" the attribute handling breaks silent saves invisibly.
- **Don't let the twin drift into a lesser copy.** The dimmed-affordance
  rule (render in place, explain, link to the server tier) is a product
  decision: hiding server features makes the tier look feature-poor;
  breaking them makes it look buggy. Every new server-tier composer control
  gets a dimmed twin + explainer entry in the same change.
- **Merge, never clobber.** Both open (`unlock`) and import run the same
  merge discipline — unknown conversation ids appended, keys unioned with
  the base winning. The one-submit open-or-create form means a typo'd
  secret CREATES a new empty project rather than erroring; the merge is
  what makes that recoverable instead of destructive.
- **The disclosure line is part of the tier.** "Private from this site"
  must never read as "private from the model provider" — the provider does
  receive the conversation. The standing visibility note and the per-step
  online notices are honesty features; a redesign that drops them breaks
  PA-4's spirit while every test stays green.

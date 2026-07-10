---
name: site-integrity
description: >-
  Load when working on serving transparency — proving the live site serves
  the open-source repo: the deploy version stamp (/version.json,
  scripts/stamp-version.mjs, wrangler [build]), the byte-for-byte verifier
  (scripts/verify-site.mjs + verify-lib.mjs), the signed asset manifest and
  Sigstore attestation (scripts/build-manifest.mjs,
  .github/workflows/attest.yml), or /build/'s "Verify what this site serves"
  section. Also load when a verify run reports mismatches, or when wording
  any user-facing claim about what is provable.
---

# Site integrity — proving the site serves the repo

Built 2026-07-10. The question this answers: *can a user verify that
deepresearch.se serves exactly the public repo?* Yes for the client,
no for the server — and every piece below is designed around that split.

## The trust model (don't overclaim)

- **No build step is the load-bearing fact.** `public/**` in git IS the
  served bytes, so "site == repo" is a byte-for-byte check, not a
  reproducible-build argument. Anything that ever introduces a build step
  breaks this whole design — flag it.
- **Provable: the client.** Everything the browser receives can be fetched
  and hash-compared by anyone.
- **Not provable: the Worker (`src/`).** Cloudflare Workers has no remote
  attestation. Server behavior stays "trust the operator + Cloudflare",
  made *transparent* (public repo, git-connected deploys, the stamp) but
  never *proven*. UI copy and docs must keep saying this plainly
  (/build/'s "Honest limits" callout is the reference wording).
- **Any single check is point-in-time and point-of-vantage.** A malicious
  server could serve clean bytes to auditors and bad bytes to a target
  (targeted serving). Mitigation is many independent verifiers, which is
  why the verify script is public and credential-optional. Per-load
  in-browser enforcement (WEBCAT-style, Firefox-only alpha as of 2026-07)
  was researched and deliberately deferred.

## The pieces

| Piece | What it does |
|---|---|
| `scripts/stamp-version.mjs` | Writes `public/version.json` (commit/branch) at deploy; runs as wrangler's `[build] command` on BOTH deploy paths (Workers Builds sets `WORKERS_CI_COMMIT_SHA`/`WORKERS_CI_BRANCH`; local deploys ask git). **Must never exit non-zero** — a broken stamp must not break a deploy. |
| `/version.json` | Public no-auth route (`isPublicAsset` in `src/index.js`); gitignored, deploy-generated. SELF-REPORTED — a pointer, not a proof. |
| `scripts/verify-site.mjs` | The proof: enumerates `public/**` at a commit (default: the stamped one, fallback HEAD), fetches every URL, hash-compares. Exit 0 = everything reachable matches. |
| `scripts/verify-lib.mjs` | The pure logic (URL mapping, verdict classification, manifest canonicalization) — unit-tested in `scripts/verify-lib.test.js`, part of `npm test`. |
| `scripts/build-manifest.mjs` | Deterministic sha256 manifest of `public/**` at a commit (same commit → byte-identical output). |
| `.github/workflows/attest.yml` | On push to main: signs the manifest into Sigstore's public transparency log (GitHub artifact attestations). Verify: regenerate the manifest at the commit, then `gh attestation verify manifest.json --repo kristerhedfors/Deepresearch.se`. |
| `/build/` section + `public/build/verify.js` | The user-facing explanation; renders the served commit from `/version.json`. |

## Running the verifier

```bash
node scripts/verify-site.mjs                        # anonymous: public surface only
node scripts/verify-site.mjs --cookie "session=…"   # + the signed-in app
BASIC_AUTH_USER=… BASIC_AUTH_PASS=… \
  node scripts/verify-site.mjs                      # break-glass: everything incl. /admin
node scripts/verify-site.mjs --ref origin/main --base https://deepresearch.se
```

Verdicts: `gated` is expected (this Worker authenticates static assets
too) and doesn't fail the run; `mismatch`/`missing`/`error` do.
Encoded gate quirks (all in `classifyResult`, keep in sync with
`src/index.js`): unauthenticated `/` serves the WELCOME page (200 with
different bytes → gated, not mismatch); `/admin/*` for non-admins is a
302; index.html files must be fetched at their directory URL
(auto-trailing-slash redirects `/foo/index.html`). Not encoded: a
signed-in cookie whose account hasn't accepted the terms (or is pending
approval) gets the terms/pending page on `/` — use an active account.

**Sandbox quirk:** Node 22's `fetch` ignores `HTTPS_PROXY`. In the Claude
sandbox, install `undici` in the scratchpad, write a
`proxy-setup.mjs` (`setGlobalDispatcher(new EnvHttpProxyAgent())`) and run
`NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node --import <shim> scripts/verify-site.mjs`.
End users on normal networks need none of this.

## Reading a FAIL (observed live, 2026-07-10)

A mismatch usually does NOT mean tampering. In order of likelihood:

1. **Another session's branch deploy owns prod** (the deploy skill's
   ping-pong). Observed in the wild during this feature's own live
   verification: prod flipped mid-run from `main` to
   `claude/client-projects-encrypted-storage-…` — 6 files mismatched vs
   main, then 82/82 PASS against that branch's tip. Diagnose with
   `--ref origin/<suspect-branch>`, or just read `/version.json` (it
   stamps the branch).
2. **A deploy in progress** — re-run.
3. Only then suspect real tampering / a broken deploy.

## Invariant-shaped rules

- The stamp script and the `[build]` hook must stay failure-proof; test any
  change by breaking git access locally and confirming exit 0.
- `public/version.json` stays gitignored (a committed stamp would make
  every verify of older commits fail) and stays on the public surface.
- The manifest serialization (`manifestJson`) is the SIGNED byte format —
  never change it without versioning `schema`, or old attestations stop
  reproducing.
- The verifier only checks repo→site. Extra files on the server aren't
  enumerable from outside; they're inert unless referenced by verified
  HTML/JS — that argument only holds while the served module graph roots
  in verified files.

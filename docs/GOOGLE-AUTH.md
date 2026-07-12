# Enabling Google sign-in

> **STATUS: IMPLEMENTED** (`src/google.js`) — with deliberate deviations
> from the original plan below, decided when the site switched to
> **Google-only** auth:
> - Google is the ONLY user-facing sign-in; password login, invitations,
>   and access requests were removed entirely.
> - Any Google account with a verified email is **auto-provisioned** on
>   first sign-in; the `ADMIN_EMAIL` wrangler var gets (and keeps) the
>   admin role. There is no invite gate — instead there is an **approval
>   gate** (config `require_approval`, default on): non-admin sign-ins
>   land as `pending` on an auto-refreshing waiting page (APIs 403,
>   nothing spends) until approved in `/admin`. Quotas are the cost
>   boundary after that, and the admin can disable users at any time.
> - Every account must also accept the **terms of use** once, right after
>   first sign-in (`POST /terms/accept`, `users.terms_accepted_at`) —
>   before the approval wait, the app, or any API.
> - Sessions are 365-day sliding cookies so PWA users never re-log-in.
> - `ADMIN_USER`/`ADMIN_PASS` remain as break-glass Basic Auth (scripts,
>   emergencies). The session/state HMAC is now keyed by a dedicated
>   `SESSION_SECRET` (random, `openssl rand -hex 32`), NOT the admin
>   password — see the note in §2. It is the sole signing key: the old
>   admin-key fallback was removed, so if `SESSION_SECRET` is unset the
>   Worker serves a configuration-error page instead of signing keyless.
>
> §1 (console setup), §2 (secrets), §3 (flow — except step 4's "not
> found" branch, see the inline note), and the pitfalls checklist below
> remain accurate and are the operational reference. §4–§7 describe the
> pre-Google-only design (password fallbacks, invitations) and are kept
> as history only.

How to add "Sign in with Google" to Deepresearch.se. The account layer was
built for this: **accounts are keyed by email**, and sessions are already
identity-carrying cookies — Google becomes the way to *prove* an email,
not a new account system.

## 1. Google Cloud Console (one-time, ~5 minutes)

In your existing project:

1. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: **External** (unless every user is in one Google Workspace
     org — then Internal is simpler and skips verification entirely).
   - App name "Deepresearch.se", your support email.
   - Scopes: only `openid`, `email`, `profile` (non-sensitive — no Google
     review needed).
   - External + only these scopes means you can set **Publishing status:
     In production** immediately; "Testing" mode caps you at 100 test users
     and expires refresh tokens, so don't stay there.
2. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: `https://deepresearch.se`
     (add `https://www.deepresearch.se` if you use it).
   - Authorized redirect URIs:
     `https://deepresearch.se/auth/google/callback`
     (and the `www` variant if applicable; for local testing also
     `http://127.0.0.1:8787/auth/google/callback`).
3. Copy the **Client ID** and **Client secret**.

## 2. Worker secrets

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

(Or dashboard → Worker → Settings → Variables and Secrets.) Presence of
these two secrets is the feature flag: when set, the login and invite pages
show the Google button; when unset, nothing changes.

**Also set `SESSION_SECRET`** (`npx wrangler secret put SESSION_SECRET`) —
the HMAC key for the session and OAuth-state cookies, `openssl rand -hex 32`.
`src/auth.js` uses it as the sole key — there is no fallback. An earlier
design derived the key from the admin credentials when `SESSION_SECRET` was
unset, which left every cookie offline-brute-forceable against `ADMIN_PASS`;
that was removed. Unset now means no signing key at all, and `src/index.js`
serves a configuration-error page rather than letting any auth flow run
keyless. Treat `SESSION_SECRET` as required.

## 3. The flow to implement (server-side OAuth code flow + OIDC)

No SDK needed — three `fetch`es and WebCrypto, all Workers-native. Two new
routes in `src/index.js` (public, like `/login`):

### `GET /auth/google` — start

- Generate a random `state` (CSRF) and set it in a short-lived cookie
  (5 min, HttpOnly, signed with the same HMAC used for `dr_session`).
  Optionally carry `?invite=<token>` inside the signed state to support
  accepting invitations via Google (see §5).
- 302 to:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=GOOGLE_CLIENT_ID
  &redirect_uri=https://deepresearch.se/auth/google/callback
  &response_type=code
  &scope=openid%20email%20profile
  &state=<state>
  &prompt=select_account
```

### `GET /auth/google/callback` — finish

1. Verify `state` matches the cookie (reject otherwise), clear the cookie.
2. Exchange the code (server-to-server):

```
POST https://oauth2.googleapis.com/token
content-type: application/x-www-form-urlencoded

code=<code>&client_id=…&client_secret=…
&redirect_uri=https://deepresearch.se/auth/google/callback
&grant_type=authorization_code
```

3. The response contains an `id_token` (JWT). Because it arrives **directly
   from Google's token endpoint over TLS**, Google's own docs say signature
   verification is optional in this flow — decode the payload
   (base64url middle segment) and validate the claims instead:
   - `iss` is `https://accounts.google.com` or `accounts.google.com`
   - `aud` === your client ID
   - `exp` in the future
   - **`email_verified === true`** (critical — never map an unverified email)
   - If you later add a "Continue with Google" that accepts ID tokens from
     the *browser* (One Tap / GIS), signature verification against
     Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, RS256 via
     `crypto.subtle.importKey("jwk", …)` + `verify`) becomes mandatory.
4. Look up the account: `getUserByEmail(env, claims.email)`.
   - **Found & active** → issue the normal session:
     `Set-Cookie: await createSessionCookie(env, String(user.id))`, 303 `/`.
     (Optionally store `claims.sub` in a new `google_sub` column on first
     Google login and require it to match thereafter — pins the account to
     one Google identity even if email ownership ever changes.)
   - **Found & disabled** → back to `/login` with an error flash.
   - **Not found** → *(superseded — see the status header)* the plan said
     "do NOT create an account (invite-only stays intact)"; the
     implemented behavior **auto-provisions** the user row instead:
     `ADMIN_EMAIL` → admin + active, everyone else → `pending` when the
     approval gate is on, `active` otherwise.

That's the whole thing — roughly 120–150 lines in a new `src/google.js`
plus two route lines and a button.

## 4. UI touches

- **Login page** (`src/login.js`): a "Continue with Google" button (a plain
  `<a href="/auth/google">` styled per Google's branding guidelines) above
  the password form, rendered only when the secrets are configured (pass a
  flag from the route).
- **Invite page**: "Accept with Google" next to the password field (§5).
- **Account panel**: show "Signed in with Google" when applicable; users
  with `pass_hash IS NULL` simply have no password to fall back on — Basic
  Auth for scripts then requires setting one (a future "set password"
  button in the panel, or keep it Google-only).

## 5. Accepting invitations via Google (recommended) *(obsolete — invitations were removed entirely; kept as history)*

Passwordless onboarding, one tap on a phone that scanned the QR:

- The invite page links to `/auth/google?invite=<token>` (token rides
  inside the signed state).
- In the callback, when the state carries an invite token: load the invite
  with `getValidInvite`; require `claims.email === invite.email`
  (case-insensitive) — the invitation stays bound to the email you issued
  it to; create the user **without a password** (`pass_hash = NULL`), mark
  the invite used (reuse the `acceptInvite` batch minus the password step —
  add an `acceptInviteGoogle(env, token, claims)` beside it), set the
  session cookie, 303 `/`.
- If the Google account's email doesn't match the invite, show the invite
  page again with an explanatory error rather than silently creating
  anything.

## 6. What does NOT change

- Admin secrets identity (`ADMIN_USER`/`ADMIN_PASS`) — untouched, still
  DB-free, still the break-glass login.
- Session mechanism — Google logins mint the same `dr_session` cookie;
  `identify()` needs zero changes.
- Quotas, roles, admin UI — all keyed on the user row, which is the same
  row regardless of how the user proves their email.
- Basic Auth for curl/scripts — email+password users keep it; Google-only
  users have no password until they set one.
- Invite-only access — Google sign-in never auto-provisions accounts.

## 7. Schema tweak (optional but recommended) *(shipped — `google_sub` is in `src/db.js`'s lazy schema)*

```sql
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
  ON users(google_sub) WHERE google_sub IS NOT NULL;
```

Add it to the `SCHEMA` string in `src/db.js` guarded the same lazy way
(D1 ignores duplicate-column errors if you wrap the ALTER in a try/catch —
or bump to a tiny versioned-migration list once there's a second change).

## 8. Testing locally

`wrangler dev --local` + the `http://127.0.0.1:8787/auth/google/callback`
redirect URI added in the console, with the two secrets in a `.dev.vars`
file (never committed):

```
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
```

The sandboxed dev environment used for this repo's verification can't
complete a real Google round-trip (interactive consent), so test the
callback logic with a forged claims object behind a test-only branch, and
do one manual end-to-end login after deploying.

## Pitfalls checklist

- [ ] `email_verified` must be checked — Google issues tokens for
      unverified emails on some account types.
- [ ] Normalize emails the same way `src/accounts.js` does
      (`trim().toLowerCase()`) before lookup.
- [ ] `state` cookie must be signed and single-use, or the callback is a
      CSRF/login-fixation target.
- [ ] Exact redirect-URI match — Google rejects even a trailing-slash
      difference (add both apex and `www` if the site answers on both).
- [ ] Consent screen left in "Testing" silently breaks for non-test users —
      publish it.
- [ ] Don't log tokens or claims; keep the existing rule (identity ids and
      counts only).

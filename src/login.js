// @ts-check
// Server-rendered auth-flow pages, all styled to match the app's sky-blue
// theme: the sign-in page (what unauthenticated browsers/PWAs get instead of
// a bare 401 challenge, which an installed PWA cannot answer — black screen),
// the one-time terms gate, the awaiting-approval waiting room, and the
// missing-secret configuration-error page. src/index.js decides which one a
// request sees.

/** @typedef {import('./auth.js').Identity} Identity */

const PAGE_CSS = `
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #6fc3fd; color: #0a2e5c;
      display: grid; place-items: center; padding: 1rem;
    }
    .card {
      background: #f2f9ff; border: 1px solid #8ec4ec; border-radius: 14px;
      padding: 1.6rem; width: min(340px, 92vw);
      display: flex; flex-direction: column; gap: .8rem; text-align: center;
    }
    img.logo { width: 72px; height: 72px; margin: 0 auto .2rem; border-radius: 18px; }
    h1 { font-size: 1.05rem; margin: 0 0 .1rem; }
    .err { color: #9a1c1c; font-size: .85rem; margin: 0; }
    .muted { color: #2f5d8e; font-size: .8rem; margin: .2rem 0 0; line-height: 1.45; }
    a.gbtn {
      display: flex; align-items: center; justify-content: center; gap: .6rem;
      background: #fff; color: #1f1f1f; text-decoration: none;
      border: 1px solid #dadce0; border-radius: 24px;
      padding: .62rem 1rem; font-weight: 600; font-size: .92rem;
    }
    a.gbtn:active { background: #f3f6fb; }
`;

// Google "G" mark per branding guidelines (inline SVG, no external fetch).
const G_SVG =
  '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
  "</svg>";

/**
 * Waiting room for the approval gate: shown to signed-in users whose
 * account is still status "pending". Auto-refreshes so approval kicks in
 * without any user action; signing out is the only available act.
 * @param {Identity} identity
 * @returns {string} full HTML document
 */
export function pendingPage(identity) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="20">
  <title>Deepresearch.se — awaiting approval</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>${PAGE_CSS}
    form { margin: 0; }
    button {
      background: #e2f1ff; color: #0a2e5c; border: 1px solid #8ec4ec;
      border-radius: 8px; padding: .5rem 1rem; font: inherit; font-weight: 600;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/icons/icon-192.png?v=4" alt="">
    <h1>Almost there</h1>
    <p class="muted">You’re signed in as <b>${escapeHtml(identity.email)}</b>,
    and your account is waiting for the site owner’s approval. This page
    checks again automatically — once you’re approved it turns into the app
    by itself.</p>
    <form method="post" action="/logout"><button type="submit">Sign out</button></form>
  </div>
</body>
</html>`;
}

/**
 * One-time terms gate, shown after first sign-in until accepted (index.js
 * enforces; acceptance is recorded on the user row). This is the condensed
 * version of the /build/ "About this project" page — what the site is and
 * what it must not be used for — kept to a single page with a single
 * Accept button so consent stays meaningful without ceremony.
 * @param {Identity} identity
 * @returns {string} full HTML document
 */
export function termsPage(identity) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepResearch.se — before you start</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>${PAGE_CSS}
    body { align-items: start; padding: 1.1rem 1rem 2rem; }
    .card { width: min(520px, 94vw); text-align: left; gap: .5rem; padding: 1.3rem 1.4rem; }
    .card h1 { text-align: center; font-size: 1.15rem; margin: 0; }
    .hi { text-align: center; font-size: 1.6rem; line-height: 1; margin: 0; }
    .lead { text-align: center; color: #2f5d8e; font-size: .82rem; margin: 0 0 .2rem; overflow-wrap: anywhere; }
    .sec { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr); gap: .1rem .55rem; align-items: start; }
    .sec > div { min-width: 0; }
    .sec .ico { font-size: 1rem; line-height: 1.5; text-align: center; }
    .sec h2 { font-size: .9rem; margin: 0; line-height: 1.5; }
    .sec p { font-size: .84rem; line-height: 1.45; margin: .1rem 0 0; color: #234; overflow-wrap: anywhere; }
    .rules { grid-column: 2; min-width: 0; list-style: none; margin: .3rem 0 0; padding: 0;
      display: grid; gap: .18rem; }
    .rules li { font-size: .82rem; line-height: 1.35; padding-left: 1.15rem;
      position: relative; color: #234; }
    .rules li::before { content: "✕"; position: absolute; left: 0; top: 0;
      color: #b53535; font-weight: 700; }
    a { color: #0d4fa0; overflow-wrap: anywhere; }
    .actions { display: flex; align-items: center; gap: .9rem; margin-top: .7rem; flex-wrap: wrap; }
    form { margin: 0; }
    button.primary {
      background: #0d4fa0; color: #fff; border: 0; border-radius: 24px;
      padding: .6rem 1.4rem; font: inherit; font-weight: 600; cursor: pointer;
    }
    button.primary:active { background: #0a3f80; }
    button.plain {
      background: none; border: 0; color: #2f5d8e; font: inherit;
      font-size: .82rem; text-decoration: underline; cursor: pointer; padding: 0;
    }
    .fine { font-size: .74rem; color: #5a7ba6; margin: .5rem 0 0; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <p class="hi">👋</p>
    <h1>Welcome — one quick read</h1>
    <p class="lead">Signed in as <b>${escapeHtml(identity.email)}</b> · about 20 seconds</p>

    <div class="sec">
      <div class="ico">🔬</div>
      <div>
        <h2>What this is</h2>
        <p>A working deep-research assistant — and an experiment in how private
        an LLM app can be. Built over a weekend, phone-only; invite-only, not a
        product. More on <a href="/build/">About</a> and
        <a href="/story/">The build story</a>; source on
        <a href="https://github.com/kristerhedfors/Deepresearch.se">GitHub</a>.</p>
      </div>
    </div>

    <div class="sec">
      <div class="ico">🚫</div>
      <div>
        <h2>House rules</h2>
        <p>It’s a text research tool. The EU AI Act’s banned uses (Article 5)
        are hard limits here — don’t use it to:</p>
      </div>
      <ul class="rules">
        <li>Manipulate or deceive anyone into harmful choices</li>
        <li>Exploit children or other vulnerable people</li>
        <li>Social-score real, identifiable people</li>
        <li>Predict a named person’s criminality from profiling</li>
        <li>Infer someone’s race, politics, religion or feelings</li>
        <li>Facial recognition or biometric surveillance — or NCII / CSAM</li>
      </ul>
    </div>

    <div class="sec">
      <div class="ico">🔒</div>
      <div>
        <h2>Privacy</h2>
        <p>Answers run on Berget.ai (EU-hosted), web search via Exa (which
        keeps queries). Conversations aren’t stored server-side beyond a
        ≤15-min recovery buffer; logs are metadata only.</p>
      </div>
    </div>

    <div class="actions">
      <form method="post" action="/terms/accept">
        <button class="primary" type="submit">I understand — let’s go</button>
      </form>
      <form method="post" action="/logout"><button class="plain" type="submit">or sign out</button></form>
    </div>
    <p class="fine">Accepting is recorded on your account. Misuse is grounds for revoking access.</p>
  </div>
</body>
</html>`;
}

/** @type {Record<string, string>} */
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** @param {unknown} s @returns {string} */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The sign-in page. Unknown flash codes render no message.
 * @param {string} flash "" | "google-failed" | "google-unverified" | "disabled" | "nodb"
 * @returns {string} full HTML document
 */
export function loginPage(flash) {
  /** @type {Record<string, string>} */
  const messages = {
    "google-failed": '<p class="err">Google sign-in didn’t complete. Please try again.</p>',
    "google-unverified":
      '<p class="err">That Google account’s email address is not verified — verify it with Google first.</p>',
    disabled: '<p class="err">This account has been disabled by the site owner.</p>',
    nodb: '<p class="err">Sign-in is temporarily unavailable (accounts database not configured).</p>',
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deepresearch.se — sign in</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/icons/icon-192.png?v=4" alt="">
    <h1>Deepresearch.se</h1>
    ${messages[flash] || ""}
    <a class="gbtn" href="/auth/google">${G_SVG} Continue with Google</a>
    <p class="muted">Sign in with your Google account. New accounts start
    with a standard research quota; your conversations are never stored on
    the server.</p>
  </div>
</body>
</html>`;
}

/**
 * Shown site-wide when a REQUIRED server secret is missing (currently
 * SESSION_SECRET — the sole session/OAuth-state signing key, with no fallback).
 * Rather than run in a broken or insecure state, the site presents this
 * misconfiguration message so the operator knows exactly what to set. No user
 * input is reflected; the copy is static.
 * @returns {string} full HTML document
 */
export function configErrorPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deepresearch.se — not configured</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>Deepresearch.se</h1>
    <p class="err">This site is not fully configured yet.</p>
    <p class="muted">The <code>SESSION_SECRET</code> server secret is not set,
    so sign-in is unavailable. The site owner needs to configure it (a random,
    high-entropy value) before anyone can sign in. Sign-in stays disabled until
    then rather than falling back to a weaker key.</p>
  </div>
</body>
</html>`;
}

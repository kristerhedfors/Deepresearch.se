// Server-rendered sign-in page. Google is the only user-facing sign-in;
// this page is what unauthenticated browsers/PWAs get instead of a bare
// 401 challenge (which an installed PWA cannot answer — black screen).
// Styled to match the app's sky-blue theme.

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

// Waiting room for the approval gate: shown to signed-in users whose
// account is still status "pending". Auto-refreshes so approval kicks in
// without any user action; signing out is the only available act.
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
    <img class="logo" src="/icons/icon-192.png?v=3" alt="">
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// flash: "" | "google-failed" | "google-unverified" | "disabled" | "nodb"
export function loginPage(flash) {
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
    <img class="logo" src="/icons/icon-192.png?v=3" alt="">
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

// Server-rendered auth pages: login (with request-access) and the invite
// landing page. Shown to unauthenticated browsers/PWAs instead of a bare
// 401 challenge (which an installed PWA cannot answer — black screen).
// Styled to match the app's sky-blue theme; autocomplete attributes let
// password managers fill the same credentials used for Basic Auth.

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
      display: flex; flex-direction: column; gap: .7rem; text-align: center;
    }
    img.logo { width: 72px; height: 72px; margin: 0 auto .2rem; border-radius: 18px; }
    h1 { font-size: 1.05rem; margin: 0 0 .3rem; }
    input, textarea {
      background: #fff; color: inherit; border: 1px solid #8ec4ec;
      border-radius: 8px; padding: .6rem .7rem; font: inherit; width: 100%;
    }
    textarea { resize: vertical; min-height: 60px; }
    button {
      background: #0d4fa0; color: #fff; border: 0; border-radius: 8px;
      padding: .6rem; font: inherit; font-weight: 600; cursor: pointer;
    }
    .err { color: #9a1c1c; font-size: .85rem; margin: 0; }
    .ok { color: #157a4b; font-size: .85rem; margin: 0; }
    .muted { color: #2f5d8e; font-size: .8rem; margin: .2rem 0 0; line-height: 1.45; }
    details { text-align: left; font-size: .85rem; }
    details summary { cursor: pointer; color: #0d4fa0; font-weight: 600; text-align: center; }
    details form { display: flex; flex-direction: column; gap: .55rem; margin-top: .6rem; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>${PAGE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// flash: "" | "failed" | "requested" | "request-off"
export function loginPage(flash, allowRequests = true) {
  const messages = {
    failed: '<p class="err">Wrong username/email or password.</p>',
    requested:
      '<p class="ok">Request sent. You’ll receive an invitation link if access is granted.</p>',
    "request-off": '<p class="err">Access requests are currently disabled.</p>',
  };
  const requestBlock = allowRequests
    ? `
    <details${flash === "requested" || flash === "request-off" ? " open" : ""}>
      <summary>No account? Request access</summary>
      <form method="post" action="/request-access">
        <input name="email" type="email" placeholder="Your email" autocomplete="email" required>
        <textarea name="message" placeholder="Who are you / why do you want access? (optional)" maxlength="500"></textarea>
        <button type="submit">Request access</button>
        <p class="muted">The site owner reviews requests manually. If approved,
        you’ll get a personal invitation link bound to this email.</p>
      </form>
    </details>`
    : "";
  return page(
    "Deepresearch.se — sign in",
    `  <div class="card">
    <img class="logo" src="/icons/icon-192.png?v=3" alt="">
    <h1>Deepresearch.se</h1>
    ${messages[flash] || ""}
    <form method="post" action="/login" style="display:flex;flex-direction:column;gap:.7rem">
      <input name="username" placeholder="Email or username" autocomplete="username" required autofocus>
      <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit">Sign in</button>
    </form>
    ${requestBlock}
  </div>`,
  );
}

// Invite landing: the token is validated server-side before rendering; this
// page only sets the password for the pre-bound email. `error` re-renders
// with a message; a null invite renders the invalid state.
export function invitePage(invite, error = "") {
  if (!invite) {
    return page(
      "Deepresearch.se — invitation",
      `  <div class="card">
    <img class="logo" src="/icons/icon-192.png?v=3" alt="">
    <h1>Invitation not valid</h1>
    <p class="muted">This invitation link is invalid, expired, or has already
    been used. Ask the site owner for a new one, or request access from the
    <a href="/">sign-in page</a>.</p>
  </div>`,
    );
  }
  return page(
    "Deepresearch.se — accept invitation",
    `  <div class="card">
    <img class="logo" src="/icons/icon-192.png?v=3" alt="">
    <h1>Welcome to Deepresearch.se</h1>
    <p class="muted">This invitation is for <b>${escapeHtml(invite.email)}</b>.
    Choose a password to create your account.</p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/invite" style="display:flex;flex-direction:column;gap:.7rem">
      <input type="hidden" name="token" value="${escapeHtml(invite.token)}">
      <input name="name" placeholder="Your name (optional)" autocomplete="name" maxlength="120">
      <input name="password" type="password" placeholder="Password (min 8 characters)" autocomplete="new-password" minlength="8" required autofocus>
      <button type="submit">Create account</button>
      <p class="muted">You’ll sign in with your email and this password.
      Google sign-in is coming later.</p>
    </form>
  </div>`,
  );
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

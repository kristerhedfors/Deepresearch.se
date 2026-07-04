// The login page shown to unauthenticated browsers/PWAs instead of a bare
// 401 challenge (which an installed PWA cannot answer — black screen).
// Styled to match the app's sky-blue theme; autocomplete attributes let
// password managers fill the same credentials used for Basic Auth.

export function loginPage(failed) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deepresearch.se — sign in</title>
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <meta name="theme-color" content="#6fc3fd">
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #6fc3fd; color: #0a2e5c;
      display: grid; place-items: center;
    }
    form {
      background: #f2f9ff; border: 1px solid #8ec4ec; border-radius: 14px;
      padding: 1.6rem; width: min(320px, 90vw);
      display: flex; flex-direction: column; gap: .7rem; text-align: center;
    }
    img { width: 72px; height: 72px; margin: 0 auto .2rem; border-radius: 18px; }
    h1 { font-size: 1.05rem; margin: 0 0 .3rem; }
    input {
      background: #fff; color: inherit; border: 1px solid #8ec4ec;
      border-radius: 8px; padding: .6rem .7rem; font: inherit;
    }
    button {
      background: #0d4fa0; color: #fff; border: 0; border-radius: 8px;
      padding: .6rem; font: inherit; font-weight: 600; cursor: pointer;
    }
    .err { color: #9a1c1c; font-size: .85rem; margin: 0; }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <img src="/icons/icon-192.png?v=3" alt="">
    <h1>Deepresearch.se</h1>
    ${failed ? '<p class="err">Wrong username or password.</p>' : ""}
    <input name="username" placeholder="Username" autocomplete="username" required autofocus>
    <input name="password" type="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

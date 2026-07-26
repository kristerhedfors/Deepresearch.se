// @ts-check
// The PUBLIC bootstrap for documentation comment mode.
//
// Any documentation page opts in with ONE script tag:
//
//   <script type="module">
//     import { mountCommentMode } from "/js/doc-comment-gate.js";
//     mountCommentMode({ path: "public/help/index.html" });
//   </script>
//
// Everything else — the mode dropdown, the comment rail, the styles, the
// selection handling — is injected by the layer itself (docs-comments.js), so
// a page needs no markup, no CSS and no layout cooperation to carry comments.
// That is deliberate: the first cut wired comment mode into ONE page's grid
// layout, which made "add it to the other documentation pages" a per-page
// porting job — and the owner's actual documentation page (/help/) went
// without it while the feature looked shipped (2026-07-25).
//
// This module is PUBLIC because documentation pages are public. It reveals
// nothing: the admin check happens against /api/me, and the layer that can
// actually write a comment (/js/docs-comments.js) stays behind the identity
// gate. Every outcome is VISIBLE — a gated feature must say that it is gated,
// or "not for you" and "broken" look identical.

/**
 * @param {{
 *   path: string,
 *   rootEl?: HTMLElement | null,
 *   textOf?: () => string,
 *   pathOf?: () => string,
 * }} opts
 *   path    repo-relative source file of the document (the feedback entry's
 *           tag, so the development loop knows which file to reconcile)
 *   rootEl  the element holding the prose (default: <main>, then <body>)
 *   textOf  the document's text as it reads now (default: rootEl.innerText)
 *   pathOf  for a viewer that swaps documents in place (/docs/), the CURRENT
 *           path — overrides `path` per render
 * @returns {Promise<{ onDocRendered: () => void } | null>}
 */
export async function mountCommentMode(opts) {
  const rootEl = opts?.rootEl || document.querySelector("main") || document.body;
  if (!rootEl) return null;

  let me = null;
  try {
    const res = await fetch("/api/me");
    if (res.ok) me = await res.json();
  } catch (e) {
    console.warn("[doc-comments] could not read the identity:", e);
  }
  if (me?.role !== "admin") {
    // Signed out is the ordinary way to arrive on a public documentation page
    // and the case worth explaining; a signed-in non-admin is told plainly.
    // Neither is an error, and neither may be silent.
    showNote(
      me
        ? "Comment mode is for administrators."
        : '<a href="/rver">Sign in as an administrator</a> to comment on this documentation.',
    );
    return null;
  }
  try {
    // A served URL, not a package specifier — the typechecker can't resolve it
    // (same convention as docs.js's pdf.js import).
    // @ts-ignore
    const { mountDocComments } = await import("/js/docs-comments.js");
    return mountDocComments({
      rootEl: /** @type {HTMLElement} */ (rootEl),
      pathOf: opts.pathOf || (() => opts.path),
      textOf: opts.textOf || (() => /** @type {HTMLElement} */ (rootEl).innerText || ""),
    });
  } catch (e) {
    console.error("[doc-comments] comment mode failed to load:", e);
    showNote("Comment mode failed to load — details in the browser console.");
    return null;
  }
}

/**
 * The quiet fallback badge, in the same corner the mode dropdown occupies.
 * Self-contained so a page that never loads the full layer still explains
 * itself.
 * @param {string} html trusted, built above — never user or document content
 */
function showNote(html) {
  const el = document.createElement("div");
  el.className = "dc-slot dc-slot-note";
  el.innerHTML = html;
  el.setAttribute(
    "style",
    "position:fixed;top:.5rem;right:.6rem;z-index:40;font:400 .74rem/1.4 system-ui,-apple-system,sans-serif;" +
      "background:rgba(127,127,127,.14);color:inherit;opacity:.75;border-radius:999px;padding:.25rem .7rem;" +
      "backdrop-filter:blur(6px);max-width:min(70vw,26rem);",
  );
  document.body.appendChild(el);
}

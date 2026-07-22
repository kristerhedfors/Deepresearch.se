// A tiny, SANITIZED markdown-ish renderer (baseplate-client step 4) — no
// vendored libs, no dependencies (PA-5). We escape ALL HTML first, then apply a
// small set of safe transforms, so hostile web content quoted in an answer can
// never inject markup. This is deliberately minimal; a fuller instance would
// vendor marked + DOMPurify same-origin, but the escape-first design keeps this
// build self-contained and provably safe. Pure — Node-testable.

/** @param {string} s @returns {string} */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a small, safe subset of markdown to HTML. Input is escaped up front,
 * so every transform below operates on already-safe text.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Fenced code blocks (``` … ```).
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/^\n/, "").replace(/\n$/, "")}</code></pre>`);
  // Inline code.
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Bold / italic.
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Bare-URL citations -> links (http/https only; target/rel hardened).
  html = html.replace(/(https?:\/\/[^\s<)\]]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

  // Paragraph/line breaks (leave <pre> blocks alone).
  return html
    .split(/\n{2,}/)
    .map((block) => (block.startsWith("<pre>") ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`))
    .join("");
}

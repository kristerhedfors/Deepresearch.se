// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, escapeHtml } from "./markdown.js";

test("escapes hostile HTML before any transform (no injection)", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)> and <script>bad()</script>');
  assert.ok(!out.includes("<img"), "raw tags must be escaped");
  assert.ok(!out.includes("<script"), "raw script must be escaped");
  assert.ok(out.includes("&lt;img"));
});

test("renders bold, inline code, and fenced code", () => {
  assert.match(renderMarkdown("**bold**"), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown("`x`"), /<code>x<\/code>/);
  assert.match(renderMarkdown("```\ncode\n```"), /<pre><code>code<\/code><\/pre>/);
});

test("links bare URLs with hardened rel/target", () => {
  const out = renderMarkdown("see https://example.com/x");
  assert.match(out, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">/);
});

test("javascript: URLs are not linkified (only http/https)", () => {
  const out = renderMarkdown("javascript:alert(1)");
  assert.ok(!out.includes("<a "));
});

test("escapeHtml handles the core entities", () => {
  assert.equal(escapeHtml('<>&"'), "&lt;&gt;&amp;&quot;");
});

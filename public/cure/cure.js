// The published-research viewer (/cure, /cure/<slug> — src/pub.js serves
// the JSON at /api/pub[/<slug>]). Read-only replay of a frozen
// deep-research session; "Continue with your own API keys" hands the
// conversation to free mode (/?continue=<slug>), where the free page
// seeds a chat from the same messages and follow-ups run on the
// visitor's own key. Reuses free mode's stylesheet and the site's
// markdown renderer — this page adds no machinery of its own.

import { renderMarkdownInto } from "/js/markdown.js";

const $ = (id) => document.getElementById(id);

function slugFromPath() {
  const m = location.pathname.match(/^\/cure\/([a-z0-9-]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

function messageEl(role, content) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  if (role === "assistant") renderMarkdownInto(el, content);
  else el.textContent = content;
  return el;
}

async function showPublication(slug) {
  const res = await fetch("/api/pub/" + encodeURIComponent(slug));
  if (!res.ok) {
    $("msgs").innerHTML = "";
    $("pubtitle").textContent = res.status === 404 ? "No such publication" : "Publication unavailable";
    return;
  }
  const pub = await res.json();
  document.title = pub.title + " — Deepresearch";
  $("pubtitle").textContent = pub.title;
  if (pub.description) {
    $("pubdesc").textContent = pub.description;
    $("pubdesc").hidden = false;
  }
  const when = pub.createdAt ? new Date(pub.createdAt).toISOString().slice(0, 10) : "";
  $("pubmeta").textContent = ["Frozen research replay", when, pub.model ? "model: " + pub.model : ""]
    .filter(Boolean)
    .join(" · ");
  $("pubmeta").hidden = false;
  const box = $("msgs");
  box.innerHTML = "";
  for (const m of pub.messages || []) box.appendChild(messageEl(m.role, m.content));
  $("continuelink").href = "/?continue=" + encodeURIComponent(slug);
  $("continuelink").hidden = false;
}

async function showIndex() {
  $("pubtitle").textContent = "Published research";
  const res = await fetch("/api/pub");
  const data = res.ok ? await res.json() : null;
  const items = data?.publications || [];
  $("msgs").innerHTML = "";
  const list = $("publist");
  list.hidden = false;
  if (!items.length) {
    list.innerHTML = '<p class="muted">Nothing published yet.</p>';
    return;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  list.innerHTML = items
    .map(
      (p) => `
    <a class="pub-item" href="/cure/${encodeURIComponent(p.slug)}">
      <strong>${esc(p.title)}</strong>
      ${p.description ? `<span class="muted">${esc(p.description)}</span>` : ""}
      <span class="muted">${p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : ""}</span>
    </a>`,
    )
    .join("");
}

const slug = slugFromPath();
(slug ? showPublication(slug) : showIndex()).catch(() => {
  $("msgs").innerHTML = '<p class="muted">Could not load this page.</p>';
});

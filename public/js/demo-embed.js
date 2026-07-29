// @ts-check
// The capability-demo CARD — the DOM half of the demo registry, for the
// surfaces that are a whole PAGE rather than an inline scene (kind: "page" in
// public/js/demo-core.js). A matched ask mounts one of these above the reply:
// what the surface is, what it does, and a link straight into it.
//
// Why a card and not an embed: /watch/ is a WebGL builder with its own
// catalogue, permalink codec and sourcing table — a real page, not a canvas.
// Inlining it would mean a second copy of that page inside a chat turn. The
// card is the honest shape: it tells the user the capability exists and takes
// them one tap into it. (The /space/ scenes DO embed — they are a canvas and a
// caption — which is why the registry distinguishes the two kinds.)
//
// Self-contained on purpose, the same rule space-embed.js follows: it injects
// its own scoped CSS (`dm-` classes) once per document, so both tiers mount it
// without either page owning card styling. All deterministic logic (the
// registry, the matchers, the language pick) stays in the pure core
// demo-core.js; this module is DOM glue only — the bash-core.js/bash-agent.js
// division again.
//
// Fail-soft, decorative-additive: the answer streams below regardless, and
// mountDemoCard returning null must never break a turn.

const CARD_CSS = `
.dm-card {
  display: block; border: 1px solid rgba(127,180,238,.28); border-radius: 12px;
  padding: .75rem .85rem; margin: 0 0 .6rem; text-decoration: none;
  background: rgba(127,180,238,.06); color: inherit;
}
.dm-card:hover { border-color: rgba(127,180,238,.5); background: rgba(127,180,238,.1); }
.dm-card .dm-kicker {
  font-size: .7rem; letter-spacing: .08em; text-transform: uppercase;
  opacity: .6; margin-bottom: .2rem;
}
.dm-card .dm-title { font-weight: 600; font-size: .98rem; margin-bottom: .25rem; }
.dm-card .dm-blurb { font-size: .85rem; line-height: 1.45; opacity: .8; }
.dm-card .dm-go { display: inline-block; margin-top: .4rem; font-size: .8rem; color: #7fb4ee; }
`;

const UI = {
  kicker: { en: "On this site", sv: "På den här sidan" },
  go: { en: "Open it →", sv: "Öppna →" },
};

/** @param {Document} doc */
function ensureStyles(doc) {
  if (doc.getElementById("dm-card-styles")) return;
  const style = doc.createElement("style");
  style.id = "dm-card-styles";
  style.textContent = CARD_CSS;
  doc.head.appendChild(style);
}

/**
 * Mounts the card for one resolved page demo. Returns the element, or null
 * when the match is not a page surface (a space match embeds instead).
 *
 * @param {HTMLElement} host
 * @param {{kind: string, lang: string, path: string,
 *          title: {en: string, sv: string}, blurb: {en: string, sv: string}}} demo
 * @returns {HTMLElement|null}
 */
export function mountDemoCard(host, demo) {
  if (!host || !demo || demo.kind !== "page") return null;
  const lang = demo.lang === "sv" ? "sv" : "en";
  const doc = host.ownerDocument;
  if (!doc) return null;
  ensureStyles(doc);

  const card = doc.createElement("a");
  card.className = "dm-card";
  card.href = demo.path;

  const kicker = doc.createElement("div");
  kicker.className = "dm-kicker";
  kicker.textContent = UI.kicker[lang];
  card.appendChild(kicker);

  const title = doc.createElement("div");
  title.className = "dm-title";
  title.textContent = demo.title[lang];
  card.appendChild(title);

  const blurb = doc.createElement("div");
  blurb.className = "dm-blurb";
  blurb.textContent = demo.blurb[lang];
  card.appendChild(blurb);

  const go = doc.createElement("div");
  go.className = "dm-go";
  go.textContent = UI.go[lang];
  card.appendChild(go);

  host.appendChild(card);
  return card;
}

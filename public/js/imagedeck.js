// The conversation-level IMAGE DECK (requested 2026-07-09): every Street
// View frame / map image a reply shows joins one ordered, conversation-wide
// deck. Clicking a thumbnail (in a frames strip, or a waypoint miniature on
// the interactive map) opens the deck's LIGHTBOX: the image enlarged, ‹/›
// navigation through every image the conversation has produced so far, a
// miniature map in the upper-left corner of the current image's position
// (clicking it opens actual Google Maps), and a per-image chat panel —
// asking there anchors the next message AT that image's position, so the
// conversation continues from that point on the map (the same map_view
// anchor mechanism the live interactive map uses; activity.js/app.js wire
// the handler).
//
// The deck is live-session only, like the frame strips themselves (data
// URLs are never persisted — a reloaded conversation keeps answers and
// links, not imagery). The registry/order/nearest-lookup core is pure and
// import-safe in Node (no DOM until the lightbox opens) — unit-tested in
// imagedeck.test.js.

// ---- pure core -----------------------------------------------------------------

let entries = []; // [{url, caption, lat, lng, kind}] — conversation order

export function resetDeck() {
  entries = [];
  closeDeck();
}

export function deckEntries() {
  return entries;
}

// Registers a reply's images (already validated data URLs). Returns the
// index of the first added entry so callers can open the deck at the
// clicked thumbnail. Coordinates are optional (older servers / map-kind
// frames) — the lightbox simply hides the mini-map without them.
export function addDeckEntries(frames) {
  const start = entries.length;
  for (const f of Array.isArray(frames) ? frames : []) {
    if (typeof f?.url !== "string" || !f.url.startsWith("data:image/")) continue;
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    const heading = Number(f.heading);
    entries.push({
      url: f.url,
      caption: f.caption || "",
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      // The frame's viewing direction — lets an ask-from-this-image
      // reproduce EXACTLY this view as the POV anchor.
      heading: Number.isFinite(heading) ? heading : 0,
      kind: f.kind === "map" ? "map" : "photo",
    });
  }
  return start;
}

// Keyless Google Maps embed URL — the classic `output=embed` surface, which
// needs NO API key or service enablement (it 301s to google.com/maps/embed
// and renders a normal navigable map). The key-based Embed API
// (embed/v1/*) is deliberately NOT used for the mini-map: when the site's
// key lacks the "Maps Embed API" service, embed/v1 renders a WHITE
// rejection page that is undetectable from outside the iframe — observed
// live 2026-07-09 (chat_logs #170/#171, "mini image in maps view is just
// white") while the very same key served the JS SDK and Static Maps fine.
// Pure — unit-tested in imagedeck.test.js.
export function keylessMapEmbedUrl(lat, lng, zoom = 16) {
  return `https://maps.google.com/maps?${new URLSearchParams({
    q: `${lat},${lng}`,
    z: String(Math.round(Number(zoom) || 16)),
    output: "embed",
  })}`;
}

// Keyless Street View embed — same rationale and surface as
// keylessMapEmbedUrl (the classic output=svembed form, 301s to
// google.com/maps/embed with the panorama params). The cbp pitch field is
// INVERTED relative to the SDK's pitch (verified against the embed?pb
// redirect: cbp …,-10 → pb 4f10), hence the negation. Pure — unit-tested.
export function keylessStreetViewEmbedUrl(lat, lng, heading = 0, pitch = 0) {
  return `https://maps.google.com/maps?${new URLSearchParams({
    layer: "c",
    cbll: `${lat},${lng}`,
    cbp: `11,${Math.round(Number(heading) || 0)},0,0,${-Math.round(Number(pitch) || 0)}`,
    output: "svembed",
  })}`;
}

// Equirectangular meters — same approximation as the server's
// distanceMeters (src/googlemaps-text.js).
function metersBetween(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// The LATEST deck image at (or within maxM of) a position — "clicking a
// waypoint miniature takes you to that image in the deck up to that point":
// among the images within the radius, the most RECENT visit wins (not the
// geometrically closest — an early exact-position image must not shadow a
// later revisit), so the deck opens on the image the user last saw there.
// -1 when nothing is near. Pure.
export function nearestDeckIndex(lat, lng, maxM = 30) {
  let best = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.lat == null || e.lng == null) continue;
    if (metersBetween(e.lat, e.lng, lat, lng) <= maxM) best = i;
  }
  return best;
}

// ---- lightbox (DOM from here down) ----------------------------------------------

let askHandler = null; // (text, {lat,lng}) => void — wired by app.js
export function onDeckAsk(fn) {
  askHandler = fn;
}

let overlay = null;
let current = 0;

export function closeDeck() {
  if (overlay) {
    overlay.remove();
    overlay = null;
    document.removeEventListener("keydown", onKey);
  }
}

function onKey(e) {
  if (e.key === "Escape") closeDeck();
  else if (e.key === "ArrowLeft") show(current - 1);
  else if (e.key === "ArrowRight") show(current + 1);
}

const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

function show(index) {
  if (!overlay || !entries.length) return;
  current = Math.max(0, Math.min(entries.length - 1, index));
  const e = entries[current];
  overlay.querySelector(".imagedeck-img").src = e.url;
  overlay.querySelector(".imagedeck-caption").textContent = e.caption || (e.kind === "map" ? "map view" : "");
  overlay.querySelector(".imagedeck-pos").textContent = `${current + 1} / ${entries.length}`;
  overlay.querySelector(".imagedeck-prev").disabled = current === 0;
  overlay.querySelector(".imagedeck-next").disabled = current === entries.length - 1;

  // Mini-map, upper-left: a KEYLESS Google Maps embed of THIS image's
  // position (pointer-events off — the wrapping link is the click target,
  // opening actual Google Maps). Keyless deliberately: see
  // keylessMapEmbedUrl. Hidden when the entry carries no coordinates, and
  // for map-kind entries the link alone stands (the big image IS a map).
  const mini = overlay.querySelector(".imagedeck-minimap");
  mini.replaceChildren();
  if (e.lat != null && e.lng != null) {
    const a = document.createElement("a");
    a.href = mapsLink(e.lat, e.lng);
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Open in Google Maps";
    if (e.kind !== "map") {
      const iframe = document.createElement("iframe");
      iframe.loading = "lazy";
      iframe.title = "Mini map";
      iframe.src = keylessMapEmbedUrl(e.lat, e.lng, 16);
      a.appendChild(iframe);
    } else {
      a.textContent = "Open in Google Maps";
      a.className = "imagedeck-maplink";
    }
    mini.appendChild(a);
    mini.hidden = false;
  } else {
    mini.hidden = true;
  }
  const input = overlay.querySelector(".imagedeck-ask input");
  input.placeholder = e.lat != null ? "Ask about this place — continues the chat from here…" : "Ask about this image…";
}

export function openDeck(index) {
  if (!entries.length || typeof document === "undefined") return;
  closeDeck();
  overlay = document.createElement("div");
  overlay.className = "imagedeck-overlay";
  overlay.innerHTML =
    '<div class="imagedeck-frame">' +
    '<button class="imagedeck-close" aria-label="Close">×</button>' +
    '<div class="imagedeck-minimap" hidden></div>' +
    '<img class="imagedeck-img" alt="Enlarged view">' +
    '<button class="imagedeck-prev" aria-label="Previous">‹</button>' +
    '<button class="imagedeck-next" aria-label="Next">›</button>' +
    '<div class="imagedeck-bar"><span class="imagedeck-caption"></span><span class="imagedeck-pos"></span></div>' +
    '<form class="imagedeck-ask"><input type="text" autocomplete="off"><button type="submit">Ask</button></form>' +
    "</div>";
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeDeck();
  });
  overlay.querySelector(".imagedeck-close").addEventListener("click", closeDeck);
  overlay.querySelector(".imagedeck-prev").addEventListener("click", () => show(current - 1));
  overlay.querySelector(".imagedeck-next").addEventListener("click", () => show(current + 1));
  overlay.querySelector(".imagedeck-ask").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = overlay.querySelector(".imagedeck-ask input");
    const text = (input.value || "").trim();
    if (!text) return;
    const e = entries[current];
    const point = e.lat != null && e.lng != null ? { lat: e.lat, lng: e.lng, heading: e.heading, kind: e.kind } : null;
    closeDeck();
    if (askHandler) askHandler(text, point);
  });
  // Touch swipe: left/right anywhere on the lightbox (except the ask
  // input) steps through the deck — the mobile complement to the ‹/›
  // buttons and arrow keys (reported 2026-07-09: "can't swipe back or
  // forth when looking at an image").
  let swipeX = null;
  let swipeY = null;
  overlay.addEventListener(
    "touchstart",
    (ev) => {
      if (ev.target.closest(".imagedeck-ask")) return;
      swipeX = ev.touches[0].clientX;
      swipeY = ev.touches[0].clientY;
    },
    { passive: true },
  );
  overlay.addEventListener(
    "touchend",
    (ev) => {
      if (swipeX == null) return;
      const t = ev.changedTouches[0];
      const dx = t.clientX - swipeX;
      const dy = t.clientY - swipeY;
      swipeX = swipeY = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) show(current + (dx < 0 ? 1 : -1));
    },
    { passive: true },
  );
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  show(index);
}

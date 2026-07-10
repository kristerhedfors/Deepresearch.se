// A minimal slippy map over OpenStreetMap raster tiles — no library, in
// keeping with the project's no-dependency stance (the whole thing is Web
// Mercator math plus absolutely-positioned <img> tiles under one CSS
// transform). OSM's tile usage policy is honored: light, user-driven load
// and the attribution line index.html renders.

const TILE = 256;

// Web Mercator world-pixel projections at zoom z (and their inverses).
export const lngToX = (lng, z) => ((lng + 180) / 360) * TILE * 2 ** z;
export const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
export const xToLng = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
export const yToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * @param {HTMLElement} container  Fills this element; pointer events are
 *   claimed for drag-to-pan and tap-to-walk.
 * @param {{zoom?: number, onTap?: (ll: {lat: number, lng: number}) => void}} [opts]
 * @returns {{
 *   setCenter: (lat: number, lng: number) => void,
 *   getCenter: () => {lat: number, lng: number},
 *   setMarkers: (list: Array<{id: string, lat: number, lng: number, html: string, cls?: string, onClick?: (m: object) => void}>) => void,
 *   destroy: () => void,
 * }} Markers are diffed by id, so callers re-send the full list each render.
 */
export function createMap(container, { zoom = 17, onTap } = {}) {
  const world = document.createElement("div"); // shared coordinate space
  world.className = "tk-world";
  const tileLayer = document.createElement("div");
  const markerLayer = document.createElement("div");
  world.appendChild(tileLayer);
  world.appendChild(markerLayer);
  container.appendChild(world);

  let center = { lat: 59.3326, lng: 18.0649 };
  const tiles = new Map(); // "x:y" (world tile indices) → img
  const markers = new Map(); // id → {el, lat, lng}

  // FLOATING ORIGIN — the load-bearing detail of this map. World-pixel
  // coordinates at zoom 17 reach ~18 million px (x = 18.4M at Stockholm's
  // longitude), which is past WebKit's ~2^24 (16.7M) rasterization limit:
  // iOS Safari silently dropped every tile <img> positioned there while the
  // emoji markers survived on their own composited layers ("map is blank,
  // markers float in the void", reported 2026-07-09). So nothing is ever
  // positioned at world coordinates: everything is placed RELATIVE to an
  // integer tile origin near the viewport, and the origin re-anchors when
  // the center drifts, keeping every offset within a few thousand px.
  let origin = null; // {tx, ty}

  const originPx = () => ({ x: origin.tx * TILE, y: origin.ty * TILE });

  function ensureOrigin() {
    const tx = Math.floor(lngToX(center.lng, zoom) / TILE);
    const ty = Math.floor(latToY(center.lat, zoom) / TILE);
    if (origin && Math.abs(tx - origin.tx) < 30 && Math.abs(ty - origin.ty) < 30) return;
    origin = { tx, ty };
    // Re-anchor everything already in the DOM to the new origin.
    for (const [key, img] of tiles) {
      const [wtx, wty] = key.split(":").map(Number);
      img.style.left = `${(wtx - origin.tx) * TILE}px`;
      img.style.top = `${(wty - origin.ty) * TILE}px`;
    }
    for (const m of markers.values()) place(m.el, m.lat, m.lng);
  }

  function render() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    ensureOrigin();
    const o = originPx();
    const cx = lngToX(center.lng, zoom) - o.x; // origin-relative center
    const cy = latToY(center.lat, zoom) - o.y;
    world.style.transform = `translate(${Math.round(w / 2 - cx)}px, ${Math.round(h / 2 - cy)}px)`;
    // Tiles covering the viewport plus a one-tile skirt (world indices).
    const x0 = origin.tx + Math.floor((cx - w / 2) / TILE) - 1;
    const x1 = origin.tx + Math.floor((cx + w / 2) / TILE) + 1;
    const y0 = origin.ty + Math.floor((cy - h / 2) / TILE) - 1;
    const y1 = origin.ty + Math.floor((cy + h / 2) / TILE) + 1;
    const max = 2 ** zoom;
    const wanted = new Set();
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= max) continue;
        const wx = ((tx % max) + max) % max; // wrap longitude
        const key = `${tx}:${ty}`;
        wanted.add(key);
        if (!tiles.has(key)) {
          const img = document.createElement("img");
          img.className = "tk-tile";
          img.src = `https://tile.openstreetmap.org/${zoom}/${wx}/${ty}.png`;
          img.style.left = `${(tx - origin.tx) * TILE}px`;
          img.style.top = `${(ty - origin.ty) * TILE}px`;
          img.draggable = false;
          img.alt = "";
          // A failed tile is forgotten so the next render retries it.
          img.addEventListener("error", () => {
            tiles.delete(key);
            img.remove();
          });
          tileLayer.appendChild(img);
          tiles.set(key, img);
        }
      }
    }
    for (const [key, img] of tiles) {
      if (!wanted.has(key)) {
        img.remove();
        tiles.delete(key);
      }
    }
  }

  function place(el, lat, lng) {
    const o = originPx();
    el.style.left = `${Math.round(lngToX(lng, zoom) - o.x)}px`;
    el.style.top = `${Math.round(latToY(lat, zoom) - o.y)}px`;
  }

  function setMarkers(list) {
    const wanted = new Set(list.map((m) => m.id));
    for (const [id, m] of markers) {
      if (!wanted.has(id)) {
        m.el.remove();
        markers.delete(id);
      }
    }
    for (const m of list) {
      let cur = markers.get(m.id);
      if (!cur) {
        const el = document.createElement("div");
        el.className = `tk-marker ${m.cls || ""}`;
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          m.onClick?.(m);
        });
        markerLayer.appendChild(el);
        cur = { el };
        markers.set(m.id, cur);
      }
      cur.lat = m.lat; // kept so a re-anchor can re-place every marker
      cur.lng = m.lng;
      cur.el.className = `tk-marker ${m.cls || ""}`;
      if (cur.el.innerHTML !== m.html) cur.el.innerHTML = m.html;
      place(cur.el, m.lat, m.lng);
    }
  }

  // Drag to pan; a sub-6px pointerup is a tap (walk target).
  let drag = null;
  container.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, lat: center.lat, lng: center.lng, moved: false };
    container.setPointerCapture(e.pointerId);
  });
  container.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (drag.moved) {
      center = {
        lat: yToLat(latToY(drag.lat, zoom) - dy, zoom),
        lng: xToLng(lngToX(drag.lng, zoom) - dx, zoom),
      };
      render();
    }
  });
  container.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved && onTap) {
      const rect = container.getBoundingClientRect();
      const cx = lngToX(center.lng, zoom) + (e.clientX - rect.left - rect.width / 2);
      const cy = latToY(center.lat, zoom) + (e.clientY - rect.top - rect.height / 2);
      onTap({ lat: yToLat(cy, zoom), lng: xToLng(cx, zoom) });
    }
    drag = null;
  });
  container.addEventListener("pointercancel", () => (drag = null));

  const onResize = () => render();
  window.addEventListener("resize", onResize);
  render();

  return {
    setCenter(lat, lng) {
      center = { lat, lng };
      render();
    },
    getCenter: () => ({ ...center }),
    setMarkers,
    destroy() {
      window.removeEventListener("resize", onResize);
      world.remove();
    },
  };
}

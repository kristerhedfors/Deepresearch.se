// A minimal slippy map over OpenStreetMap raster tiles — no library, in
// keeping with the project's no-dependency stance (the whole thing is Web
// Mercator math plus absolutely-positioned <img> tiles under one CSS
// transform). OSM's tile usage policy is honored: light, user-driven load
// and the attribution line index.html renders.

const TILE = 256;

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

// createMap(container, {zoom, onTap}) → {setCenter, getCenter, setMarkers, destroy}
// Markers: [{id, lat, lng, html, cls, onClick}] — diffed by id.
export function createMap(container, { zoom = 17, onTap } = {}) {
  const world = document.createElement("div"); // shared coordinate space
  world.className = "tk-world";
  const tileLayer = document.createElement("div");
  const markerLayer = document.createElement("div");
  world.appendChild(tileLayer);
  world.appendChild(markerLayer);
  container.appendChild(world);

  let center = { lat: 59.3326, lng: 18.0649 };
  const tiles = new Map(); // "x:y" → img
  const markers = new Map(); // id → {el, lat, lng}

  function render() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    const cx = lngToX(center.lng, zoom);
    const cy = latToY(center.lat, zoom);
    world.style.transform = `translate(${Math.round(w / 2 - cx)}px, ${Math.round(h / 2 - cy)}px)`;
    // Tiles covering the viewport plus a one-tile skirt.
    const x0 = Math.floor((cx - w / 2) / TILE) - 1;
    const x1 = Math.floor((cx + w / 2) / TILE) + 1;
    const y0 = Math.floor((cy - h / 2) / TILE) - 1;
    const y1 = Math.floor((cy + h / 2) / TILE) + 1;
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
          img.style.left = `${tx * TILE}px`;
          img.style.top = `${ty * TILE}px`;
          img.draggable = false;
          img.alt = "";
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
    el.style.left = `${lngToX(lng, zoom)}px`;
    el.style.top = `${latToY(lat, zoom)}px`;
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

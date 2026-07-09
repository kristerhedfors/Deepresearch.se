// Street mode: the real-world AR pane. Renders the server's scene — a
// Street View frame captured at the player's position and heading — and
// overlays the projected spawns (creatures/items/villains) INSIDE the
// imagery at the x/y/scale the server computed (src/tokemon-nav.js).
// Navigation happens outside this module (text commands, look buttons,
// walking); this pane only presents and reports taps.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function createStreetView(container, { onTapSpawn, onTurn }) {
  container.innerHTML = `
    <div class="tk-sv-stage">
      <img class="tk-sv-img" alt="Street view" draggable="false">
      <div class="tk-sv-overlays"></div>
      <div class="tk-sv-note" hidden></div>
      <div class="tk-sv-compass"></div>
      <button class="tk-sv-turn tk-sv-left" type="button" aria-label="Turn left">⟲</button>
      <button class="tk-sv-turn tk-sv-right" type="button" aria-label="Turn right">⟳</button>
    </div>`;
  const img = container.querySelector(".tk-sv-img");
  const overlaysEl = container.querySelector(".tk-sv-overlays");
  const note = container.querySelector(".tk-sv-note");
  const compass = container.querySelector(".tk-sv-compass");
  container.querySelector(".tk-sv-left").addEventListener("click", () => onTurn?.(-45));
  container.querySelector(".tk-sv-right").addEventListener("click", () => onTurn?.(45));

  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function showMessage(msg) {
    img.removeAttribute("src");
    img.classList.add("empty");
    overlaysEl.innerHTML = "";
    compass.textContent = "";
    note.textContent = msg;
    note.hidden = false;
  }

  function render(scene) {
    if (!scene?.available) {
      showMessage(scene?.message || "Street view is unavailable here.");
      return;
    }
    note.hidden = true;
    img.classList.remove("empty");
    img.src = scene.image;
    compass.textContent =
      COMPASS[Math.round(scene.heading / 45) % 8] + ` ${scene.heading}°` + (scene.date ? ` · imagery ${scene.date}` : "");
    overlaysEl.innerHTML = "";
    for (const o of scene.overlays || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `tk-sv-spawn${o.near ? " near" : ""}`;
      b.style.left = `${o.xPct}%`;
      b.style.top = `${o.yPct}%`;
      b.style.fontSize = `${Math.round(30 * o.scale)}px`;
      b.innerHTML = `<span>${o.emoji}</span><i>${esc(o.name || "")}${o.kind === "creature" ? ` Lv ${o.level}` : ""} · ${o.distM} m</i>`;
      b.addEventListener("click", () => onTapSpawn?.(o));
      overlaysEl.appendChild(b);
    }
  }

  return {
    render,
    showLoading: () => showMessage("Fetching the street…"),
    showMessage,
  };
}

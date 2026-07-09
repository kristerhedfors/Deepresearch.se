// Tokemon bootstrap: player state, movement (GPS follow or tap-to-walk),
// spawn polling + markers, encounters, and the party/bag/dex panels. Game
// rules all live server-side (src/tokemon.js) — this is presentation and
// movement only.

import * as api from "./api.js";
import { createBattleUI } from "./battle.js";
import { createMap } from "./map.js";

const WALK_SPEED = 4; // m/s — brisk tap-to-walk so desktop play isn't a slog
const SPAWN_POLL_MS = 30_000;
const DEFAULT_POS = { lat: 59.3326, lng: 18.0649 }; // Sergels torg, Stockholm

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let save = null;
let pos = { ...DEFAULT_POS };
let walkTarget = null;
let gpsWatch = null;
let spawns = [];
let encounterRadius = 80;
let lastSpawnFetch = { t: 0, lat: 0, lng: 0 };
let map = null;
let battleUI = null;
let follow = true; // keep the camera on the player

const $ = (id) => document.getElementById(id);

function toast(msg, ms = 2600) {
  const t = $("tk-toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => (t.hidden = true), ms);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Movement

function setPos(lat, lng) {
  pos = { lat, lng };
  if (follow) map.setCenter(lat, lng);
  renderMarkers();
  maybeFetchSpawns();
}

function tick(last) {
  const now = performance.now();
  const dt = Math.min(1, (now - (last || now)) / 1000);
  if (walkTarget) {
    const d = haversineM(pos.lat, pos.lng, walkTarget.lat, walkTarget.lng);
    if (d < 1.5) {
      walkTarget = null;
    } else {
      const step = Math.min(1, (WALK_SPEED * dt) / d);
      setPos(pos.lat + (walkTarget.lat - pos.lat) * step, pos.lng + (walkTarget.lng - pos.lng) * step);
    }
  }
  requestAnimationFrame(() => tick(now));
}

function toggleGps() {
  if (gpsWatch != null) {
    navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = null;
    $("tk-gps").classList.remove("on");
    toast("GPS off — tap the map to walk.");
    return;
  }
  if (!navigator.geolocation) {
    toast("This browser has no geolocation — tap the map to walk.");
    return;
  }
  gpsWatch = navigator.geolocation.watchPosition(
    (p) => {
      walkTarget = null;
      $("tk-gps").classList.add("on");
      setPos(p.coords.latitude, p.coords.longitude);
    },
    () => {
      toast("Couldn't read your location — tap the map to walk instead.");
      navigator.geolocation.clearWatch(gpsWatch);
      gpsWatch = null;
      $("tk-gps").classList.remove("on");
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
  );
}

// ---------------------------------------------------------------------------
// Spawns & markers

async function maybeFetchSpawns(force = false) {
  const now = Date.now();
  const moved = haversineM(pos.lat, pos.lng, lastSpawnFetch.lat, lastSpawnFetch.lng);
  if (!force && now - lastSpawnFetch.t < SPAWN_POLL_MS && moved < 90) return;
  lastSpawnFetch = { t: now, lat: pos.lat, lng: pos.lng };
  try {
    const r = await api.getSpawns(pos.lat, pos.lng);
    spawns = r.spawns || [];
    encounterRadius = r.encounterRadiusM || 80;
    renderMarkers();
  } catch (err) {
    if (err.status === 503) showFatal(err.message);
  }
}

function renderMarkers() {
  if (!map) return;
  const markers = spawns.map((s) => ({
    id: s.id,
    lat: s.lat,
    lng: s.lng,
    cls: `tk-spawn tk-${s.kind}` + (haversineM(pos.lat, pos.lng, s.lat, s.lng) <= encounterRadius ? " near" : ""),
    html: `<span>${s.emoji}</span>${s.kind === "creature" ? `<i>Lv ${s.level}</i>` : s.kind === "villain" ? `<i>${esc(s.villain)}</i>` : ""}`,
    onClick: () => tapSpawn(s),
  }));
  markers.push({ id: "__player", lat: pos.lat, lng: pos.lng, cls: "tk-player", html: "🧭" });
  map.setMarkers(markers);
}

async function tapSpawn(s) {
  const d = haversineM(pos.lat, pos.lng, s.lat, s.lng);
  if (d > encounterRadius) {
    walkTarget = { lat: s.lat, lng: s.lng };
    toast(`${Math.round(d)} m away — walking there…`);
    return;
  }
  try {
    if (s.kind === "item") {
      const r = await api.collect(s.id, pos.lat, pos.lng);
      save = r.save;
      toast(`Picked up ${r.collected.count}× ${r.collected.item}!`);
      spawns = spawns.filter((x) => x.id !== s.id);
      renderMarkers();
      renderHud();
    } else {
      const r = await api.encounter(s.id, pos.lat, pos.lng);
      save = r.save;
      battleUI.open(r.battle, save);
    }
  } catch (err) {
    toast(err.message);
    if (err.status === 400 && /any more/i.test(err.message || "")) {
      spawns = spawns.filter((x) => x.id !== s.id);
      renderMarkers();
    }
  }
}

// ---------------------------------------------------------------------------
// HUD & panels

function renderHud() {
  const lead = save?.party?.[0];
  $("tk-lead").innerHTML = lead
    ? `${lead.emoji} <b>${esc(lead.name)}</b> Lv ${lead.level} · ${lead.hp}/${lead.maxHp} HP`
    : "No Tokemon yet";
  $("tk-balls").textContent = `⭕ ${save?.items?.tokeball ?? 0}`;
}

function closePanels() {
  $("tk-panel").hidden = true;
}

function openPanel(html) {
  const p = $("tk-panel");
  p.innerHTML = `<button class="tk-close" id="tk-panel-close">✕</button>${html}`;
  p.hidden = false;
  $("tk-panel-close").addEventListener("click", closePanels);
}

function creatureRow(c, where) {
  const pct = Math.max(0, Math.min(100, (c.hp / c.maxHp) * 100));
  const actions =
    where === "party"
      ? `<button data-op="lead" data-uid="${c.uid}">Lead</button>
         <button data-op="box" data-uid="${c.uid}">Box</button>`
      : `<button data-op="party" data-uid="${c.uid}">To party</button>`;
  const heals = ["potion", "superpotion", "revive"]
    .filter((i) => (save.items[i] || 0) > 0)
    .map((i) => `<button data-op="item" data-item="${i}" data-uid="${c.uid}">${i === "potion" ? "Patch" : i === "superpotion" ? "Hotfix" : "Reboot"}</button>`)
    .join("");
  return `<div class="tk-row">
    <div class="tk-row-main"><span class="tk-emoji">${c.emoji}</span>
      <b>${esc(c.name)}</b> Lv ${c.level} <small>${c.hp}/${c.maxHp} HP · ${c.moves.map((m) => esc(m.name)).join(", ")}</small>
      <div class="tk-hpbar"><div class="tk-hpfill${pct < 20 ? " crit" : pct < 50 ? " low" : ""}" style="width:${pct}%"></div></div>
    </div>
    <div class="tk-row-actions">${actions}${heals}</div>
  </div>`;
}

function openParty() {
  const party = (save.party || []).map((c) => creatureRow(c, "party")).join("") || "<p>No Tokemon in the party.</p>";
  const box = (save.box || []).map((c) => creatureRow(c, "box")).join("");
  openPanel(`<h2>Party</h2>${party}${box ? `<h2>Box</h2>${box}` : ""}`);
  $("tk-panel").querySelectorAll("[data-op]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const payload = { op: b.dataset.op, uid: b.dataset.uid };
        if (b.dataset.item) payload.item = b.dataset.item;
        const r = await api.party(payload);
        save = r.save;
        renderHud();
        openParty();
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}

const ITEM_LABEL = {
  tokeball: ["⭕ Tokeball", "catches wild Tokemon"],
  megaball: ["🔵 Megaball", "a better catch rate"],
  hyperball: ["🟡 Hyperball", "the best catch rate"],
  potion: ["🩹 Patch", "restores 20 HP"],
  superpotion: ["💊 Hotfix", "restores 50 HP"],
  revive: ["♻️ Reboot", "revives a fainted Tokemon"],
};

function openBag() {
  const rows = Object.entries(ITEM_LABEL)
    .map(([id, [label, desc]]) => `<div class="tk-row"><div class="tk-row-main"><b>${label}</b> ×${save.items[id] || 0} <small>${desc}</small></div></div>`)
    .join("");
  openPanel(`<h2>Bag</h2>${rows}
    <h2>Progress</h2>
    <div class="tk-row"><div class="tk-row-main">Caught ${save.stats.caught} · Battles won ${save.stats.battlesWon} · Villains beaten ${save.stats.villainsBeaten} · Items collected ${save.stats.itemsCollected}</div></div>`);
}

function openDex() {
  const entries = Object.entries(save.dex || {});
  const rows = entries.length
    ? entries
        .map(
          ([id, d]) =>
            `<div class="tk-row"><div class="tk-row-main"><b>${esc(id)}</b> <small>seen ${d.seen} · caught ${d.caught}</small></div></div>`,
        )
        .join("")
    : "<p>Nothing recorded yet — go find some Tokemon!</p>";
  openPanel(`<h2>Tokedex (${entries.filter(([, d]) => d.caught > 0).length} caught)</h2>${rows}`);
}

async function doHeal() {
  try {
    const r = await api.heal();
    save = r.save;
    renderHud();
    toast("Recharged — the whole team is at full power!");
  } catch (err) {
    if (err.status === 429 && err.body?.readyAt) {
      toast(`Recharge ready ${new Date(err.body.readyAt).toLocaleTimeString()}.`);
    } else {
      toast(err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Starter flow & fatal states

function showStarterPick() {
  const choices = (save.starters || [])
    .map(
      (s) => `<button class="tk-starter" data-id="${s.id}">
        <span class="tk-emoji">${s.emoji}</span><b>${esc(s.name)}</b><small>${s.types.join(", ")}</small></button>`,
    )
    .join("");
  openPanel(`<h2>Welcome to Tokemon!</h2>
    <p>Wild Tokemon roam the real streets around you. Walk up to them (GPS, or tap the
    map to stroll), catch them with Tokeballs, and take on the villains of Team Glitch.</p>
    <p><b>Choose your first Tokemon:</b></p>
    <div class="tk-starters">${choices}</div>`);
  $("tk-panel").querySelectorAll(".tk-starter").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await api.chooseStarter(b.dataset.id);
        save = r.save;
        closePanels();
        renderHud();
        toast(`${save.party[0].name} joined you — go explore!`);
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}

function showFatal(msg) {
  openPanel(`<h2>Tokemon</h2><p>${esc(msg || "The game is unavailable right now.")}</p>`);
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  map = createMap($("tk-map"), {
    zoom: 17,
    onTap: (ll) => {
      walkTarget = ll;
      follow = true;
    },
  });
  battleUI = createBattleUI(document.body, {
    onAction: (action) => api.battleAction(action),
    onEnd: (result, s) => {
      save = s || save;
      renderHud();
      maybeFetchSpawns(true);
      if (result === "caught") toast("Registered to the Tokedex!");
      if (result === "lost") toast("Your team fainted — Recharge or use Reboots.");
    },
  });

  $("tk-gps").addEventListener("click", toggleGps);
  $("tk-center").addEventListener("click", () => {
    follow = true;
    map.setCenter(pos.lat, pos.lng);
  });
  $("tk-party").addEventListener("click", openParty);
  $("tk-bag").addEventListener("click", openBag);
  $("tk-dex").addEventListener("click", openDex);
  $("tk-heal").addEventListener("click", doHeal);
  // Panning the map manually stops the camera-follow until recentered.
  $("tk-map").addEventListener("pointermove", (e) => {
    if (e.buttons) follow = false;
  });

  try {
    const r = await api.getState();
    save = r.save;
  } catch (err) {
    showFatal(err.status === 401 ? "Sign in first, then reload this page." : err.message);
    return;
  }
  renderHud();

  // Resume a battle that survived a reload.
  if (save.battle) battleUI.open(save.battle, save);
  else if (!save.starter) showStarterPick();

  // One best-effort location fix to start somewhere real; the map stays
  // usable without it (tap-to-walk from the default location).
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => setPos(p.coords.latitude, p.coords.longitude),
      () => setPos(pos.lat, pos.lng),
      { maximumAge: 60_000, timeout: 8000 },
    );
  }
  setPos(pos.lat, pos.lng);
  maybeFetchSpawns(true);
  setInterval(() => maybeFetchSpawns(), SPAWN_POLL_MS);
  requestAnimationFrame(() => tick());
}

boot();

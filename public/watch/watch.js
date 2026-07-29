// The NHxx watch builder page (/watch/): pick a case, a dial, a set of hands
// and the rest of the stack, and watch the finished piece assemble itself in
// 3D — rotate it, zoom it, turn the lights out, save the frame.
//
// This module is page CHROME only. Every millimetre, every compatibility rule
// and every triangle comes from the shared pure core /js/watch-core.js (which
// `node --test` checks without a browser), and every GL call from
// /js/watch-render.js. If you are looking for why a part does or does not fit,
// it is in the core, not here.

import {
  SLOTS,
  slotOptions,
  resolveBuild,
  normalizeBuild,
  checkBuild,
  buildSpec,
  sourcingFor,
  encodeBuild,
  decodeBuild,
  DEFAULT_BUILD,
  SOURCES,
  mm,
} from "/js/watch-core.js";
import { mountWatch } from "/js/watch-render.js";

// ---------------------------------------------------------------------------
// Language. EN default, SV honoured from the browser or a previous visit —
// the same convention as /space/.

const UI = {
  title: { en: "NHxx watch builder", sv: "NHxx klockbyggare" },
  sub: {
    en:
      "Mix and match Seiko NH35/NH36 mod parts and see the build before you buy it. Drag to rotate, scroll or pinch to zoom. Every dimension comes from a named source, every part links to the AliExpress search that actually sells it.",
    sv:
      "Kombinera Seiko NH35/NH36-moddelar och se bygget innan du köper det. Dra för att rotera, scrolla eller nyp för att zooma. Varje mått har en namngiven källa och varje del länkar till AliExpress-sökningen som faktiskt säljer den.",
  },
  hint: {
    en: "Drag to rotate · scroll or pinch to zoom · the seconds hand ticks at the NH35's real six beats a second.",
    sv: "Dra för att rotera · scrolla eller nyp för att zooma · sekundvisaren tickar i NH35:ans verkliga sex slag per sekund.",
  },
  reset: { en: "Reset view", sv: "Återställ vy" },
  top: { en: "Top down", sv: "Rakt uppifrån" },
  poseLive: { en: "Live time", sv: "Aktuell tid" },
  pose1010: { en: "10:10 pose", sv: "10:10-pose" },
  lume: { en: "Lights out", sv: "Släck ljuset" },
  png: { en: "Save PNG", sv: "Spara PNG" },
  random: { en: "Surprise me", sv: "Överraska mig" },
  copy: { en: "Copy link", sv: "Kopiera länk" },
  copied: { en: "Copied", sv: "Kopierad" },
  specs: { en: "Spec sheet", sv: "Specifikation" },
  fit: { en: "Does it fit?", sv: "Passar det?" },
  src: { en: "Where to buy it", sv: "Var du köper delarna" },
  allgood: { en: "Every part in this build fits. Nothing to fix.", sv: "Alla delar i det här bygget passar. Inget att åtgärda." },
  noGl: {
    en: "This browser cannot open a WebGL context, so the 3D view is unavailable. The spec sheet, the fit check and the sourcing links below all still work.",
    sv: "Den här webbläsaren kan inte öppna en WebGL-kontext, så 3D-vyn är otillgänglig. Specifikationen, passformskontrollen och inköpslänkarna nedan fungerar ändå.",
  },
  foot: {
    en:
      'An experimental capability of <a href="/">DeepResearch.se</a>. Dimensions are read off published sources and mod-parts listings, not measured here — treat anything marked ≈ as a starting point and confirm on the listing before you order.',
    sv:
      'En experimentell del av <a href="/">DeepResearch.se</a>. Måtten är hämtade från publicerade källor och moddelsannonser, inte uppmätta här — behandla allt märkt ≈ som en utgångspunkt och kontrollera annonsen innan du beställer.',
  },
  labels: {
    dia: { en: "Case Ø", sv: "Boett Ø" },
    l2l: { en: "Lug to lug", sv: "Mellan hornen" },
    thick: { en: "Thickness", sv: "Tjocklek" },
    lugW: { en: "Lug width", sv: "Bandbredd" },
    dial: { en: "Dial Ø", sv: "Urtavla Ø" },
    crystal: { en: "Crystal Ø", sv: "Glas Ø" },
    insert: { en: "Insert Ø", sv: "Inlägg Ø" },
    crown: { en: "Crown at", sv: "Krona vid" },
    wr: { en: "Water resist.", sv: "Vattentäthet" },
    mvt: { en: "Movement", sv: "Urverk" },
    bph: { en: "Beat", sv: "Frekvens" },
    reserve: { en: "Reserve", sv: "Gångreserv" },
    tubes: { en: "Hand tubes", sv: "Visarhål" },
    stack: { en: "Height budget", sv: "Höjdbudget" },
    price: { en: "Parts total", sv: "Delar totalt" },
  },
};

let lang = localStorage.getItem("watch_lang") ||
  ((navigator.language || "").toLowerCase().startsWith("sv") ? "sv" : "en");

/** @param {{en:string,sv:string}|string|null|undefined} t */
const T = (t) => (!t ? "" : typeof t === "string" ? t : t[lang] || t.en || "");

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State: the current build, read from the URL hash so a link is a build.

let build = normalizeBuild(location.hash.length > 1 ? decodeBuild(decodeURIComponent(location.hash.slice(1))) : DEFAULT_BUILD);
let stage = null;
let pose = "live";
let lume = false;

function pushHash(replace) {
  const code = encodeBuild(build);
  const url = `${location.pathname}#${encodeURIComponent(code)}`;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  const input = /** @type {HTMLInputElement} */ ($("perma"));
  if (input) input.value = location.origin + url;
}

function setPart(slotKey, id) {
  build = normalizeBuild({ ...build, [slotKey]: id });
  // Picking a case also picks its stock finish the first time, so switching
  // from a blasted Tuna to a polished Sub does not leave the Tuna's finish on.
  applyAll();
  pushHash(false);
}

// ---------------------------------------------------------------------------
// The picker: one row per slot, chips for the options.

function swatchFor(slotKey, opt) {
  if (slotKey === "finish" || slotKey === "strap") return opt.color;
  if (slotKey === "dial") return opt.base;
  if (slotKey === "insert" || slotKey === "chapterRing") return opt.base;
  if (slotKey === "crystal") return opt.tint;
  return "";
}

function renderPicker() {
  const host = $("picker");
  if (!host) return;
  host.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = lang === "sv" ? "Delar" : "Parts";
  host.appendChild(h2);
  const { parts } = resolveBuild(build);
  for (const slot of SLOTS) {
    const row = document.createElement("div");
    row.className = "slot";
    const label = document.createElement("div");
    label.className = "label";
    const name = document.createElement("span");
    name.textContent = T(slot.name);
    const pick = document.createElement("span");
    pick.className = "pick";
    pick.textContent = T(parts[slot.key].name);
    label.append(name, pick);
    row.appendChild(label);

    const chips = document.createElement("div");
    chips.className = "chips";
    for (const opt of slotOptions(slot.key)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (opt.id === build[slot.key] ? " on" : "");
      const sw = swatchFor(slot.key, opt);
      if (sw) {
        const dot = document.createElement("span");
        dot.className = "sw";
        dot.style.background = sw;
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(T(opt.name)));
      if (opt.blurb) b.title = T(opt.blurb);
      b.addEventListener("click", () => setPart(slot.key, opt.id));
      chips.appendChild(b);
    }
    row.appendChild(chips);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Spec sheet.

function renderSpecs() {
  const host = $("specs");
  if (!host) return;
  const s = buildSpec(build);
  const { parts } = resolveBuild(build);
  const L = UI.labels;
  const rows = [
    [L.dia, mm(s.caseDia, s.approxDims)],
    [L.l2l, mm(s.l2l, s.approxDims)],
    [L.thick, mm(s.thick, s.approxDims)],
    [L.lugW, mm(s.lugW, s.approxDims)],
    [L.dial, mm(s.dialDia)],
    [L.crystal, mm(s.crystalDia, !!(parts.case.crystal && parts.case.crystal.approx))],
    [L.insert, s.insert ? `${s.insert.od} / ${s.insert.id} mm` : lang === "sv" ? "boettspecifikt" : "case-specific"],
    [L.crown, `${s.crownHour}:00`],
    [L.wr, `${s.wr} m`],
    [L.mvt, s.movement],
    [L.bph, `${s.bph.toLocaleString(lang === "sv" ? "sv-SE" : "en-US")} A/h`],
    [L.reserve, `${s.reserveH} h`],
    [L.tubes, `${s.handTubes.hour} / ${s.handTubes.minute} / ${s.handTubes.second} mm`],
    [L.stack, mm(s.stackMm, true)],
    [L.price, `USD ${s.priceUsd.low}–${s.priceUsd.high}`],
  ];
  host.innerHTML = "";
  for (const [k, v] of rows) {
    const cell = document.createElement("div");
    cell.className = "spec";
    const kk = document.createElement("div");
    kk.className = "k";
    kk.textContent = T(k);
    const vv = document.createElement("div");
    vv.className = "v";
    vv.textContent = v;
    cell.append(kk, vv);
    host.appendChild(cell);
  }
  // Where the case's numbers came from — the point of carrying `src` at all.
  const src = SOURCES[parts.case.src];
  if (src) {
    const note = document.createElement("div");
    note.className = "spec";
    note.style.gridColumn = "1 / -1";
    note.innerHTML =
      `<div class="k">${lang === "sv" ? "Källa för boettmåtten" : "Case dimensions from"}</div>` +
      `<div class="v" style="font-size:.78rem;font-weight:400">` +
      (src.url ? `<a href="${src.url}" target="_blank" rel="noopener">${src.label}</a>` : src.label) +
      `</div>`;
    host.appendChild(note);
  }
  const caseNote = parts.case.note;
  if (caseNote) {
    const n = document.createElement("div");
    n.className = "spec";
    n.style.gridColumn = "1 / -1";
    n.innerHTML = `<div class="v" style="font-size:.78rem;font-weight:400;color:var(--warn)">${T(caseNote)}</div>`;
    host.appendChild(n);
  }
}

// ---------------------------------------------------------------------------
// Fit check.

function renderIssues() {
  const host = $("issues");
  if (!host) return;
  const { issues } = checkBuild(build);
  host.innerHTML = "";
  if (!issues.length) {
    const ok = document.createElement("div");
    ok.className = "allgood";
    ok.textContent = T(UI.allgood);
    host.appendChild(ok);
    return;
  }
  const rank = { error: 0, warning: 1, note: 2 };
  for (const i of [...issues].sort((a, b) => rank[a.level] - rank[b.level])) {
    const row = document.createElement("div");
    row.className = `issue ${i.level}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent =
      lang === "sv"
        ? { error: "fel", warning: "varning", note: "obs" }[i.level]
        : i.level;
    const txt = document.createElement("span");
    txt.textContent = i[lang] || i.en;
    row.append(tag, txt);
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Sourcing — the pre-indexed AliExpress table for exactly this build.

function renderSourcing() {
  const host = $("sourcing");
  if (!host) return;
  host.innerHTML = "";
  for (const row of sourcingFor(build)) {
    const el = document.createElement("div");
    el.className = "src";
    const head = document.createElement("div");
    head.className = "head";
    const left = document.createElement("div");
    left.innerHTML = `<strong>${T(row.slotName)}</strong> — ${T(row.name)}` +
      (row.brands.length ? `<div class="who">${row.brands.join(" · ")}</div>` : "");
    const price = document.createElement("div");
    price.className = "price";
    if (row.priceUsd) price.textContent = `USD ${row.priceUsd[0]}–${row.priceUsd[1]}`;
    head.append(left, price);
    el.appendChild(head);
    if (row.links.length) {
      const links = document.createElement("div");
      links.className = "links";
      for (const l of row.links) {
        const a = document.createElement("a");
        a.href = l.url;
        a.target = "_blank";
        a.rel = "noopener nofollow";
        a.textContent = l.q;
        links.appendChild(a);
      }
      el.appendChild(links);
    }
    if (row.watchFor) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = T(row.watchFor);
      el.appendChild(w);
    }
    host.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Wiring.

function applyStatic() {
  document.documentElement.lang = lang;
  $("h1").textContent = T(UI.title);
  $("sub").textContent = T(UI.sub);
  $("hint").textContent = T(UI.hint);
  $("t-specs").textContent = T(UI.specs);
  $("t-fit").textContent = T(UI.fit);
  $("t-src").textContent = T(UI.src);
  $("b-reset").textContent = T(UI.reset);
  $("b-top").textContent = T(UI.top);
  $("b-pose").textContent = pose === "live" ? T(UI.pose1010) : T(UI.poseLive);
  $("b-lume").textContent = T(UI.lume);
  $("b-png").textContent = T(UI.png);
  $("b-random").textContent = T(UI.random);
  $("b-copy").textContent = T(UI.copy);
  $("foot").innerHTML = T(UI.foot);
  $("lang-en").classList.toggle("active", lang === "en");
  $("lang-sv").classList.toggle("active", lang === "sv");
}

function applyAll() {
  applyStatic();
  renderPicker();
  renderSpecs();
  renderIssues();
  renderSourcing();
  if (stage) stage.setBuild(build);
}

function randomBuild() {
  /** @type {Record<string,string>} */
  const next = {};
  for (const slot of SLOTS) {
    const opts = slotOptions(slot.key);
    next[slot.key] = opts[Math.floor(Math.random() * opts.length)].id;
  }
  // Keep the movement honest: pick a dial that matches the movement's
  // complications so "surprise me" produces a buildable watch rather than a
  // pile of errors. The fit check is there to teach, not to nag.
  const dials = slotOptions("dial");
  const mv = slotOptions("movement").find((m) => m.id === next.movement);
  const match = dials.filter((d) => !!d.date === !!mv.date && !!d.day === !!mv.day && !!d.gmt === !!mv.gmt);
  if (match.length) next.dial = match[Math.floor(Math.random() * match.length)].id;
  const hands = slotOptions("hands").filter((h) => !!h.gmt === !!mv.gmt);
  if (hands.length) next.hands = hands[Math.floor(Math.random() * hands.length)].id;
  build = normalizeBuild(next);
  applyAll();
  pushHash(false);
}

function init() {
  const canvas = /** @type {HTMLCanvasElement} */ ($("view"));
  stage = mountWatch(canvas, {
    onError: () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      canvas.remove();
      const p = document.createElement("p");
      p.className = "nogl";
      p.textContent = T(UI.noGl);
      parent.prepend(p);
    },
  });

  $("lang-en").addEventListener("click", () => {
    lang = "en";
    localStorage.setItem("watch_lang", lang);
    applyAll();
  });
  $("lang-sv").addEventListener("click", () => {
    lang = "sv";
    localStorage.setItem("watch_lang", lang);
    applyAll();
  });
  $("b-reset").addEventListener("click", () => stage && stage.resetView());
  $("b-top").addEventListener("click", () => stage && stage.topView());
  $("b-pose").addEventListener("click", () => {
    pose = pose === "live" ? "1010" : "live";
    if (stage) stage.setPose(pose);
    $("b-pose").textContent = pose === "live" ? T(UI.pose1010) : T(UI.poseLive);
    $("b-pose").classList.toggle("active", pose === "1010");
  });
  $("b-lume").addEventListener("click", () => {
    lume = !lume;
    if (stage) stage.setLume(lume);
    $("b-lume").classList.toggle("active", lume);
  });
  $("b-png").addEventListener("click", () => {
    if (!stage) return;
    const a = document.createElement("a");
    a.href = stage.toPNG();
    a.download = `${encodeBuild(build).replace(/[^a-z0-9]+/gi, "-").slice(0, 80)}.png`;
    a.click();
  });
  $("b-random").addEventListener("click", randomBuild);
  $("b-copy").addEventListener("click", async () => {
    const input = /** @type {HTMLInputElement} */ ($("perma"));
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand("copy");
    }
    $("b-copy").textContent = T(UI.copied);
    setTimeout(() => ($("b-copy").textContent = T(UI.copy)), 1400);
  });

  window.addEventListener("popstate", () => {
    build = normalizeBuild(location.hash.length > 1 ? decodeBuild(decodeURIComponent(location.hash.slice(1))) : DEFAULT_BUILD);
    applyAll();
  });

  applyAll();
  pushHash(true);
}

init();

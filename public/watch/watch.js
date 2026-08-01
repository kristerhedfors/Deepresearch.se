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
import {
  annotateOptions,
  groupOptions,
  splitSpecRows,
  surpriseBuild,
  slotIsText,
  textFieldDef,
  axisGroupsBySlot,
  axisSummary,
  sanitizeTextValue,
  TEXT_SLOT_MAXLEN,
} from "/js/watch-page-core.js";
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
  back: { en: "Case back", sv: "Boettbotten" },
  // The cushion switch is labelled by its STATE, not by the action it would
  // perform. "Hide cushion" next to a watch already lying on one reads as a
  // description of what you are looking at, which is how a switch the reporter
  // asked for by name (feedback #59) went unnoticed a second time.
  cushionOn: { en: "Cushion: on", sv: "Kudde: på" },
  cushionOff: { en: "Cushion: off", sv: "Kudde: av" },
  scene: { en: "Scene", sv: "Miljö" },
  poseLive: { en: "Live time", sv: "Aktuell tid" },
  pose1010: { en: "10:10 pose", sv: "10:10-pose" },
  lume: { en: "Lights out", sv: "Släck ljuset" },
  png: { en: "Save PNG", sv: "Spara PNG" },
  random: { en: "Surprise me", sv: "Överraska mig" },
  copy: { en: "Copy link", sv: "Kopiera länk" },
  copied: { en: "Copied", sv: "Kopierad" },
  specs: { en: "Spec sheet", sv: "Specifikation" },
  specsMore: { en: "All the other numbers", sv: "Alla övriga mått" },
  specsLess: { en: "Hide the other numbers", sv: "Dölj övriga mått" },
  fit: { en: "Does it fit?", sv: "Passar det?" },
  src: { en: "Where to buy it", sv: "Var du köper delarna" },
  // The picker's warning surface. `clash` takes the count: the same phrasing
  // reads correctly for one option and for thirteen in both languages.
  clash: {
    en: (n) => `⚠ ${n} that ${n === 1 ? "does" : "do"} not fit this build`,
    sv: (n) => `⚠ ${n} som inte passar det här bygget`,
  },
  clashPicked: {
    en: "You picked a part that does not fit the rest of this build. It stays selected — the build is yours — but here is what is wrong:",
    sv: "Du har valt en del som inte passar resten av bygget. Den förblir vald — bygget är ditt — men så här är felet:",
  },
  textHint: {
    en: "Leave it empty for none.",
    sv: "Lämna tomt för ingen text.",
  },
  // Groups the catalogue files under a heading this page has no slot for. The
  // ones that DO belong to a part now hang off that part's row instead.
  fineTuning: {
    en: "Fine tuning — the variables behind each part",
    sv: "Finjustering — variablerna bakom varje del",
  },
  // The collapsed line above each part's variables. It names the count so the
  // reader knows the fold is worth opening, and the names follow it.
  moreChoices: {
    en: (n) => `${n} more ${n === 1 ? "choice" : "choices"}:`,
    sv: (n) => `${n} ${n === 1 ? "val till" : "fler val"}:`,
  },
  pickHint: {
    en: "Each part opens on more choices — dial colour, finish, indices, strap colour and the rest — on the dashed line under its row.",
    sv: "Varje del döljer fler val — urtavlans färg, finish, index, bandets färg och resten — på den streckade raden under sin rad.",
  },
  expandAll: { en: "Open every choice", sv: "Öppna alla val" },
  collapseAll: { en: "Close every choice", sv: "Stäng alla val" },
  calcFail: {
    en: "This section could not be worked out for the current build. The rest of the page still works — try a different combination.",
    sv: "Det här avsnittet kunde inte räknas ut för det aktuella bygget. Resten av sidan fungerar ändå — prova en annan kombination.",
  },
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
// The presentation cushion. Feedback #59 asked for the switch, and asked for it
// in the same sentence as the display back — with the cushion on, the case back
// has a leather cylinder directly behind it and there is nothing to see.
let cushion = true;
let lume = false;
// The scene the stage is lit in. The list and the setter both arrive from
// modules this page only feature-detects (see `wireScenes`), so this holds an
// id and nothing else until one is known to work.
let sceneId = "";
try {
  sceneId = localStorage.getItem("watch_scene") || "";
} catch {
  sceneId = "";
}

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

// Which disclosures the user left open, so a re-render (every pick re-renders
// the whole picker) does not snap them shut under the cursor.
/** @type {Set<string>} */
const openDisclosures = new Set();

/**
 * A chip for one option. `warn` marks the ones that do not fit; they are
 * offered all the same.
 */
function chipFor(slotKey, opt, selected, why) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip" + (selected ? " on" : "") + (opt.none || opt.asListed ? " none" : "") + (why ? " soft" : "");
  const sw = swatchFor(slotKey, opt);
  if (sw) {
    const dot = document.createElement("span");
    dot.className = "sw";
    dot.style.background = sw;
    b.appendChild(dot);
  }
  // A compatible option can still come back with something worth saying. Mark
  // it softly — it fits, so it is not behind the ⚠ disclosure — and put the
  // sentence on the tooltip.
  b.appendChild(document.createTextNode((why ? "⚠ " : "") + T(opt.name)));
  const tip = [why ? T(why) : "", opt.blurb ? T(opt.blurb) : ""].filter(Boolean).join(" — ");
  if (tip) b.title = tip;
  b.addEventListener("click", () => setPart(slotKey, opt.id));
  return b;
}

/**
 * The free-text fields — a custom dial legend or a case-back engraving is
 * typed, not picked (#56: "support for custom text dial logos and dial text
 * specifications").
 */
function textSlotRow(slot) {
  const max = Number(slot.max) > 0 ? Number(slot.max) : TEXT_SLOT_MAXLEN;
  const wrap = document.createElement("div");
  wrap.className = "txtslot";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = max;
  input.value = String(build[slot.key] || "");
  input.placeholder = T(slot.placeholder) || T(UI.textHint);
  input.setAttribute("aria-label", T(slot.name));
  const count = document.createElement("span");
  count.className = "count";
  const sync = () => (count.textContent = `${input.value.length}/${max}`);
  sync();
  input.addEventListener("input", sync);
  // Commit on blur / Enter rather than per keystroke: every commit pushes a
  // history entry, and one per letter would bury the back button.
  const commit = () => {
    const clean = sanitizeTextValue(input.value, max);
    input.value = clean;
    sync();
    if (clean !== String(build[slot.key] || "")) setPart(slot.key, clean);
  };
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
  });
  wrap.append(input, count);
  return wrap;
}

/**
 * Which option a slot or an axis currently holds. An axis left alone is not
 * written into the build at all (that is what keeps an old permalink opening
 * the same watch), so its current value is its own default.
 */
function currentId(slot) {
  const set = build[slot.key];
  if (typeof set === "string" && set) return set;
  if (slot.asListed) return "as-listed";
  if (slot.defaultId) return slot.defaultId;
  const first = annotateOptions(slot.key, build)[0];
  return first ? first.option.id : "";
}

/**
 * One fine-tuning group as a disclosure, with its variables named on the
 * summary so they are readable while it is shut (feedback #59).
 *
 * @param {any} group
 * @param {Set<string>} saidWhy
 */
function axisGroup(group, saidWhy) {
  const key = `axes:${group.id}`;
  const det = document.createElement("details");
  det.className = "axes";
  det.open = openDisclosures.has(key);
  det.addEventListener("toggle", () => {
    if (det.open) openDisclosures.add(key);
    else openDisclosures.delete(key);
  });

  const sum = document.createElement("summary");
  const { items, setCount } = axisSummary(group, build);
  const lead = document.createElement("span");
  lead.className = "axlead";
  lead.textContent = UI.moreChoices[lang === "sv" ? "sv" : "en"](items.length);
  sum.appendChild(lead);
  items.forEach((item, i) => {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "axsep";
      sep.textContent = "·";
      sum.appendChild(sep);
    }
    const n = document.createElement("span");
    n.className = "axname" + (item.set ? " set" : "");
    // A variable the user has moved shows what it was moved TO, so the fold
    // never hides a choice already made.
    n.textContent = item.set && item.value ? `${T(item.label)}: ${T(item.value)}` : T(item.label);
    sum.appendChild(n);
  });
  sum.title = `${T(group.name)}${setCount ? ` — ${setCount}` : ""}`;
  det.appendChild(sum);

  const body = document.createElement("div");
  body.className = "axesbody";
  for (const axis of group.axes) body.appendChild(slotRow(axis, saidWhy));
  for (const f of group.texts) body.appendChild(slotRow(f, saidWhy));
  det.appendChild(body);
  return det;
}

/**
 * One picker row — the same shape for a base slot and for an axis: the label
 * with what is chosen, the chips that fit, and the ⚠ disclosure holding the
 * ones that do not with the reason each of them clashes. `groups` are the
 * fine-tuning disclosures that belong to THIS part; they render inside the
 * row, under its chips.
 *
 * @param {any} slot
 * @param {Set<string>} saidWhy reasons already printed in this render pass
 * @param {any[]} [groups]
 */
function slotRow(slot, saidWhy, groups) {
  const row = document.createElement("div");
  row.className = "slot";
  // The part's own variables sit INSIDE its row (feedback #59) — a dial colour
  // that lives three sections below the dial is a dial colour nobody finds.
  const withGroups = () => {
    for (const g of groups || []) row.appendChild(axisGroup(g, saidWhy));
    return row;
  };

  const field = textFieldDef(slot.key);
  const now = field ? String(build[slot.key] || "") : currentId(slot);

  const label = document.createElement("div");
  label.className = "label";
  const name = document.createElement("span");
  name.textContent = T(slot.name);
  label.appendChild(name);

  if (field || slotIsText(slot.key)) {
    const pick = document.createElement("span");
    pick.className = "pick";
    pick.textContent = now || (lang === "sv" ? "tom" : "empty");
    label.appendChild(pick);
    row.appendChild(label);
    row.appendChild(textSlotRow(field || slot));
    return withGroups();
  }

  const rows = annotateOptions(slot.key, build);
  const selected = rows.find((r) => r.option.id === now) || null;
  const { fits, clashes } = groupOptions(rows);

  const pick = document.createElement("span");
  pick.className = "pick" + (selected && !selected.compatible ? " bad" : "");
  pick.textContent =
    (selected && !selected.compatible ? "⚠ " : "") +
    (selected ? T(selected.option.name) : now);
  label.appendChild(pick);
  row.appendChild(label);

  const chips = document.createElement("div");
  chips.className = "chips";
  for (const r of fits) chips.appendChild(chipFor(slot.key, r.option, r.option.id === now, r.why));
  row.appendChild(chips);

  // The user is allowed to keep a part that does not fit — but then the reason
  // stays on screen rather than only inside the dropdown.
  const stuck = selected && (!selected.compatible || (selected.why && selected.level === "warning"));
  if (stuck && selected.why && !saidWhy.has(T(selected.why))) {
    saidWhy.add(T(selected.why));
    const w = document.createElement("div");
    w.className = "warnpick";
    w.textContent = selected.compatible
      ? `⚠ ${T(selected.why)}`
      : `⚠ ${T(UI.clashPicked)} ${T(selected.why)}`;
    row.appendChild(w);
  }

  if (clashes.length) {
    const key = `clash:${slot.key}`;
    const det = document.createElement("details");
    det.className = "clash";
    det.open = openDisclosures.has(key);
    det.addEventListener("toggle", () => {
      if (det.open) openDisclosures.add(key);
      else openDisclosures.delete(key);
    });
    const sum = document.createElement("summary");
    sum.textContent = UI.clash[lang === "sv" ? "sv" : "en"](clashes.length);
    det.appendChild(sum);
    const list = document.createElement("div");
    list.className = "clashlist";
    for (const r of clashes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "clashopt" + (r.option.id === now ? " on" : "");
      const n = document.createElement("span");
      n.className = "n";
      const sw = swatchFor(slot.key, r.option);
      if (sw) {
        const dot = document.createElement("span");
        dot.className = "sw";
        dot.style.background = sw;
        n.appendChild(dot);
      }
      n.appendChild(document.createTextNode(`⚠ ${T(r.option.name)}`));
      b.appendChild(n);
      if (r.why) {
        const why = document.createElement("span");
        why.className = "why";
        why.textContent = T(r.why);
        b.appendChild(why);
      }
      b.addEventListener("click", () => setPart(slot.key, r.option.id));
      list.appendChild(b);
    }
    det.appendChild(list);
    row.appendChild(det);
  }

  return withGroups();
}

function renderPicker() {
  const host = $("picker");
  if (!host) return;
  host.innerHTML = "";

  // The orthogonal variables (#56: "dials come in so many shapes, colours and
  // sizes that the current fixed-variable system needs replacement"), addressed
  // to the part each of them modifies (#59). A group whose axes cannot apply to
  // this build is not rendered at all.
  const { bySlot, orphans } = axisGroupsBySlot(build);

  const head = document.createElement("div");
  head.className = "pickhead";
  const h2 = document.createElement("h2");
  h2.textContent = lang === "sv" ? "Delar" : "Parts";
  head.appendChild(h2);
  // Every group on the page right now, so the one control can open or shut all
  // of them without becoming a mode that fights the individual disclosures.
  const allKeys = [...Object.values(bySlot).flat(), ...orphans].map((g) => `axes:${g.id}`);
  if (allKeys.length) {
    const allOpen = allKeys.every((k) => openDisclosures.has(k));
    const all = document.createElement("button");
    all.type = "button";
    all.className = "tool tiny" + (allOpen ? " active" : "");
    all.textContent = allOpen ? T(UI.collapseAll) : T(UI.expandAll);
    all.addEventListener("click", () => {
      for (const k of allKeys) {
        if (allOpen) openDisclosures.delete(k);
        else openDisclosures.add(k);
      }
      // Only the picker: this changes no part, so nothing needs re-rendering in
      // the stage, the spec sheet or the sourcing table.
      guardRender("picker", renderPicker);
    });
    head.appendChild(all);
  }
  host.appendChild(head);

  if (Object.keys(bySlot).length) {
    const hint = document.createElement("p");
    hint.className = "pickhint";
    hint.textContent = T(UI.pickHint);
    host.appendChild(hint);
  }

  // One clash is usually visible from both ends of it — a dated dial under a
  // no-date movement is the same sentence in the dial slot and the movement
  // slot. Say it once, on the first slot that reports it, and leave the ⚠ on
  // the others.
  /** @type {Set<string>} */
  const saidWhy = new Set();
  for (const slot of SLOTS) host.appendChild(slotRow(slot, saidWhy, bySlot[slot.key]));

  // A group the catalogue files under something this page has no part for still
  // gets rendered — under the old heading — rather than silently vanishing.
  if (orphans.length) {
    const h3 = document.createElement("h2");
    h3.className = "axeshead";
    h3.textContent = T(UI.fineTuning);
    host.appendChild(h3);
    for (const g of orphans) host.appendChild(axisGroup(g, saidWhy));
  }
}

// ---------------------------------------------------------------------------
// Spec sheet.

/** One key/value cell of the spec sheet. */
function specCell(row) {
  const cell = document.createElement("div");
  cell.className = "spec";
  const kk = document.createElement("div");
  kk.className = "k";
  kk.textContent = T(row.label);
  const vv = document.createElement("div");
  vv.className = "v";
  vv.textContent = row.value;
  cell.append(kk, vv);
  return cell;
}

function renderSpecs() {
  const host = $("specs");
  const rest = $("specs-rest");
  if (!host || !rest) return;
  const s = buildSpec(build);
  const { parts } = resolveBuild(build);
  const L = UI.labels;
  const rows = [
    { key: "dia", label: L.dia, value: mm(s.caseDia, s.approxDims) },
    { key: "l2l", label: L.l2l, value: mm(s.l2l, s.approxDims) },
    { key: "thick", label: L.thick, value: mm(s.thick, s.approxDims) },
    { key: "lugW", label: L.lugW, value: mm(s.lugW, s.approxDims) },
    { key: "dial", label: L.dial, value: mm(s.dialDia) },
    { key: "crystal", label: L.crystal, value: mm(s.crystalDia, !!(parts.case.crystal && parts.case.crystal.approx)) },
    { key: "insert", label: L.insert, value: s.insert ? `${s.insert.od} / ${s.insert.id} mm` : lang === "sv" ? "boettspecifikt" : "case-specific" },
    { key: "crown", label: L.crown, value: `${s.crownHour}:00` },
    { key: "wr", label: L.wr, value: `${s.wr} m` },
    { key: "mvt", label: L.mvt, value: s.movement },
    { key: "bph", label: L.bph, value: `${s.bph.toLocaleString(lang === "sv" ? "sv-SE" : "en-US")} A/h` },
    { key: "reserve", label: L.reserve, value: `${s.reserveH} h` },
    { key: "tubes", label: L.tubes, value: `${s.handTubes.hour} / ${s.handTubes.minute} / ${s.handTubes.second} mm` },
    { key: "stack", label: L.stack, value: mm(s.stackMm, true) },
    { key: "price", label: L.price, value: `USD ${s.priceUsd.low}–${s.priceUsd.high}` },
  ];
  // The sheet opens on the numbers that decide whether a watch fits a wrist and
  // a parts drawer; everything else is one tap away (feedback #56).
  const { basic, more } = splitSpecRows(rows);

  host.innerHTML = "";
  for (const row of basic) host.appendChild(specCell(row));

  rest.innerHTML = "";
  for (const row of more) rest.appendChild(specCell(row));

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
    rest.appendChild(note);
  }
  // A caveat about the case's own numbers is not "extra detail" — it stays on
  // the summary, where the numbers it qualifies are.
  const caseNote = parts.case.note;
  if (caseNote) {
    const n = document.createElement("div");
    n.className = "spec";
    n.style.gridColumn = "1 / -1";
    n.innerHTML = `<div class="v" style="font-size:.78rem;font-weight:400;color:var(--warn)">${T(caseNote)}</div>`;
    host.appendChild(n);
  }

  const det = /** @type {HTMLDetailsElement} */ ($("specs-more"));
  if (det) det.hidden = more.length === 0;
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

/**
 * The cushion switch reads as a SWITCH: it says which state it is in and lights
 * up while the cushion is there. It was already on the bar before feedback #59
 * asked for it — labelled "Hide cushion", which describes the tap rather than
 * the state, and unlit while on, so it looked like a button that did nothing.
 */
function syncCushion() {
  const btn = $("b-cushion");
  if (!btn) return;
  btn.textContent = cushion ? T(UI.cushionOn) : T(UI.cushionOff);
  btn.classList.toggle("active", cushion);
}

function applyStatic() {
  document.documentElement.lang = lang;
  $("h1").textContent = T(UI.title);
  $("sub").textContent = T(UI.sub);
  $("hint").textContent = T(UI.hint);
  $("t-specs").textContent = T(UI.specs);
  const det = /** @type {HTMLDetailsElement} */ ($("specs-more"));
  $("t-specs-more").textContent = det && det.open ? T(UI.specsLess) : T(UI.specsMore);
  $("t-fit").textContent = T(UI.fit);
  $("t-src").textContent = T(UI.src);
  $("b-reset").textContent = T(UI.reset);
  $("b-top").textContent = T(UI.top);
  $("b-back").textContent = T(UI.back);
  syncCushion();
  $("t-scene").textContent = T(UI.scene);
  syncSceneLabels();
  $("b-pose").textContent = pose === "live" ? T(UI.pose1010) : T(UI.poseLive);
  $("b-lume").textContent = T(UI.lume);
  $("b-png").textContent = T(UI.png);
  $("b-random").textContent = T(UI.random);
  $("b-copy").textContent = T(UI.copy);
  $("foot").innerHTML = T(UI.foot);
  $("lang-en").classList.toggle("active", lang === "en");
  $("lang-sv").classList.toggle("active", lang === "sv");
}

// One derived section failing must not take the page down with it. The builder
// is a tool you keep using while the catalogue underneath it grows — a part
// combination the catalogue cannot price or measure yet should cost you that
// panel, not the whole workbench.
function guardRender(hostId, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`watch: ${hostId} failed`, err);
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = "";
    const p = document.createElement("div");
    p.className = "issue warning";
    p.textContent = T(UI.calcFail);
    host.appendChild(p);
  }
}

function applyAll() {
  applyStatic();
  guardRender("picker", renderPicker);
  guardRender("specs", renderSpecs);
  guardRender("issues", renderIssues);
  guardRender("sourcing", renderSourcing);
  try {
    if (stage) stage.setBuild(build);
  } catch (err) {
    console.error("watch: stage failed", err);
  }
}

// "Surprise me" is only allowed to hand over a build that passes the fit check
// (feedback #57). Picking each slot independently — what this used to do —
// produced a hard error about seven times in ten, so the button taught the
// user that the tool contradicts itself. The guarantee lives in the page core,
// where a unit test holds it to two thousand draws.
function randomBuild() {
  build = surpriseBuild();
  applyAll();
  pushHash(false);
}

// ---------------------------------------------------------------------------
// The scene picker.
//
// Both halves of it live outside this file — the list (`SCENES`) and the
// resolver in /js/watch-materials.js, the setter (`setScene`) on the stage —
// and neither is assumed to exist. The import is DYNAMIC on purpose: a static
// `import { SCENES }` against a module that has not grown the export yet is a
// link-time failure that takes the whole page down, and this control is worth
// less than the builder. Nothing is shown until both halves answer, so the
// select can never be a control that does nothing (UX-18).

/** @type {{ id: string, name: any }[]} */
let scenes = [];

function applyScene() {
  if (!stage || typeof stage.setScene !== "function" || !sceneId) return;
  try {
    stage.setScene(sceneId);
  } catch (err) {
    console.error("watch: setScene failed", err);
  }
}

async function wireScenes() {
  const wrap = $("scenewrap");
  const select = /** @type {HTMLSelectElement} */ ($("scene"));
  if (!wrap || !select) return;
  if (!stage || typeof stage.setScene !== "function") return;
  /** @type {any} */
  let mats = null;
  try {
    mats = await import("/js/watch-materials.js");
  } catch {
    return;
  }
  const list = mats && Array.isArray(mats.SCENES) ? mats.SCENES.filter((s) => s && s.id) : [];
  // One scene is not a choice.
  if (list.length < 2) return;
  scenes = list;
  if (!scenes.some((s) => s.id === sceneId)) sceneId = scenes[0].id;

  select.innerHTML = "";
  for (const s of scenes) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = T(s.name) || s.id;
    select.appendChild(opt);
  }
  select.value = sceneId;
  select.addEventListener("change", () => {
    sceneId = select.value;
    try {
      localStorage.setItem("watch_scene", sceneId);
    } catch { /* a blocked store must not break the picker */ }
    applyScene();
  });
  wrap.hidden = false;
  applyScene();
}

/** Re-label the scene options after a language switch. */
function syncSceneLabels() {
  const select = /** @type {HTMLSelectElement} */ ($("scene"));
  if (!select || !scenes.length) return;
  for (const opt of Array.from(select.options)) {
    const s = scenes.find((x) => x.id === opt.value);
    if (s) opt.textContent = T(s.name) || s.id;
  }
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
  $("b-reset").addEventListener("click", () => {
    if (!stage) return;
    setCushion(true);
    stage.setStrap(true);
    stage.resetView();
  });
  $("b-top").addEventListener("click", () => stage && stage.topView());
  const setCushion = (v) => {
    cushion = !!v;
    if (stage) stage.setWrist(cushion);
    syncCushion();
  };
  $("b-cushion").addEventListener("click", () => setCushion(!cushion));
  $("b-back").addEventListener("click", () => {
    if (!stage) return;
    // Turning to the back with the cushion and the band still on shows the
    // cushion and the clasp — which is how "the clear back does nothing" looks
    // from the outside. Inspecting a case back means taking the watch off.
    setCushion(false);
    stage.setStrap(false);
    stage.backView();
  });
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
  const specsMore = /** @type {HTMLDetailsElement} */ ($("specs-more"));
  if (specsMore) {
    specsMore.addEventListener("toggle", () => {
      $("t-specs-more").textContent = specsMore.open ? T(UI.specsLess) : T(UI.specsMore);
    });
  }
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

  wireScenes();

  window.addEventListener("popstate", () => {
    build = normalizeBuild(location.hash.length > 1 ? decodeBuild(decodeURIComponent(location.hash.slice(1))) : DEFAULT_BUILD);
    applyAll();
  });

  applyAll();
  pushHash(true);
}

init();

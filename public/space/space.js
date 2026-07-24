// The space-animations archive page (/space/): renders the showcase gallery
// of question→reply cards, each with a PLAYABLE wireframe 3D animation and a
// log-scale zoom that absorbs the size gulf between a moon's surface and a
// light-year. Rendering convention (the page's visual identity): background
// stars — and only stars (the Sun, Proxima, the light pulse) — get real
// additive glow; every body, craft and figure is unlit 3D wireframe.
//
// All deterministic logic (the scene registry, the EN+SV question matcher,
// zoom math, mesh builders, feedback validation) lives in the shared pure
// core /js/space-core.js, and the playable canvas itself (stage, HUD,
// pointer interaction, the per-kind scene runners) in the shared embeddable
// renderer /js/space-embed.js — mounted here per card and, since feedback
// #18, inside chat answers on both tiers. This module is the gallery's page
// chrome: cards, chips, the ask box, language toggle, and per-scene feedback.

import { SPACE_SCENES, spaceIntent, validateSpaceFeedback } from "/js/space-core.js";
import { mountSpaceScene } from "/js/space-embed.js";

// ---------------------------------------------------------------------------
// Language (EN default, SV honored from browser or a previous visit).

const UI = {
  sub: {
    en: "An archive of playable animations answering common space questions. Drag to rotate, zoom from a moon's surface out to a light-year — sizes and distances are real. Only the stars shine; everything else is wireframe.",
    sv: "Ett arkiv av spelbara animationer som besvarar vanliga rymdfrågor. Dra för att rotera, zooma från en månyta ut till ett ljusår — storlekar och avstånd är verkliga. Bara stjärnorna lyser; allt annat är trådmodell.",
  },
  askPlaceholder: {
    en: "Ask a space question — e.g. \"How far away is the Moon?\"",
    sv: "Ställ en rymdfråga — t.ex. \"Hur långt bort är månen?\"",
  },
  askBtn: { en: "Find animation", sv: "Hitta animation" },
  askMiss: {
    en: "No tailored animation for that one yet — browse the archive below.",
    sv: "Ingen skräddarsydd animation för den ännu — bläddra i arkivet nedan.",
  },
  fbAsk: { en: "Was this animation helpful?", sv: "Var animationen hjälpsam?" },
  fbComment: { en: "Optional: what should improve?", sv: "Frivilligt: vad borde förbättras?" },
  fbSend: { en: "Send feedback", sv: "Skicka feedback" },
  fbDone: { en: "Thanks — feedback recorded.", sv: "Tack — feedbacken är sparad." },
  fbErr: { en: "Could not send feedback right now.", sv: "Det gick inte att skicka feedback just nu." },
  foot: {
    en: "An experimental capability of <a href=\"/\">DeepResearch.se</a> — every animation is generated from real orbital data, wireframe by design.",
    sv: "En experimentell del av <a href=\"/\">DeepResearch.se</a> — varje animation genereras ur verkliga bandata, trådmodell av princip.",
  },
};

let lang = localStorage.getItem("space_lang") ||
  ((navigator.language || "").toLowerCase().startsWith("sv") ? "sv" : "en");

// ---------------------------------------------------------------------------
// Static page text + language toggle.

const $ = (id) => document.getElementById(id);

// Per-card language hooks: the embed handle's setLang plus the card chrome's
// own text updater, both re-applied by the page toggle.
const cards = [];

function applyLang() {
  localStorage.setItem("space_lang", lang);
  $("lang-en").classList.toggle("active", lang === "en");
  $("lang-sv").classList.toggle("active", lang === "sv");
  $("t-sub").textContent = UI.sub[lang];
  $("ask-input").placeholder = UI.askPlaceholder[lang];
  $("ask-btn").textContent = UI.askBtn[lang];
  $("t-foot").innerHTML = UI.foot[lang];
  document.documentElement.lang = lang;
  for (const c of cards) {
    c.handle.setLang(lang);
    c.applyLang();
  }
  renderChips();
}
$("lang-en").addEventListener("click", () => { lang = "en"; applyLang(); });
$("lang-sv").addEventListener("click", () => { lang = "sv"; applyLang(); });

function renderChips() {
  const box = $("chips");
  box.textContent = "";
  for (const scene of SPACE_SCENES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${scene.emoji} ${scene.title[lang]}`;
    b.addEventListener("click", () => revealScene(scene.id));
    box.appendChild(b);
  }
}

function revealScene(id) {
  const card = document.getElementById(`scene-${id}`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  card.classList.remove("flash");
  requestAnimationFrame(() => card.classList.add("flash"));
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("ask-input").value;
  const id = spaceIntent(q);
  if (id) {
    $("ask-miss").textContent = "";
    revealScene(id);
  } else {
    $("ask-miss").textContent = UI.askMiss[lang];
  }
});

// ---------------------------------------------------------------------------
// Card construction: question bubble → mounted animation → reply → feedback.

function buildCard(scene) {
  const card = document.createElement("article");
  card.className = "card";
  card.id = `scene-${scene.id}`;

  const q = document.createElement("div");
  q.className = "q";
  q.innerHTML = `<span class="who">Q</span><p></p>`;
  card.appendChild(q);

  // The playable stage — the shared embeddable renderer. The gallery card
  // shows the scene's reply in its own bubble below, so no embed caption.
  const stageHost = document.createElement("div");
  card.appendChild(stageHost);
  const handle = mountSpaceScene(stageHost, scene, { lang, caption: false });

  const reply = document.createElement("div");
  reply.className = "reply";
  reply.innerHTML = `<span class="who">${scene.emoji}</span><p></p>`;
  card.appendChild(reply);

  const fb = document.createElement("div");
  fb.className = "fb";
  fb.innerHTML = `
    <div class="fbrow">
      <span class="fbq"></span>
      <button class="v up" type="button">👍</button>
      <button class="v down" type="button">👎</button>
      <span class="done" hidden></span>
      <span class="err" hidden></span>
    </div>
    <textarea hidden></textarea>
    <button class="send" type="button" hidden></button>`;
  card.appendChild(fb);

  // --- feedback wiring ------------------------------------------------------
  const upBtn = fb.querySelector(".up");
  const downBtn = fb.querySelector(".down");
  const ta = fb.querySelector("textarea");
  const sendBtn = fb.querySelector(".send");
  const doneEl = fb.querySelector(".done");
  const errEl = fb.querySelector(".err");
  let verdict = null;
  const already = localStorage.getItem(`space_fb_${scene.id}`);
  const markDone = () => {
    upBtn.disabled = true; downBtn.disabled = true;
    ta.hidden = true; sendBtn.hidden = true;
    doneEl.hidden = false;
  };
  if (already) {
    (already === "up" ? upBtn : downBtn).classList.add(`picked-${already}`);
    markDone();
  }
  const pick = (v) => {
    verdict = v;
    upBtn.classList.toggle("picked-up", v === "up");
    downBtn.classList.toggle("picked-down", v === "down");
    ta.hidden = false;
    sendBtn.hidden = false;
    errEl.hidden = true;
  };
  upBtn.addEventListener("click", () => pick("up"));
  downBtn.addEventListener("click", () => pick("down"));
  sendBtn.addEventListener("click", async () => {
    const body = { scene: scene.id, verdict, comment: ta.value };
    if (!validateSpaceFeedback(body).ok) return;
    sendBtn.disabled = true;
    try {
      const res = await fetch("/api/space/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      localStorage.setItem(`space_fb_${scene.id}`, verdict);
      markDone();
    } catch {
      errEl.textContent = UI.fbErr[lang];
      errEl.hidden = false;
      sendBtn.disabled = false;
    }
  });

  // --- language-dependent card chrome ---------------------------------------
  const applyCardLang = () => {
    q.querySelector("p").textContent = scene.question[lang];
    reply.querySelector("p").textContent = scene.reply[lang];
    fb.querySelector(".fbq").textContent = UI.fbAsk[lang];
    ta.placeholder = UI.fbComment[lang];
    sendBtn.textContent = UI.fbSend[lang];
    doneEl.textContent = UI.fbDone[lang];
  };
  applyCardLang();
  cards.push({ handle, applyLang: applyCardLang });
  return card;
}

const gallery = $("gallery");
gallery.style.display = "flex";
gallery.style.flexDirection = "column";
gallery.style.gap = "1.1rem";
for (const scene of SPACE_SCENES) gallery.appendChild(buildCard(scene));
applyLang();

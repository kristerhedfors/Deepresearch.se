// @ts-check
// The INLINE watch builder — the NHxx render mounted inside a chat turn, driven
// by the conversation instead of by a control panel.
//
// Feedback #49 wired "Seiko watch demo" to the /watch/ page as a CARD. Feedback
// #52 (2026-07-30) said what was actually wanted: "i want the watch builder to
// be inline so I get the watch animation here and suggestions on what one can
// change through text commands … every new reply contains a new watch animation
// with text on what changed". So this module is the /watch/ page's stage without
// its panel: the canvas, the what-changed line, the spec, the fit warnings, and
// the suggested next commands — the commands ARE the controls.
//
// Self-contained on purpose, the rule space-embed.js and demo-embed.js follow:
// it injects its own scoped CSS (`wa-` classes) once per document, so both tiers
// mount it without either page owning stage styling. Every deterministic
// decision — which build, what changed, what to suggest — is already made in
// the pure core public/js/watch-chat-core.js; this module is DOM + WebGL glue.
//
// FAIL-SOFT, and specifically fail-soft INTO the card: a device with no working
// WebGL gets null back, and the caller falls through to demo-embed.js's link
// card, which is the honest degrade — the builder still exists, it just cannot
// draw here.

import { mountWatch } from "./watch-render.js";
import { checkBuild } from "./watch-core.js";
import { builderLink, changeSummary, specLine, suggestCommands } from "./watch-chat-core.js";

const STAGE_CSS = `
.wa-wrap { margin: 0 0 .7rem; }
.wa-stage { position: relative; border: 1px solid #1d2a45; border-radius: 12px; overflow: hidden; background: #0e1014; }
.wa-stage canvas { display: block; width: 100%; height: 320px; touch-action: none; cursor: grab; }
.wa-stage canvas:active { cursor: grabbing; }
.wa-hint { position: absolute; top: .5rem; right: .7rem; font-size: .72rem; color: rgba(157,185,214,.55); pointer-events: none; }
.wa-changed {
  position: absolute; top: .5rem; left: .7rem; max-width: 65%;
  font-size: .78rem; line-height: 1.35; color: #dbe6f6;
  background: rgba(6,9,16,.62); border-radius: 8px; padding: .2rem .45rem; pointer-events: none;
}
.wa-hud {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: .4rem;
  padding: .5rem .7rem; background: linear-gradient(transparent, rgba(6,9,16,.85) 45%);
}
.wa-hud button {
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18);
  color: #d7e3f7; border-radius: 8px; padding: .22rem .5rem; font-size: .76rem; cursor: pointer;
}
.wa-hud button:hover { background: rgba(255,255,255,.14); }
.wa-spec { margin: .45rem 0 0; font-size: .8rem; line-height: 1.45; opacity: .75; font-variant-numeric: tabular-nums; }
.wa-issues { margin: .3rem 0 0; font-size: .8rem; line-height: 1.45; }
.wa-issues .wa-error { color: #f2a5a5; }
.wa-issues .wa-warning { color: #e6c98a; }
.wa-issues div { margin-top: .12rem; }
.wa-try { margin: .5rem 0 0; font-size: .76rem; letter-spacing: .04em; text-transform: uppercase; opacity: .55; }
.wa-chips { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .3rem; }
.wa-chips button, .wa-chips span {
  font: inherit; font-size: .8rem; border-radius: 999px; padding: .25rem .6rem;
  border: 1px solid rgba(127,180,238,.3); background: rgba(127,180,238,.07); color: inherit;
}
.wa-chips button { cursor: pointer; }
.wa-chips button:hover { border-color: rgba(127,180,238,.6); background: rgba(127,180,238,.15); }
/* The app door (feedback #56). It LEADS the card, so it is a button and not a
   trailing link — a reader who finds typing commands clunky should meet it
   before the render, not under four paragraphs of it. */
.wa-open {
  display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
  margin: 0 0 .5rem; padding: .5rem .7rem;
  border: 1px solid rgba(127,180,238,.42); border-radius: 10px;
  background: linear-gradient(90deg, rgba(127,180,238,.16), rgba(127,180,238,.05));
}
.wa-open a {
  font-weight: 600; font-size: .86rem; color: #cfe4ff; text-decoration: none;
  border: 1px solid rgba(127,180,238,.55); border-radius: 999px;
  padding: .3rem .75rem; background: rgba(127,180,238,.14); white-space: nowrap;
}
.wa-open a:hover { background: rgba(127,180,238,.28); border-color: rgba(127,180,238,.9); }
.wa-open span { font-size: .78rem; line-height: 1.35; opacity: .72; }
@media (max-width: 560px) { .wa-stage canvas { height: 260px; } .wa-changed { max-width: 80%; } }
`;

const UI = {
  hint: { en: "drag to rotate · pinch/scroll to zoom", sv: "dra för att rotera · nyp/skrolla för att zooma" },
  lumeOn: { en: "lights out", sv: "släck lamporna" },
  lumeOff: { en: "lights on", sv: "tänd lamporna" },
  top: { en: "top view", sv: "ovanifrån" },
  reset: { en: "reset view", sv: "återställ vy" },
  png: { en: "save PNG", sv: "spara PNG" },
  tryTyping: { en: "Try typing", sv: "Prova att skriva" },
  tryTypingStatic: { en: "Try typing one of these", sv: "Prova att skriva någon av dessa" },
  open: { en: "Open the full builder →", sv: "Öppna hela byggaren →" },
  openWhy: {
    en: "Opens this exact build with every slot, the sources and where to buy — no retyping.",
    sv: "Öppnar exakt det här bygget med alla delar, källorna och var man köper — inget behöver skrivas om.",
  },
};

/** @param {Document} doc */
function ensureStyles(doc) {
  if (doc.getElementById("wa-stage-styles")) return;
  const style = doc.createElement("style");
  style.id = "wa-stage-styles";
  style.textContent = STAGE_CSS;
  doc.head.appendChild(style);
}

/**
 * Mount one turn's watch. `state` is watch-chat-core.js's watchThread result for
 * the conversation up to this turn — the build, what the last message changed,
 * and any view command that came with it.
 *
 * `opts.onCommand` is the host page's composer, lent through demo-mount.js. With
 * it a suggestion chip sends the command it shows; without it the chips are
 * read-only hints, which still answers the ask ("suggestions on what one can
 * change") on a surface that has no composer to lend.
 *
 * @param {HTMLElement} host
 * @param {import('./watch-chat-core.js').WatchThreadState} state
 * @param {{ lang?: string, moreLink?: boolean, onCommand?: ((text: string) => void) | null }} [opts]
 * @returns {{ destroy: () => void } | null} null when WebGL is unavailable —
 *   the caller falls back to the link card.
 */
export function mountWatchBuild(host, state, opts = {}) {
  if (!host || !state || !state.active) return null;
  const doc = host.ownerDocument;
  if (!doc) return null;
  const lang = (opts.lang || state.lang) === "sv" ? "sv" : "en";
  const sender = typeof opts.onCommand === "function" ? opts.onCommand : null;
  ensureStyles(doc);

  const wrap = doc.createElement("div");
  wrap.className = "wa-wrap";

  // The app door FIRST (feedback #56: "building through the chatbot interface is
  // unavoidably clunky and the wrong approach — send user to the app
  // immediately"). The owner kept both surfaces, so the answer is not to remove
  // the inline builder but to make one tap out of it the first thing on the
  // card, carrying this turn's build in the hash.
  if (opts.moreLink !== false) {
    const open = doc.createElement("div");
    open.className = "wa-open";
    const link = doc.createElement("a");
    link.href = builderLink(state.code || state.build);
    link.textContent = UI.open[lang];
    open.appendChild(link);
    const why = doc.createElement("span");
    why.textContent = UI.openWhy[lang];
    open.appendChild(why);
    wrap.appendChild(open);
  }

  const stage = doc.createElement("div");
  stage.className = "wa-stage";
  const canvas = doc.createElement("canvas");
  stage.appendChild(canvas);
  wrap.appendChild(stage);
  host.appendChild(wrap);

  let view;
  try {
    view = mountWatch(/** @type {HTMLCanvasElement} */ (canvas), { onError: () => {} });
  } catch {
    view = null;
  }
  if (!view) {
    wrap.remove();
    return null;
  }
  try {
    view.setBuild(state.build);
  } catch {
    view.destroy();
    wrap.remove();
    return null;
  }

  // The view commands the same message could carry ("lights out", "top view").
  if (state.view && state.view.lume === true) view.setLume(true);
  if (state.view && state.view.top) view.topView();

  const changed = doc.createElement("div");
  changed.className = "wa-changed";
  changed.textContent = changeSummary(state.changes, lang, {
    reset: state.reset, randomized: state.randomized, view: state.view, opened: state.opened,
  });
  stage.appendChild(changed);

  const hint = doc.createElement("div");
  hint.className = "wa-hint";
  hint.textContent = UI.hint[lang];
  stage.appendChild(hint);

  // --- HUD: the three things a render needs that no text command can express
  // (where the camera is) plus the frame grab.
  const hud = doc.createElement("div");
  hud.className = "wa-hud";
  let lume = !!(state.view && state.view.lume);
  /** @param {string} label @param {() => void} onClick @returns {HTMLButtonElement} */
  const addButton = (label, onClick) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", onClick);
    hud.appendChild(b);
    return b;
  };
  const lumeBtn = addButton(lume ? UI.lumeOff[lang] : UI.lumeOn[lang], () => {
    lume = !lume;
    view.setLume(lume);
    lumeBtn.textContent = lume ? UI.lumeOff[lang] : UI.lumeOn[lang];
  });
  addButton(UI.top[lang], () => view.topView());
  addButton(UI.reset[lang], () => view.resetView());
  addButton(UI.png[lang], () => {
    try {
      const a = doc.createElement("a");
      a.href = view.toPNG();
      a.download = `${state.code.replace(/[^a-z0-9]+/gi, "-").slice(0, 80) || "watch"}.png`;
      a.click();
    } catch { /* a blocked download must not break the turn */ }
  });
  stage.appendChild(hud);

  const spec = doc.createElement("p");
  spec.className = "wa-spec";
  spec.textContent = specLine(state.build, lang);
  wrap.appendChild(spec);

  // Compatibility: the whole reason this tool exists next to a render. Notes are
  // left out here — they are catalogue caveats the /watch/ page has room for,
  // and a chat turn does not.
  const issues = checkBuild(state.build).issues.filter((x) => x.level !== "note");
  if (issues.length) {
    const box = doc.createElement("div");
    box.className = "wa-issues";
    for (const issue of issues) {
      const row = doc.createElement("div");
      row.className = issue.level === "error" ? "wa-error" : "wa-warning";
      row.textContent = `${issue.level === "error" ? "✕" : "!"} ${issue[lang] || issue.en}`;
      box.appendChild(row);
    }
    wrap.appendChild(box);
  }

  // --- the suggestions. Rotated by turn number in the core, so consecutive
  // replies do not offer the same three things.
  const commands = suggestCommands(state.build, lang, state.turn);
  if (commands.length) {
    const label = doc.createElement("p");
    label.className = "wa-try";
    label.textContent = sender ? UI.tryTyping[lang] : UI.tryTypingStatic[lang];
    wrap.appendChild(label);
    const chips = doc.createElement("div");
    chips.className = "wa-chips";
    for (const command of commands) {
      if (sender) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = command;
        b.addEventListener("click", () => {
          try {
            if (sender) sender(command);
          } catch { /* the chip is a shortcut, never a requirement */ }
        });
        chips.appendChild(b);
      } else {
        const s = doc.createElement("span");
        s.textContent = command;
        chips.appendChild(s);
      }
    }
    wrap.appendChild(chips);
  }

  // (The link out lives at the TOP of the card now — see the wa-open block
  // above. One door, and it is the first thing on the card, not the last.)

  // Only draw while on screen. A long conversation can hold several of these,
  // and each one is a WebGL context with its own animation loop.
  /** @type {IntersectionObserver | null} */
  let observer = null;
  try {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) view.setRunning(entry.isIntersecting);
    }, { rootMargin: "120px" });
    observer.observe(stage);
  } catch { /* no IntersectionObserver: it simply keeps drawing */ }

  return {
    destroy() {
      try {
        if (observer) observer.disconnect();
      } catch { /* already gone */ }
      view.destroy();
      wrap.remove();
    },
  };
}

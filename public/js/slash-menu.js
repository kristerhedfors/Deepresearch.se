// @ts-check
// The slash-command TYPEAHEAD — the composer half of the platform's command
// surface (owner directive, 2026-07-26: "just typing slash should show you
// various options from a list from the available commands").
//
// ONE module for BOTH tiers: public/js/app.js mounts it on the Se/rver
// composer and public/cure/drc.js on the Se/cure one. They differ in nothing —
// same markup, same keys, same rows — because the commands are platform
// baseline, not a per-tier or per-agent feature. All the decision-making lives
// in the pure core (slash-core.js: which rows, in which order, in which
// language, and where the highlight moves), so this file only draws and
// listens; the behaviour is unit-tested without a DOM.
//
// Interaction (UX-13, the ux-conventions registry):
//   · a "/" typed as the FIRST character of the composer opens the list;
//   · typing filters it, and the moment the text stops being a bare command
//     token — an argument is being written, or the slash isn't at position 0 —
//     the list closes and Enter sends as usual (UX-8);
//   · ↑/↓ move the highlight (wrapping), Enter or Tab picks, Escape closes,
//     a click/tap picks;
//   · picking inserts "/name " and leaves the caret after it, so the user types
//     the argument straight on and Enter then SENDS. There is no state to get
//     stuck in.
//
// The keydown listener is bound to `document` in the CAPTURE phase, so it runs
// before the composer's own Enter-sends handler (app.js / drc.js) no matter
// which module was loaded first, and stops propagation only for the keys the
// open menu actually consumes.

import { moveSlashIndex, slashMenuItems } from "./slash-core.js";

/**
 * Mount the typeahead on a composer.
 * @param {Object} opts
 * @param {HTMLTextAreaElement | HTMLInputElement} opts.input the composer field
 * @param {HTMLElement} opts.container the positioned ancestor to hang the list in (#composer)
 * @param {() => ("en"|"sv")} [opts.lang] reply-language picker (canned-faq detectLang convention)
 * @param {string} [opts.id] element id, for styling hooks
 * @returns {{ close: () => void, isOpen: () => boolean, refresh: () => void }}
 */
export function mountSlashMenu({ input, container, lang, id = "slashmenu" }) {
  const menu = document.createElement("div");
  menu.id = id;
  menu.className = "slash-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Commands");
  menu.hidden = true;
  container.appendChild(menu);

  /** @type {ReturnType<typeof slashMenuItems>} */
  let items = [];
  let index = 0;

  const isOpen = () => !menu.hidden;

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.textContent = "";
    items = [];
    index = 0;
    input.removeAttribute("aria-expanded");
  }

  function paint() {
    menu.textContent = "";
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button"; // never submits the form it lives in
      row.className = "slash-item" + (i === index ? " active" : "");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === index ? "true" : "false");
      const head = document.createElement("span");
      head.className = "slash-name";
      head.textContent = item.title;
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "slash-args";
        hint.textContent = " " + item.hint;
        head.appendChild(hint);
      }
      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = item.desc;
      row.append(head, desc);
      // pointerdown, not click: the textarea must not lose focus first (a blur
      // would close the menu under the finger before the click landed).
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        choose(i);
      });
      menu.appendChild(row);
    });
  }

  /** @param {number} i */
  function choose(i) {
    const item = items[i];
    if (!item) return;
    input.value = item.insert;
    close();
    try {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } catch {
      /* not focusable yet — the value is set either way */
    }
    // Let the composer's own listeners (autogrow, mode hints) see the change.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function refresh() {
    const l = (() => {
      try {
        return lang ? lang() : "en";
      } catch {
        return "en";
      }
    })();
    const next = slashMenuItems(input.value, l === "sv" ? "sv" : "en");
    if (!next.length) return close();
    // Keep the highlight on the same command while the list narrows; otherwise
    // start at the top.
    const keep = items[index]?.name;
    items = next;
    const at = next.findIndex((c) => c.name === keep);
    index = at >= 0 ? at : 0;
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paint();
  }

  input.addEventListener("input", refresh);
  input.addEventListener("blur", () => setTimeout(close, 120));

  document.addEventListener(
    "keydown",
    (e) => {
      if (!isOpen() || e.target !== input) return;
      if (e.isComposing || e.keyCode === 229) return; // IME candidate, not navigation
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        index = moveSlashIndex(index, e.key === "ArrowDown" ? 1 : -1, items.length);
        paint();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        choose(index);
      }
    },
    true,
  );

  // UX-1: any interaction outside the list dismisses it.
  document.addEventListener("pointerdown", (e) => {
    if (!isOpen()) return;
    const t = /** @type {Node} */ (e.target);
    if (menu.contains(t) || t === input) return;
    close();
  });

  return { close, isOpen, refresh };
}

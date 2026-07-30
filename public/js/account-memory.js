// @ts-check
// The account panel's "Memory" view — Settings → Memory, one level below the
// gear icon, same treatment as the LLM sharing and MCP server screens (a door
// rather than a knob, because it holds a switch, a browsable store and two
// destructive-or-exporting actions).
//
// What it shows: what memory is and what it is not, the switch that fills it,
// how much is stored, a readable list of the notes themselves, and the two
// buttons the whole feature exists to make ordinary — DOWNLOAD (the vault, as
// an Obsidian-ready .zip) and RESET (delete everything).
//
// The notes are shown in full rather than as a count. A store of what the
// system has quietly decided to remember about someone is exactly the kind of
// thing that must be inspectable, not merely deletable — a reset button over
// an opaque store asks the user to take it on faith.
//
// Server: src/memory.js (GET /api/memory, GET /api/memory/export,
// DELETE /api/memory). Note model + Obsidian serialization: memory-core.js.

import { escapeHtml } from "./notifications.js";
import { settingRow, wireSettingPopovers } from "./account-views.js";
import { NOTE_TYPES } from "./memory-core.js";
import { memoryOn, setMemory } from "./settings.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

/** Note type → the vault folder it files under, for display. @param {string} t */
const folderFor = (t) => /** @type {Record<string,string>} */ (NOTE_TYPES)[t] || "Notes";

const HEADER = `
  <button id="memorybackbtn" type="button" class="back-link">← Back</button>
  <p class="section-lbl">Memory</p>`;

const INTRO = `Research you do here can leave behind <b>notes</b> — one per person,
  place, organisation or idea that came up — linked to each other. Later questions
  are answered with those notes in view, so you don't start from nothing every time.
  It's stored the way <b>Obsidian</b> stores knowledge, which means you can download
  the whole thing and open it in Obsidian (or any Markdown editor) whenever you like.`;

const MEMORY_INFO = `<strong>Memory</strong><br>
  <b>On:</b> after each answer, a short pass picks out anything durable — facts about
  the things you research — and files it as notes. Small talk, your phrasing and
  one-off questions are deliberately skipped.<br>
  <b>Off (the default):</b> nothing is written. Notes already stored stay put and
  stay downloadable until you reset.<br>
  <b>Never recorded:</b> anything from a <b>ghost</b> (incognito) chat, and anything
  that looks like a credential or a payment detail.<br>
  <b>Where it lives:</b> on the server, tied to this account. That makes it a
  DeepResearch.<b>Se<span class="sl">/</span>rver</b> feature only —
  DeepResearch.<b>Se<span class="sl">/</span>cure</b> keeps the server out of its
  data path, so it has no memory of this kind and never will.`;

/** @param {number} ts */
const when = (ts) => (ts ? new Date(ts).toLocaleDateString() : "");

/**
 * One note, rendered read-only. Links show as the wikilink text they are in
 * the exported vault, so what you see here and what you open in Obsidian match.
 * @param {any} note
 * @returns {string}
 */
function noteHtml(note) {
  const links = Array.isArray(note.links) ? note.links : [];
  const tags = Array.isArray(note.tags) ? note.tags : [];
  return `
    <div class="mem-note">
      <p class="mem-note-head">
        <b>${escapeHtml(note.title || note.slug)}</b>
        <span class="muted">${escapeHtml(folderFor(note.type))}${
          note.updated_at ? ` · ${escapeHtml(when(note.updated_at))}` : ""
        }</span>
      </p>
      <p>${escapeHtml(note.body || "")}</p>
      ${links.length ? `<p class="muted mem-note-links">${links.map((/** @type {string} */ l) => `[[${escapeHtml(l)}]]`).join(" ")}</p>` : ""}
      ${tags.length ? `<p class="muted mem-note-tags">${tags.map((/** @type {string} */ t) => `#${escapeHtml(t)}`).join(" ")}</p>` : ""}
    </div>`;
}

/**
 * @param {any} data the /api/memory payload
 * @returns {string}
 */
function statsHtml(data) {
  const count = Number(data?.count) || 0;
  if (!count) {
    return `<p class="muted">No notes yet. With the switch above on, they build up as you research.</p>`;
  }
  const links = Number(data?.links) || 0;
  const types = Object.entries(data?.by_type || {})
    .map(([t, n]) => `${n} ${escapeHtml(folderFor(t).toLowerCase())}`)
    .join(" · ");
  return `<p class="muted">${count} note${count === 1 ? "" : "s"} · ${links} link${
    links === 1 ? "" : "s"
  }${types ? ` · ${types}` : ""} · room for ${escapeHtml(String(data?.max_notes || ""))}</p>`;
}

/**
 * Render + wire the Memory view.
 * @param {PanelCtx} ctx
 */
export async function loadMemoryView(ctx) {
  ctx.body.innerHTML = `${HEADER}<p class="muted">Loading…</p>`;
  /** @type {any} */
  let data = null;
  /** @type {string} */
  let error = "";
  try {
    const res = await fetch("/api/memory");
    if (res.ok) data = await res.json();
    else error = (await res.json().catch(() => ({})))?.error || `Memory is unavailable (${res.status}).`;
  } catch {
    error = "Couldn't reach the server.";
  }
  if (error) {
    ctx.body.innerHTML = `${HEADER}<p class="muted">${escapeHtml(error)}</p>`;
    document.getElementById("memorybackbtn")?.addEventListener("click", () => ctx.show("settings"));
    return;
  }

  const notes = Array.isArray(data?.notes) ? data.notes : [];
  ctx.body.innerHTML = `
    ${HEADER}
    <p class="muted">${INTRO}</p>
    ${settingRow({
      id: "memoryknob",
      label: "Remember what I research",
      checked: memoryOn(),
      popId: "memorypop",
      info: MEMORY_INFO,
    })}
    <p id="memorystatus" class="muted setting-note" hidden></p>
    <p class="section-lbl">What's stored</p>
    <div id="memstats">${statsHtml(data)}</div>
    <div class="account-actions">
      <button type="button" id="memdownload"${notes.length ? "" : " disabled"}>Download vault (.zip)</button>
      <button type="button" id="memreset"${notes.length ? "" : " disabled"}>Reset memory</button>
    </div>
    <p class="muted setting-note">The download is a folder of Markdown notes with
      <code>[[links]]</code> between them — open it in Obsidian as a vault, or read it
      anywhere. Reset deletes every note here for good; the download is the only copy
      you'll keep.</p>
    <div id="memnotes">${notes.map(noteHtml).join("")}</div>`;

  document.getElementById("memorybackbtn")?.addEventListener("click", () => ctx.show("settings"));
  wireSettingPopovers(ctx.body);

  const status = document.getElementById("memorystatus");
  /** @param {string} msg */
  const say = (msg) => {
    if (!status) return;
    status.textContent = msg;
    status.hidden = !msg;
  };

  const knob = /** @type {HTMLInputElement | null} */ (document.getElementById("memoryknob"));
  knob?.addEventListener("change", async () => {
    const want = knob.checked;
    knob.disabled = true;
    const ok = await setMemory(want);
    knob.disabled = false;
    if (!ok) {
      knob.checked = !want;
      say("Couldn't save that — try again.");
      return;
    }
    say(want ? "New research will be remembered." : "Memory is off. Nothing new will be written.");
  });

  // The download is a plain navigation to the export endpoint rather than a
  // fetch + object URL: the server already sets Content-Disposition, and
  // letting the browser own the transfer keeps the file out of the page's
  // memory and works the same in the installed PWA.
  document.getElementById("memdownload")?.addEventListener("click", () => {
    say("Preparing your vault…");
    location.href = "/api/memory/export";
    setTimeout(() => say(""), 3000);
  });

  document.getElementById("memreset")?.addEventListener("click", async () => {
    // Deliberately a confirm(): this is the one irreversible control on the
    // screen, and the download sitting next to it is what the user would wish
    // they had tapped first.
    if (!confirm(`Delete all ${notes.length} note${notes.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    const btn = /** @type {HTMLButtonElement} */ (document.getElementById("memreset"));
    btn.disabled = true;
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error(String(res.status));
      loadMemoryView(ctx);
    } catch {
      btn.disabled = false;
      say("Couldn't reset just now — try again.");
    }
  });
}

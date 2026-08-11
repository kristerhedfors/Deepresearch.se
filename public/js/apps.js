// @ts-check
// Published apps — the page behind /apps/. Lists what Agent Studio has
// published to `/app/<slug>/` and lets the owner (or an admin) rename an app,
// edit its files, and delete it.
//
// The "C" of CRUD is deliberately absent: apps are CREATED in the chat, in
// Agent Studio, and this page's empty state says so rather than growing a
// second builder. Everything else is here — read, update, delete.
//
// Every rule and every format lives in ./apps-core.js (pure, Node-tested) and
// is IMPORTED rather than restated: the title cap, the sort orders, the search
// match, who may manage an app, the edit check and the remove planner, byte
// sizes and relative times. A cap that means one thing in the API and another in the UI is the
// bug this split exists to prevent. This file is DOM + fetch only.
//
// Fail-soft throughout, in the same voice as public/js/captures.js: a 403 for
// somebody else's app, a 404 for one that was deleted in another tab, a Worker
// that predates the endpoint — each ends in a calm inline sentence, never a
// blank screen or a thrown error.

import {
  APP_SORTS,
  APP_TITLE_MAX,
  appUrl,
  canManageApp,
  checkFileEdit,
  formatBytes,
  formatWhen,
  normalizeAppTitle,
  planFileRemove,
  selectApps,
} from "./apps-core.js";

const API = "/api/apps";
/** Where the page renders, and where the count is written. */
const BOX_ID = "apps";
const COUNT_ID = "apps-count";

/** Human labels for the four sort orders apps-core offers. Keyed by the core's
 * ids so adding a sort there surfaces here as a missing label rather than as a
 * silently absent option. */
const SORT_LABELS = {
  new: "Newest",
  old: "Oldest",
  name: "Name",
  size: "Largest",
};

/** How close to the title cap the remaining-characters hint appears. Below
 * this it is noise: nobody typing a six-word name needs a countdown. */
const TITLE_HINT_AT = 24;

/** The edge caches a published app for 60 s (src/build-pub.js sets
 * `cache-control: public, max-age=60`), so a save is live immediately but a tab
 * already holding the old copy may need a hard reload. Said once, after a save,
 * rather than as standing small print. */
const CACHE_NOTE = "The live URL is updated. /app/ responses are cached for 60 seconds, so an already-open tab may need a hard reload.";

/**
 * @typedef {{slug: string, title: string, createdAt: number, updatedAt: number,
 *   owner: string, files: number, bytes: number, url: string}} AppRow
 */

/** Module state — one page, one listing, at most one open app. */
const state = {
  /** @type {AppRow[]} every app the server returned for the current scope */
  apps: [],
  /** @type {{id?: string, role?: string}} the caller, per the listing response */
  me: {},
  /** @type {string} the live search box contents (filtering is client-side) */
  q: "",
  /** @type {string} one of APP_SORTS */
  sort: "new",
  /** @type {boolean} admin-only: list every account's apps, not just mine */
  all: false,
  /** @type {string|null} a listing-level error to show instead of the grid */
  error: null,
  /** @type {boolean} true until the first listing lands (so "no apps yet" is
   * never claimed before we have asked) */
  loading: true,
  /** @type {boolean} the server hit its listing cap and stopped walking. Said
   * out loud rather than swallowed: a capped list that looks complete is the
   * one failure mode where the page would be actively lying. */
  truncated: false,
  /** @type {string|null} the slug whose detail view is open; null = the list */
  open: null,
  /** @type {{app: AppRow, files: Array<{path: string, size: number}>, can_manage: boolean}|null} */
  detail: null,
  /** @type {string|null} an error from the detail fetch */
  detailError: null,
  /** @type {string|null} the file being edited */
  file: null,
  /** @type {string} the content as LOADED — what Revert restores to */
  loaded: "",
  /** @type {string} the content as EDITED */
  draft: "",
  /** @type {Map<string, string>} contents fetched this session, keyed by path.
   * The editor reads from here; the SAVE check needs only sizes (checkFileEdit). */
  contents: new Map(),
  /** @type {string|null} a message under the editor (error or confirmation) */
  fileMsg: null,
  /** @type {boolean} whether fileMsg is an error */
  fileMsgIsError: false,
  /** @type {string|null} the slug whose delete confirmation is showing */
  confirming: null,
  /** @type {string|null} the slug whose rename form is open */
  renaming: null,
  /** @type {boolean} true while a write is in flight */
  busy: false,
};

// ---- tiny DOM helpers ------------------------------------------------------
// App titles, slugs and file contents are text this page did not author: a
// title is whatever the build wrote, and a file's contents are program source.
// So NOTHING here interpolates into innerHTML — every string lands via
// textContent, which cannot inject markup at all.

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * A real <button> for every action — never a clickable div — so the keyboard
 * and the screen reader get the page for free.
 * @param {string} label
 * @param {string} cls
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function btn(label, cls, onClick) {
  const b = /** @type {HTMLButtonElement} */ (el("button", cls, label));
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * @param {string} href
 * @param {string} label
 * @param {string} [cls]
 * @returns {HTMLAnchorElement}
 */
function link(href, label, cls) {
  const a = /** @type {HTMLAnchorElement} */ (el("a", cls, label));
  a.href = href;
  return a;
}

/** @param {string} id */
function byId(id) {
  return document.getElementById(id);
}

/**
 * JSON fetch with an `__error` envelope on ANY failure, so no caller has to
 * think about exceptions. A 403 (somebody else's app) and a 404 (deleted in
 * another tab) are ordinary outcomes here, not incidents: the server's own
 * `{error}` string is carried through verbatim and shown, which is the whole
 * reason a wrong click never produces a blank screen.
 *
 * A 204 (DELETE an app) has no body; `.catch` turns that into `{}` and the
 * `res.ok` check lets it through as success.
 *
 * @param {string} path
 * @param {{ method?: string, body?: any }} [opts]
 * @returns {Promise<any>}
 */
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
      headers: opts.body ? { "content-type": "application/json" } : {},
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { __error: data?.error || `HTTP ${res.status}` };
    return data ?? {};
  } catch {
    return { __error: "Network error — nothing was changed." };
  }
}

// ---- entry point -----------------------------------------------------------

/**
 * Start the page. Exported (rather than run from module scope) so the module
 * can be imported and reasoned about without a DOM.
 *
 * Never throws: a rendering bug must leave the page's own explanation standing
 * rather than replacing it with a broken grid.
 *
 * @returns {Promise<void>}
 */
export async function startApps() {
  const box = byId(BOX_ID);
  if (!box) return; // not this page — nothing to do
  try {
    render(box);
    await loadList(box);
  } catch {
    box.textContent = "The app list could not be loaded.";
    box.className = "muted";
  }
}

// Self-start. `type="module"` scripts are deferred, so by the time this runs
// the document is normally parsed and #apps exists; the readyState check covers
// the one case that isn't (a dynamic import from a still-parsing document),
// because a start that silently found no container would look exactly like an
// account with no apps.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { startApps(); });
} else {
  startApps();
}

// ---- fetching --------------------------------------------------------------

/**
 * Fetch the listing for the current scope and repaint.
 *
 * The server also understands `?q=` and `?sort=` — this page does NOT use them.
 * Search filters live, on every keystroke, and round-tripping that would put a
 * network hop between a letter and the grid for a list that is an account's
 * builds. The same apps-core functions run on both ends, so the two answers
 * agree by construction. `?all=1` is the one parameter worth a refetch: it
 * changes which rows exist, not which of them to show.
 *
 * @param {HTMLElement} box
 */
async function loadList(box) {
  state.loading = true;
  state.error = null;
  render(box);
  const data = await api(state.all ? `${API}?all=1` : API);
  state.loading = false;
  if (data.__error) {
    state.error = String(data.__error);
    state.apps = [];
  } else {
    state.apps = Array.isArray(data.apps) ? data.apps : [];
    state.me = data.me && typeof data.me === "object" ? data.me : {};
    state.truncated = Boolean(data.truncated);
  }
  render(box);
}

/**
 * Open one app's detail view.
 * @param {HTMLElement} box
 * @param {string} slug
 */
async function loadDetail(box, slug) {
  state.open = slug;
  state.detail = null;
  state.detailError = null;
  state.file = null;
  state.loaded = "";
  state.draft = "";
  state.fileMsg = null;
  state.contents = new Map();
  render(box);
  const data = await api(`${API}/${encodeURIComponent(slug)}`);
  if (state.open !== slug) return; // navigated away while in flight
  if (data.__error) {
    state.detailError = String(data.__error);
  } else {
    state.detail = {
      app: data.app,
      files: Array.isArray(data.files) ? data.files : [],
      can_manage: Boolean(data.can_manage),
    };
  }
  render(box);
  // Land the keyboard somewhere meaningful after the view swap, so a keyboard
  // or screen-reader user is not left at the top of a page that just changed
  // under them.
  const back = box.querySelector(".app-back");
  if (back instanceof HTMLElement) back.focus();
}

/**
 * Load one file's content into the editor.
 * @param {HTMLElement} box
 * @param {string} path
 */
async function loadFile(box, path) {
  state.file = path;
  state.fileMsg = null;
  const cached = state.contents.get(path);
  if (typeof cached === "string") {
    state.loaded = cached;
    state.draft = cached;
    render(box);
    return;
  }
  state.loaded = "";
  state.draft = "";
  render(box);
  const slug = state.open;
  if (!slug) return;
  const data = await api(`${API}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`);
  if (state.file !== path || state.open !== slug) return;
  if (data.__error) {
    setFileMsg(String(data.__error), true);
  } else {
    const content = typeof data.content === "string" ? data.content : "";
    state.contents.set(path, content);
    state.loaded = content;
    state.draft = content;
  }
  render(box);
}

// ---- rendering -------------------------------------------------------------

/**
 * Paint the whole page from `state`. One entry point, called after every
 * change — the surface is small enough that a full repaint is simpler to reason
 * about than a set of targeted updates, and it means no view can drift out of
 * step with the data behind it.
 *
 * The one thing repainting must NOT do is destroy work in progress, so the
 * editor's textarea and the search box write back to `state` on every input
 * and are re-created from it.
 *
 * @param {HTMLElement} box
 */
function render(box) {
  box.innerHTML = "";
  if (state.open) {
    renderDetail(box);
    return;
  }

  box.appendChild(toolbar(box));
  // The results live in their own container so a keystroke in the search box
  // can repaint the grid WITHOUT rebuilding the box it was typed into — which
  // would take the caret and the focus with it on every letter.
  box.appendChild(el("div", "app-results"));
  paintResults(box);
}

/**
 * Fill (or refill) the results container from `state`. Called by the initial
 * render and by every search keystroke.
 * @param {HTMLElement} box
 */
function paintResults(box) {
  const out = box.querySelector(".app-results");
  if (!(out instanceof HTMLElement)) return;
  out.innerHTML = "";

  if (state.error) {
    out.appendChild(el("p", "err", state.error));
    showCount(0);
    return;
  }
  if (state.loading) {
    out.appendChild(el("p", "muted", "Loading…"));
    showCount(0);
    return;
  }

  showCount(state.apps.length);

  // No apps AT ALL is a different message from "no apps match what you typed",
  // and conflating them is how a search for a typo reads as "you have nothing".
  if (!state.apps.length) {
    out.appendChild(emptyState());
    return;
  }

  const rows = selectApps(state.apps, { q: state.q, sort: state.sort });
  if (!rows.length) {
    const p = el("p", "muted");
    p.append(`Nothing matches “${state.q}”. `);
    p.appendChild(btn("Clear the search", "linkish", () => {
      state.q = "";
      const field = byId("app-search");
      if (field instanceof HTMLInputElement) {
        field.value = "";
        field.focus();
      }
      paintResults(box);
    }));
    out.appendChild(p);
    return;
  }

  const grid = el("div", "app-grid");
  for (const app of rows) grid.appendChild(card(box, app));
  out.appendChild(grid);

  if (state.q) {
    out.appendChild(el("p", "muted", `${rows.length} of ${state.apps.length} shown.`));
  }
  // The server's listing walk is bounded. When it stopped early, the search box
  // above is searching a PARTIAL list — which is exactly the moment a reader
  // would otherwise conclude an app had been deleted.
  if (state.truncated) {
    out.appendChild(el("p", "muted app-truncated", `Only the first ${state.apps.length} apps could be listed — there are more than this page can walk.`));
  }
}

/**
 * Search + sort + (for an admin) the all-accounts toggle.
 * @param {HTMLElement} box
 * @returns {HTMLElement}
 */
function toolbar(box) {
  const bar = el("div", "app-toolbar");

  const search = /** @type {HTMLInputElement} */ (document.createElement("input"));
  search.type = "search";
  search.id = "app-search";
  search.className = "app-search";
  search.placeholder = "Search by name or slug";
  search.value = state.q;
  // Filtering is client-side and instant. `appMatches` folds diacritics, so a
  // Swedish title is as findable as an English one whichever way it is typed.
  // Only the results are repainted — the field the letter was typed into stays
  // exactly as it is, caret included.
  search.addEventListener("input", () => {
    state.q = search.value;
    paintResults(box);
  });
  const searchLabel = el("label", "app-lbl", "Search");
  searchLabel.setAttribute("for", "app-search");
  const searchWrap = el("div", "app-field");
  searchWrap.appendChild(searchLabel);
  searchWrap.appendChild(search);
  bar.appendChild(searchWrap);

  const sort = /** @type {HTMLSelectElement} */ (document.createElement("select"));
  sort.id = "app-sort";
  sort.className = "app-sort";
  for (const id of APP_SORTS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = SORT_LABELS[id] || id;
    if (state.sort === id) opt.selected = true;
    sort.appendChild(opt);
  }
  sort.addEventListener("change", () => {
    state.sort = sort.value;
    render(box);
  });
  const sortLabel = el("label", "app-lbl", "Sort");
  sortLabel.setAttribute("for", "app-sort");
  const sortWrap = el("div", "app-field");
  sortWrap.appendChild(sortLabel);
  sortWrap.appendChild(sort);
  bar.appendChild(sortWrap);

  // The all-accounts view is a REFETCH, not a filter: those rows were never
  // sent. Offered only to an admin, because for anyone else it would be a
  // switch that changes nothing.
  if (state.me.role === "admin") {
    const check = /** @type {HTMLInputElement} */ (document.createElement("input"));
    check.type = "checkbox";
    check.id = "app-all";
    check.checked = state.all;
    check.addEventListener("change", () => {
      state.all = check.checked;
      loadList(box);
    });
    const label = el("label", "app-check");
    label.setAttribute("for", "app-all");
    label.appendChild(check);
    label.append(" All accounts’ apps");
    bar.appendChild(label);
  }

  return bar;
}

/**
 * The empty state. It is the page's answer to "where do apps come from", and
 * the reason this page never grew a builder of its own: creation lives in the
 * chat, so the empty state's job is to point at it clearly.
 * @returns {HTMLElement}
 */
function emptyState() {
  const wrap = el("div", "app-empty");
  wrap.appendChild(el("p", "", state.all ? "No published apps on any account yet." : "You have not published an app yet."));
  const p = el("p", "muted");
  p.append("Apps are built in ");
  p.appendChild(el("b", "", "Agent Studio"));
  p.append(" — the green entry in the chat’s mode dropdown. Open the chat, switch the mode to Agent Studio, and describe the app you want; when it is published it appears here.");
  wrap.appendChild(p);
  const go = link("/", "Open the chat", "app-cta");
  wrap.appendChild(go);
  return wrap;
}

/**
 * One app card.
 * @param {HTMLElement} box
 * @param {AppRow} app
 * @returns {HTMLElement}
 */
function card(box, app) {
  const c = el("div", "app-card");

  const head = el("div", "app-head");
  const title = el("h3", "app-title", app.title || app.slug);
  title.title = app.title || app.slug;
  head.appendChild(title);
  // The owner is only meaningful in the all-accounts view; in your own list
  // every badge would read the same and say nothing.
  if (state.all && app.owner) head.appendChild(el("span", "badge app-owner", app.owner));
  c.appendChild(head);

  c.appendChild(el("code", "app-slug", `#${app.slug}`));

  const facts = el("p", "app-facts muted");
  facts.textContent = [
    `${app.files} file${app.files === 1 ? "" : "s"}`,
    formatBytes(app.bytes),
    formatWhen(app.createdAt),
  ].join(" · ");
  // The two timestamps agree for an app nobody has edited (apps-core falls
  // updatedAt back to createdAt), so "edited" is only said when it is news.
  if (Number(app.updatedAt) > Number(app.createdAt)) {
    facts.append(` · edited ${formatWhen(app.updatedAt)}`);
  }
  c.appendChild(facts);

  const manage = canManageApp(app, state.me);

  if (state.renaming === app.slug && manage) {
    c.appendChild(renameForm(box, app, () => {
      state.renaming = null;
      render(box);
    }));
    return c;
  }

  if (state.confirming === app.slug && manage) {
    c.appendChild(confirmDelete(box, app));
    return c;
  }

  const actions = el("div", "app-actions");
  const open = link(app.url || appUrl(app.slug), "Open", "app-btn app-open");
  open.target = "_blank";
  open.rel = "noopener";
  open.title = `Open ${app.url || appUrl(app.slug)} in a new tab`;
  actions.appendChild(open);
  actions.appendChild(copyButton(app));
  if (manage) {
    actions.appendChild(btn("Edit", "secondary", () => loadDetail(box, app.slug)));
    actions.appendChild(btn("Rename", "secondary", () => {
      state.renaming = app.slug;
      state.confirming = null;
      render(box);
      focusIn(box, ".app-rename-input");
    }));
    actions.appendChild(btn("Delete", "secondary app-danger", () => {
      state.confirming = app.slug;
      state.renaming = null;
      render(box);
    }));
  }
  c.appendChild(actions);
  return c;
}

/**
 * Copy the app's public URL. Falls back to selecting the URL in a field when
 * the clipboard API is unavailable or refused (it needs a secure context and,
 * on some browsers, a permission), because "Copy link" that silently does
 * nothing is worse than no button.
 * @param {AppRow} app
 * @returns {HTMLElement}
 */
function copyButton(app) {
  const url = new URL(app.url || appUrl(app.slug), location.origin).href;
  const b = btn("Copy link", "secondary", async () => {
    try {
      await navigator.clipboard.writeText(url);
      const was = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = was; }, 1400);
    } catch {
      // Put the URL on screen, selected, so the copy is one keystroke away.
      const field = /** @type {HTMLInputElement} */ (document.createElement("input"));
      field.type = "text";
      field.readOnly = true;
      field.value = url;
      field.className = "app-copyfallback";
      b.replaceWith(field);
      field.focus();
      field.select();
    }
  });
  b.title = url;
  return b;
}

/**
 * The rename form — an inline edit of the title, capped where the server caps
 * it. The remaining-characters hint appears only near the cap; a countdown on
 * a three-word name is noise.
 * @param {HTMLElement} box
 * @param {AppRow} app
 * @param {() => void} done
 * @returns {HTMLElement}
 */
function renameForm(box, app, done) {
  const wrap = el("div", "app-rename");
  const input = /** @type {HTMLInputElement} */ (document.createElement("input"));
  input.type = "text";
  input.className = "app-rename-input";
  input.value = app.title || "";
  input.maxLength = APP_TITLE_MAX;
  input.setAttribute("aria-label", `New name for ${app.title || app.slug}`);
  wrap.appendChild(input);

  const hint = el("p", "app-hint muted");
  hint.hidden = true;
  wrap.appendChild(hint);
  const paintHint = () => {
    const left = APP_TITLE_MAX - input.value.length;
    hint.hidden = left > TITLE_HINT_AT;
    hint.textContent = left > 0 ? `${left} characters left` : "That is the longest a name can be.";
  };
  input.addEventListener("input", paintHint);
  paintHint();

  const err = el("p", "err app-rename-err");
  err.hidden = true;
  wrap.appendChild(err);

  const save = async () => {
    const title = normalizeAppTitle(input.value);
    if (!title) {
      err.textContent = "A name cannot be empty.";
      err.hidden = false;
      input.focus();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    const res = await api(`${API}/${encodeURIComponent(app.slug)}`, { method: "PATCH", body: { title } });
    state.busy = false;
    if (res.__error) {
      // The typed name stays in the field: losing it to a transient failure is
      // the one thing a rename must never do.
      err.textContent = String(res.__error);
      err.hidden = false;
      return;
    }
    mergeApp(res.app, app.slug, { title });
    done();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); done(); }
  });

  const row = el("div", "app-actions");
  row.appendChild(btn("Save name", "", save));
  row.appendChild(btn("Cancel", "secondary", done));
  wrap.appendChild(row);
  return wrap;
}

/**
 * The delete confirmation — step two of a two-step, in the card, in place.
 *
 * Never a bare `confirm()`: this destroys somebody's published work and takes
 * a live URL down with it, and a browser dialog says none of that. The card
 * names the app, says the word permanent, and says what happens to the URL.
 * @param {HTMLElement} box
 * @param {AppRow} app
 * @returns {HTMLElement}
 */
function confirmDelete(box, app) {
  const wrap = el("div", "app-confirm");
  wrap.appendChild(el("p", "app-confirm-lead", `Really delete “${app.title || app.slug}”?`));
  const detail = el("p", "muted");
  detail.append("This is permanent. All ");
  detail.append(`${app.files} file${app.files === 1 ? "" : "s"}`);
  detail.append(" are removed and ");
  detail.appendChild(el("code", "", app.url || appUrl(app.slug)));
  detail.append(" will return 404 for anyone you have shared it with.");
  wrap.appendChild(detail);

  const err = el("p", "err");
  err.hidden = true;
  wrap.appendChild(err);

  const row = el("div", "app-actions");
  const yes = btn("Delete permanently", "app-danger-solid", async () => {
    if (state.busy) return;
    state.busy = true;
    yes.disabled = true;
    const res = await api(`${API}/${encodeURIComponent(app.slug)}`, { method: "DELETE" });
    state.busy = false;
    yes.disabled = false;
    if (res.__error) {
      err.textContent = String(res.__error);
      err.hidden = false;
      return;
    }
    state.apps = state.apps.filter((a) => a.slug !== app.slug);
    state.confirming = null;
    if (state.open === app.slug) closeDetail(box);
    else render(box);
  });
  row.appendChild(yes);
  row.appendChild(btn("Cancel", "secondary", () => {
    state.confirming = null;
    render(box);
  }));
  wrap.appendChild(row);
  return wrap;
}

// ---- the detail / edit view ------------------------------------------------
// A full-width view that REPLACES the grid rather than a modal over it. On a
// phone a dialog holding a file list and a code editor is a scroll trap with a
// close button somewhere off screen; a view with a back link at the top is the
// same interaction the rest of the site already uses.

/**
 * @param {HTMLElement} box
 */
function renderDetail(box) {
  const slug = String(state.open);
  box.appendChild(btn("← All apps", "secondary app-back", () => closeDetail(box)));

  if (state.detailError) {
    box.appendChild(el("p", "err", state.detailError));
    return;
  }
  if (!state.detail) {
    box.appendChild(el("p", "muted", "Loading…"));
    return;
  }

  const { app, files, can_manage: canManage } = state.detail;
  showCount(state.apps.length);

  const head = el("div", "app-detail-head");
  if (state.renaming === app.slug && canManage) {
    head.appendChild(el("h3", "app-detail-title", app.title || app.slug));
    head.appendChild(renameForm(box, app, () => {
      state.renaming = null;
      if (state.detail) state.detail.app = findApp(app.slug) || state.detail.app;
      render(box);
    }));
  } else {
    const h = el("h3", "app-detail-title", app.title || app.slug);
    head.appendChild(h);
    if (canManage) {
      head.appendChild(btn("Rename", "secondary", () => {
        state.renaming = app.slug;
        render(box);
        focusIn(box, ".app-rename-input");
      }));
    }
  }
  box.appendChild(head);

  const sub = el("p", "app-detail-sub muted");
  sub.appendChild(el("code", "app-slug", `#${app.slug}`));
  sub.append(" · ");
  const live = link(app.url || appUrl(slug), app.url || appUrl(slug), "app-live");
  live.target = "_blank";
  live.rel = "noopener";
  live.title = "Open the live app in a new tab";
  sub.appendChild(live);
  sub.append(` · ${formatBytes(app.bytes)} · ${formatWhen(app.createdAt)}`);
  box.appendChild(sub);

  if (!canManage) {
    box.appendChild(el("p", "muted", "This app belongs to another account — you can open it, but not change it."));
  }

  box.appendChild(fileList(box, files, canManage));
  box.appendChild(editor(box, canManage));

  if (canManage) {
    const row = el("div", "app-actions app-detail-actions");
    if (state.confirming === app.slug) {
      box.appendChild(confirmDelete(box, app));
    } else {
      row.appendChild(btn("Delete this app", "secondary app-danger", () => {
        state.confirming = app.slug;
        render(box);
      }));
      box.appendChild(row);
    }
  }
}

/**
 * @param {HTMLElement} box
 */
function closeDetail(box) {
  state.open = null;
  state.detail = null;
  state.detailError = null;
  state.file = null;
  state.confirming = null;
  state.renaming = null;
  state.contents = new Map();
  render(box);
}

/**
 * The app's files, as a row of selectable chips with their sizes. Remove is
 * offered per file EXCEPT on index.html: planFileRemove refuses it (an app
 * without its entry point 404s at its own URL), so the button is not shown
 * rather than shown and rejected.
 *
 * @param {HTMLElement} box
 * @param {Array<{path: string, size: number}>} files
 * @param {boolean} canManage
 * @returns {HTMLElement}
 */
function fileList(box, files, canManage) {
  const wrap = el("div", "app-files");
  wrap.appendChild(el("p", "app-files-lead muted", `${files.length} file${files.length === 1 ? "" : "s"} — pick one to read or edit.`));
  const list = el("div", "app-filelist");
  for (const f of files) {
    const row = el("div", state.file === f.path ? "app-file is-on" : "app-file");
    const pick = btn(f.path, "app-file-pick", () => loadFile(box, f.path));
    pick.setAttribute("aria-pressed", state.file === f.path ? "true" : "false");
    row.appendChild(pick);
    row.appendChild(el("span", "app-file-size muted", formatBytes(f.size)));
    if (canManage && f.path !== "index.html") {
      const rm = btn("Remove", "secondary app-file-rm", () => removeFile(box, f.path));
      rm.setAttribute("aria-label", `Remove ${f.path}`);
      row.appendChild(rm);
    }
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * The editor: a monospace textarea over the selected file, with Save and
 * Revert. Revert restores what was LOADED, not what is stored — the two are
 * the same until a save lands, and after one the loaded copy is the stored one.
 *
 * @param {HTMLElement} box
 * @param {boolean} canManage
 * @returns {HTMLElement}
 */
function editor(box, canManage) {
  const wrap = el("div", "app-editor");
  if (!state.file) {
    wrap.appendChild(el("p", "muted", "No file selected."));
    return wrap;
  }

  const ta = /** @type {HTMLTextAreaElement} */ (document.createElement("textarea"));
  ta.className = "app-code";
  ta.id = "app-code";
  ta.value = state.draft;
  ta.spellcheck = false;
  ta.setAttribute("aria-label", `Contents of ${state.file}`);
  if (!canManage) ta.readOnly = true;
  // Written back on every keystroke so a repaint (a rename saving, a file
  // removed) cannot swallow an edit in progress.
  ta.addEventListener("input", () => { state.draft = ta.value; paintDirty(box); });
  wrap.appendChild(ta);

  const status = el("p", "app-editor-status muted");
  wrap.appendChild(status);

  if (canManage) {
    const row = el("div", "app-actions");
    const save = btn("Save", "", () => saveFile(box));
    row.appendChild(save);
    row.appendChild(btn("Revert", "secondary", () => {
      state.draft = state.loaded;
      state.fileMsg = null;
      render(box);
      focusIn(box, "#app-code");
    }));
    wrap.appendChild(row);
  }

  const msg = el("p", state.fileMsgIsError ? "err app-editor-msg" : "app-editor-msg app-ok");
  msg.hidden = !state.fileMsg;
  if (state.fileMsg) msg.textContent = state.fileMsg;
  wrap.appendChild(msg);

  paintStatusInto(status);
  return wrap;
}

/**
 * The one line under the textarea: the size of what is in the box and whether
 * it differs from what was loaded. Repainted on input rather than re-rendering
 * the whole view, which would take the caret with it.
 * @param {HTMLElement} box
 */
function paintDirty(box) {
  const status = box.querySelector(".app-editor-status");
  if (status instanceof HTMLElement) paintStatusInto(status);
}

/** @param {HTMLElement} node */
function paintStatusInto(node) {
  const bytes = new TextEncoder().encode(state.draft).length;
  const dirty = state.draft !== state.loaded;
  node.textContent = `${state.file} · ${formatBytes(bytes)}${dirty ? " · unsaved changes" : ""}`;
}

/**
 * Save the open file.
 *
 * Validated with `checkFileEdit` FIRST, against the app's whole file list, so a
 * cap breach is a sentence under the button rather than a round trip that ends
 * in a 400. That check is the same ruleset the server plans with, decided from
 * the `[{path, size}]` the detail endpoint already returns — the page never has
 * to pull all 40 files just to weigh the collection.
 *
 * @param {HTMLElement} box
 */
async function saveFile(box) {
  if (state.busy || !state.open || !state.file || !state.detail) return;
  const plan = checkFileEdit(state.detail.files ?? [], state.file, state.draft);
  if ("error" in plan) {
    setFileMsg(plan.error, true);
    render(box);
    return;
  }
  state.busy = true;
  const res = await api(`${API}/${encodeURIComponent(state.open)}/file`, {
    method: "PUT",
    body: { path: state.file, content: state.draft },
  });
  state.busy = false;
  if (res.__error) {
    setFileMsg(String(res.__error), true);
    render(box);
    return;
  }
  state.loaded = state.draft;
  state.contents.set(state.file, state.draft);
  applyDetail(res.app);
  setFileMsg(`Saved ${state.file}. ${CACHE_NOTE}`, false);
  render(box);
}

/**
 * Remove one file from the app. Validated with `planFileRemove` first for the
 * same reason a save is — and because the one refusal it makes (index.html) is
 * a rule the reader should meet as an explanation, not as an error code.
 *
 * @param {HTMLElement} box
 * @param {string} path
 */
async function removeFile(box, path) {
  if (state.busy || !state.open || !state.detail) return;
  const plan = planFileRemove(state.detail?.files ?? [], path);
  if ("error" in plan) {
    setFileMsg(plan.error, true);
    render(box);
    return;
  }
  state.busy = true;
  const res = await api(`${API}/${encodeURIComponent(state.open)}/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  state.busy = false;
  if (res.__error) {
    setFileMsg(String(res.__error), true);
    render(box);
    return;
  }
  state.contents.delete(path);
  if (state.detail) state.detail.files = state.detail.files.filter((f) => f.path !== path);
  if (state.file === path) {
    state.file = null;
    state.loaded = "";
    state.draft = "";
  }
  applyDetail(res.app);
  setFileMsg(`Removed ${path}. ${CACHE_NOTE}`, false);
  render(box);
}


/**
 * @param {string} msg
 * @param {boolean} isError
 */
function setFileMsg(msg, isError) {
  state.fileMsg = msg;
  state.fileMsgIsError = isError;
}

/**
 * Fold a server-returned app row back into both the listing and the open
 * detail view, so a rename or a save is reflected without a refetch.
 * @param {any} app
 */
function applyDetail(app) {
  if (!app || typeof app !== "object") return;
  if (state.detail) state.detail.app = app;
  mergeApp(app, app.slug);
}

/**
 * @param {any} app the server's updated row (may be absent on an older Worker)
 * @param {string} slug
 * @param {Partial<AppRow>} [fallback] applied when the server sent no row
 */
function mergeApp(app, slug, fallback) {
  const i = state.apps.findIndex((a) => a.slug === slug);
  if (i < 0) return;
  if (app && typeof app === "object") state.apps[i] = { ...state.apps[i], ...app };
  else if (fallback) state.apps[i] = { ...state.apps[i], ...fallback };
}

/** @param {string} slug */
function findApp(slug) {
  return state.apps.find((a) => a.slug === slug) || null;
}

/**
 * Move focus to a freshly rendered control. A repaint destroys the node the
 * click came from, so anything that opens an input has to put the keyboard
 * back where the eye went.
 * @param {HTMLElement} box
 * @param {string} selector
 */
function focusIn(box, selector) {
  const node = box.querySelector(selector);
  if (node instanceof HTMLElement) node.focus();
}

/**
 * Write the app count into the page heading. Zero renders as empty, which the
 * stylesheet hides (`h2 .count:empty`) — a pill saying "0" beside a heading
 * that already says there is nothing is worse than no pill.
 * @param {number} n
 */
function showCount(n) {
  const badge = byId(COUNT_ID);
  if (badge) badge.textContent = n > 0 ? String(n) : "";
}

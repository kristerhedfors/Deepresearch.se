// @ts-check
// Capture reviews — the swipe deck that DRIVES THE /captures/ PAGE. One
// recorded clip at a time: the video, what produced it, and the facts of the
// edit. Swipe RIGHT to keep it, LEFT to say what is wrong with it.
//
// It used to be one panel section among a dozen on /admin (`#captures-sec`).
// It moved up a level to its own admin-gated page on 2026-08-10 (owner
// directive) because it is a REVIEW tool, not an ops panel: the owner watches
// a recorded research run and files it. The move is a MOVE — the gesture math,
// the fly-out, the feedback field, the filters and the fail-soft fetch posture
// are all unchanged. What went away is the panel plumbing: the section id, the
// `hidden` unhide, the count-badge callback, and the keyboard handler's
// "is this fold open?" guard (there is no fold on a dedicated page).
//
// Extended on 2026-08-11 (the same owner directive that replaced the chat
// interface's try-it launcher with a link here): a card now leads with its
// REFERENCE NUMBER and short name — "#CAP-12 · Swedish electricity prices" —
// because that number is how the owner asks for one ("produce a review of
// #12"); it carries the commit it was recorded at as provenance; a capture
// that has been re-recorded shows its version history rather than only its
// newest cut; the four lists are the owner's words (To review / Appreciated /
// Needs work / All), the needs-work list showing the feedback thread that the
// next version has to answer; and the queue's health ("14 of 20 unanswered")
// is stated once, calmly, under the filters. The gesture math, the fly-out,
// the feedback field and the fail-soft posture are untouched.
//
// The left swipe does NOT post. It reveals a feedback field in the card's
// place, because the server REQUIRES a note on a `feedback` verdict — a left
// swipe with no words is a shrug, not a review, and the reviewer would only
// learn that from a 400 they cannot act on. Revealing the field is the
// mechanism that makes the gesture complete, not decoration on top of it.
//
// All the gesture MATH is public/js/captures-core.js (pure, Node-tested);
// this file is DOM + fetch only. Everything here stays fail-soft: a non-admin
// who somehow lands here, a missing endpoint, or a failed POST all end in a
// calm inline message rather than a thrown error or a half-broken deck.

import {
  DECK_FILTERS,
  KEY_VERDICTS,
  NOTE_MAX,
  QUEUE_TARGET,
  activeVersion,
  captureFacts,
  captureHeadline,
  captureThread,
  captureVersions,
  cardStyle,
  flingVerdict,
  formatDay,
  hasVersionHistory,
  nextDeck,
  playbackSource,
  queueHealthLine,
  queueTarget,
  queueUnanswered,
  reviewSummary,
  shortSha,
  statusLabel,
  swipeHint,
  swipeVerdict,
  validateNote,
  versionLabel,
} from "./captures-core.js";

const API = "/api/admin/captures";
/** Where the deck renders, and where the queue count is written. */
const DECK_ID = "captures";
const COUNT_ID = "cap-count";

/**
 * @typedef {{ id: number|string, tag?: string, name?: string, label?: string,
 *   agent?: string, model?: string, starter?: string, mode?: string, lang?: string,
 *   prompt?: string, status?: string, commit_sha?: string|null, version?: number,
 *   answered?: boolean, answered_at?: number|null, versions?: any[],
 *   has_video?: boolean, has_poster?: boolean, video_url?: string, poster_url?: string,
 *   reviews?: any[] }} Capture
 */

/** Module state — one deck at a time; the panel is a singleton. */
const state = {
  /** @type {string} the active filter id ("" = all) */
  filter: "new",
  /** @type {Capture[]} the fetched rows for the active filter */
  rows: [],
  /** @type {Set<string>} ids filed in THIS session (the queue is not re-fetched per swipe) */
  reviewed: new Set(),
  /** @type {number} how many were in the queue when it was fetched — the "N of M" denominator */
  total: 0,
  /** @type {number} unreviewed captures at the last queue fetch. Held separately
   * from the rendered rows because the heading count must keep reporting the
   * REVIEW QUEUE while the owner browses the liked/needs-work filters —
   * zeroing it there would claim there is no work left when there is. */
  queueCount: 0,
  /** @type {boolean} true while a card is flying out / a POST is in flight */
  busy: false,
  /** @type {boolean} true while the feedback field is open (arrow keys must not file) */
  composing: false,
  /** @type {number|null} unanswered captures per the queue-status probe. null =
   * not known (an older Worker has no probe), which renders as no health line
   * rather than as a guessed one. */
  unanswered: null,
  /** @type {number} the queue's target size — the health line's denominator */
  target: QUEUE_TARGET,
  /** @type {Set<string>} ids whose full record (with `versions`) has been
   * merged in. Guards the lazy hydration against re-asking on every render. */
  hydrated: new Set(),
};

// ---- tiny DOM helpers ------------------------------------------------------
// Capture prompts, labels, notes and model ids are attacker-influenceable text
// in principle: they arrive over an API, and the prompt of a published clip is
// content this page did not author. So NOTHING here interpolates capture text
// into innerHTML — every string lands via textContent, which cannot inject
// markup at all. If a future edit does need a template, escape it with
// notifications.js's `escapeHtml`; do not reach for a raw template literal.

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
 * @param {string} id
 */
function byId(id) {
  return document.getElementById(id);
}

/**
 * Admin JSON fetch. Returns an `__error` envelope on ANY failure (403 for a
 * non-admin, a 503 with no D1, a missing endpoint) — the caller renders a calm
 * message rather than an alarming error, because someone arriving here without
 * the role is not an incident. The route in src/index.js already redirects a
 * non-admin away, so this is the second line: a session that expires with the
 * page open must degrade to a sentence, not to a broken deck.
 *
 * @param {string} path
 * @param {{ method?: string, body?: any }} [opts] body is a plain object, JSON-encoded here
 * @returns {Promise<any|null>}
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
    return data;
  } catch {
    return { __error: "Network error — the review was not saved." };
  }
}

// ---- entry point -----------------------------------------------------------

/**
 * Start the deck on the /captures/ page. Exported (rather than run straight
 * from module scope) so the module can be imported and reasoned about without
 * a DOM, and so the bootstrap below stays one readable line.
 *
 * Never throws: a rendering bug must leave the page's explanation standing
 * rather than replacing it with a broken deck.
 *
 * @returns {Promise<void>}
 */
export async function startCaptures() {
  const box = byId(DECK_ID);
  if (!box) return; // not this page — nothing to do
  try {
    await refresh(box);
  } catch {
    box.textContent = "The review deck could not be loaded.";
    box.className = "muted";
  }
}

// Self-start. `type="module"` scripts are deferred, so by the time this runs
// the document is normally parsed and #captures exists; the readyState check
// covers the one case that isn't (a dynamic import from a still-parsing
// document), because a start that silently found no container would look
// exactly like an empty queue.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { startCaptures(); });
} else {
  startCaptures();
}

/**
 * Fetch the active filter's rows and render.
 *
 * @param {HTMLElement} box
 */
async function refresh(box) {
  const qs = state.filter === "new" ? "queue=1&limit=50" : state.filter ? `status=${encodeURIComponent(state.filter)}&limit=50` : "limit=50";
  const data = await api(`${API}?${qs}`);
  if (!data || data.__error) {
    render(box, data?.__error ? String(data.__error) : null);
  } else {
    state.rows = Array.isArray(data.captures) ? data.captures : [];
    render(box, null);
  }
  // The queue's HEALTH is a separate probe, deliberately not awaited by the
  // render: it is one calm line, and the deck must not wait on (or break for) a
  // Worker that predates the endpoint. It repaints in place when it lands.
  refreshHealth(box);
}

/**
 * Fill in the "N of 20 unanswered" line. Fail-soft in the strongest sense —
 * every failure path leaves the line as it was, because the honest answer to
 * "how is the queue doing" when the probe 404s is silence, not "0 of 20".
 *
 * @param {HTMLElement} box
 */
async function refreshHealth(box) {
  const data = await api(`${API}/queue-status`);
  const n = queueUnanswered(data);
  if (n === null) return;
  state.unanswered = n;
  state.target = queueTarget(data);
  paintHealth(box);
}

/**
 * @param {HTMLElement} box
 */
function paintHealth(box) {
  const line = box.querySelector(".cap-health");
  if (!(line instanceof HTMLElement)) return;
  // Until the probe answers, the queue length we already fetched is a true (if
  // narrower) statement of the same thing, so the line is never empty for an
  // owner whose Worker is simply older than the endpoint.
  const n = state.unanswered !== null ? state.unanswered : state.queueCount || null;
  const text = queueHealthLine(n, state.target);
  line.textContent = text;
  line.hidden = !text;
}

// ---- rendering -------------------------------------------------------------

/**
 * @param {HTMLElement} box
 * @param {string|null} error a load error to show instead of the deck
 */
function render(box, error) {
  box.innerHTML = "";
  box.appendChild(filterRow(box));
  // The health line sits with the filters and reports the REVIEW QUEUE on
  // every list, because "how much is waiting" is the same question whichever
  // list is open. It is created empty and filled by paintHealth so a slow
  // probe cannot reorder the page under the reader.
  const health = el("p", "cap-health muted");
  health.hidden = true;
  box.appendChild(health);
  paintHealth(box);

  if (error) {
    box.appendChild(el("p", "muted", error));
    showCount(state.queueCount);
    return;
  }

  // The review QUEUE is a deck; every other filter is a read-only list, since
  // re-swiping something already filed would just churn the record.
  if (state.filter !== "new") {
    renderList(box);
    return;
  }

  const deck = nextDeck(state.rows, { reviewedIds: state.reviewed });
  state.total = state.rows.length;
  state.queueCount = deck.length;
  showCount(deck.length);
  // Now that the queue length is known it can stand in for the probe.
  paintHealth(box);

  if (!deck.length) {
    box.appendChild(emptyState());
    return;
  }

  const progress = el("p", "cap-progress muted");
  progress.textContent = `${state.total - deck.length + 1} of ${state.total}`;
  box.appendChild(progress);

  const stack = el("div", "cap-deck");
  // Only the top card is interactive; the two behind it exist to show the deck
  // has depth, which is what tells the reviewer there is more to do without
  // reading the counter.
  deck.slice(0, 3).forEach((c, i) => {
    const card = buildCard(c, i === 0);
    card.style.zIndex = String(10 - i);
    if (i > 0) card.classList.add("cap-card--behind");
    stack.appendChild(card);
  });
  box.appendChild(stack);
  box.appendChild(actionRow(box, deck[0]));
  box.appendChild(el("p", "cap-hintline muted", "Swipe right to keep it, left to send it back — or use ← / → and the buttons."));

  wireDrag(/** @type {HTMLElement} */ (stack.firstElementChild), deck[0], box);
  hydrateTop(box, deck[0]);
}

/**
 * Pull the TOP card's full record, which is the only place the version list
 * lives: `GET /api/admin/captures` leaves `versions` off (fifty captures ×
 * their whole history is a lot of rows for a deck that shows one card), while
 * `GET /api/admin/captures/:id` attaches it. So the deck asks for the one card
 * it is actually showing, and only once per capture.
 *
 * Silent on every failure — an older Worker answers without `versions`, and
 * the card it already rendered is correct without them. It re-renders ONLY
 * when there is a history to show, so a capture with a single version never
 * flickers.
 *
 * @param {HTMLElement} box
 * @param {Capture} capture
 */
async function hydrateTop(box, capture) {
  if (!capture || capture.id == null) return;
  const id = String(capture.id);
  // Marked before the fetch, not after: render() runs again when the answer
  // lands and would otherwise ask for the same card forever.
  if (state.hydrated.has(id)) return;
  state.hydrated.add(id);
  const data = await api(`${API}/${encodeURIComponent(id)}`);
  const full = data && !data.__error ? data.capture : null;
  if (!full || !hasVersionHistory(full)) return;
  const i = state.rows.findIndex((r) => r && String(r.id) === id);
  if (i < 0) return;
  state.rows[i] = { ...state.rows[i], ...full };
  // Still the top card? A verdict may have landed while the fetch was in
  // flight, and re-rendering then would throw away the card the reviewer is
  // now looking at.
  const top = nextDeck(state.rows, { reviewedIds: state.reviewed })[0];
  if (!top || String(top.id) !== id) return;
  render(box, null);
}

/**
 * The filter row — so a clip that was already filed can be found again.
 * @param {HTMLElement} box
 */
function filterRow(box) {
  const row = el("div", "cap-filters");
  for (const f of DECK_FILTERS) {
    const b = el("button", state.filter === f.id ? "cap-filter is-on" : "cap-filter secondary", f.label);
    b.addEventListener("click", async () => {
      state.filter = f.id;
      await refresh(box);
    });
    row.appendChild(b);
  }
  return row;
}

function emptyState() {
  const wrap = el("div", "cap-empty");
  wrap.appendChild(el("p", "", "No captures waiting."));
  const p = el("p", "muted");
  p.append("Record some with ");
  p.appendChild(el("code", "", "npm run capture"));
  p.append(", edit them with ");
  p.appendChild(el("code", "", "npm run capture:edit"));
  p.append(", then publish with ");
  p.appendChild(el("code", "", "scripts/captures --upload"));
  p.append(".");
  wrap.appendChild(p);
  return wrap;
}

/**
 * One capture card.
 *
 * @param {Capture} c
 * @param {boolean} top whether this is the interactive top card
 */
function buildCard(c, top) {
  const card = el("div", top ? "cap-card cap-card--top" : "cap-card");
  card.dataset.id = String(c.id);

  // The two drag overlays. They fade in with the gesture, which is what makes
  // the swipe discoverable — otherwise the first-time reviewer has to guess
  // which direction means what, and guessing wrong files a keeper.
  card.appendChild(el("div", "cap-hint like", "👍 Like"));
  card.appendChild(el("div", "cap-hint feedback", "✍️ Feedback"));

  // The player, plus — when this capture has been re-recorded — the version
  // strip that plays an older cut. The newest plays by default; the older ones
  // are kept deliberately (a feedback thread is answered by a NEW version, and
  // the previous one is the thing the new one has to beat), so they are shown
  // rather than filed away where only the API can reach them.
  const stage = el("div", "cap-stage");
  const player = el("div", "cap-player");
  stage.appendChild(player);
  const versions = captureVersions(c);
  playVersion(player, c, activeVersion(c));
  if (hasVersionHistory(c)) stage.appendChild(versionStrip(c, versions, player));
  card.appendChild(stage);

  const body = el("div", "cap-body");
  body.appendChild(headline(c));

  const chips = el("div", "cap-chips");
  for (const [k, v] of [["agent", c.agent], ["model", c.model], ["starter", c.starter], ["lang", c.lang]]) {
    if (typeof v === "string" && v.trim()) chips.appendChild(el("span", "badge", `${k}: ${v.trim()}`));
  }
  if (chips.childElementCount) body.appendChild(chips);

  if (typeof c.prompt === "string" && c.prompt.trim()) {
    body.appendChild(el("p", "cap-prompt", c.prompt.trim()));
  }

  const facts = factsRow(c);
  if (facts) body.appendChild(facts);

  const summary = reviewSummary(c);
  if (summary) body.appendChild(el("p", "cap-review", summary));

  card.appendChild(body);
  return card;
}

/**
 * The card's headline: THE NUMBER first, then the short name. The number is
 * how the owner refers to a capture out loud ("produce a review of #12"), so
 * it leads and it is selectable (the card sets `user-select: none` for the
 * drag; the stylesheet gives this line back).
 *
 * @param {Capture} c
 * @returns {HTMLElement}
 */
function headline(c) {
  return headlineInto(el("h3", "cap-title"), c);
}

/**
 * Fill a node with "#CAP-12 · the name". Shared by the card's <h3> and the
 * list row's <b> so the two can never disagree about how a capture is named.
 *
 * @param {HTMLElement} node
 * @param {Capture} c
 * @returns {HTMLElement} the same node
 */
function headlineInto(node, c) {
  const { tag, name, text } = captureHeadline(c);
  node.title = text;
  if (tag) {
    node.appendChild(el("span", "cap-tag", tag));
    if (name) node.appendChild(el("span", "cap-sep", " · "));
  }
  if (name) node.appendChild(el("span", "cap-name", name));
  return node;
}

/**
 * The facts row, plus the COMMIT the recording was made at. The commit is
 * provenance — it is what makes a clip reproducible — so it rides in the facts
 * row as a quiet monospace chip rather than as a headline fact.
 *
 * @param {Capture} c
 * @returns {HTMLElement|null} null when there is nothing to say
 */
function factsRow(c) {
  const facts = captureFacts(c);
  const sha = shortSha(c.commit_sha);
  if (!facts.length && !sha) return null;
  const row = el("p", "cap-facts muted");
  if (facts.length) row.append(facts.join(" · "));
  if (sha) {
    if (facts.length) row.append(" · ");
    const chip = el("code", "cap-sha", sha);
    chip.title = "the commit this recording was made at";
    row.appendChild(chip);
  }
  return row;
}

/**
 * Load one version into the player. Called once per card, and again for every
 * tap on the version strip — one path, so an older cut renders exactly like
 * the newest one.
 *
 * @param {HTMLElement} player the stable container the <video> lives in
 * @param {Capture} c
 * @param {any} version a normalised version, or null for a capture with none
 */
function playVersion(player, c, version) {
  player.innerHTML = "";
  const src = playbackSource(c, version);
  if (!src.has_video) {
    player.appendChild(el("p", "muted", "No video uploaded for this capture yet."));
    return;
  }
  const v = document.createElement("video");
  v.src = src.video_url;
  if (src.poster_url) v.poster = src.poster_url;
  v.controls = true;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  // metadata only: a deck of 50 clips must not pull 50 MP4s on page open.
  v.preload = "metadata";
  // A clip the browser cannot decode otherwise renders as a silent black box
  // with a dead scrubber, and the reviewer has no way to tell that from "the
  // recording is broken" — so say which it is. This is not hypothetical: the
  // clips are H.264 (the one codec LinkedIn and every phone want), and
  // Playwright's bundled Chromium ships WITHOUT proprietary codecs, so it
  // fails exactly here. A real browser plays them; a stripped build says so.
  v.addEventListener("error", () => {
    if (v.parentElement !== player) return;
    const note = el("p", "muted", "This browser could not play the clip (it is H.264/MP4). The file itself is fine — open it directly: ");
    const a = document.createElement("a");
    a.textContent = "download the MP4";
    a.href = src.video_url;
    note.appendChild(a);
    player.replaceChild(note, v);
  });
  player.appendChild(v);

  // Which cut is on screen, said in words — but ONLY for an older one. On the
  // default (newest) version the line would be noise on every card.
  if (version && version.is_current === false) {
    const line = el("p", "cap-playing muted", `playing v${version.version}`);
    const sha = shortSha(version.commit_sha);
    if (sha) {
      line.append(" · ");
      const chip = el("code", "cap-sha", sha);
      chip.title = "the commit this version was recorded at";
      line.appendChild(chip);
    }
    player.appendChild(line);
  }
}

/**
 * The version history strip. It exists because older versions are RETAINED on
 * purpose: feedback on a clip is answered by re-recording it, and the previous
 * cut is what the new one has to beat. Hiding them would make the retention
 * pointless from the only surface that reviews them.
 *
 * @param {Capture} c
 * @param {any[]} versions newest first (from captureVersions)
 * @param {HTMLElement} player
 * @returns {HTMLElement}
 */
function versionStrip(c, versions, player) {
  const wrap = el("div", "cap-versions");
  wrap.appendChild(el("span", "cap-versions-lead muted", `${versions.length} versions`));
  const active = activeVersion(c);
  /** @type {HTMLElement[]} */
  const buttons = [];
  for (const v of versions) {
    const b = el("button", "cap-version secondary", versionLabel(v));
    // The buttons are inside the draggable card; the drag handler already
    // ignores gestures that start on a <button>, so a tap here cannot file the
    // capture by accident.
    const bits = [versionLabel(v)];
    const day = formatDayTitle(v);
    if (day) bits.push(day);
    const sha = shortSha(v.commit_sha);
    if (sha) bits.push(`commit ${sha}`);
    b.title = bits.join(" · ");
    if (active && v.version === active.version) b.classList.add("is-on");
    b.addEventListener("click", () => {
      for (const other of buttons) other.classList.toggle("is-on", other === b);
      playVersion(player, c, v);
    });
    buttons.push(b);
    wrap.appendChild(b);
  }
  return wrap;
}

/**
 * @param {any} v
 * @returns {string} the version's recording day, or ""
 */
function formatDayTitle(v) {
  return v && typeof v === "object" ? formatDay(v.created_at ?? v.time) : "";
}

/**
 * The explicit buttons — a gesture must never be the ONLY way to act.
 * @param {HTMLElement} box
 * @param {Capture} capture
 */
function actionRow(box, capture) {
  const row = el("div", "cap-actions");
  const like = el("button", "cap-act-like", "👍 Like");
  like.addEventListener("click", () => file("like", capture, box));
  const fb = el("button", "cap-act-feedback secondary", "✍️ Feedback");
  fb.addEventListener("click", () => file("feedback", capture, box));
  row.appendChild(like);
  row.appendChild(fb);
  const err = el("p", "cap-err err");
  err.hidden = true;
  row.appendChild(err);
  return row;
}

/**
 * Read-only rendering for the appreciated / needs-work / all filters.
 * @param {HTMLElement} box
 */
function renderList(box) {
  if (!state.rows.length) {
    box.appendChild(el("p", "muted", "Nothing here."));
    showCount(state.queueCount);
    return;
  }
  const list = el("div", "cap-list");
  for (const c of state.rows) {
    const row = el("div", "rowitem cap-row");
    const head = el("div", "head");
    head.appendChild(headlineInto(el("b", ""), c));
    // The badge says the status in the list's own words ("appreciated", not
    // "liked") — two names for one state reads as two states.
    const label = statusLabel(c.status);
    if (label) head.appendChild(el("span", `badge ${c.status === "liked" ? "shipped" : ""}`.trim(), label));
    head.appendChild(el("span", "spacer"));
    row.appendChild(head);
    // agent · model — the list has no chips row, and a list of clips that all
    // read alike is unusable for finding one again.
    const who = [c.agent, c.model].filter((v) => typeof v === "string" && v.trim()).join(" · ");
    if (who) row.appendChild(el("p", "cap-sub muted", who));
    const versions = captureVersions(c);
    if (versions.length > 1) row.appendChild(el("p", "cap-sub muted", `${versions.length} versions — newest is v${versions[0].version}`));
    const facts = factsRow(c);
    if (facts) row.appendChild(facts);
    // On "Needs work" the point of the row IS the conversation: what was asked
    // for, in the order it was asked, so the next cut can answer it. Elsewhere
    // the one-line summary is enough.
    if (state.filter === "needs_work") {
      const thread = threadBlock(c);
      if (thread) row.appendChild(thread);
    } else {
      const summary = reviewSummary(c);
      if (summary) row.appendChild(el("p", "cap-review", summary));
    }
    if (c.video_url) {
      const a = el("a", "cap-link", "Open the clip");
      /** @type {HTMLAnchorElement} */ (a).href = String(c.video_url);
      /** @type {HTMLAnchorElement} */ (a).target = "_blank";
      /** @type {HTMLAnchorElement} */ (a).rel = "noopener";
      row.appendChild(a);
    }
    list.appendChild(row);
  }
  box.appendChild(list);
  // The count always reports the REVIEW QUEUE, never the filtered list — a
  // heading reading "12" while the owner browses likes would be reporting the
  // wrong number entirely.
  showCount(state.queueCount);
}

/**
 * The feedback THREAD on a needs-work capture: every review note, oldest
 * first. A "thread" here is exactly that — the record of what was asked for,
 * which is what the re-recording answers and what the next version is judged
 * against.
 *
 * @param {Capture} c
 * @returns {HTMLElement|null} null when the capture has no reviews
 */
function threadBlock(c) {
  const entries = captureThread(c);
  if (!entries.length) return null;
  const wrap = el("div", "cap-thread");
  for (const e of entries) {
    const p = el("p", `cap-msg ${e.verdict}`);
    const who = el("strong", "", e.day ? `${e.mark} ${e.day}` : e.mark);
    p.appendChild(who);
    // textContent, never innerHTML: a note is text somebody typed.
    p.append(" ", e.note || (e.verdict === "like" ? "liked" : "(no note)"));
    wrap.appendChild(p);
  }
  return wrap;
}

/**
 * Write the queue count into the page heading. This is what replaced the admin
 * panel's collapsed-header badge: on a dedicated page nothing is folded, so
 * the number lives in the heading instead of in a callback the host page owns.
 * Zero renders as empty, which the stylesheet hides (`h2 .count:empty`) — a
 * blank pill saying "0" is worse than no pill.
 *
 * @param {number} n
 */
function showCount(n) {
  const badge = byId(COUNT_ID);
  if (badge) badge.textContent = n > 0 ? String(n) : "";
}

/**
 * @param {HTMLElement} box
 * @param {string} msg
 */
function showError(box, msg) {
  const err = box.querySelector(".cap-err");
  if (!(err instanceof HTMLElement)) return;
  err.textContent = msg;
  err.hidden = false;
}

// ---- the drag gesture ------------------------------------------------------

/**
 * Wire pointer dragging on the top card. setPointerCapture keeps the events
 * coming even when the thumb leaves the card mid-swipe — without it a fast
 * swipe drops its own pointerup and the card sticks half off the deck.
 *
 * @param {HTMLElement|null} card
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
function wireDrag(card, capture, box) {
  if (!card) return;
  /** @type {{ id:number, x:number, y:number, t:number, moving:boolean }|null} */
  let drag = null;

  card.addEventListener("pointerdown", (e) => {
    if (state.busy || state.composing) return;
    // The <video> owns its own controls (play, scrub, fullscreen). Starting a
    // drag from them would make the clip unwatchable — every scrub attempt
    // would file the capture.
    if (e.target instanceof Element && e.target.closest("video, button, a")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moving: false };
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moving) {
      // A few px of slop before the card starts moving, so a tap that wobbles
      // does not visibly shove the deck.
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.moving = true;
      card.classList.add("cap-card--dragging");
    }
    const s = cardStyle(dx, dy, card.offsetWidth);
    card.style.transform = s.transform;
    card.style.opacity = String(s.opacity);
    const hint = swipeHint(dx, dy, card.offsetWidth);
    paintHint(card, hint);
  });

  /** @param {PointerEvent} e */
  const finish = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    card.releasePointerCapture?.(e.pointerId);
    card.classList.remove("cap-card--dragging");
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // Fling first (a phone user flicks), then the settled distance rule.
    const verdict = d.moving ? flingVerdict(dx, dy, card.offsetWidth, Date.now() - d.t) || swipeVerdict(dx, dy, card.offsetWidth) : null;
    paintHint(card, { side: null, progress: 0 });
    if (!verdict) {
      springBack(card);
      return;
    }
    file(verdict, capture, box, card);
  };
  card.addEventListener("pointerup", finish);
  // pointercancel fires when the browser takes the gesture over (a scroll
  // handoff, a system gesture). Treated as "no verdict" — an interrupted
  // gesture must never file a clip.
  card.addEventListener("pointercancel", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    card.classList.remove("cap-card--dragging");
    paintHint(card, { side: null, progress: 0 });
    springBack(card);
  });
}

/**
 * @param {HTMLElement} card
 * @param {{side: string|null, progress: number}} hint
 */
function paintHint(card, hint) {
  const like = card.querySelector(".cap-hint.like");
  const fb = card.querySelector(".cap-hint.feedback");
  if (like instanceof HTMLElement) like.style.opacity = hint.side === "like" ? String(hint.progress) : "0";
  if (fb instanceof HTMLElement) fb.style.opacity = hint.side === "feedback" ? String(hint.progress) : "0";
}

/**
 * Return an uncommitted card to rest.
 * @param {HTMLElement} card
 */
function springBack(card) {
  card.classList.add("cap-card--spring");
  card.style.transform = "";
  card.style.opacity = "";
  setTimeout(() => card.classList.remove("cap-card--spring"), 300);
}

// ---- filing a verdict ------------------------------------------------------

/**
 * Act on a verdict, from a swipe, a button or an arrow key — one path, so the
 * three input methods can never diverge.
 *
 * @param {"like"|"feedback"} verdict
 * @param {Capture} capture
 * @param {HTMLElement} box
 * @param {HTMLElement} [card]
 */
async function file(verdict, capture, box, card) {
  if (state.busy || state.composing || !capture) return;
  const top = card || /** @type {HTMLElement|null} */ (box.querySelector(".cap-card--top")) || undefined;

  if (verdict === "feedback") {
    // NOTHING is posted yet. The card flies out left and the feedback field
    // takes its place; the server requires a note, so the note is the gesture's
    // second half rather than an optional extra.
    state.composing = true;
    if (top) flyOut(top, "left");
    openFeedback(capture, box, top);
    return;
  }

  state.busy = true;
  if (top) flyOut(top, "right");
  const res = await api(`${API}/${encodeURIComponent(String(capture.id))}/review`, {
    method: "POST",
    body: { verdict: "like" },
  });
  state.busy = false;
  if (!res || res.__error) {
    // The verdict is NOT silently dropped: the card comes back and says why.
    if (top) {
      top.classList.remove("cap-card--out-right");
      springBack(top);
    }
    showError(box, res?.__error ? String(res.__error) : "The like was not saved.");
    return;
  }
  advance(capture, box);
}

/**
 * @param {HTMLElement} card
 * @param {"left"|"right"} dir
 */
function flyOut(card, dir) {
  card.classList.add(dir === "left" ? "cap-card--out-left" : "cap-card--out-right");
}

/**
 * The FEEDBACK FIELD — revealed in the card's place by a left swipe.
 * Carries the capture's title above it so the reviewer knows what they are
 * writing about (the card itself has just flown off screen).
 *
 * @param {Capture} capture
 * @param {HTMLElement} box
 * @param {HTMLElement} [card]
 */
function openFeedback(capture, box, card) {
  const deck = box.querySelector(".cap-deck");
  if (!(deck instanceof HTMLElement)) {
    state.composing = false;
    return;
  }
  const form = el("div", "cap-feedback");
  form.appendChild(el("p", "cap-feedback-lead muted", "What is wrong with this clip?"));
  // The NUMBER goes on the feedback form too: the card has just flown off
  // screen, and a note the owner will later discuss as "#12" should be written
  // with #12 in front of them.
  form.appendChild(el("h4", "cap-feedback-title", captureHeadline(capture).text));

  const ta = document.createElement("textarea");
  ta.className = "cap-feedback-note";
  ta.rows = 4;
  ta.maxLength = NOTE_MAX;
  ta.placeholder = "e.g. the cut swallows the first search round — re-run with --min-still 2500";
  form.appendChild(ta);

  const err = el("p", "cap-feedback-err err");
  err.hidden = true;
  form.appendChild(err);

  const row = el("div", "cap-feedback-actions");
  const send = el("button", "", "Send feedback");
  const cancel = el("button", "secondary", "Cancel");
  row.appendChild(send);
  row.appendChild(cancel);
  form.appendChild(row);
  deck.appendChild(form);
  ta.focus();

  const close = () => {
    state.composing = false;
    form.remove();
  };

  cancel.addEventListener("click", () => {
    close();
    // Cancel returns the card to the deck rather than filing it — a left
    // swipe the reviewer thought better of must cost nothing.
    if (card) {
      card.classList.remove("cap-card--out-left");
      springBack(card);
    }
  });

  send.addEventListener("click", async () => {
    const v = validateNote(ta.value);
    if (!v.ok) {
      err.textContent = String(v.error);
      err.hidden = false;
      ta.focus();
      return;
    }
    err.hidden = true;
    send.setAttribute("disabled", "disabled");
    const res = await api(`${API}/${encodeURIComponent(String(capture.id))}/review`, {
      method: "POST",
      body: { verdict: "feedback", note: v.note },
    });
    send.removeAttribute("disabled");
    if (!res || res.__error) {
      // The typed note stays in the box — losing someone's written feedback to
      // a transient network error is the one unforgivable failure here.
      err.textContent = String(res?.__error || "The feedback was not saved — try again.");
      err.hidden = false;
      return;
    }
    close();
    advance(capture, box);
  });
}

/**
 * Mark a capture filed and re-render the deck at the next card.
 *
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
function advance(capture, box) {
  state.reviewed.add(String(capture.id));
  render(box, null);
}

// ---- keyboard --------------------------------------------------------------
// Bound once at the document, active whenever the deck has a top card.
//
// The panel version also required its <section> to be OPEN, because the module
// was loaded on /admin whether or not the owner had that fold expanded — an
// arrow key pressed while editing a quota in another panel would otherwise
// have filed a capture behind their back. On a dedicated page there is no
// fold and nothing else on screen to be typing into, so that guard went with
// the panel. The two guards that carry real weight STAY:
//
//   1. no modifier keys — ⌘←/Alt← are browser navigation, never a verdict;
//   2. never steal an arrow key while focus is in a text field — the feedback
//      textarea is right there, and left/right move a text cursor.
//
// `state.composing` covers the same textarea a third way (nothing files while
// the feedback field is open at all), and the missing top card covers the
// read-only filters.

document.addEventListener("keydown", (e) => {
  const verdict = KEY_VERDICTS[e.key];
  if (!verdict) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.busy || state.composing) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const box = byId(DECK_ID);
  const card = box?.querySelector(".cap-card--top");
  if (!(box instanceof HTMLElement) || !(card instanceof HTMLElement)) return;
  const capture = nextDeck(state.rows, { reviewedIds: state.reviewed })[0];
  if (!capture) return;
  e.preventDefault();
  file(verdict, capture, box, card);
});

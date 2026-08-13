// @ts-check
// Capture reviews — the FEED that drives the /captures/ page. Every recorded
// clip in the open list is on the page, in order, scrolled north to south, and
// any one of them can be reviewed: swipe RIGHT to keep it, LEFT to say what is
// wrong with it, or take a verdict back with the card's undo.
//
// It used to be one panel section among a dozen on /admin (`#captures-sec`).
// It moved up a level to its own admin-gated page on 2026-08-10 (owner
// directive) because it is a REVIEW tool, not an ops panel: the owner watches
// a recorded research run and files it.
//
// Extended on 2026-08-11: a card leads with its REFERENCE NUMBER and short
// name — "#CAP-12 · Swedish electricity prices" — because that number is how
// the owner asks for one ("produce a review of #12"); it carries the commit it
// was recorded at as provenance; a capture that has been re-recorded shows its
// version history rather than only its newest cut; the four lists are the
// owner's words (To review / Appreciated / Needs work / All); and the queue's
// health ("14 of 20 unanswered") is stated once, calmly, under the filters.
//
// TURNED FROM A DECK INTO A FEED on 2026-08-13 (owner directive: "I can see
// only the next in queue — I want to scroll through all of them north to south
// and swipe or review any one of my choice", and "revert the one I just swiped
// right"). Three consequences, and they are the whole design of this file:
//
//   1. **Every row renders.** Not three stacked cards with one interactive
//      top; one card per capture, each with its own gesture, its own buttons
//      and its own error line. Reviewing is no longer an order imposed on the
//      owner — it is a page they scroll.
//   2. **Filing does not consume a card.** A verdict updates the card IN PLACE
//      from the row the server sends back, and the card keeps its position in
//      the scroll. Nothing under the thumb moves, which is what makes a feed
//      reviewable at all: a card that vanished would take the reader's place in
//      the list with it.
//   3. **A verdict is reversible.** A filed card carries "↩︎ Undo the 👍",
//      which DELETEs the last review server-side and puts the capture back on
//      the queue. Swiping right by accident used to be permanent, on a gesture
//      designed to be quick.
//
// The four lists are all feeds now, all reviewable. "Appreciated" and "Needs
// work" used to be read-only lists, which is precisely the thing the directive
// asks for: changing your mind about a clip you already filed is reviewing it.
//
// A card's videos are mounted LAZILY (IntersectionObserver, 600px ahead). A
// deck of one could afford to load its clip on render; fifty <video> elements
// each pulling metadata on page open cannot.
//
// The left swipe does NOT post. It opens a feedback field inside the card,
// because the server REQUIRES a note on a `feedback` verdict — a left swipe
// with no words is a shrug, not a review, and the reviewer would only learn
// that from a 400 they cannot act on.
//
// All the gesture MATH is public/js/captures-core.js (pure, Node-tested);
// this file is DOM + fetch only. Everything here stays fail-soft: a non-admin
// who somehow lands here, a missing endpoint, or a failed POST all end in a
// calm inline message rather than a thrown error or a half-broken page.

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
  cardState,
  cardStyle,
  feedRows,
  flingVerdict,
  formatDay,
  hasVersionHistory,
  pendingCount,
  playbackSource,
  queueHealthLine,
  queueTarget,
  queueUnanswered,
  reviewSummary,
  shortSha,
  statusLabel,
  swipeHint,
  swipeVerdict,
  undoLabel,
  validateNote,
  versionLabel,
} from "./captures-core.js";

const API = "/api/admin/captures";
/** Where the feed renders, and where the queue count is written. */
const DECK_ID = "captures";
const COUNT_ID = "cap-count";
/** How far ahead of the viewport a card's clip is mounted. */
const MOUNT_MARGIN = "600px 0px";

/**
 * @typedef {{ id: number|string, tag?: string, name?: string, label?: string,
 *   agent?: string, model?: string, starter?: string, mode?: string, lang?: string,
 *   prompt?: string, status?: string, commit_sha?: string|null, version?: number,
 *   answered?: boolean, answered_at?: number|null, versions?: any[],
 *   has_video?: boolean, has_poster?: boolean, video_url?: string, poster_url?: string,
 *   reviews?: any[] }} Capture
 */

/** Module state — one feed at a time; the page is a singleton. */
const state = {
  /** @type {string} the active filter id ("" = all) */
  filter: "new",
  /** @type {Capture[]} the fetched rows for the active filter, each updated in
   * place from the server's answer as verdicts land */
  rows: [],
  /** @type {Set<string>} ids with a request in flight — per card, not global:
   * on a feed the owner can file the next clip while the last POST is still
   * going, and a single `busy` flag would swallow that swipe. */
  busy: new Set(),
  /** @type {Set<string>} ids whose feedback field is open (arrow keys must not
   * file while one is being typed into) */
  composing: new Set(),
  /** @type {number} unreviewed captures in the queue at the last fetch. Held
   * separately from the rendered rows because the heading count must keep
   * reporting the REVIEW QUEUE while the owner browses the liked/needs-work
   * lists — zeroing it there would claim there is no work left when there is. */
  queueCount: 0,
  /** @type {number|null} unanswered captures per the queue-status probe. null =
   * not known (an older Worker has no probe), which renders as no health line
   * rather than as a guessed one. */
  unanswered: null,
  /** @type {number} the queue's target size — the health line's denominator */
  target: QUEUE_TARGET,
  /** @type {Set<string>} ids whose full record (with `versions`) has been
   * merged in. Guards the lazy hydration against re-asking on every render. */
  hydrated: new Set(),
  /** @type {IntersectionObserver|null} the lazy-mount observer for this render */
  observer: null,
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
 * page open must degrade to a sentence, not to a broken feed.
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
 * Start the feed on the /captures/ page. Exported (rather than run straight
 * from module scope) so the module can be imported and reasoned about without
 * a DOM, and so the bootstrap below stays one readable line.
 *
 * Never throws: a rendering bug must leave the page's explanation standing
 * rather than replacing it with a broken feed.
 *
 * @returns {Promise<void>}
 */
export async function startCaptures() {
  const box = byId(DECK_ID);
  if (!box) return; // not this page — nothing to do
  try {
    await refresh(box);
  } catch {
    box.textContent = "The review feed could not be loaded.";
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
  // render: it is one calm line, and the feed must not wait on (or break for) a
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
 * @param {string|null} error a load error to show instead of the feed
 */
function render(box, error) {
  // A fresh render invalidates every card the old observer was watching.
  state.observer?.disconnect();
  state.observer = null;
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

  const rows = feedRows(state.rows);
  // The heading always reports the QUEUE, so its number only moves when the
  // queue is what is on screen.
  if (state.filter === "new") state.queueCount = pendingCount(rows);
  showCount(state.queueCount);
  paintHealth(box);

  if (!rows.length) {
    box.appendChild(state.filter === "new" ? emptyState() : el("p", "muted", "Nothing here."));
    return;
  }

  // How long the scroll is, said once at the top. On a feed this is the thing
  // the old "3 of 20" progress line was really for — not where you are in a
  // queue somebody else ordered, but how much there is to scroll through.
  box.appendChild(el("p", "cap-progress muted", feedLead(rows)));
  box.appendChild(el("p", "cap-hintline muted", "Scroll through them all. Swipe right (or →, or 👍) to keep one, left (or ←, or ✍️) to send it back — and undo either."));

  const feed = el("div", "cap-feed");
  rows.forEach((c, i) => feed.appendChild(buildCard(c, i, rows.length, box)));
  box.appendChild(feed);
  observeCards(feed, box);
}

/**
 * @param {any[]} rows
 * @returns {string}
 */
function feedLead(rows) {
  const pending = pendingCount(rows);
  const n = rows.length;
  const clips = `${n} clip${n === 1 ? "" : "s"}`;
  if (state.filter !== "new") return pending ? `${clips} · ${pending} still to review` : clips;
  return `${clips} waiting`;
}

/**
 * The filter row — every list is a reviewable feed, so this is a view switch
 * rather than "the deck, and some archives".
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
 * One capture card. Every card in the feed is interactive — that is the point
 * of the feed — so there is no "top card" variant any more.
 *
 * The card is built in three parts on purpose: the STAGE (the player, mounted
 * lazily and never rebuilt), the BODY (what the clip is) and the FOOTER (what
 * can be done about it). A verdict rebuilds the last two and leaves the first
 * alone, so filing a clip does not restart the video the owner is watching.
 *
 * @param {Capture} c
 * @param {number} index position in the feed, for the card's own counter
 * @param {number} total
 * @param {HTMLElement} box
 */
function buildCard(c, index, total, box) {
  const card = el("div", "cap-card");
  card.dataset.id = String(c.id);
  // Where this card sits in the feed, kept on the element so a redraw after a
  // verdict does not have to re-derive it (or re-render the whole feed to find
  // out — which would scroll the reviewer's place away).
  card.dataset.index = String(index);
  card.dataset.total = String(total);
  // Focusable so the arrow keys have something to aim at: on a feed "the card"
  // is whichever one the reviewer is looking at, and focus is the only way to
  // say that out loud for a keyboard user.
  card.tabIndex = 0;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", captureHeadline(c).text);

  // The two drag overlays. They fade in with the gesture, which is what makes
  // the swipe discoverable — otherwise the first-time reviewer has to guess
  // which direction means what, and guessing wrong files a keeper.
  card.appendChild(el("div", "cap-hint like", "👍 Like"));
  card.appendChild(el("div", "cap-hint feedback", "✍️ Feedback"));

  // The stage is a placeholder until the card nears the viewport (observeCards
  // → mountStage). It carries its own min-height so mounting a clip does not
  // shove the rest of the feed down under the reader's thumb.
  const stage = el("div", "cap-stage");
  stage.appendChild(el("div", "cap-player cap-player--pending"));
  card.appendChild(stage);

  card.appendChild(cardBody(c, index, total));
  card.appendChild(cardFooter(c, card, box));
  paintFiled(card, c);

  wireDrag(card, c, box);
  return card;
}

/**
 * The descriptive half of a card: who made the clip, what it answered, and
 * every verdict it has already drawn.
 *
 * @param {Capture} c
 * @param {number} index
 * @param {number} total
 */
function cardBody(c, index, total) {
  const body = el("div", "cap-body");

  const head = el("div", "cap-head");
  head.appendChild(headline(c));
  // Where this card sits in the scroll. On a feed the reviewer can be anywhere,
  // so the position belongs on the card rather than above the whole page.
  head.appendChild(el("span", "cap-pos muted", `${index + 1}/${total}`));
  body.appendChild(head);

  const chips = el("div", "cap-chips");
  for (const [k, v] of [["agent", c.agent], ["model", c.model], ["starter", c.starter], ["lang", c.lang]]) {
    if (typeof v === "string" && v.trim()) chips.appendChild(el("span", "badge", `${k}: ${v.trim()}`));
  }
  const st = cardState(c);
  // What was already decided about this clip, in the list's own words. On the
  // queue it is normally absent; on a re-cut it is the reason there IS a new
  // cut, so it belongs beside the facts rather than buried in the thread.
  if (st.filed) chips.appendChild(el("span", `badge ${st.status === "liked" ? "shipped" : ""}`.trim(), statusLabel(st.status)));
  if (chips.childElementCount) body.appendChild(chips);

  if (typeof c.prompt === "string" && c.prompt.trim()) {
    body.appendChild(el("p", "cap-prompt", c.prompt.trim()));
  }

  const facts = factsRow(c);
  if (facts) body.appendChild(facts);

  // The whole thread, on every card that has one. In the deck this was a
  // needs-work-only detail; in a feed the reviewer arrives at a card cold and
  // the notes are what say why it looks the way it does.
  const thread = threadBlock(c);
  if (thread) body.appendChild(thread);
  else {
    const summary = reviewSummary(c);
    if (summary) body.appendChild(el("p", "cap-review", summary));
  }

  return body;
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
 * Fill a node with "#CAP-12 · the name". Shared by every surface that names a
 * capture so they cannot disagree about how one is called.
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

// ---- the lazy player -------------------------------------------------------

/**
 * Mount each card's clip as it nears the viewport. Fifty <video> elements with
 * `preload="metadata"` are fifty range requests on page open — on a phone that
 * is the difference between a feed that scrolls and one that stalls — so the
 * player is built at most once per card, 600px ahead of the fold.
 *
 * Falls back to mounting everything when IntersectionObserver is missing: a
 * heavy feed is a cost, a feed of empty frames is a broken page.
 *
 * @param {HTMLElement} feed
 * @param {HTMLElement} box
 */
function observeCards(feed, box) {
  const cards = /** @type {HTMLElement[]} */ ([...feed.querySelectorAll(".cap-card")]);
  if (typeof IntersectionObserver !== "function") {
    for (const card of cards) mountStage(card, box);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      mountStage(/** @type {HTMLElement} */ (e.target), box);
    }
  }, { rootMargin: MOUNT_MARGIN });
  state.observer = observer;
  for (const card of cards) observer.observe(card);
}

/**
 * Build one card's player (and its version strip), once.
 *
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
function mountStage(card, box) {
  const stage = card.querySelector(".cap-stage");
  const player = card.querySelector(".cap-player");
  if (!(stage instanceof HTMLElement) || !(player instanceof HTMLElement)) return;
  if (!player.classList.contains("cap-player--pending")) return; // already mounted
  player.classList.remove("cap-player--pending");
  const c = rowFor(card.dataset.id);
  if (!c) return;
  playVersion(player, c);
  if (hasVersionHistory(c)) stage.appendChild(versionStrip(c, captureVersions(c), player));
  // Only now is the version list worth asking for: a card nobody has scrolled
  // to does not need its history.
  hydrateCard(card, c, box);
}

/**
 * Load one version into the player. Called once per card, and again for every
 * tap on the version strip — one path, so an older cut renders exactly like
 * the newest one.
 *
 * @param {HTMLElement} player the stable container the <video> lives in
 * @param {Capture} c
 * @param {any} [version] a normalised version; omitted = the capture's current one
 */
function playVersion(player, c, version) {
  const chosen = version === undefined ? activeVersion(c) : version;
  player.innerHTML = "";
  const src = playbackSource(c, chosen);
  if (!src.has_video) {
    player.appendChild(el("p", "muted", "No video uploaded for this capture yet."));
    return;
  }
  const v = document.createElement("video");
  v.src = src.video_url;
  if (src.poster_url) v.poster = src.poster_url;
  v.controls = true;
  v.muted = true;
  // NOT looping, deliberately (2026-08-12, owner review of #CAP-20/21/22). The
  // last frame of a capture is the run's VERDICT — it shows the finished answer,
  // or the error the run died on. A looping <video> wraps to t=0 the instant it
  // ends, and t=0 is the page-load white flash before the site paints, so the
  // reviewer's eye lands on a blank frame and the evidence is never on screen.
  // Three reviews in a row reported that blank as if the encode were broken; it
  // was this flag. Ending on the final frame is what makes "look at the last
  // frame to see whether it went wrong" possible at all.
  v.loop = false;
  v.playsInline = true;
  // metadata only: even lazily mounted, a long feed must not pull whole MP4s
  // for clips the reviewer scrolled past.
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

  // Replay has to be one click, because not looping costs the one thing looping
  // was good for. The scrubber can do it, but a reviewer scrolling a feed
  // should not have to aim at a 4-pixel track to watch a 40-second clip twice.
  // The button only exists once the clip has ended, so it never covers a frame
  // anyone is still looking at.
  const replay = document.createElement("button");
  replay.className = "cap-replay";
  replay.textContent = "↺ Replay";
  replay.type = "button";
  replay.hidden = true;
  replay.addEventListener("click", () => {
    replay.hidden = true;
    v.currentTime = 0;
    v.play().catch(() => {});
  });
  v.addEventListener("ended", () => { replay.hidden = false; });
  v.addEventListener("play", () => {
    replay.hidden = true;
    // One clip at a time. On a feed the previous card's audio-less video would
    // otherwise keep running off-screen, burning bandwidth and making the
    // scrubbers disagree about which clip is "the" one being reviewed.
    pauseOthers(v);
  });
  player.appendChild(replay);

  // Which cut is on screen, said in words — but ONLY for an older one. On the
  // default (newest) version the line would be noise on every card.
  if (chosen && chosen.is_current === false) {
    const line = el("p", "cap-playing muted", `playing v${chosen.version}`);
    const sha = shortSha(chosen.commit_sha);
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
 * @param {HTMLVideoElement} keep
 */
function pauseOthers(keep) {
  const box = byId(DECK_ID);
  if (!box) return;
  for (const other of box.querySelectorAll("video")) {
    if (other !== keep && other instanceof HTMLVideoElement && !other.paused) other.pause();
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
 * Pull ONE card's full record, which is the only place the version list lives:
 * `GET /api/admin/captures` leaves `versions` off (fifty captures × their whole
 * history is a lot of rows for a list), while `GET /api/admin/captures/:id`
 * attaches it. So a card asks for itself when it is mounted, and only once.
 *
 * Silent on every failure — an older Worker answers without `versions`, and
 * the card it already rendered is correct without them. It only redraws when
 * there is a history to show, so a capture with a single version never
 * flickers.
 *
 * @param {HTMLElement} card
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
async function hydrateCard(card, capture, box) {
  if (!capture || capture.id == null) return;
  const id = String(capture.id);
  // Marked before the fetch, not after: a re-render would otherwise ask for
  // the same card forever.
  if (state.hydrated.has(id)) return;
  state.hydrated.add(id);
  const data = await api(`${API}/${encodeURIComponent(id)}`);
  const full = data && !data.__error ? data.capture : null;
  if (!full || !hasVersionHistory(full)) return;
  const merged = mergeRow(id, full);
  if (!merged || !card.isConnected) return;
  // Only the stage is rebuilt, and only because the version strip is new. The
  // rest of the card is already correct, and rebuilding it would throw away a
  // feedback field the reviewer may be typing into.
  const stage = card.querySelector(".cap-stage");
  if (!(stage instanceof HTMLElement)) return;
  stage.innerHTML = "";
  const player = el("div", "cap-player");
  stage.appendChild(player);
  playVersion(player, merged);
  stage.appendChild(versionStrip(merged, captureVersions(merged), player));
  refreshCard(card, merged, box);
}

// ---- a card's actions ------------------------------------------------------

/**
 * The footer: either the two verdict buttons, or — on a card that has already
 * been filed — what was decided and how to take it back.
 *
 * A gesture must never be the ONLY way to act, which is why the buttons exist
 * at all; on a feed they matter more than they did on a deck, because a mouse
 * user scrolling a long page is not going to drag fifty cards.
 *
 * @param {Capture} c
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
function cardFooter(c, card, box) {
  const row = el("div", "cap-actions");
  const st = cardState(c);

  if (st.filed) {
    row.appendChild(el("span", `cap-filed ${st.status}`, st.label));
  } else {
    const like = el("button", "cap-act-like", "👍 Like");
    like.addEventListener("click", () => file("like", c, card, box));
    const fb = el("button", "cap-act-feedback secondary", "✍️ Feedback");
    fb.addEventListener("click", () => file("feedback", c, card, box));
    row.appendChild(like);
    row.appendChild(fb);
  }

  // UNDO — the second half of the 2026-08-13 directive. Offered whenever the
  // capture has a verdict to take back, INCLUDING on a card that is back on
  // the queue: a re-cut keeps its thread, and "the 👍 I just gave" is still
  // the last thing in it.
  if (st.can_undo) {
    const undo = el("button", "cap-act-undo secondary", undoLabel(c));
    undo.title = "Delete the last verdict and put this capture back on the queue.";
    undo.addEventListener("click", () => undoVerdict(c, card, box));
    row.appendChild(undo);
  }

  const err = el("p", "cap-err err");
  err.hidden = true;
  row.appendChild(err);
  return row;
}

/**
 * Redraw a card's body and footer from the row the server sent back, leaving
 * the stage (and therefore the video) exactly as it is.
 *
 * @param {HTMLElement} card
 * @param {Capture} c
 * @param {HTMLElement} box
 */
function refreshCard(card, c, box) {
  const body = card.querySelector(".cap-body");
  const footer = card.querySelector(".cap-actions");
  const index = Number(card.dataset.index);
  const total = Number(card.dataset.total);
  if (body) body.replaceWith(cardBody(c, Number.isFinite(index) ? index : 0, Number.isFinite(total) && total > 0 ? total : 1));
  if (footer) footer.replaceWith(cardFooter(c, card, box));
  paintFiled(card, c);
  // The heading counts the queue, and a verdict (or an undo) just changed it.
  if (state.filter === "new") {
    state.queueCount = pendingCount(state.rows);
    showCount(state.queueCount);
    paintHealth(box);
  }
}

/**
 * The filed LOOK: a quieter card, so a scroll through the queue shows at a
 * glance what is left. Deliberately not `display: none` — the card stays, and
 * staying is what makes it undoable.
 *
 * @param {HTMLElement} card
 * @param {Capture} c
 */
function paintFiled(card, c) {
  const st = cardState(c);
  card.classList.toggle("cap-card--filed", st.filed);
  card.classList.toggle("cap-card--liked", st.status === "liked");
  card.classList.toggle("cap-card--needs-work", st.status === "needs_work");
}

/**
 * @param {unknown} id
 * @returns {Capture|null}
 */
function rowFor(id) {
  const key = id == null ? "" : String(id);
  return state.rows.find((r) => r && String(r.id) === key) || null;
}

/**
 * Merge the server's answer into the row we hold, so every later render reads
 * the same truth the server has.
 *
 * @param {string} id
 * @param {any} full
 * @returns {Capture|null}
 */
function mergeRow(id, full) {
  const i = state.rows.findIndex((r) => r && String(r.id) === id);
  if (i < 0) return null;
  state.rows[i] = { ...state.rows[i], ...full };
  return state.rows[i];
}

/**
 * The feedback THREAD on a card that has one: every review note, oldest first.
 * A "thread" here is exactly that — the record of what was asked for, which is
 * what a re-recording answers and what the next version is judged against.
 *
 * On the deck this was a needs-work-list detail. On a feed it belongs on every
 * card that has one: the reviewer arrives at a card cold, and the notes are
 * what say why the clip looks the way it does — and, on a card they have just
 * filed, they are the receipt for the swipe they can still undo.
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
 * @param {HTMLElement} card
 * @param {string} msg
 */
function showError(card, msg) {
  const err = card.querySelector(".cap-err");
  if (!(err instanceof HTMLElement)) return;
  err.textContent = msg;
  err.hidden = false;
}

/**
 * @param {HTMLElement} card
 */
function clearError(card) {
  const err = card.querySelector(".cap-err");
  if (err instanceof HTMLElement) err.hidden = true;
}

// ---- the drag gesture ------------------------------------------------------

/**
 * Wire pointer dragging on a card. setPointerCapture keeps the events coming
 * even when the thumb leaves the card mid-swipe — without it a fast swipe
 * drops its own pointerup and the card sticks half off the feed.
 *
 * @param {HTMLElement} card
 * @param {Capture} capture
 * @param {HTMLElement} box
 */
function wireDrag(card, capture, box) {
  /** @type {{ id:number, x:number, y:number, t:number, moving:boolean }|null} */
  let drag = null;

  card.addEventListener("pointerdown", (e) => {
    if (isBusy(capture) || isComposing(capture)) return;
    // The <video> owns its own controls (play, scrub, fullscreen). Starting a
    // drag from them would make the clip unwatchable — every scrub attempt
    // would file the capture.
    if (e.target instanceof Element && e.target.closest("video, button, a, textarea")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), moving: false };
    card.setPointerCapture?.(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moving) {
      // A few px of slop before the card starts moving, so a tap that wobbles
      // does not visibly shove the feed.
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
    // The card ALWAYS returns to its place, verdict or not. In the deck a
    // committed swipe flew the card off screen because the next one was
    // underneath it; in a feed the card is the reviewer's position in a scroll,
    // and throwing it away would throw that away with it.
    springBack(card);
    if (verdict) file(verdict, capture, card, box);
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
 * Return a card to rest.
 * @param {HTMLElement} card
 */
function springBack(card) {
  card.classList.add("cap-card--spring");
  card.style.transform = "";
  card.style.opacity = "";
  setTimeout(() => card.classList.remove("cap-card--spring"), 300);
}

// ---- filing a verdict ------------------------------------------------------

/** @param {Capture} c */
function isBusy(c) {
  return state.busy.has(String(c?.id));
}

/** @param {Capture} c */
function isComposing(c) {
  return state.composing.has(String(c?.id));
}

/**
 * Act on a verdict, from a swipe, a button or an arrow key — one path, so the
 * three input methods can never diverge.
 *
 * @param {"like"|"feedback"} verdict
 * @param {Capture} capture
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
async function file(verdict, capture, card, box) {
  if (!capture || isBusy(capture) || isComposing(capture)) return;
  const id = String(capture.id);
  clearError(card);

  if (verdict === "feedback") {
    // NOTHING is posted yet. The feedback field opens INSIDE the card — the
    // card stays where it is on the page, because on a feed it is also the
    // reviewer's place in the scroll — and the server requires a note, so the
    // note is the gesture's second half rather than an optional extra.
    openFeedback(capture, card, box);
    return;
  }

  state.busy.add(id);
  card.classList.add("cap-card--busy");
  const res = await api(`${API}/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: { verdict: "like" },
  });
  state.busy.delete(id);
  card.classList.remove("cap-card--busy");
  if (!res || res.__error) {
    // The verdict is NOT silently dropped: the card says why, in place.
    showError(card, res?.__error ? String(res.__error) : "The like was not saved.");
    return;
  }
  applyServerRow(id, res.capture, card, box);
}

/**
 * Take the last verdict back. The server deletes the review row, un-counts the
 * like and returns the capture to the queue; the card redraws from what comes
 * back rather than from a guess about what the undo did.
 *
 * @param {Capture} capture
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
async function undoVerdict(capture, card, box) {
  if (!capture || isBusy(capture)) return;
  const id = String(capture.id);
  clearError(card);
  state.busy.add(id);
  card.classList.add("cap-card--busy");
  const res = await api(`${API}/${encodeURIComponent(id)}/review`, { method: "DELETE" });
  state.busy.delete(id);
  card.classList.remove("cap-card--busy");
  if (!res || res.__error) {
    showError(card, res?.__error ? String(res.__error) : "The verdict was not taken back.");
    return;
  }
  applyServerRow(id, res.capture, card, box);
}

/**
 * @param {string} id
 * @param {any} row the capture as the server now has it
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
function applyServerRow(id, row, card, box) {
  const merged = row && typeof row === "object" ? mergeRow(id, row) : rowFor(id);
  if (!merged) return;
  refreshCard(card, merged, box);
}

/**
 * The FEEDBACK FIELD — opened inside the card by a left swipe or the ✍️
 * button. The card is right there above it, so unlike the deck's version this
 * one does not need to repeat which capture is being written about.
 *
 * @param {Capture} capture
 * @param {HTMLElement} card
 * @param {HTMLElement} box
 */
function openFeedback(capture, card, box) {
  const id = String(capture.id);
  if (card.querySelector(".cap-feedback")) return;
  state.composing.add(id);
  const form = el("div", "cap-feedback");
  form.appendChild(el("p", "cap-feedback-lead muted", "What is wrong with this clip?"));

  const ta = document.createElement("textarea");
  ta.className = "cap-feedback-note";
  ta.rows = 3;
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
  card.appendChild(form);
  ta.focus();

  const close = () => {
    state.composing.delete(id);
    form.remove();
  };

  cancel.addEventListener("click", () => {
    // Cancel costs nothing — a left swipe the reviewer thought better of leaves
    // the card exactly as it was.
    close();
    card.focus();
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
    const res = await api(`${API}/${encodeURIComponent(id)}/review`, {
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
    applyServerRow(id, res.capture, card, box);
  });
}

// ---- keyboard --------------------------------------------------------------
// Bound once at the document. On a deck "the card" was unambiguous; on a feed
// it is whichever card the reviewer is at, so the target is resolved the same
// way a person would: the focused card if there is one, otherwise the card
// filling the viewport.
//
// The two guards that carry real weight are unchanged from the panel version:
//
//   1. no modifier keys — ⌘←/Alt← are browser navigation, never a verdict;
//   2. never steal an arrow key while focus is in a text field — a feedback
//      textarea may be open, and left/right move a text cursor.
//
// `state.composing` covers that textarea a third way (nothing files on a card
// whose feedback field is open), and an already-filed card is skipped: an
// arrow key on a clip that is already liked would otherwise post the same
// verdict twice.

document.addEventListener("keydown", (e) => {
  const verdict = KEY_VERDICTS[e.key];
  if (!verdict) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const box = byId(DECK_ID);
  if (!(box instanceof HTMLElement)) return;
  const card = activeCard(box);
  if (!card) return;
  const capture = rowFor(card.dataset.id);
  if (!capture || isBusy(capture) || isComposing(capture)) return;
  if (cardState(capture).filed) return;
  e.preventDefault();
  file(verdict, capture, card, box);
});

/**
 * The card an arrow key acts on: the focused one, else the first unfiled card
 * that is actually on screen. "On screen" is deliberately generous at the top
 * (a card counts while its bottom is still 80px below the fold) so a key press
 * lands on the clip the reviewer has just scrolled to rather than on the one
 * whose last pixels are leaving.
 *
 * @param {HTMLElement} box
 * @returns {HTMLElement|null}
 */
function activeCard(box) {
  const focused = document.activeElement instanceof Element ? document.activeElement.closest(".cap-card") : null;
  if (focused instanceof HTMLElement) return focused;
  const height = window.innerHeight || 0;
  /** @type {HTMLElement|null} */
  let fallback = null;
  for (const node of box.querySelectorAll(".cap-card")) {
    if (!(node instanceof HTMLElement)) continue;
    const r = node.getBoundingClientRect();
    if (r.bottom < 80 || r.top > height) continue;
    if (!fallback) fallback = node;
    const c = rowFor(node.dataset.id);
    if (c && !cardState(c).filed) return node;
  }
  return fallback;
}

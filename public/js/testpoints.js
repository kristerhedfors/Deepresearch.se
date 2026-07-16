// Testable interaction points — the DRS client (banner + queue + executor).
//
// Two entry points, both fed by the admin surface /api/admin/testpoints
// (src/testpoints.js; the whole feature is admin-only, so this fails soft —
// the launcher and banner simply never appear for non-admins):
//
//   1. The QUEUE. A header launcher (#tryqueuebtn, shown only when there are
//      open points) opens a list of declared points. Tap one's label to go
//      try it — same-page targets open the banner in place, cross-page
//      targets navigate via the point's /try/<id> deep link.
//   2. The TRY-IT BANNER. On landing with ?try=<id> (a shared /try link, or
//      a same-page open), fetch the point, run its ACTIONS to set the scene,
//      and show a fixed bottom sheet: the "what was fixed" summary plus the
//      three verdicts — 👍 works / 👎 doesn't / ❓ can't test (never reached
//      a state where the fix could be tried, or unclear what to do) — and an
//      optional note. Submitting records the verdict and advances to the
//      next open point. An ❓ starts a CLARIFICATION THREAD: the note lands
//      as a tester message, the Claude Code loop answers on the point and
//      re-opens it, and the banner shows the whole dialogue on the next
//      visit — back and forth until a real 👍/👎 lands.
//
// The pure plumbing (deep-link parsing, action partitioning, next-in-queue)
// is public/js/testpoints-core.js. The app-specific side effects an action
// triggers come in as `hooks` from app.js, so this module never reaches into
// app.js internals; the generic ones (element highlight, settings-knob
// pulse) it does itself by stable element id.

import { parseTryId, partitionActions, nextOpenPoint, stripTryParam } from "./testpoints-core.js";

const API = "/api/admin/testpoints";

// knob key (settings.js name) → the checkbox element the Settings view
// renders (account-views.js / account-settings.js). Used to pulse the right
// row after an openSettings action.
const KNOB_SELECTORS = {
  server_history: "#cloudknob",
  shodan_mcp: "#shodanknob",
  google_maps: "#gmapsknob",
  feedback_mode: "#fbknob",
  bash_lite_mcp: "#sbknob",
  developer_mode: "#devknob",
};

/** @type {Record<string, Function>} */
let hooks = {};
/** @type {any} */
let els = null;

/**
 * @param {{ hooks?: Record<string, Function> }} [opts]
 */
export function initTestpoints(opts = {}) {
  hooks = opts.hooks || {};
  buildDom();
  const btn = document.getElementById("tryqueuebtn");
  if (btn) btn.addEventListener("click", openQueue);

  const id = parseTryId(location.search);
  if (id != null) {
    // Clean the address bar so a reload doesn't reopen the banner, then open.
    try {
      history.replaceState(null, "", stripTryParam(location.href));
    } catch {
      /* ignore */
    }
    openPoint(id);
  }
  // Always probe the queue so the launcher badge reflects reality (fail-soft:
  // a 401/403 for a non-admin just leaves the launcher hidden).
  refreshBadge();
}

// ---- DOM scaffold (built once, hidden until used) -------------------------

function buildDom() {
  if (els) return;
  const overlay = document.createElement("div");
  overlay.id = "tryqueue";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="tryqueue-card">
      <div class="tryqueue-head">
        <strong>Test queue</strong>
        <button type="button" class="tryqueue-close" aria-label="Close">‹</button>
      </div>
      <div class="tryqueue-list"><p class="muted">Loading…</p></div>
    </div>`;
  const banner = document.createElement("div");
  banner.id = "trybanner";
  banner.hidden = true;
  document.body.appendChild(overlay);
  document.body.appendChild(banner);
  els = {
    overlay,
    banner,
    list: overlay.querySelector(".tryqueue-list"),
  };
  overlay.querySelector(".tryqueue-close").addEventListener("click", () => {
    overlay.hidden = true;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
}

// ---- API (all fail-soft; non-admins get 403 and everything stays hidden) --

async function apiGet(path) {
  try {
    const res = await fetch(API + path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadQueue() {
  const data = await apiGet("?open=1");
  return data && Array.isArray(data.testpoints) ? data.testpoints : null;
}

// ---- launcher badge -------------------------------------------------------

async function refreshBadge() {
  const btn = document.getElementById("tryqueuebtn");
  const badge = document.getElementById("tryqueue-badge");
  if (!btn) return;
  const queue = await loadQueue();
  if (!queue) {
    btn.hidden = true; // not admin, or feature/db off
    return;
  }
  btn.hidden = false;
  const n = queue.length;
  if (badge) {
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? "99+" : String(n);
  }
}

// ---- the queue overlay ----------------------------------------------------

async function openQueue() {
  if (!els) return;
  els.overlay.hidden = false;
  els.list.innerHTML = '<p class="muted">Loading…</p>';
  const queue = await loadQueue();
  if (!queue) {
    els.list.innerHTML = '<p class="muted">Could not load the test queue.</p>';
    return;
  }
  if (!queue.length) {
    els.list.innerHTML = '<p class="muted">Nothing to test — the queue is empty. 🎉</p>';
    return;
  }
  // Oldest first: work the backlog in the order points were declared.
  const ordered = [...queue].sort((a, b) => a.id - b.id);
  els.list.innerHTML = "";
  for (const p of ordered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tryqueue-item";
    row.innerHTML =
      `<span class="tryqueue-item-label"></span>` +
      `<span class="tryqueue-item-target muted"></span>`;
    row.querySelector(".tryqueue-item-label").textContent = p.label;
    row.querySelector(".tryqueue-item-target").textContent = p.target;
    row.addEventListener("click", () => {
      els.overlay.hidden = true;
      goToPoint(p);
    });
    els.list.appendChild(row);
  }
}

// Same-page target → open the banner in place; cross-page target → navigate
// via the /try/<id> deep link so that page's client picks it up.
function goToPoint(point) {
  let path = point.target;
  try {
    path = new URL(point.target, location.origin).pathname;
  } catch {
    /* keep raw */
  }
  if (path === location.pathname) {
    openPoint(point.id, point);
  } else {
    location.assign(point.try_url || `/try/${point.id}`);
  }
}

// ---- opening a point: run actions, then show the banner -------------------

async function openPoint(id, prefetched) {
  const point =
    prefetched || (await apiGet("/" + id).then((d) => (d && d.testpoint ? d.testpoint : null)));
  if (!point) return; // not admin / gone — stay quiet
  await runActions(point.actions || []);
  showBanner(point);
}

async function runActions(actions) {
  const { known } = partitionActions(actions);
  for (const a of known) {
    try {
      await executeAction(a);
    } catch {
      // one bad action must never abort the rest — the point still opens
    }
  }
}

async function executeAction(a) {
  switch (a.type) {
    case "note":
      return; // guidance only; rendered in the banner
    case "openAccount":
      hooks.openAccountView?.(a.view || "summary");
      return;
    case "openSettings":
      hooks.openAccountView?.("settings");
      if (a.knob && KNOB_SELECTORS[a.knob]) {
        // The Settings view fetches before it paints — pulse the row once
        // it exists.
        await delay(250);
        pulse(document.querySelector(KNOB_SELECTORS[a.knob])?.closest(".settings-item"));
      }
      return;
    case "openProjects":
      hooks.openProjects?.();
      return;
    case "openHistory":
      hooks.openHistory?.();
      return;
    case "newChat":
      hooks.newChat?.();
      return;
    case "compose":
      hooks.compose?.(a.text || "", a.send === true);
      return;
    case "setSearch":
      hooks.setSearch?.(a.on === true);
      return;
    case "setBudget":
      hooks.setBudget?.(Number(a.seconds));
      return;
    case "selectModel":
      hooks.selectModel?.(a.model);
      return;
    case "highlight":
      pulse(document.querySelector(a.selector));
      return;
  }
}

// ---- the try-it banner ----------------------------------------------------

function showBanner(point) {
  if (!els) return;
  const { unknown } = partitionActions(point.actions || []);
  const b = els.banner;
  b.hidden = false;
  b.innerHTML = `
    <div class="trybanner-inner">
      <div class="trybanner-top">
        <span class="trybanner-tag">Try it</span>
        <span class="trybanner-label"></span>
        <button type="button" class="trybanner-x" aria-label="Close">✕</button>
      </div>
      <p class="trybanner-summary"></p>
      ${
        unknown.length
          ? `<p class="trybanner-warn">${unknown.length} setup step${unknown.length > 1 ? "s" : ""} this build can't run — set the scene by hand.</p>`
          : ""
      }
      ${point.ref ? `<p class="trybanner-ref muted"></p>` : ""}
      <div class="trybanner-thread" hidden></div>
      <div class="trybanner-verdict">
        <button type="button" class="trybanner-up" aria-label="It works">👍 Works</button>
        <button type="button" class="trybanner-down" aria-label="It doesn't work">👎 Doesn't</button>
        <button type="button" class="trybanner-na" aria-label="Can't test — needs clarification">❓ Can't test</button>
      </div>
      <textarea class="trybanner-note" rows="1" placeholder="Optional note (what you saw)…"></textarea>
      <div class="trybanner-actions">
        <button type="button" class="trybanner-skip">Skip</button>
        <button type="button" class="trybanner-submit" disabled>Submit</button>
      </div>
    </div>`;
  b.querySelector(".trybanner-label").textContent = point.label;
  b.querySelector(".trybanner-summary").textContent = point.summary;
  if (point.ref) b.querySelector(".trybanner-ref").textContent = "ref: " + point.ref;
  renderThread(b.querySelector(".trybanner-thread"), point.messages);

  const up = b.querySelector(".trybanner-up");
  const down = b.querySelector(".trybanner-down");
  const na = b.querySelector(".trybanner-na");
  const submit = b.querySelector(".trybanner-submit");
  const note = b.querySelector(".trybanner-note");
  let verdict = null;
  const choose = (v) => {
    verdict = v;
    up.classList.toggle("chosen", v === "pass");
    down.classList.toggle("chosen", v === "fail");
    na.classList.toggle("chosen", v === "untestable");
    // An ❓ opens a dialogue — nudge the note toward saying what blocked them.
    note.placeholder =
      v === "untestable"
        ? "What blocked you / what needs clarifying? The loop will answer here…"
        : "Optional note (what you saw)…";
    submit.disabled = false;
  };
  up.addEventListener("click", () => choose("pass"));
  down.addEventListener("click", () => choose("fail"));
  na.addEventListener("click", () => choose("untestable"));
  note.addEventListener("input", () => {
    note.style.height = "auto";
    note.style.height = note.scrollHeight + "px";
  });
  submit.addEventListener("click", async () => {
    if (!verdict) return;
    submit.disabled = true;
    submit.textContent = "Saving…";
    await submitVerdict(point, verdict, note.value);
  });
  b.querySelector(".trybanner-skip").addEventListener("click", () => advance(point.id));
  b.querySelector(".trybanner-x").addEventListener("click", () => closeBanner());
}

async function submitVerdict(point, result, noteText) {
  try {
    await fetch(`${API}/${point.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result, note: noteText || undefined }),
    });
  } catch {
    /* fail-soft — advancing still moves the tester along */
  }
  refreshBadge();
  advance(point.id);
}

// After a verdict/skip, pull the next open point and open it in place (if it
// lives on this page) or navigate to it; otherwise close and celebrate.
async function advance(justDoneId) {
  const queue = await loadQueue();
  const next = nextOpenPoint(queue || [], justDoneId);
  if (!next) {
    closeBanner();
    return;
  }
  let path = next.target;
  try {
    path = new URL(next.target, location.origin).pathname;
  } catch {
    /* keep raw */
  }
  if (path === location.pathname) {
    openPoint(next.id, next);
  } else {
    location.assign(next.try_url || `/try/${next.id}`);
  }
}

function closeBanner() {
  if (els) els.banner.hidden = true;
}

// The clarification thread — the ❓ dialogue between the tester's verdict
// notes and the loop's answers, rendered oldest-first above the verdict
// buttons so a re-opened point shows what was answered.
function renderThread(container, messages) {
  if (!container || !Array.isArray(messages) || !messages.length) return;
  container.hidden = false;
  for (const m of messages) {
    const row = document.createElement("p");
    row.className = "trybanner-msg " + (m.author === "agent" ? "agent" : "tester");
    const who = document.createElement("strong");
    who.textContent = m.author === "agent" ? "Loop: " : "You: ";
    row.appendChild(who);
    row.appendChild(document.createTextNode(m.body));
    container.appendChild(row);
  }
}

// ---- tiny DOM helpers -----------------------------------------------------

function pulse(el) {
  if (!el) return;
  el.classList.add("try-pulse");
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch {
    /* ignore */
  }
  setTimeout(() => el.classList.remove("try-pulse"), 2400);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

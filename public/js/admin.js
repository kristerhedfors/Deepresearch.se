// Admin UI: the notification center (pending approvals + operational
// alerts), usage totals (overall and by model), user management
// (role/status/quota/delete), and site configuration. All data comes from
// /api/admin/* (role-gated server-side); this page is just rendering and
// actions. Accounts are provisioned by Google sign-in — there is nothing
// to create here.

import { alertSeverityBadge, escapeHtml, pendingApprovalLine } from "./notifications.js";

const $ = (id) => document.getElementById(id);
const PERIODS = ["h5", "day", "week", "month"];
const PERIOD_LABEL = { h5: "Last 5 h", day: "Today", week: "This week", month: "This month" };

let overview = null;

async function api(path, opts = {}) {
  const res = await fetch("/api/admin" + path, {
    headers: opts.body ? { "content-type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const euro = (v) => "€" + (Number(v) || 0).toFixed(2);
const count = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(n);
};

async function load() {
  try {
    overview = await api("/overview");
  } catch (err) {
    if (String(err.message).includes("Database not configured")) {
      $("setup").hidden = false;
      return;
    }
    document.querySelector("main").insertAdjacentHTML(
      "afterbegin",
      `<section><p class="err">${escapeHtml(err.message)}</p></section>`,
    );
    return;
  }
  renderAlerts();
  renderTotals();
  renderByModel();
  renderUsers();
  renderConfig();
  loadSecurity();
  loadFeatures();
  loadPanels();
}

// ---- decision-board interaction (shared by every selection board) ---------
// Every selection board renders its items COLLAPSED to their header row:
// badges + title + votes only. Tapping a header opens that item's full
// detail (summary + the review controls); in the work-order (priority) view
// each header carries a drag GRIP, and dragging reorders the list — the new
// top-to-bottom order is written back as the items' priority (1..N), i.e. the
// fixed order the agent loop consumes. The mechanics below are generic
// (`.board` / `.board-item` / `.board-detail` / `.grip`), so any future board
// reuses them; the security board is the only client-rendered consumer today.

// Tap a header (anywhere but a control or the grip) to open/close its detail.
function wireBoardItemToggle(el) {
  el.addEventListener("click", (e) => {
    if (e.target.closest(".head") && !e.target.closest("button, .grip, .vote")) {
      el.classList.toggle("open");
    }
  });
}

// The sibling the dragged row should sit ABOVE for a given pointer Y — the
// nearest item whose vertical center is below the cursor (null → append last).
function boardDropTarget(container, y) {
  let closest = null;
  let closestOffset = -Infinity;
  for (const el of container.querySelectorAll(".board-item:not(.dragging)")) {
    const box = el.getBoundingClientRect();
    const offset = y - (box.top + box.height / 2);
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
    }
  }
  return closest;
}

// Pointer-based drag reorder (works on touch, unlike native HTML5 DnD). Drag
// starts only on a `.grip` (so the list still scrolls and headers still tap),
// reorders the DOM live, and on drop calls onReorder with the new id order.
function enableBoardReorder(container, onReorder) {
  let drag = null;
  container.addEventListener("pointerdown", (e) => {
    if (!container.classList.contains("reorderable")) return;
    const grip = e.target.closest(".grip");
    if (!grip) return;
    const item = grip.closest(".board-item");
    if (!item) return;
    drag = { item, pointerId: e.pointerId, startY: e.clientY, moving: false };
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  container.addEventListener("pointermove", (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.moving) {
      if (Math.abs(e.clientY - drag.startY) < 6) return;
      drag.moving = true;
      drag.item.classList.add("dragging");
      container.classList.add("reordering");
    }
    e.preventDefault();
    const after = boardDropTarget(container, e.clientY);
    if (after == null) container.appendChild(drag.item);
    else if (after !== drag.item) container.insertBefore(drag.item, after);
  });
  const finish = async (e) => {
    if (!drag || drag.pointerId !== e.pointerId) return;
    const d = drag;
    drag = null;
    container.releasePointerCapture?.(e.pointerId);
    d.item.classList.remove("dragging");
    container.classList.remove("reordering");
    if (!d.moving) return; // a still tap on the grip — not a reorder
    const ids = [...container.querySelectorAll(".board-item")].map((el) => el.dataset.id);
    await onReorder(ids);
  };
  container.addEventListener("pointerup", finish);
  container.addEventListener("pointercancel", finish);
}

// ---- security-risk review board -------------------------------------------
// The register's (SECURITY-RISKS.md §3) open-fix backlog with admin review
// state on top: up/down votes, a manual severity score (CVSS or free-form),
// a note, and the explicit PRIORITY — the fixed order the Claude Code
// security-fix loop works through (?format=text / scripts/security reads the
// same ordering). Two views: fix order (priority) and documented severity.

let secOrder = "priority";
let secItems = [];

async function loadSecurity() {
  let data;
  try {
    data = await api(`/security?order=${secOrder}`);
  } catch (err) {
    $("security").innerHTML = `<p class="err">${escapeHtml(err.message)}</p>`;
    $("security-sec").hidden = false;
    return;
  }
  secItems = data.items;
  const box = $("security");
  box.innerHTML = "";
  // Reorder is only meaningful in the work-order view (severity view is a
  // fixed documented ranking).
  box.className = "board" + (secOrder === "priority" ? " reorderable" : "");
  $("sec-order-priority").className = secOrder === "priority" ? "on" : "secondary";
  $("sec-order-severity").className = secOrder === "severity" ? "on" : "secondary";

  let fixPos = 0;
  for (const it of data.items) {
    const open = it.status === "open";
    const posLabel =
      secOrder === "priority" && open ? `<b class="muted">#${++fixPos}</b>` : "";
    const el = document.createElement("div");
    el.className = "rowitem board-item";
    el.dataset.id = it.id;
    el.innerHTML = `
      <div class="head">
        <span class="grip" title="Drag to reorder">⠿</span>
        ${posLabel}
        <span class="badge sev-${it.severity}">${it.severity}</span>
        ${open ? "" : `<span class="badge ${escapeHtml(it.status)}">${escapeHtml(it.status)}</span>`}
        ${it.priority != null ? `<span class="badge prio">priority ${it.priority}</span>` : ""}
        ${it.recurring ? '<span class="badge">recurring</span>' : ""}
        <b>${escapeHtml(it.id)} · ${escapeHtml(it.title)}</b>
        <span class="spacer"></span>
        <span class="vote">
          <button data-act="up" class="secondary" title="Upvote">▲</button>
          <b>${it.votes}</b>
          <button data-act="down" class="secondary" title="Downvote">▼</button>
        </span>
        <span class="caret" aria-hidden="true">▸</span>
      </div>
      <div class="board-detail">
        <p class="muted" style="margin:.35rem 0 0">${escapeHtml(it.summary)}</p>
        <div class="sec-review">
          <label>Priority
            <input type="number" min="1" max="999" step="1" data-f="priority"
              value="${it.priority ?? ""}" placeholder="—"></label>
          <label>Score
            <input type="text" data-f="score" value="${escapeHtml(it.score || "")}"
              placeholder="e.g. CVSS 6.5 / AV:N…" maxlength="120"></label>
          <label style="flex:1">Note
            <input type="text" data-f="note" value="${escapeHtml(it.note || "")}"
              placeholder="suggestion / rationale" maxlength="2000"></label>
          <button data-act="save" class="secondary">Save</button>
        </div>
      </div>`;
    wireBoardItemToggle(el);
    el.addEventListener("click", async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === "up" || act === "down") {
          await api(`/security/${it.id}/vote`, { method: "POST", body: { dir: act } });
          await loadSecurity();
        } else if (act === "save") {
          const body = {};
          for (const input of el.querySelectorAll("[data-f]")) {
            body[input.dataset.f] = input.value === "" ? null : input.value;
          }
          await api(`/security/${it.id}`, { method: "PATCH", body });
          await loadSecurity();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    box.appendChild(el);
  }
  $("security-sec").hidden = false;
}

// Drag-drop reorder → write the new visual order as priority 1..N (the loop's
// fixed work order); only PATCH items whose priority actually changed.
enableBoardReorder($("security"), async (ids) => {
  const byId = new Map(secItems.map((it) => [it.id, it]));
  try {
    for (let i = 0; i < ids.length; i++) {
      const it = byId.get(ids[i]);
      if (it && it.priority !== i + 1) {
        await api(`/security/${ids[i]}`, { method: "PATCH", body: { priority: i + 1 } });
      }
    }
  } catch (err) {
    alert(err.message);
  }
  await loadSecurity();
});

for (const mode of ["priority", "severity"]) {
  $(`sec-order-${mode}`).addEventListener("click", () => {
    secOrder = mode;
    loadSecurity();
  });
}

// ---- features/priority board ----------------------------------------------
// The SECOND loop channel (see the feature-board skill): FEATURES.md §3's
// backlog with the same board choice UX as security — votes, an EFFORT
// estimate (the shared "score" field, relabelled), a note, and the explicit
// PRIORITY (drag the headers) that is the build loop's fixed order. Same
// collapse-to-header + drag mechanics; impact instead of severity, build order
// instead of fix order. ?format=text / scripts/features reads the same order.

let featOrder = "priority";
let featItems = [];

async function loadFeatures() {
  let data;
  try {
    data = await api(`/features?order=${featOrder}`);
  } catch (err) {
    $("features").innerHTML = `<p class="err">${escapeHtml(err.message)}</p>`;
    $("features-sec").hidden = false;
    return;
  }
  featItems = data.items;
  const box = $("features");
  box.innerHTML = "";
  box.className = "board" + (featOrder === "priority" ? " reorderable" : "");
  $("feat-order-priority").className = featOrder === "priority" ? "on" : "secondary";
  $("feat-order-impact").className = featOrder === "impact" ? "on" : "secondary";

  let buildPos = 0;
  for (const it of data.items) {
    const open = it.status === "open";
    const posLabel =
      featOrder === "priority" && open ? `<b class="muted">#${++buildPos}</b>` : "";
    const el = document.createElement("div");
    el.className = "rowitem board-item";
    el.dataset.id = it.id;
    el.innerHTML = `
      <div class="head">
        <span class="grip" title="Drag to reorder">⠿</span>
        ${posLabel}
        <span class="badge imp-${it.impact}">${it.impact} impact</span>
        ${open ? "" : `<span class="badge ${escapeHtml(it.status)}">${escapeHtml(it.status)}</span>`}
        ${it.priority != null ? `<span class="badge prio">priority ${it.priority}</span>` : ""}
        <b>${escapeHtml(it.id)} · ${escapeHtml(it.title)}</b>
        <span class="spacer"></span>
        <span class="vote">
          <button data-act="up" class="secondary" title="Upvote">▲</button>
          <b>${it.votes}</b>
          <button data-act="down" class="secondary" title="Downvote">▼</button>
        </span>
        <span class="caret" aria-hidden="true">▸</span>
      </div>
      <div class="board-detail">
        <p class="muted" style="margin:.35rem 0 0">${escapeHtml(it.summary)}</p>
        <div class="sec-review">
          <label>Priority
            <input type="number" min="1" max="999" step="1" data-f="priority"
              value="${it.priority ?? ""}" placeholder="—"></label>
          <label>Effort
            <input type="text" data-f="score" value="${escapeHtml(it.score || "")}"
              placeholder="e.g. S / ~2 days" maxlength="120"></label>
          <label style="flex:1">Note
            <input type="text" data-f="note" value="${escapeHtml(it.note || "")}"
              placeholder="direction / suggestion" maxlength="2000"></label>
          <button data-act="save" class="secondary">Save</button>
        </div>
      </div>`;
    wireBoardItemToggle(el);
    el.addEventListener("click", async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === "up" || act === "down") {
          await api(`/features/${it.id}/vote`, { method: "POST", body: { dir: act } });
          await loadFeatures();
        } else if (act === "save") {
          const body = {};
          for (const input of el.querySelectorAll("[data-f]")) {
            body[input.dataset.f] = input.value === "" ? null : input.value;
          }
          await api(`/features/${it.id}`, { method: "PATCH", body });
          await loadFeatures();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    box.appendChild(el);
  }
  $("features-sec").hidden = false;
}

// Drag-drop reorder → write the new visual order as priority 1..N (the build
// loop's fixed order); only PATCH items whose priority actually changed.
enableBoardReorder($("features"), async (ids) => {
  const byId = new Map(featItems.map((it) => [it.id, it]));
  try {
    for (let i = 0; i < ids.length; i++) {
      const it = byId.get(ids[i]);
      if (it && it.priority !== i + 1) {
        await api(`/features/${ids[i]}`, { method: "PATCH", body: { priority: i + 1 } });
      }
    }
  } catch (err) {
    alert(err.message);
  }
  await loadFeatures();
});

for (const mode of ["priority", "impact"]) {
  $(`feat-order-${mode}`).addEventListener("click", () => {
    featOrder = mode;
    loadFeatures();
  });
}

// ---- panel selection board (the ATTENTION loop) ---------------------------
// A board whose ITEMS are the admin panels themselves — and it has NO board
// widget of its own. Each panel header carries ▲/▼ thumbs (injected below),
// and voting reshapes THIS view in place: panels sort by net votes (whatever
// the owner is working on floats to the top), and a net-negative panel
// collapses its body and sinks. That live order is the admin's FOCUS ORDER a
// Claude Code loop reads (/api/admin/panels?format=text) to know which surface
// the owner is actively working — a loop driven PURELY by up/down votes, no
// drag, no explicit priority. See the feature-board skill (the attention
// board) and src/panels.js. Fail-soft: the reshaping is an enhancement, so any
// error just leaves the authored order untouched.

const PANEL_MAIN = document.querySelector("main");

async function loadPanels() {
  let data;
  try {
    data = await api("/panels?order=focus");
  } catch {
    return; // DB off or endpoint missing — leave the page as authored
  }
  for (const it of data.items) {
    const sec = PANEL_MAIN.querySelector(`section[data-panel="${it.id}"]`);
    if (!sec) continue;
    // Inject / refresh the header vote widget (once per panel).
    const h2 = sec.querySelector("h2");
    if (h2) {
      let w = h2.querySelector(".pvote");
      if (!w) {
        h2.insertAdjacentHTML(
          "beforeend",
          `<span class="pvote" data-panel-vote="${it.id}">
             <button data-pact="up" class="secondary" title="Pull this panel up">▲</button>
             <b>0</b>
             <button data-pact="down" class="secondary" title="Push this panel down">▼</button>
           </span>`,
        );
        w = h2.querySelector(".pvote");
      }
      w.querySelector("b").textContent = it.votes;
    }
    // Net-negative panels are "muted": collapsed (body hidden) and dimmed, but
    // the header + votes stay so the owner can pull it back up.
    sec.classList.toggle("panel-muted", it.votes < 0);
    // Re-sequence: append in the server's focus order (moving an element that
    // is already a child just relocates it), so the DOM matches the votes.
    PANEL_MAIN.appendChild(sec);
  }
}

// Delegated vote handler — the thumbs live inside the panel headers, so one
// listener on <main> covers them all (and survives header re-renders).
PANEL_MAIN.addEventListener("click", async (e) => {
  const btn = e.target.closest?.("[data-pact]");
  if (!btn) return;
  const id = btn.closest("[data-panel-vote]")?.dataset.panelVote;
  if (!id) return;
  try {
    await api(`/panels/${id}/vote`, { method: "POST", body: { dir: btn.dataset.pact } });
    await loadPanels();
  } catch (err) {
    alert(err.message);
  }
});

// ---- notification center ---------------------------------------------------
// Unifies everything needing admin attention — pending sign-in approvals
// (already in overview.users) and operational alerts (overview.alerts) —
// each rendered with a plain-language issue description and a suggested
// remediation, so this is a place to ACT from, not just a log to skim.

function renderAlerts() {
  const box = $("alerts");
  const pending = (overview.users || []).filter((u) => u.status === "pending");
  const openAlerts = (overview.alerts || []).filter((a) => !a.acknowledged_at);

  box.innerHTML = "";
  if (!pending.length && !openAlerts.length) {
    box.innerHTML = '<p class="muted">No active notifications.</p>';
    $("alerts-sec").hidden = false;
    return;
  }

  for (const u of pending) {
    const el = document.createElement("div");
    el.className = "rowitem notif-row";
    el.innerHTML = `
      <div class="head">
        <span class="badge pending">pending approval</span>
        <b>${pendingApprovalLine(u)}</b>
        <span class="spacer"></span>
        <button data-act="approve">Approve</button>
      </div>
      <p class="muted" style="margin:.35rem 0 0">
        ${escapeHtml(u.email)} — signed in with Google and is waiting for
        access. <b>Remediation:</b> click Approve to let them in with the
        default quota, or leave pending and delete the account below if
        this sign-in wasn't expected.
      </p>`;
    el.querySelector('[data-act="approve"]').addEventListener("click", async () => {
      try {
        await api(`/users/${u.id}`, { method: "PATCH", body: { status: "active" } });
        await load();
      } catch (err) {
        alert(err.message);
      }
    });
    box.appendChild(el);
  }

  for (const a of openAlerts) {
    const el = document.createElement("div");
    el.className = "rowitem notif-row";
    el.innerHTML = `
      <div class="head">
        ${alertSeverityBadge(a)}
        <b>${escapeHtml(a.message)}</b>
        <span class="spacer"></span>
        <button data-act="ack">Dismiss</button>
      </div>
      <p class="muted" style="margin:.35rem 0 0">
        <b>Remediation:</b> ${escapeHtml(a.remediation || "")}
      </p>
      <p class="muted" style="margin:.35rem 0 0">
        Seen ${a.count}× · first ${new Date(a.first_seen_at).toLocaleString()} ·
        last ${new Date(a.last_seen_at).toLocaleString()}
        ${a.detail ? `<br>${escapeHtml(a.detail)}` : ""}
      </p>`;
    el.querySelector('[data-act="ack"]').addEventListener("click", async () => {
      try {
        await api(`/alerts/${a.id}/ack`, { method: "POST" });
        await load();
      } catch (err) {
        alert(err.message);
      }
    });
    box.appendChild(el);
  }
  $("alerts-sec").hidden = false;
}

// ---- usage by model ------------------------------------------------------

function renderByModel() {
  const rows = overview.by_model || [];
  const table = $("models-table");
  if (!rows.length) {
    table.innerHTML = '<tr><td class="muted">No model usage recorded yet.</td></tr>';
  } else {
    table.innerHTML =
      `<tr><th>Model</th>${PERIODS.map((p) => `<th>${PERIOD_LABEL[p]}</th>`).join("")}<th>Month in/out</th><th>Requests</th></tr>` +
      rows
        .map(
          (m) => `<tr>
        <td class="model-name">${escapeHtml(String(m.model).split("/").pop())}</td>
        ${PERIODS.map((p) => `<td>${count(m[`${p}_tokens`] || 0)} tok<br><b>${euro(m[`${p}_cost`] || 0)}</b></td>`).join("")}
        <td>${count(m.month_prompt || 0)} / ${count(m.month_completion || 0)}</td>
        <td>${m.month_requests || 0}</td>
      </tr>`,
        )
        .join("");
  }
  $("models-sec").hidden = false;
}

// ---- overview cards ---------------------------------------------------

function renderTotals() {
  const t = overview.totals;
  const pending = overview.users.filter((u) => u.status === "pending").length;
  // Aggregate cost + billable counts (tokens for Berget, searches for Exa).
  const win = (p) =>
    `${euro((t[`${p}_berget_cost`] || 0) + (t[`${p}_exa_cost`] || 0))}` +
    `<div class="sub">${count(t[`${p}_tokens`])} tok ${euro(t[`${p}_berget_cost`])} · ` +
    `${count(t[`${p}_searches`])} srch ${euro(t[`${p}_exa_cost`])}</div>`;
  const cards = [
    ["Last 5 h", win("h5")],
    ["Today", win("day")],
    ["This week", win("week")],
    ["This month", win("month")],
    ["Requests this month", String(t.month_requests || 0)],
    ["Users", String(overview.users.length)],
    ["Awaiting approval", String(pending)],
  ];
  $("totals").innerHTML = cards
    .map(([lbl, big]) => `<div class="card"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
  $("totals-sec").hidden = false;
}

// ---- users ---------------------------------------------------------------

function quotaBar(label, used, limit, fmt) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return `<div class="qbar">${label}: ${fmt(used)}${limit > 0 ? " / " + fmt(limit) : ""}
    <div class="track"><div class="fill${pct >= 90 ? " hot" : ""}" style="width:${pct}%"></div></div></div>`;
}

function renderUsers() {
  const box = $("users");
  box.innerHTML = overview.users.length
    ? ""
    : '<p class="muted">No users yet — accounts appear on first Google sign-in.</p>';
  const defaults = overview.config.quotas;

  // Usage recorded under the shared break-glass identity (ADMIN_USER
  // secrets over Basic Auth, or a legacy pre-Google session cookie) —
  // shown here so no spend is ever invisible. Reference bars use the
  // global defaults; nothing is enforced on this identity.
  if (overview.admin_usage) {
    const a = overview.admin_usage;
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = `
      <div class="head">
        <b>Break-glass admin</b>
        <span class="muted">ADMIN_USER secrets · legacy sessions · never blocked</span>
        <span class="badge admin">admin</span>
      </div>
      <div class="quota-bars">
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} budget`, a[`${p}_berget_cost`] || 0, defaults[p].budget_eur, euro)).join("")}
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} searches`, a[`${p}_searches`] || 0, defaults[p].searches, count)).join("")}
      </div>
      <p class="muted" style="margin:.45rem 0 0">
        Tokens: ${PERIODS.map((p) => `${PERIOD_LABEL[p].toLowerCase()} ${count(a[`${p}_tokens`] || 0)}`).join(" · ")}<br>
        Total cost incl. Exa: ${PERIODS.map((p) => `${PERIOD_LABEL[p].toLowerCase()} ${euro((a[`${p}_berget_cost`] || 0) + (a[`${p}_exa_cost`] || 0))}`).join(" · ")}
      </p>`;
    box.appendChild(el);
  }
  for (const u of overview.users) {
    const usage = u.usage || {};
    let override = null;
    try { override = u.quota_json ? JSON.parse(u.quota_json) : null; } catch { override = null; }
    const q = {};
    for (const p of PERIODS) {
      q[p] = {
        budget_eur: override?.[p]?.budget_eur ?? defaults[p].budget_eur,
        searches: override?.[p]?.searches ?? defaults[p].searches,
      };
    }
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = `
      <div class="head">
        <b>${escapeHtml(u.name || u.email)}</b>
        <span class="muted">${escapeHtml(u.email)}</span>
        <span class="badge ${u.role}">${u.role}</span>
        ${u.status === "disabled" ? '<span class="badge disabled">disabled</span>' : ""}
        ${u.status === "pending" ? '<span class="badge pending">awaiting approval</span>' : ""}
        ${override ? '<span class="badge">custom quota</span>' : ""}
        <span class="spacer"></span>
        ${u.status === "pending" ? '<button data-act="approve">Approve</button>' : ""}
        <button data-act="edit" class="secondary">Quota…</button>
        ${u.status === "pending" ? "" : `<button data-act="toggle-status" class="secondary">${u.status === "disabled" ? "Enable" : "Disable"}</button>`}
        <button data-act="delete" class="danger">Delete</button>
      </div>
      <div class="quota-bars">
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} budget`, usage[`${p}_berget_cost`] || 0, q[p].budget_eur, euro)).join("")}
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} searches`, usage[`${p}_searches`] || 0, q[p].searches, count)).join("")}
      </div>
      <p class="muted" style="margin:.45rem 0 0">
        Tokens: ${PERIODS.map((p) => `${PERIOD_LABEL[p].toLowerCase()} ${count(usage[`${p}_tokens`] || 0)}`).join(" · ")}<br>
        Total cost incl. Exa: ${PERIODS.map((p) => `${PERIOD_LABEL[p].toLowerCase()} ${euro((usage[`${p}_berget_cost`] || 0) + (usage[`${p}_exa_cost`] || 0))}`).join(" · ")}
      </p>
      <div class="quota-edit">
        <p class="muted">Per-user quota override — blank fields inherit the global defaults
        (${PERIODS.map((p) => `${PERIOD_LABEL[p]}: ${euro(defaults[p].budget_eur)} / ${defaults[p].searches} searches`).join(" · ")}). 0 = uncapped.
        The budget is enforced as real Berget cost; users only ever see a percentage.</p>
        <div class="quota-grid">
          <span></span><span class="col">budget €</span><span class="col">searches</span>
          ${PERIODS.map((p) => `
            <span>${PERIOD_LABEL[p]}</span>
            <input type="number" min="0" step="0.05" data-q="${p}.budget_eur" value="${override?.[p]?.budget_eur ?? ""}" placeholder="${defaults[p].budget_eur}">
            <input type="number" min="0" step="5" data-q="${p}.searches" value="${override?.[p]?.searches ?? ""}" placeholder="${defaults[p].searches}">`).join("")}
        </div>
        <p style="margin:.6rem 0 0; display:flex; gap:.5rem">
          <button data-act="save-quota">Save quota</button>
          <button data-act="clear-quota" class="secondary">Reset to defaults</button>
        </p>
      </div>`;
    el.addEventListener("click", async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      try {
        if (act === "edit") {
          el.classList.toggle("open");
        } else if (act === "approve") {
          await api(`/users/${u.id}`, { method: "PATCH", body: { status: "active" } });
          await load();
        } else if (act === "toggle-status") {
          await api(`/users/${u.id}`, { method: "PATCH", body: { status: u.status === "disabled" ? "active" : "disabled" } });
          await load();
        } else if (act === "delete") {
          if (!confirm(`Delete ${u.email} and their usage history? They can sign in again with Google and start fresh.`)) return;
          await api(`/users/${u.id}`, { method: "DELETE" });
          await load();
        } else if (act === "save-quota") {
          const quota = {};
          for (const input of el.querySelectorAll("[data-q]")) {
            const [p, k] = input.dataset.q.split(".");
            if (input.value !== "") (quota[p] ||= {})[k] = Number(input.value);
          }
          await api(`/users/${u.id}`, { method: "PATCH", body: { quota: Object.keys(quota).length ? quota : null } });
          await load();
        } else if (act === "clear-quota") {
          await api(`/users/${u.id}`, { method: "PATCH", body: { quota: null } });
          await load();
        }
      } catch (err) {
        alert(err.message);
      }
    });
    box.appendChild(el);
  }
  $("users-sec").hidden = false;
}

// ---- config ---------------------------------------------------------------

function renderConfig() {
  const c = overview.config;
  const form = $("config-form");
  form.innerHTML = `
    <h3>Default quotas (per user; 0 = uncapped)</h3>
    <p class="muted">The budget is enforced as real Berget cost (tokens ×
    each model's actual per-token price) — users only ever see a
    percentage bar, never amounts. Searches are Exa's billing unit.</p>
    <div class="quota-grid">
      <span></span><span class="col">budget €</span><span class="col">searches</span>
      ${PERIODS.map((p) => `
        <span>${PERIOD_LABEL[p]}</span>
        <input type="number" min="0" step="0.05" name="q.${p}.budget_eur" value="${c.quotas[p].budget_eur}">
        <input type="number" min="0" step="5" name="q.${p}.searches" value="${c.quotas[p].searches}">`).join("")}
    </div>
    <h3>Research</h3>
    <div class="group">
      <label>Exa cost / search € <input type="number" min="0" step="0.001" name="exa" value="${c.exa_cost_per_search_eur}"></label>
      <label>Max time budget (s) <input type="number" min="15" max="600" name="maxbudget" value="${c.max_time_budget_s}"></label>
      <label>Default model <input name="model" value="${escapeHtml(c.default_model || "")}" placeholder="(worker default)" style="min-width:230px"></label>
    </div>
    <h3>Accounts</h3>
    <div class="group">
      <label><input type="checkbox" name="approval" ${c.require_approval ? "checked" : ""}>
        Require admin approval for new sign-ins (off = anyone with a Google account gets access immediately)</label>
    </div>
    <h3>Intro animation</h3>
    <div class="group">
      <label style="flex:1;display:flex;align-items:center;gap:.6rem">Speed
        <input type="range" name="animspeed" min="-100" max="100" step="1" style="flex:1"
          value="${Math.round((100 * Math.log(c.anim_speed > 0 ? c.anim_speed : 1)) / Math.log(4))}">
        <span id="animspeed-val" style="min-width:8.5rem;font-variant-numeric:tabular-nums"></span>
      </label>
    </div>
    <p class="muted">The /cure first-visit umbrella intro. Center = the default pace
      (itself 2.5× the original design); range ¼× to 4× of that. Served publicly at
      /api/anim; a change reaches visitors within ~2 minutes (config + browser cache).</p>
    <div class="group"><button type="submit">Save configuration</button><span class="muted" id="config-msg"></span></div>`;
  // The slider is log-scaled so the default sits exactly at center with
  // symmetric slower/faster halves: multiplier = 4^(v/100), v ∈ [-100, 100].
  const animSlider = form.querySelector('[name="animspeed"]');
  const animLabel = form.querySelector("#animspeed-val");
  const animMult = () => Math.pow(4, Number(animSlider.value) / 100);
  const syncAnimLabel = () => {
    const m = animMult();
    animLabel.textContent =
      `${m.toFixed(2)}× default` + (Math.abs(m - 1) < 0.005 ? " (center)" : ` (${(2.5 * m).toFixed(1)}× original)`);
  };
  syncAnimLabel();
  animSlider.addEventListener("input", syncAnimLabel);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const quotas = {};
    for (const p of PERIODS) {
      quotas[p] = { budget_eur: Number(f.get(`q.${p}.budget_eur`)), searches: Number(f.get(`q.${p}.searches`)) };
    }
    try {
      await api("/config", {
        method: "PUT",
        body: {
          quotas,
          exa_cost_per_search_eur: Number(f.get("exa")),
          max_time_budget_s: Number(f.get("maxbudget")),
          default_model: String(f.get("model") || ""),
          require_approval: f.get("approval") === "on",
          anim_speed: Math.round(animMult() * 1000) / 1000,
        },
      });
      $("config-msg").textContent = "Saved ✓";
      setTimeout(() => ($("config-msg").textContent = ""), 2000);
      await load();
    } catch (err) {
      alert(err.message);
    }
  };
  $("config-sec").hidden = false;
}

load();

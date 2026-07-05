// Admin UI: usage totals, user management (role/status/quota/delete), and
// site configuration. All data comes from /api/admin/* (role-gated
// server-side); this page is just rendering and actions. Accounts are
// provisioned by Google sign-in — there is nothing to create here.

const $ = (id) => document.getElementById(id);
const PERIODS = ["day", "week", "month"];

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
const hours = (ms) => ((Number(ms) || 0) / 3_600_000).toFixed(2) + " h";

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
  renderTotals();
  renderUsers();
  renderConfig();
}

// ---- overview cards ---------------------------------------------------

function renderTotals() {
  const t = overview.totals;
  const pending = overview.users.filter((u) => u.status === "pending").length;
  const cards = [
    ["Today", `${euro(t.day_cost)} · ${hours(t.day_ms)}`],
    ["This week", `${euro(t.week_cost)} · ${hours(t.week_ms)}`],
    ["This month", `${euro(t.month_cost)} · ${hours(t.month_ms)}`],
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
  for (const u of overview.users) {
    const usage = u.usage || {};
    let override = null;
    try { override = u.quota_json ? JSON.parse(u.quota_json) : null; } catch { override = null; }
    const q = {};
    for (const p of PERIODS) {
      q[p] = {
        hours: override?.[p]?.hours ?? defaults[p].hours,
        cost_eur: override?.[p]?.cost_eur ?? defaults[p].cost_eur,
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
        ${quotaBar("Today", (usage.day_ms || 0) / 3.6e6, q.day.hours, (v) => v.toFixed(2) + " h")}
        ${quotaBar("Today", usage.day_cost || 0, q.day.cost_eur, euro)}
        ${quotaBar("Week", (usage.week_ms || 0) / 3.6e6, q.week.hours, (v) => v.toFixed(2) + " h")}
        ${quotaBar("Week", usage.week_cost || 0, q.week.cost_eur, euro)}
        ${quotaBar("Month", (usage.month_ms || 0) / 3.6e6, q.month.hours, (v) => v.toFixed(2) + " h")}
        ${quotaBar("Month", usage.month_cost || 0, q.month.cost_eur, euro)}
      </div>
      <div class="quota-edit">
        <p class="muted">Per-user quota override — blank fields inherit the global defaults
        (${PERIODS.map((p) => `${p}: ${defaults[p].hours} h / ${euro(defaults[p].cost_eur)}`).join(" · ")}).</p>
        <div class="quota-grid">
          <span></span><span class="col">hours</span><span class="col">cost €</span>
          ${PERIODS.map((p) => `
            <span>${p}</span>
            <input type="number" min="0" step="0.25" data-q="${p}.hours" value="${override?.[p]?.hours ?? ""}" placeholder="${defaults[p].hours}">
            <input type="number" min="0" step="0.1" data-q="${p}.cost_eur" value="${override?.[p]?.cost_eur ?? ""}" placeholder="${defaults[p].cost_eur}">`).join("")}
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
    <h3>Default quotas (per user)</h3>
    <div class="quota-grid">
      <span></span><span class="col">hours</span><span class="col">cost €</span>
      ${PERIODS.map((p) => `
        <span>${p}</span>
        <input type="number" min="0" step="0.25" name="q.${p}.hours" value="${c.quotas[p].hours}">
        <input type="number" min="0" step="0.1" name="q.${p}.cost_eur" value="${c.quotas[p].cost_eur}">`).join("")}
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
    <div class="group"><button type="submit">Save configuration</button><span class="muted" id="config-msg"></span></div>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const quotas = {};
    for (const p of PERIODS) {
      quotas[p] = { hours: Number(f.get(`q.${p}.hours`)), cost_eur: Number(f.get(`q.${p}.cost_eur`)) };
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

load();

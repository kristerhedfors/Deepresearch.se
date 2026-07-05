// Admin UI: usage totals, user management (role/status/quota/delete), and
// site configuration. All data comes from /api/admin/* (role-gated
// server-side); this page is just rendering and actions. Accounts are
// provisioned by Google sign-in — there is nothing to create here.

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
  renderTotals();
  renderUsers();
  renderConfig();
}

// ---- overview cards ---------------------------------------------------

function renderTotals() {
  const t = overview.totals;
  const pending = overview.users.filter((u) => u.status === "pending").length;
  // Aggregate cost + billable counts (tokens for Berget, searches for Exa).
  const win = (p) =>
    `${euro(t[`${p}_cost`])}<div class="sub">${count(t[`${p}_tokens`])} tok · ${count(t[`${p}_searches`])} searches</div>`;
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
  for (const u of overview.users) {
    const usage = u.usage || {};
    let override = null;
    try { override = u.quota_json ? JSON.parse(u.quota_json) : null; } catch { override = null; }
    const q = {};
    for (const p of PERIODS) {
      q[p] = {
        tokens: override?.[p]?.tokens ?? defaults[p].tokens,
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
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} tokens`, usage[`${p}_tokens`] || 0, q[p].tokens, count)).join("")}
        ${PERIODS.map((p) => quotaBar(`${PERIOD_LABEL[p]} searches`, usage[`${p}_searches`] || 0, q[p].searches, count)).join("")}
      </div>
      <p class="muted" style="margin:.45rem 0 0">
        Cost: ${PERIODS.map((p) => `${PERIOD_LABEL[p].toLowerCase()} ${euro(usage[`${p}_cost`] || 0)}`).join(" · ")}
      </p>
      <div class="quota-edit">
        <p class="muted">Per-user quota override — blank fields inherit the global defaults
        (${PERIODS.map((p) => `${PERIOD_LABEL[p]}: ${count(defaults[p].tokens)} tok / ${defaults[p].searches} searches`).join(" · ")}). 0 = uncapped.</p>
        <div class="quota-grid">
          <span></span><span class="col">tokens</span><span class="col">searches</span>
          ${PERIODS.map((p) => `
            <span>${PERIOD_LABEL[p]}</span>
            <input type="number" min="0" step="1000" data-q="${p}.tokens" value="${override?.[p]?.tokens ?? ""}" placeholder="${defaults[p].tokens}">
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
    <div class="quota-grid">
      <span></span><span class="col">tokens</span><span class="col">searches</span>
      ${PERIODS.map((p) => `
        <span>${PERIOD_LABEL[p]}</span>
        <input type="number" min="0" step="1000" name="q.${p}.tokens" value="${c.quotas[p].tokens}">
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
    <div class="group"><button type="submit">Save configuration</button><span class="muted" id="config-msg"></span></div>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const quotas = {};
    for (const p of PERIODS) {
      quotas[p] = { tokens: Number(f.get(`q.${p}.tokens`)), searches: Number(f.get(`q.${p}.searches`)) };
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

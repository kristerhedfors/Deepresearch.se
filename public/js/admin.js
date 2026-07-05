// Admin UI: access requests, invitations (+QR), users with quotas, config.
// All data comes from /api/admin/* (role-gated server-side); this page is
// just rendering and actions.

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
const when = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") : "—");

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
  renderRequests();
  renderInvites();
  renderUsers();
  renderConfig();
}

// ---- overview cards ---------------------------------------------------

function renderTotals() {
  const t = overview.totals;
  const cards = [
    ["Today", `${euro(t.day_cost)} · ${hours(t.day_ms)}`],
    ["This week", `${euro(t.week_cost)} · ${hours(t.week_ms)}`],
    ["This month", `${euro(t.month_cost)} · ${hours(t.month_ms)}`],
    ["Requests this month", String(t.month_requests || 0)],
    ["Users", String(overview.users.length)],
    ["Pending access requests", String(overview.requests.length)],
  ];
  $("totals").innerHTML = cards
    .map(([lbl, big]) => `<div class="card"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`)
    .join("");
  $("totals-sec").hidden = false;
}

// ---- access requests ----------------------------------------------------

function renderRequests() {
  const box = $("requests");
  $("requests-count").textContent = overview.requests.length || "";
  box.innerHTML = overview.requests.length
    ? ""
    : '<p class="muted">No pending requests.</p>';
  for (const r of overview.requests) {
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = `
      <div class="head">
        <b>${escapeHtml(r.email)}</b>
        <span class="muted">${when(r.created_at)}</span>
        <span class="spacer"></span>
        <button data-act="approve">Approve → invite</button>
        <button data-act="deny" class="danger">Deny</button>
      </div>
      ${r.message ? `<p class="msg">${escapeHtml(r.message)}</p>` : ""}`;
    el.addEventListener("click", async (e) => {
      const act = e.target.dataset?.act;
      if (!act) return;
      e.target.disabled = true;
      try {
        const res = await api(`/requests/${r.id}`, { method: "POST", body: { action: act } });
        await load();
        if (res.invite) showQr(res.invite);
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    });
    box.appendChild(el);
  }
  $("requests-sec").hidden = false;
}

// ---- invitations ---------------------------------------------------------

function renderInvites() {
  const box = $("invites");
  const open = overview.invites.filter((i) => !i.used_at);
  const used = overview.invites.filter((i) => i.used_at);
  box.innerHTML = open.length || used.length ? "" : '<p class="muted">No invitations yet.</p>';
  for (const inv of open) {
    const expired = inv.expires_at < Date.now();
    const el = document.createElement("div");
    el.className = "rowitem";
    el.innerHTML = `
      <div class="head">
        <b>${escapeHtml(inv.email)}</b>
        <span class="badge ${inv.role}">${inv.role}</span>
        <span class="muted">${expired ? "expired" : "expires"} ${when(inv.expires_at)}</span>
        <span class="spacer"></span>
        ${expired ? "" : '<button data-act="qr" class="secondary">Link / QR</button>'}
        <button data-act="revoke" class="danger">Revoke</button>
      </div>`;
    el.addEventListener("click", async (e) => {
      const act = e.target.dataset?.act;
      if (act === "qr") showQr(inv);
      if (act === "revoke") {
        try {
          await api(`/invites/${inv.token}`, { method: "DELETE" });
          await load();
        } catch (err) {
          alert(err.message);
        }
      }
    });
    box.appendChild(el);
  }
  if (used.length) {
    const el = document.createElement("p");
    el.className = "muted";
    el.textContent = `${used.length} used invitation${used.length === 1 ? "" : "s"}: ` +
      used.slice(0, 8).map((i) => i.email).join(", ") + (used.length > 8 ? ", …" : "");
    box.appendChild(el);
  }
  $("invites-sec").hidden = false;
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await api("/invites", {
      method: "POST",
      body: { email: $("invite-email").value, role: $("invite-role").value },
    });
    $("invite-email").value = "";
    await load();
    showQr(res.invite);
  } catch (err) {
    alert(err.message);
  }
});

// ---- users ---------------------------------------------------------------

function quotaBar(label, used, limit, fmt) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return `<div class="qbar">${label}: ${fmt(used)}${limit > 0 ? " / " + fmt(limit) : ""}
    <div class="track"><div class="fill${pct >= 90 ? " hot" : ""}" style="width:${pct}%"></div></div></div>`;
}

function renderUsers() {
  const box = $("users");
  box.innerHTML = overview.users.length ? "" : '<p class="muted">No users yet — create an invitation above.</p>';
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
        ${override ? '<span class="badge">custom quota</span>' : ""}
        <span class="spacer"></span>
        <button data-act="edit" class="secondary">Quota…</button>
        <button data-act="toggle-role" class="secondary">${u.role === "admin" ? "Make user" : "Make admin"}</button>
        <button data-act="toggle-status" class="secondary">${u.status === "disabled" ? "Enable" : "Disable"}</button>
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
        } else if (act === "toggle-role") {
          await api(`/users/${u.id}`, { method: "PATCH", body: { role: u.role === "admin" ? "user" : "admin" } });
          await load();
        } else if (act === "toggle-status") {
          await api(`/users/${u.id}`, { method: "PATCH", body: { status: u.status === "disabled" ? "active" : "disabled" } });
          await load();
        } else if (act === "delete") {
          if (!confirm(`Delete ${u.email} and their usage history?`)) return;
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
      <label><input type="checkbox" name="requests" ${c.allow_access_requests ? "checked" : ""}> Allow access requests on the login page</label>
      <label>Invite expiry (days) <input type="number" min="1" max="365" name="expiry" value="${c.invite_expiry_days}"></label>
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
          allow_access_requests: f.get("requests") === "on",
          invite_expiry_days: Number(f.get("expiry")),
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

// ---- QR overlay -------------------------------------------------------------

function showQr(invite) {
  $("qr-title").textContent = `Invitation for ${invite.email}`;
  $("qr-link").value = invite.url;
  const canvas = $("qr-canvas");
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (window.qrcodegen) {
    const qr = qrcodegen.QrCode.encodeText(invite.url, qrcodegen.QrCode.Ecc.MEDIUM);
    const scale = Math.floor(canvas.width / (qr.size + 8)); // 4-module quiet zone
    const offset = Math.floor((canvas.width - qr.size * scale) / 2);
    ctx.fillStyle = "#0a2e5c";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
      }
    }
  }
  $("qr-overlay").hidden = false;
}
$("qr-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("qr-link").value);
    $("qr-copy").textContent = "Copied ✓";
  } catch {
    $("qr-link").select();
  }
  setTimeout(() => ($("qr-copy").textContent = "Copy link"), 1500);
});
$("qr-close").addEventListener("click", () => ($("qr-overlay").hidden = true));
$("qr-overlay").addEventListener("click", (e) => {
  if (e.target === $("qr-overlay")) $("qr-overlay").hidden = true;
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

load();

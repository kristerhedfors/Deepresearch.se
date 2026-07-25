// The account panel's "LLM sharing" view — the sharer's dashboard and BOTH
// halves of mutual consent, on one screen (owner directive, 2026-07-25: one
// level below Settings).
//
// Compute sharing (docs/COMPUTE-SHARING.md) lends a signed-in user's local
// OpenAI-compatible model to other people through the broker. Two questions
// gate every relayed prompt, and the same account is routinely on both sides
// of them, so they live together here:
//
//   INCOMING (ingress) — people asking to run prompts on YOUR model. You
//                        answer once per identity; the answer is remembered.
//   OUTGOING (egress)  — pools YOU send prompts to. You answer once per pool
//                        owner; the same rule.
//
// Everything the screen shows about WHO is asking comes from the server's
// view of a session (pool.js consumerView / poolOwnerIdentity) — never from a
// name a peer typed. Where the platform could not verify an identity the row
// says so rather than dressing a token up as a person.
//
// The panel shell (showView) lives in account.js; the data comes from
// GET /api/pool and the decisions go back through POST /api/pool/ingress
// (mine to make) and POST /api/pool/egress (mine to make about others).

import { escapeHtml } from "./notifications.js";
import { poolDataFlowNotice } from "./pool-core.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

const HEADER = `
  <button id="poolbackbtn" type="button" class="back-link">← Back</button>
  <p class="section-lbl">LLM sharing</p>`;

/**
 * The "LLM sharing" view. Reached from Settings (one level below it) and
 * deep-linkable as the `llmsharing` view.
 * @param {PanelCtx} ctx
 */
export async function loadPoolView(ctx) {
  ctx.body.innerHTML = `${HEADER}<p class="muted">Loading…</p>`;
  wireBack(ctx);

  let view = null;
  let error = "";
  try {
    const res = await fetch("/api/pool");
    if (res.ok) view = await res.json();
    else error = res.status === 503 ? "Compute sharing is not available on this server." : "Could not load your sharing status.";
  } catch {
    error = "Could not load your sharing status.";
  }

  if (!view) {
    ctx.body.innerHTML = `${HEADER}<p class="muted">${escapeHtml(error || "Could not load your sharing status.")}</p>`;
    wireBack(ctx);
    return;
  }

  ctx.body.innerHTML = `
    ${HEADER}
    <p class="muted setting-note">Lend your own local model to other people, or use theirs.
      Both directions are consent-based: nobody's prompts reach your machine, and
      yours reach nobody's, until the people involved have said yes to each other.</p>
    ${renderIncoming(view)}
    ${renderOutgoing(view)}
    ${renderProviders(view)}
    ${renderTokens(view)}
    <div class="pool-flow">
      <p class="section-lbl">How the data flows</p>
      ${poolDataFlowNotice().map((p) => `<p class="muted setting-note">${escapeHtml(p)}</p>`).join("")}
    </div>`;
  wireBack(ctx);
  wireDecisions(ctx);
  wireMint(ctx);
}

/** @param {PanelCtx} ctx */
function wireBack(ctx) {
  document.getElementById("poolbackbtn")?.addEventListener("click", () => ctx.show("settings"));
}

// ---- incoming: people asking to use YOUR model -------------------------------

/** @param {any} view */
function renderIncoming(view) {
  const consumers = view.consumers || [];
  const pending = consumers.filter((c) => c.state === "pending");
  const decided = consumers.filter((c) => c.state !== "pending");
  const pendingRows = pending.map((c) => incomingRow(c, true)).join("");
  const decidedRows = decided.map((c) => incomingRow(c, false)).join("");
  return `
    <p class="section-lbl">Incoming — who may use your model${pending.length ? ` (${pending.length} waiting)` : ""}</p>
    ${
      pending.length
        ? `<p class="muted setting-note">Each of these holds a token for your pool and is waiting for you.
             Everything they send would be computed by your local model, and you can read it.</p>${pendingRows}`
        : ""
    }
    ${decidedRows || (pending.length ? "" : '<p class="muted setting-note">Nobody has asked to use your model yet.</p>')}`;
}

/** @param {any} c @param {boolean} waiting */
function incomingRow(c, waiting) {
  const who = escapeHtml(c.display || c.consumerKey);
  // Say plainly what the platform did and did not verify. A token holder with
  // no session is NOT a person we can name, and the row must not pretend.
  const badge = c.verified
    ? '<span class="pool-badge verified">verified account</span>'
    : '<span class="pool-badge unverified">token holder — unverified</span>';
  const usage = c.jobs
    ? `<span class="muted">${c.jobs} request${c.jobs === 1 ? "" : "s"} · ${c.promptTokens + c.completionTokens} tokens</span>`
    : '<span class="muted">no requests yet</span>';
  const actions = waiting
    ? `<button type="button" class="pool-allow" data-ingress="${escapeHtml(c.consumerKey)}" data-decision="allow">Allow</button>
       <button type="button" class="pool-deny" data-ingress="${escapeHtml(c.consumerKey)}" data-decision="deny">Deny</button>`
    : c.state === "allowed"
      ? `<button type="button" class="pool-deny" data-ingress="${escapeHtml(c.consumerKey)}" data-decision="deny">Remove access</button>`
      : `<button type="button" class="pool-allow" data-ingress="${escapeHtml(c.consumerKey)}" data-decision="allow">Allow again</button>`;
  return `
    <div class="pool-row ${waiting ? "waiting" : ""}">
      <div class="pool-who">${who} ${badge} <span class="pool-state ${c.state}">${stateLabel(c.state)}</span></div>
      <div class="pool-meta">${usage}</div>
      <div class="pool-actions">${actions}</div>
    </div>`;
}

// ---- outgoing: pools YOU send prompts to -------------------------------------

/** @param {any} view */
function renderOutgoing(view) {
  const rows = (view.egress || []).map(outgoingRow).join("");
  return `
    <p class="section-lbl">Outgoing — whose model you use${view.pendingEgress ? ` (${view.pendingEgress} waiting on you)` : ""}</p>
    ${
      rows ||
      '<p class="muted setting-note">You are not using anyone else’s shared model. A shared workspace or a sharing link is what puts a pool here.</p>'
    }`;
}

/** @param {any} e */
function outgoingRow(e) {
  const who = escapeHtml(e.ownerDisplay || e.poolId);
  const actions =
    e.state === "allowed"
      ? `<button type="button" class="pool-deny" data-egress="${escapeHtml(e.poolId)}" data-decision="deny">Stop sending</button>`
      : `<button type="button" class="pool-allow" data-egress="${escapeHtml(e.poolId)}" data-decision="allow">Allow</button>`;
  return `
    <div class="pool-row ${e.state === "pending" ? "waiting" : ""}">
      <div class="pool-who">${who} <span class="pool-state ${e.state}">${stateLabel(e.state, true)}</span></div>
      <div class="pool-meta"><span class="muted">${
        e.state === "pending"
          ? "Your prompts would be computed on their machine, and they can read everything you send."
          : e.state === "allowed"
            ? "Your prompts may be sent to this person's machine."
            : "You declined — nothing of yours is sent here."
      }</span></div>
      <div class="pool-actions">${actions}</div>
    </div>`;
}

/** @param {string} state @param {boolean} [outgoing] */
function stateLabel(state, outgoing) {
  if (state === "allowed") return outgoing ? "allowed" : "allowed in";
  if (state === "blocked") return outgoing ? "declined" : "blocked";
  return "waiting for you";
}

// ---- your own providers + tokens ---------------------------------------------

/** @param {any} view */
function renderProviders(view) {
  const online = (view.providers || []).filter((p) => p.online);
  return `
    <p class="section-lbl">Your shared model</p>
    ${
      online.length
        ? online
            .map(
              (p) => `<p class="muted setting-note">Online: ${escapeHtml(p.label || "this browser")}${
                p.models.length ? ` · ${escapeHtml(p.models.slice(0, 6).join(", "))}` : ""
              }</p>`,
            )
            .join("")
        : `<p class="muted setting-note">You are not sharing right now. Turn on
             <b>Share my compute</b> next to your local-server setting in the
             Se/cure tier (<a href="/cure" target="_blank" rel="noopener">/cure</a>)
             — that browser tab is what runs the prompts.</p>`
    }`;
}

/** @param {any} view */
function renderTokens(view) {
  const tokens = view.tokens || [];
  const rows = tokens
    .map(
      (t) => `
      <div class="pool-row">
        <div class="pool-who">${escapeHtml(t.label || "unlabelled")} <span class="muted">${
          t.remaining == null ? "any number of requests" : `${t.remaining} of ${t.quota} left`
        }</span></div>
        <div class="pool-actions">
          <button type="button" class="pool-deny" data-revoke="${escapeHtml(t.jti)}">Revoke</button>
        </div>
      </div>`,
    )
    .join("");
  return `
    <p class="section-lbl">Sharing links</p>
    <p class="muted setting-note">A link lets someone point their client at your model.
      It is only capacity — they still appear above as a request you have to allow.</p>
    <div class="pool-mint">
      <input id="poollabel" type="text" placeholder="Who is this for? (label)" maxlength="60" />
      <button id="poolmint" type="button">Create a sharing link</button>
    </div>
    <p id="poolminted" class="muted setting-note" hidden></p>
    ${rows}`;
}

// ---- wiring -------------------------------------------------------------------

/** @param {PanelCtx} ctx */
function wireDecisions(ctx) {
  // INGRESS — my decision about someone else reaching my machine.
  ctx.body.querySelectorAll("[data-ingress]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await post("/api/pool/ingress", {
        consumerKey: btn.getAttribute("data-ingress"),
        decision: btn.getAttribute("data-decision"),
      });
      await loadPoolView(ctx); // re-render from the server's state, not the DOM's
    });
  });
  // EGRESS — my decision about my prompts leaving. The token that names the
  // pool usually lives in the Se/cure browser, so from here the session is
  // the proof instead: the server writes the decision against MY consumer key.
  ctx.body.querySelectorAll("[data-egress]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await post("/api/pool/egress", {
        pool: btn.getAttribute("data-egress"),
        decision: btn.getAttribute("data-decision"),
      });
      await loadPoolView(ctx);
    });
  });
  ctx.body.querySelectorAll("[data-revoke]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await post("/api/pool/revoke", { jti: btn.getAttribute("data-revoke") });
      await loadPoolView(ctx);
    });
  });
}

/** @param {PanelCtx} ctx */
function wireMint(ctx) {
  const btn = document.getElementById("poolmint");
  btn?.addEventListener("click", async () => {
    btn.disabled = true;
    const label = /** @type {HTMLInputElement} */ (document.getElementById("poollabel"))?.value || "";
    const out = document.getElementById("poolminted");
    const res = await post("/api/pool/token", { label });
    if (res && res.link) {
      out.hidden = false;
      out.innerHTML = `Share this link: <code class="pool-link">${escapeHtml(res.link)}</code>`;
    } else {
      out.hidden = false;
      out.textContent = "Could not create a link — try again in a moment.";
    }
    btn.disabled = false;
  });
}

/** @param {string} path @param {any} body */
async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

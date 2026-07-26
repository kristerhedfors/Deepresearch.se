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
import { createPoolProvider } from "./pool-provider.js";
import { listLocalPoolModels, normalizePoolLocalUrl, runLocalPoolJob } from "./pool-local.js";

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
  wireSharing();
}

/** The sharer's two controls. The URL is saved as it is typed so the toggle
 * beside it always acts on what the field shows; changing it while sharing
 * restarts the loop so the broker re-advertises the new server's models. */
function wireSharing() {
  const url = /** @type {HTMLInputElement | null} */ (document.getElementById("poollocalurl"));
  const box = /** @type {HTMLInputElement | null} */ (document.getElementById("poolshare"));
  url?.addEventListener("change", async () => {
    write(LOCAL_URL_KEY, normalizePoolLocalUrl(url.value));
    if (sharing()) {
      await setPoolSharing(false);
      const on = await setPoolSharing(true);
      if (box) box.checked = on;
    }
    const el = document.getElementById("poolshare-status");
    if (el) el.textContent = shareStatusText();
  });
  box?.addEventListener("change", async () => {
    box.disabled = true;
    const on = await setPoolSharing(box.checked);
    box.checked = on;
    box.disabled = false;
    const el = document.getElementById("poolshare-status");
    if (el) el.textContent = shareStatusText();
  });
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

/**
 * "Your shared model" — the SHARER's own control, working right here.
 *
 * This used to say "turn it on over in the Se/cure tier", which read as though
 * lending compute were a Se/cure-only feature (feedback #31, 2026-07-26). It
 * never was: the broker only needs a signed-in browser tab that can reach a
 * local model, and the signed-in Se/rver app is one. Both tiers now carry the
 * same toggle over the same loop; whichever tab is open does the lending, and
 * two tabs simply register as two providers under the one pool.
 * @param {any} view
 */
function renderProviders(view) {
  const providers = view.providers || [];
  const online = providers.filter((p) => p.online);
  const here = sharing();
  const others = online.filter((p) => !here || p.label !== THIS_TAB_LABEL);
  return `
    <p class="section-lbl">Your shared model</p>
    <p class="muted setting-note">Lend the OpenAI-compatible model running on this
      machine (Ollama, LM Studio, llama.cpp). The prompts run in <b>this browser tab</b>,
      against that server — so the tab has to stay open while you share. You can do the
      same from a <a href="/cure" target="_blank" rel="noopener">Se/cure</a> tab; either
      tier lends the same pool.</p>
    <div class="pool-share">
      <label class="pool-share-url">Local server URL
        <input id="poollocalurl" type="url" inputmode="url" spellcheck="false"
               placeholder="http://localhost:11434/v1" value="${escapeHtml(localUrl())}" />
      </label>
      <label class="pool-share-toggle">
        <input id="poolshare" type="checkbox" ${here ? "checked" : ""} />
        <span>Share my compute</span>
      </label>
    </div>
    <p id="poolshare-status" class="muted setting-note">${escapeHtml(shareStatusText())}</p>
    ${others
      .map(
        (p) => `<p class="muted setting-note">Also online: ${escapeHtml(p.label || "another browser")}${
          p.models && p.models.length ? ` · ${escapeHtml(p.models.slice(0, 6).join(", "))}` : ""
        }</p>`,
      )
      .join("")}
    ${
      !online.length && !here
        ? `<p class="muted setting-note">You are not sharing right now — nobody can reach your model until you turn this on.</p>`
        : ""
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

// ---- the sharer's engine: lending this machine's model from Se/rver -----------
//
// The loop is a MODULE-LEVEL singleton, not view state: leaving the LLM
// sharing screen (or the account panel entirely) must not stop the lending the
// user switched on, and re-entering it must not start a second one. It lives
// as long as the tab does, which is exactly the promise the copy makes.

const LOCAL_URL_KEY = "dr_pool_local_url"; // this machine's OpenAI-compatible server
const SHARE_KEY = "dr_pool_share_drs"; // "1" — sharing is on, auto-resumes next visit
const THIS_TAB_LABEL = "Se/rver browser tab";

/** @type {ReturnType<typeof createPoolProvider> | null} */
let loop = null;
/** @type {{state: string, detail?: string, jobs?: number}} */
let lastStatus = { state: "off" };

/** @param {string} k @param {string} [fallback] */
function read(k, fallback = "") {
  try {
    return localStorage.getItem(k) || fallback;
  } catch {
    return fallback; // storage blocked — the setting just won't persist
  }
}

/** @param {string} k @param {string} v */
function write(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked — sharing still works for this tab's lifetime */
  }
}

/** The local server this tab lends. Empty until the sharer sets one. */
function localUrl() {
  return normalizePoolLocalUrl(read(LOCAL_URL_KEY));
}

/** Is this tab lending right now? The loop is the truth; the flag is intent. */
function sharing() {
  return !!(loop && loop.active);
}

function shareStatusText() {
  const s = lastStatus;
  if (s.state === "error") return "⚠ " + (s.detail || "sharing stopped");
  if (s.state === "job") return "Sharing — running a job for someone now…";
  if (s.state === "idle")
    return "Sharing — waiting for work" + (s.jobs ? ` · ${s.jobs} job${s.jobs === 1 ? "" : "s"} served` : "");
  if (!localUrl()) return "Set the URL of your local server first — sharing lends THAT model.";
  return "";
}

/** Build (once) the provider loop for this tab. Both halves of the local-model
 * conversation come from the shared runner (pool-local.js), so the Se/rver tab
 * and a Se/cure tab speak the identical wire to a user's own machine. */
function provider() {
  if (loop) return loop;
  loop = createPoolProvider({
    label: THIS_TAB_LABEL,
    listModels: () => listLocalPoolModels(localUrl()),
    runJob: (body) => runLocalPoolJob(localUrl(), body),
    onStatus: (s) => {
      lastStatus = s;
      // Repaint only if the screen happens to be open; the loop outlives it.
      const el = document.getElementById("poolshare-status");
      if (el) el.textContent = shareStatusText();
    },
  });
  return loop;
}

/**
 * Turn lending on or off. Refuses to start without a local server URL — an
 * empty one would register a provider that fails every job it claims, which is
 * worse for the consumer than no capacity at all.
 * @param {boolean} on
 * @returns {Promise<boolean>} whether sharing is on afterwards
 */
export async function setPoolSharing(on) {
  if (on && !localUrl()) {
    lastStatus = { state: "off" };
    const el = document.getElementById("poolshare-status");
    if (el) el.textContent = "Set the URL of your local server first — sharing lends THAT model.";
    return false;
  }
  write(SHARE_KEY, on ? "1" : "0");
  if (on) return provider().start();
  if (loop) await loop.stop();
  return false;
}

/**
 * Resume lending on app boot for a sharer who left the toggle on — their
 * explicit, revocable choice, exactly as the Se/cure tab auto-resumes. Called
 * from the app's boot tail; entirely fail-soft.
 */
export function resumePoolSharing() {
  try {
    if (read(SHARE_KEY) !== "1" || !localUrl()) return;
    setPoolSharing(true).catch(() => {});
  } catch {
    /* never break boot over it */
  }
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

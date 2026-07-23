// @ts-check
// The Agent Platform preview surface (public/agents/preview.html). Loads the
// agent registry the SAME way introspection and the Agent Studio do — from the
// committed source snapshot (public/introspect/source-snapshot.json) via the
// pure agentsFromSnapshot() — so what you preview is by construction the
// deployed definition. Renders each agent's composer from its spec
// (composerMarkup), lets you ask its example questions (each opens the real
// agent composer prefilled, via the deep-link), and shows the quota a shared
// agent link would mint. No build step, no framework; fail-soft throughout.

import {
  agentsFromSnapshot,
  findAgent,
  composerMarkup,
  esc,
  resolveExamples,
  resolveQuota,
  resolveControls,
} from "./agent-spec-core.js";
import { buildComposerDeepLink } from "./deeplink-core.js";

const SNAPSHOT_URL = "/introspect/source-snapshot.json";

/** The chat mode a shipped agent opens in; derived flavours fall back to normal. @param {any} agent */
function modeFor(agent) {
  return agent && (agent.mode === "sdk" || agent.mode === "agent-builder") ? "sdk"
    : agent && agent.mode === "introspection" ? "introspection"
    : "normal";
}

/** Render one agent into the stage. @param {any} agent */
function renderAgent(agent) {
  const stage = document.getElementById("stage");
  if (!stage || !agent) return;
  const mode = modeFor(agent);
  const q = resolveQuota(agent);
  const examples = resolveExamples(agent).seed;

  const exampleChips = examples
    .map((qn) => `<a class="ex" href="${esc(buildComposerDeepLink({ mode, ask: qn }))}">${esc(qn)}</a>`)
    .join("");

  // A shareable link to this specific agent's preview (a real, working link).
  const shareUrl = `${location.origin}/agents/preview.html?agent=${encodeURIComponent(agent.id)}`;

  stage.innerHTML = `
    <div class="pane">${composerMarkup(agent)}</div>
    <div class="meta">
      <h2>${esc(agent.name)} <span class="tier">${esc(agent.tier || agent.platform)}</span></h2>
      <p class="tag">${esc(agent.tagline || "")}</p>
      <dl>
        <dt>Platform type</dt><dd>${esc(agent.platform)}-tier</dd>
        <dt>Chat mode</dt><dd>${esc(agent.mode || "normal")}</dd>
        <dt>Derives from</dt><dd>${esc(agent.derivesFrom || "baseplate")}</dd>
        <dt>Controls</dt><dd>${resolveControls(agent).map((c) => esc(c.id || c.type)).join(", ")}</dd>
        <dt>Intro / loading</dt><dd>${esc(agent.intro?.kind || "none")} / ${esc(agent.loading?.kind || "none")}</dd>
      </dl>

      <h3>Ask an example question</h3>
      <div class="examples">${exampleChips || '<span class="muted">(no seed examples — Agent Studio can generate some)</span>'}</div>

      <h3>Share this agent</h3>
      <p class="muted">A shared link mints a token carrying this agent's quota — bounded, disclosed, revocable, fail-safe (PA-8/PA-9).</p>
      <div class="quota">
        <code>${esc(String(q.requests))} requests / ${esc(q.window)}${q.credits != null ? ` · ${esc(String(q.credits))} credits` : ""}</code>
      </div>
      <div class="share">
        <input type="text" readonly value="${esc(shareUrl)}" aria-label="Share link">
        <button type="button" id="copyshare">Copy</button>
      </div>
      <div class="share">
        <button type="button" id="mintlink">Mint token link (admin)</button>
        <span id="mintout" class="muted"></span>
      </div>
      <p class="src">Defined in <code>sdk/AGENTS.json</code> · rendered by <code>composerMarkup()</code> · <a href="/docs#AGENT-PLATFORM">docs</a></p>
    </div>`;

  const copy = document.getElementById("copyshare");
  copy?.addEventListener("click", () => {
    navigator.clipboard?.writeText(shareUrl).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    }).catch(() => {});
  });

  // Mint a real Se/rver token for this agent (admin-only endpoint — a non-admin
  // gets a clear 403 message rather than a broken button).
  const mint = document.getElementById("mintlink");
  const mintOut = document.getElementById("mintout");
  mint?.addEventListener("click", async () => {
    if (!mintOut) return;
    mint.setAttribute("disabled", "true");
    mintOut.textContent = "Minting…";
    try {
      const res = await fetch("/api/admin/agent-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: agent.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.link) {
        mintOut.innerHTML = `Minted: <a href="${esc(data.link)}">token link</a> (${esc(String((data.services || []).map((/** @type {any} */ s) => `${s.svc}:${s.quota}`).join(", ")))})`;
      } else if (res.status === 403) {
        mintOut.textContent = "Minting a token link requires an admin sign-in.";
      } else {
        mintOut.textContent = data.error || `Couldn't mint (HTTP ${res.status}).`;
      }
    } catch {
      mintOut.textContent = "Couldn't reach the mint endpoint.";
    } finally {
      mint.removeAttribute("disabled");
    }
  });

  // Reflect the theme onto the stage container so the whole card is themed.
  const pane = stage.querySelector(".agent-composer");
  if (pane) stage.setAttribute("style", pane.getAttribute("style") || "");
}

/** Build the left rail of agent buttons. @param {any} reg @param {string} activeId */
function renderRail(reg, activeId) {
  const rail = document.getElementById("rail");
  if (!rail) return;
  rail.innerHTML = (reg.agents || [])
    .map((/** @type {any} */ a) => `<button type="button" class="railbtn${a.id === activeId ? " active" : ""}" data-agent="${esc(a.id)}">
      <strong>${esc(a.name)}</strong><span>${esc(a.platform)}</span></button>`)
    .join("");
  rail.querySelectorAll(".railbtn").forEach((b) =>
    b.addEventListener("click", () => select(reg, /** @type {HTMLElement} */ (b).dataset.agent || ""))
  );
}

let REG = null;
/** @param {any} reg @param {string} id */
function select(reg, id) {
  const agent = findAgent(reg, id) || (reg.agents || [])[0];
  if (!agent) return;
  renderRail(reg, agent.id);
  renderAgent(agent);
  try { history.replaceState(null, "", `?agent=${encodeURIComponent(agent.id)}`); } catch { /* ignore */ }
}

export async function initAgentPreview() {
  const stage = document.getElementById("stage");
  try {
    const res = await fetch(SNAPSHOT_URL, { cache: "no-cache" });
    const snap = await res.json();
    REG = agentsFromSnapshot(snap);
    if (!REG || !REG.agents?.length) throw new Error("no agents in snapshot");
    const wanted = new URLSearchParams(location.search).get("agent") || REG.agents[0].id;
    select(REG, wanted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (stage) stage.innerHTML = `<p class="muted">Couldn't load the agent registry (${esc(msg)}). It ships in <code>sdk/AGENTS.json</code>; the preview reads it from the deployed source snapshot.</p>`;
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAgentPreview);
  else initAgentPreview();
}

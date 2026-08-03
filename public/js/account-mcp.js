// The account panel's "MCP server" view — one level below Settings, reached
// from the row the gear icon's Settings screen puts there.
//
// This is the screen that connects an EXTERNAL agent — Claude Code, Cursor,
// any MCP client — to this account's research pipeline, and the screen that
// decides what such an agent may reach once connected. Three sections, in the
// order someone actually needs them:
//
//   1. CONNECT — the endpoint, the one-line `claude mcp add` command, and the
//      key. The key's token is shown exactly once, at mint; afterwards the
//      screen can only tell you which key is live (its last six characters)
//      and offer to rotate or revoke it. That is a property of the server
//      (src/mcp-api.js stores only the jti and the hint), not a UI choice.
//   2. TOOLS — one switch per exposable tool, grouped by the catalog the
//      server sends. There is no second copy of the tool list in this file:
//      /api/mcp/config carries the catalog precisely so the screen cannot
//      drift from what the server actually serves.
//   3. RESEARCH DEFAULTS — what a `deep_research` call gets when the caller
//      does not say, and whether a caller may override it at all. This is the
//      spend dial: every call runs the real pipeline on this account's quota.
//
// A master switch above all three turns the whole surface off without
// touching any of it, which is the fastest honest answer to "stop, now".
//
// Everything here reads and writes /api/mcp/config and /api/mcp/key, both
// behind the identity gate — an MCP key can never reach them, which is what
// makes this screen the only place the exposure can change.

import { escapeHtml } from "./notifications.js";
import { settingRow, wireSettingPopovers } from "./account-views.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

const HEADER = `
  <button id="mcpbackbtn" type="button" class="back-link">← Back</button>
  <p class="section-lbl">MCP server</p>`;

const INTRO = `Connect an outside agent — <b>Claude Code</b>, Cursor, or anything
  that speaks MCP — to this account's research pipeline. It gets the same
  deep-research run the chat does: plan, search, gap-check, synthesize, cite.
  Calls draw on <b>your</b> quota, and every one is logged like a chat.`;

const MASTER_INFO = `<strong>MCP server</strong><br>
  <b>On:</b> the endpoint answers for this account — a signed-in browser
  session, and any MCP key you have minted below.<br>
  <b>Off:</b> the endpoint refuses everything for this account, whatever keys
  exist. Nothing is deleted; switching back on restores exactly what you had.`;

const KEY_INFO = `<strong>The MCP key</strong><br>
  A bearer credential you paste into an MCP client's configuration, because a
  client has no way to hold a browser session.<br>
  <b>What it can do:</b> call the tools you switch on below, on this account's
  quota.<br>
  <b>What it cannot do:</b> sign in. It is refused everywhere except the MCP
  endpoint — it cannot read your chats, projects, files, history or account, and
  it can never open the admin interface.<br>
  <b>One at a time:</b> minting again replaces the previous key, so a key you
  pasted somewhere you regret is one tap from dead. Revoking takes effect on the
  next call.`;

const OVERRIDE_MODEL_INFO = `<strong>Let callers choose the model</strong><br>
  <b>On:</b> a client may name any model your account can use; your default
  applies when it doesn't.<br>
  <b>Off:</b> every call runs on your default, whatever the client asks for.
  Worth switching off when the key is out of your hands and the price
  difference between models matters.`;

const OVERRIDE_BUDGET_INFO = `<strong>Let callers choose the time budget</strong><br>
  <b>On:</b> a client may ask for a longer or shorter research run, within the
  site's 15–600 second window.<br>
  <b>Off:</b> every call gets your default budget. This is the blunt cap on what
  a single call can spend.`;

const SEARCH_INFO = `<strong>Web search by default</strong><br>
  <b>On:</b> MCP research runs live web searches, like the chat does.<br>
  <b>Off:</b> the model answers from what it knows, and nothing is sent to the
  search provider. A caller can always decline search; it can never switch it
  back on.`;

/**
 * The "MCP server" view.
 * @param {PanelCtx} ctx
 */
export async function loadMcpView(ctx) {
  ctx.body.innerHTML = `${HEADER}<p class="muted">Loading…</p>`;
  wireBack(ctx);

  let data = null;
  let error = "";
  try {
    const res = await fetch("/api/mcp/config");
    if (res.ok) data = await res.json();
    else if (res.status === 403) error = "The MCP server needs a signed-in account (break-glass sessions have none).";
    else error = "Could not load your MCP settings.";
  } catch {
    error = "Could not load your MCP settings.";
  }
  if (!data) {
    ctx.body.innerHTML = `${HEADER}<p class="muted">${escapeHtml(error)}</p>`;
    wireBack(ctx);
    return;
  }

  render(ctx, data, "");
}

/**
 * Paint the whole screen from a config payload. Re-called after every write
 * with the server's authoritative answer, so what is on screen is always what
 * the server stored — never an optimistic guess.
 * @param {PanelCtx} ctx
 * @param {any} data the /api/mcp/config payload
 * @param {string} freshToken the just-minted token, shown once, or ""
 */
function render(ctx, data, freshToken) {
  const config = data.config || {};
  const on = config.enabled !== false;
  ctx.body.innerHTML = `
    ${HEADER}
    <p class="muted setting-note">${INTRO}</p>
    ${settingRow({
      id: "mcpmaster",
      label: "MCP server",
      checked: on,
      disabled: false,
      popId: "mcpmasterpop",
      info: MASTER_INFO,
    })}
    ${on ? "" : `<p class="muted setting-note">The endpoint is refusing every call for this account. Nothing below is lost — switch it back on and it all applies again.</p>`}

    <p class="section-lbl">Connect</p>
    ${endpointMarkup(data, freshToken)}

    <p class="section-lbl">Tools exposed</p>
    <p class="muted setting-note">What a connected agent can see and call. A tool
      switched off here disappears from the client's tool list, and a call to it
      is refused even if the client remembered it.</p>
    ${toolsMarkup(data)}

    <p class="section-lbl">Research defaults</p>
    <p class="muted setting-note">What a <code>deep_research</code> call gets when
      the caller doesn't say — and how much of that a caller may change.</p>
    ${defaultsMarkup(config)}

    <p id="mcpstatus" class="muted setting-note" hidden></p>`;

  wireBack(ctx);
  wireSettingPopovers(ctx.body);
  wireControls(ctx, data);
}

/** The endpoint + key section. */
function endpointMarkup(data, freshToken) {
  const key = data.config?.key || null;
  const command = escapeHtml(data.connect_command || "");
  const keyLine = freshToken
    ? `<p class="muted setting-note"><b>Copy this now — it is shown once.</b> The
         server keeps no copy: only enough to recognize and revoke it.</p>
       <textarea id="mcptoken" readonly rows="3" style="width:100%;font-size:.72rem;word-break:break-all">${escapeHtml(freshToken)}</textarea>`
    : key
      ? `<p class="muted setting-note">A key is live: <b>…${escapeHtml(key.hint)}</b>${
          key.label ? ` (${escapeHtml(key.label)})` : ""
        }${key.created_at ? `, minted ${new Date(key.created_at).toISOString().slice(0, 10)}` : ""}.
         The key itself was shown once at mint and can't be read back — mint a new
         one if you no longer have it.</p>`
      : `<p class="muted setting-note">No key yet. Mint one, paste the command into
           your terminal, and the client is connected.</p>`;

  return `
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">Endpoint</span>
        <span class="muted">${escapeHtml(data.endpoint || "")}</span>
      </div>
      <p class="muted setting-note">Streamable HTTP (JSON-RPC 2.0). Point any MCP
        client at this URL with your key in an <code>Authorization: Bearer</code>
        header.</p>
    </div>
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">MCP key
          <button type="button" class="setting-info" data-pop="mcpkeypop" aria-label="More about the MCP key">ⓘ</button>
        </span>
        <span class="row" style="display:flex;gap:.4rem;flex-wrap:wrap">
          <button type="button" id="mcpmint">${key || freshToken ? "Mint new" : "Mint key"}</button>
          ${key || freshToken ? '<button type="button" id="mcprevoke">Revoke</button>' : ""}
        </span>
      </div>
      <div class="setting-pop" id="mcpkeypop" hidden>${KEY_INFO}</div>
      ${keyLine}
      <p class="muted setting-note">Run this where your client lives:</p>
      <textarea id="mcpcommand" readonly rows="3" style="width:100%;font-size:.72rem;word-break:break-all">${command}</textarea>
      <div class="row" style="display:flex;gap:.5rem;flex-wrap:wrap">
        <button type="button" id="mcpcopycmd">Copy command</button>
        ${freshToken ? '<button type="button" id="mcpcopykey">Copy key</button>' : ""}
      </div>
    </div>`;
}

/** One switch per catalog tool, under its group heading. */
function toolsMarkup(data) {
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const tools = data.config?.tools || {};
  let out = "";
  let group = "";
  for (const entry of catalog) {
    if (entry.group !== group) {
      group = entry.group;
      out += `<p class="muted setting-note" style="margin-top:.6rem"><b>${escapeHtml(group)}</b></p>`;
    }
    out += settingRow({
      id: `mcptool-${entry.id}`,
      label: `<code>${escapeHtml(entry.label)}</code>`,
      checked: tools[entry.id] !== false,
      disabled: false,
      popId: `mcptoolpop-${entry.id}`,
      info: `<strong>${escapeHtml(entry.label)}</strong><br>${escapeHtml(entry.blurb)}`,
    });
    out += chatgptPairWarning(entry, catalog, tools);
  }
  return out || '<p class="muted setting-note">This server exposes no MCP tools.</p>';
}

/**
 * The one switch here whose effect is not "this tool disappears".
 *
 * ChatGPT validates a server's tool list at CONNECT time and refuses any
 * server that does not expose BOTH `search` and `fetch` by name (developer
 * mode lifts that, but it is web-only and paid-tier). So switching either one
 * off does not narrow a ChatGPT connector — it stops one being added at all,
 * and the failure surfaces inside ChatGPT as a generic "couldn't connect"
 * with nothing pointing back at this screen. Say so here, where the decision
 * is made, rather than leaving it to be discovered.
 *
 * Rendered after the LAST tool of the pair, so it reads as a note on the pair
 * rather than on whichever switch happens to come first.
 */
function chatgptPairWarning(entry, catalog, tools) {
  const pair = ["search", "fetch"];
  if (entry.id !== pair[pair.length - 1]) return "";
  // Only if the catalog actually carries both — a future catalog edit that
  // drops one should not leave this warning talking about a tool that is gone.
  if (!pair.every((id) => catalog.some((e) => e.id === id))) return "";
  const off = pair.filter((id) => tools[id] === false);
  if (!off.length) return "";
  const which = off.length === 2 ? "Both are" : `<code>${escapeHtml(off[0])}</code> is`;
  return `<p class="muted setting-note" style="margin-top:.35rem">⚠︎ ${which} switched off.
    ChatGPT requires <code>search</code> and <code>fetch</code> to exist before it will add
    this server as a connector, so a new ChatGPT connection will fail while that is the case.
    Claude and Claude Code are unaffected.</p>`;
}

/** The defaults + override policy section. */
function defaultsMarkup(config) {
  const defaults = config.defaults || {};
  const budget = Number(defaults.time_budget_s) || 120;
  return `
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">Time budget</span>
        <span class="row" style="display:flex;gap:.4rem;align-items:center">
          <input type="number" id="mcpbudget" min="15" max="600" step="5" value="${budget}"
                 style="width:5.5rem" aria-label="Default time budget in seconds">
          <span class="muted">seconds</span>
        </span>
      </div>
      <p class="muted setting-note">A longer budget buys more search angles and gap
        rounds — and costs proportionally more.</p>
    </div>
    ${settingRow({
      id: "mcpsearch",
      label: "Web search by default",
      checked: defaults.web_search !== false,
      disabled: false,
      popId: "mcpsearchpop",
      info: SEARCH_INFO,
    })}
    ${settingRow({
      id: "mcpmodeloverride",
      label: "Let callers choose the model",
      checked: config.allow_model_override !== false,
      disabled: false,
      popId: "mcpmodelpop",
      info: OVERRIDE_MODEL_INFO,
    })}
    ${settingRow({
      id: "mcpbudgetoverride",
      label: "Let callers choose the time budget",
      checked: config.allow_budget_override !== false,
      disabled: false,
      popId: "mcpbudgetpop",
      info: OVERRIDE_BUDGET_INFO,
    })}`;
}

// ---- wiring ------------------------------------------------------------------

/**
 * @param {PanelCtx} ctx
 * @param {any} data
 */
function wireControls(ctx, data) {
  const status = document.getElementById("mcpstatus");
  const say = (text) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = text;
  };

  /**
   * PUT a partial config and repaint from the server's answer. Repainting
   * rather than patching in place is what keeps the screen honest when a write
   * is rejected or normalized.
   * @param {object} patch
   * @param {string} okText
   */
  const write = async (patch, okText) => {
    say("Saving…");
    try {
      const res = await fetch("/api/mcp/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not save the change.");
      render(ctx, body, "");
      const fresh = document.getElementById("mcpstatus");
      if (fresh) {
        fresh.hidden = false;
        fresh.textContent = okText;
      }
    } catch (err) {
      say(err?.message || "Could not save the change.");
    }
  };

  document.getElementById("mcpmaster")?.addEventListener("change", (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked;
    write({ enabled: on }, on ? "The MCP server is on." : "The MCP server is off for this account.");
  });

  for (const entry of data.catalog || []) {
    document.getElementById(`mcptool-${entry.id}`)?.addEventListener("change", (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      write(
        { tools: { [entry.id]: on } },
        on ? `${entry.label} is exposed.` : `${entry.label} is no longer exposed.`,
      );
    });
  }

  document.getElementById("mcpsearch")?.addEventListener("change", (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked;
    write(
      { defaults: { web_search: on } },
      on ? "MCP research searches the web." : "MCP research answers without searching.",
    );
  });
  document.getElementById("mcpmodeloverride")?.addEventListener("change", (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked;
    write({ allow_model_override: on }, on ? "Callers may pick a model." : "Every call uses your default model.");
  });
  document.getElementById("mcpbudgetoverride")?.addEventListener("change", (e) => {
    const on = /** @type {HTMLInputElement} */ (e.target).checked;
    write({ allow_budget_override: on }, on ? "Callers may pick a budget." : "Every call uses your default budget.");
  });

  // The budget is a number field, so it commits on blur/Enter rather than on
  // every keystroke — a PUT per digit would be both noisy and rejected
  // mid-typing (a lone "1" is outside the allowed window).
  const budget = /** @type {HTMLInputElement | null} */ (document.getElementById("mcpbudget"));
  const commitBudget = () => {
    const value = Number(budget?.value);
    if (!Number.isFinite(value)) return;
    if (value === Number(data.config?.defaults?.time_budget_s)) return;
    write({ defaults: { time_budget_s: value } }, `Default budget: ${Math.round(value)} seconds.`);
  };
  budget?.addEventListener("change", commitBudget);
  budget?.addEventListener("keydown", (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === "Enter") commitBudget();
  });

  document.getElementById("mcpmint")?.addEventListener("click", async () => {
    say("Minting…");
    try {
      const res = await fetch("/api/mcp/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "MCP client" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not mint a key.");
      render(ctx, body, body.token || "");
      const fresh = document.getElementById("mcpstatus");
      if (fresh) {
        fresh.hidden = false;
        fresh.textContent = body.rotated
          ? "New key minted — the previous one stopped working immediately."
          : "Key minted.";
      }
    } catch (err) {
      say(err?.message || "Could not mint a key.");
    }
  });

  document.getElementById("mcprevoke")?.addEventListener("click", async () => {
    say("Revoking…");
    try {
      const res = await fetch("/api/mcp/key", { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Could not revoke the key.");
      render(ctx, body, "");
      const fresh = document.getElementById("mcpstatus");
      if (fresh) {
        fresh.hidden = false;
        fresh.textContent = "Key revoked — the next call from it will be refused.";
      }
    } catch (err) {
      say(err?.message || "Could not revoke the key.");
    }
  });

  wireCopy("mcpcopycmd", "mcpcommand");
  wireCopy("mcpcopykey", "mcptoken");
}

/**
 * @param {string} buttonId
 * @param {string} fieldId
 */
function wireCopy(buttonId, fieldId) {
  const button = document.getElementById(buttonId);
  const field = /** @type {HTMLTextAreaElement | null} */ (document.getElementById(fieldId));
  if (!button || !field) return;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      button.textContent = "Copied ✓";
    } catch {
      field.select();
      button.textContent = "Select and copy manually";
    }
  });
}

/** @param {PanelCtx} ctx */
function wireBack(ctx) {
  document.getElementById("mcpbackbtn")?.addEventListener("click", () => ctx.show("settings"));
}

// @ts-check
// AgentSpec — the DeepResearch AGENTS SDK's declarative definition of ONE
// agent (a "flavour" of the Se/cure + Se/rver pair). The Agents SDK is the
// project's second SDK, distinct from the Platform SDK (DistillSDK, sdk/ —
// which builds a whole platform): it is tailored to Agent Studio and the
// integrated Linux environment, and this module is its pure core — what both
// tiers, the sdk/pair-cli.mjs CLI, and the Agent Studio mode use to load,
// validate, and resolve agent definitions. Same convention as sdk-core.js / bash-core.js /
// introspect-core.js: it lives under public/ because the browser can only
// import served modules while the Worker bundler imports from any repo path;
// src/agent-spec.js is the thin server façade and sdk/pair-cli.mjs re-exports
// these helpers.
//
// I/O-free and Node-tested (agent-spec-core.test.js). An "agent" is DEFINED by
// its chat-input-pane controls, its intro + loading animations, its colour
// theme, its seed example questions, and the default quota a minted share-link
// token carries. The four agents this project ships — research, secure,
// under-construction, agent-builder — are the reference specs in sdk/AGENTS.json;
// deriving a new agent is copying one, changing these fields, and validating.

// ---- the closed control vocabulary -------------------------------------------
//
// A chat-input-pane control is one interactive affordance attached to the
// composer. The vocabulary is CLOSED (like the manifest's capability classes
// and the server token's permission set): a spec may only use these types, so a
// renderer on either tier — and the visual-proof test — knows every shape it
// must draw. Each entry declares the extra fields that type carries and their
// defaults, so resolveControls() can normalize a terse spec into a full one.

/** @typedef {"model-select"|"depth-slider"|"toggle"|"mode-select"|"attachments"|"prompt-input"|"send-button"} ControlType */

/**
 * The control registry: type → { required extra fields, defaults, whether it
 * drives a pipeline knob }. `drives` names the request field the control sets
 * (documentation + the proof test assert on it); null for pure-UI controls.
 */
export const CONTROL_REGISTRY = {
  "prompt-input": { drives: "message", defaults: { placeholder: "Ask anything…", multiline: true }, label: "Prompt" },
  "send-button": { drives: null, defaults: { label: "Send" }, label: "Send" },
  "model-select": { drives: "model", defaults: { providers: "all", allowLocal: false }, label: "Model" },
  "depth-slider": {
    drives: "depth",
    defaults: { min: 0, max: 3, default: 1, ticks: ["Quick", "Standard", "Deep", "Exhaustive"] },
    label: "Research depth",
  },
  "toggle": { drives: "flag", defaults: { default: false }, label: "Toggle" },
  "mode-select": { drives: "mode", defaults: { modes: ["normal"] }, label: "Mode" },
  "attachments": { drives: "attachments", defaults: { accept: "*/*", max: 5 }, label: "Attach" },
};

/** @type {ControlType[]} */
export const CONTROL_TYPES = /** @type {ControlType[]} */ (Object.keys(CONTROL_REGISTRY));

/** Platform types (DESIGN.md §3.1): a client-tier agent vs a server-tier agent. */
export const PLATFORM_TYPES = ["client", "server"];

/** Quota windows a minted share-link token can meter over (mirrors src/quota.js windows). */
export const QUOTA_WINDOWS = ["minute", "hour", "day", "month"];

// ---- validation --------------------------------------------------------------

/**
 * Structural validation of one agent spec. Returns a list of problem strings —
 * empty means valid. Never throws: a bad field is a reported problem, so the
 * Agent Studio can surface exactly what to fix.
 * @param {any} a
 * @returns {string[]}
 */
export function validateAgentSpec(a) {
  const problems = [];
  const at = (/** @type {string} */ msg) => `${a && a.id ? a.id : "(no id)"}: ${msg}`;
  if (!a || typeof a !== "object") return ["spec is not an object"];
  if (!a.id || typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) {
    problems.push(at("id must be a lowercase slug [a-z][a-z0-9-]*"));
  }
  if (!a.name || typeof a.name !== "string") problems.push(at("name is required"));
  if (!PLATFORM_TYPES.includes(a.platform)) problems.push(at(`platform must be one of ${PLATFORM_TYPES.join("/")}`));

  // Controls
  if (!Array.isArray(a.controls) || !a.controls.length) {
    problems.push(at("controls must be a non-empty array"));
  } else {
    const seen = new Set();
    for (const c of a.controls) {
      if (!c || typeof c !== "object") { problems.push(at("a control is not an object")); continue; }
      if (!CONTROL_TYPES.includes(c.type)) { problems.push(at(`unknown control type "${c.type}"`)); continue; }
      const key = c.id || c.type;
      if (seen.has(key)) problems.push(at(`duplicate control "${key}"`));
      seen.add(key);
      if (c.type === "toggle" && !c.id) problems.push(at('a "toggle" control needs an id (the flag it drives)'));
      if (c.type === "depth-slider") {
        const min = c.min ?? CONTROL_REGISTRY["depth-slider"].defaults.min;
        const max = c.max ?? CONTROL_REGISTRY["depth-slider"].defaults.max;
        if (!(Number.isInteger(min) && Number.isInteger(max) && min < max)) {
          problems.push(at("depth-slider needs integer min < max"));
        }
      }
    }
    // Every agent must have a way to type and send a message.
    if (!a.controls.some((/** @type {any} */ c) => c && c.type === "prompt-input")) problems.push(at('controls must include a "prompt-input"'));
  }

  // Theme: a small set of CSS-custom-property values.
  if (a.theme && typeof a.theme !== "object") problems.push(at("theme must be an object of CSS custom properties"));

  // Animations
  for (const k of ["intro", "loading"]) {
    if (a[k] && typeof a[k] !== "object") problems.push(at(`${k} must be an object`));
    if (a[k] && a[k].kind && typeof a[k].kind !== "string") problems.push(at(`${k}.kind must be a string`));
  }

  // Examples
  if (a.examples && !Array.isArray(a.examples)) problems.push(at("examples must be an array of strings"));

  // Quota (share-link token defaults)
  const q = a.quota;
  if (q != null) {
    if (typeof q !== "object") problems.push(at("quota must be an object"));
    else {
      if (q.window != null && !QUOTA_WINDOWS.includes(q.window)) problems.push(at(`quota.window must be one of ${QUOTA_WINDOWS.join("/")}`));
      for (const k of ["requests", "credits"]) {
        if (q[k] != null && !(Number.isFinite(q[k]) && q[k] >= 0)) problems.push(at(`quota.${k} must be a non-negative number`));
      }
    }
  }
  return problems;
}

/**
 * Validate a whole registry object ({agents:[...]}). Checks each spec plus
 * cross-agent uniqueness of ids. Returns problem strings; empty means valid.
 * @param {any} reg
 * @returns {string[]}
 */
export function validateAgentRegistry(reg) {
  const problems = [];
  if (!reg || !Array.isArray(reg.agents)) return ["registry has no agents array"];
  const ids = new Set();
  for (const a of reg.agents) {
    for (const p of validateAgentSpec(a)) problems.push(p);
    if (a && a.id) {
      if (ids.has(a.id)) problems.push(`duplicate agent id: ${a.id}`);
      ids.add(a.id);
    }
  }
  return problems;
}

// ---- resolution --------------------------------------------------------------

/**
 * Normalize a terse control descriptor into a full one: fill the type's default
 * fields, resolve its label, and record which request field it `drives`. This
 * is what a renderer draws from and what the proof test asserts against.
 * @param {any} c
 * @returns {any}
 */
export function resolveControl(c) {
  const reg = /** @type {any} */ (CONTROL_REGISTRY)[c.type];
  if (!reg) return { ...c, unknown: true };
  const out = { ...reg.defaults, ...c };
  out.type = c.type;
  out.id = c.id || c.type;
  out.label = c.label || reg.label;
  out.drives = c.type === "toggle" ? c.id : reg.drives;
  return out;
}

/**
 * The full, ordered control set for an agent: resolved descriptors. Guarantees
 * a prompt-input and a send-button exist (appended if a spec omitted the
 * send-button — the one control every composer needs and rarely bothers to
 * name).
 * @param {any} a
 * @returns {any[]}
 */
export function resolveControls(a) {
  const list = Array.isArray(a?.controls) ? a.controls.map(resolveControl) : [];
  if (!list.some((/** @type {any} */ c) => c.type === "send-button")) list.push(resolveControl({ type: "send-button" }));
  return list;
}

/** The default theme custom properties an agent inherits when it declares none. */
export const BASE_THEME = {
  "--agent-accent": "#3b82f6",
  "--agent-accent-soft": "rgba(59,130,246,0.14)",
  "--agent-bg": "#0b0f17",
  "--agent-fg": "#e8edf4",
};

/**
 * The resolved theme: BASE_THEME overlaid with the spec's declared properties.
 * @param {any} a
 * @returns {Record<string,string>}
 */
export function resolveTheme(a) {
  return { ...BASE_THEME, ...(a && a.theme && typeof a.theme === "object" ? a.theme : {}) };
}

/**
 * The default share-link quota for an agent, filled from spec.quota with safe
 * fallbacks. A minted agent link is metered by exactly these numbers under a
 * freshly-issued token (PA-8/PA-9 — fail-safe, bounded, revocable).
 * @param {any} a
 * @returns {{ window: string, requests: number, credits: number|null, note: string }}
 */
export function resolveQuota(a) {
  const q = (a && a.quota && typeof a.quota === "object") ? a.quota : {};
  return {
    window: QUOTA_WINDOWS.includes(q.window) ? q.window : "day",
    requests: Number.isFinite(q.requests) && q.requests >= 0 ? q.requests : 50,
    credits: Number.isFinite(q.credits) && q.credits >= 0 ? q.credits : null,
    note: typeof q.note === "string" ? q.note : "",
  };
}

// ---- share-link mint contract (PA-8 / PA-9) ----------------------------------

/**
 * The upstream services an agent SHARE LINK needs, named in the Se/rver
 * token's CLOSED permission vocabulary (server-token.js `SERVER_TOKEN_SERVICES`
 * = `web`/`api`): `api` = one LLM completion through the server's key (any agent
 * that calls a model), `web` = one web search through the server's key (an agent
 * with a web-search toggle). Kept here as plain strings so this pure module has
 * no server-token import; the endpoint feeds them to `mintServerTokenGrant`.
 */
export const AGENT_LINK_SERVICES = { llm: "api", search: "web" };

/**
 * The token-mint request an agent SHARE LINK produces: the upstream
 * permissions the agent needs (derived from its controls) plus the quota the
 * minted token is metered by (from resolveQuota). This is the bounded,
 * disclosed, revocable, fail-safe contract of the pair's server-token bridge —
 * the token authorises upstream API access ONLY, never the Se/rver tier's own
 * data, never a login. Pure: the caller signs/persists it (server-grants.js);
 * this only computes what a link for THIS agent should grant, straight from the
 * spec, so a shared agent runs on exactly the credits you defined and not more.
 * @param {any} a
 * @returns {{ agent: string, platform: string, perms: string[], quota: ReturnType<typeof resolveQuota> }}
 */
export function agentLinkPlan(a) {
  const controls = resolveControls(a);
  const perms = new Set();
  for (const c of controls) {
    if (c.type === "model-select" || c.type === "prompt-input") perms.add(AGENT_LINK_SERVICES.llm); // "api"
    if (c.type === "toggle" && (c.id === "web_search" || c.id === "search")) perms.add(AGENT_LINK_SERVICES.search); // "web"
  }
  return {
    agent: a?.id || "",
    platform: a?.platform || "client",
    perms: [...perms],
    quota: resolveQuota(a),
  };
}

/** A quota window as a token TTL in hours (the Se/rver token carries ONE duration). @param {string} window */
export function windowHours(window) {
  switch (window) {
    case "minute": return 1 / 60;
    case "hour": return 1;
    case "month": return 24 * 30;
    case "day":
    default: return 24;
  }
}

/**
 * The exact arguments a share-link mint passes to `mintServerTokenGrant`
 * (src/server-grants.js): the upstream `services`, a per-service `quotas` map
 * (the spec's credits — else its request count — as the unit allowance), the
 * `ttlHours` from the quota window, and a human `label`. This is the one seam
 * between the pure AgentSpec and the existing server-token subsystem, so the
 * endpoint stays a thin adapter and the JWT/metering stay entirely by the book.
 * @param {any} a
 * @returns {{ services: string[], quotas: Record<string, number>, ttlHours: number, label: string }}
 */
export function agentTokenGrantParams(a) {
  const plan = agentLinkPlan(a);
  const units = plan.quota.credits != null ? plan.quota.credits : plan.quota.requests;
  /** @type {Record<string, number>} */
  const quotas = {};
  for (const svc of plan.perms) quotas[svc] = units;
  return {
    services: plan.perms,
    quotas,
    ttlHours: windowHours(plan.quota.window),
    label: (a && a.name) ? String(a.name) : (a && a.id) || "agent",
  };
}

// ---- example questions -------------------------------------------------------

/**
 * The example questions to show for an agent: its seed `examples`, de-duplicated
 * and bounded. `generatable` is true when the agent opted into on-demand
 * generation (the Agent Studio can then ask the model for more, seeded by these
 * and the agent's purpose). Pure: generation itself is a model call at the call
 * site — this only resolves the seed + the flag.
 * @param {any} a
 * @param {number} [max]
 * @returns {{ seed: string[], generatable: boolean }}
 */
export function resolveExamples(a, max = 6) {
  const seen = new Set();
  const seed = [];
  for (const e of Array.isArray(a?.examples) ? a.examples : []) {
    const s = typeof e === "string" ? e.trim() : "";
    if (s && !seen.has(s)) { seen.add(s); seed.push(s); }
    if (seed.length >= max) break;
  }
  return { seed, generatable: a?.generateExamples !== false };
}

/**
 * The prompt used to GENERATE fresh example questions for an agent (the Agent
 * Builder feeds this to the answer model). Pure string assembly; the caller
 * runs the model and parses one-question-per-line.
 * @param {any} a
 * @param {number} [n]
 * @returns {string}
 */
export function exampleGenPrompt(a, n = 4) {
  const purpose = a?.tagline || a?.description || a?.name || "a research assistant";
  const seed = resolveExamples(a).seed;
  return [
    `Write ${n} short, natural example questions a user might ask "${a?.name || a?.id}" — ${purpose}.`,
    seed.length ? `Match the style of these existing examples:\n${seed.map((s) => `- ${s}`).join("\n")}` : "",
    "Return ONE question per line, no numbering, no preamble.",
  ].filter(Boolean).join("\n\n");
}

// ---- snapshot loading (mirrors sdk-core.manifestFromSnapshot) ----------------

/** The registry's repo path — resolved out of the committed source snapshot. */
export const AGENTS_PATH = "sdk/AGENTS.json";

/**
 * Parse sdk/AGENTS.json out of a source snapshot ({files:[{p,t}]}). Null (never
 * a throw) when missing or unparsable — so the Agent Studio degrades to "no
 * agent templates in this deployment" rather than erroring.
 * @param {{ files?: Array<{p: string, t: string}> } | null | undefined} snapshot
 * @returns {any | null}
 */
export function agentsFromSnapshot(snapshot) {
  try {
    const f = (snapshot?.files || []).find((x) => x.p === AGENTS_PATH);
    if (!f || typeof f.t !== "string") return null;
    const reg = JSON.parse(f.t);
    return reg && Array.isArray(reg.agents) ? reg : null;
  } catch {
    return null;
  }
}

/** @param {any} reg @param {string} id @returns {any | null} */
export function findAgent(reg, id) {
  return (reg?.agents || []).find((/** @type {any} */ a) => a && a.id === id) || null;
}

// ---- rendering (plain text — terminal / VM / tool-result friendly) -----------

/** @param {any} reg @returns {string} */
export function renderAgentList(reg) {
  const lines = ["Agents (sdk/AGENTS.json) — DistillSDK flavours of the Se/cure + Se/rver pair:", ""];
  for (const a of reg?.agents || []) {
    const ctrls = (a.controls || []).map((/** @type {any} */ c) => c.id || c.type).join(", ");
    lines.push(`  ${a.id}  (${a.platform})  ${a.name}`);
    lines.push(`      ${a.tagline || ""}`);
    lines.push(`      controls: ${ctrls}`);
  }
  return lines.join("\n").trimEnd();
}

// ---- the composer model + markup (the "an agent IS its composer" renderer) ---
//
// composerModel() is the single resolved description of an agent's chat-input
// pane: its ordered controls, theme, animations and examples. Both the browser
// preview (public/js/agent-preview.js, which adds interactivity) and the
// Node-run visual proof (scripts/agent-proof.mjs) build from it, so what the
// proof asserts is exactly what a user sees — the spec defines the composer.

/** @param {any} a @returns {{ id:string, name:string, tagline:string, platform:string, mode:string, controls:any[], theme:Record<string,string>, intro:any, loading:any, examples:{seed:string[],generatable:boolean}, quota:any }} */
export function composerModel(a) {
  return {
    id: a?.id || "",
    name: a?.name || a?.id || "",
    tagline: a?.tagline || "",
    platform: a?.platform || "client",
    mode: a?.mode || "normal",
    controls: resolveControls(a),
    theme: resolveTheme(a),
    intro: a?.intro || { kind: "none" },
    loading: a?.loading || { kind: "none" },
    examples: resolveExamples(a),
    quota: resolveQuota(a),
  };
}

/** Minimal HTML escape for text interpolated into the proof markup. @param {unknown} s */
function esc(s) {
  /** @type {Record<string,string>} */
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * The composer markup for ONE control, as an HTML string. Every element carries
 * `data-control` (the type) and, when it sets a request field, `data-drives`
 * (that field) — the attributes the visual proof and the browser wiring both
 * key off. Pure and XSS-safe.
 * @param {any} c a resolved control (from resolveControl)
 * @returns {string}
 */
export function controlMarkup(c) {
  const base = `data-control="${esc(c.type)}"${c.drives ? ` data-drives="${esc(c.drives)}"` : ""}`;
  switch (c.type) {
    case "prompt-input":
      return `<textarea class="ac-prompt" ${base} placeholder="${esc(c.placeholder)}" rows="2"></textarea>`;
    case "send-button":
      return `<button type="button" class="ac-send" ${base}>${esc(c.label)}</button>`;
    case "model-select":
      return `<label class="ac-ctl ac-model"><span>${esc(c.label)}</span><select ${base}><option>${esc(c.providers)} models…</option></select></label>`;
    case "depth-slider": {
      const ticks = (c.ticks || []).map((/** @type {any} */ t) => `<span>${esc(t)}</span>`).join("");
      return `<label class="ac-ctl ac-depth"><span>${esc(c.label)}</span><input type="range" ${base} min="${esc(c.min)}" max="${esc(c.max)}" value="${esc(c.default)}"><span class="ac-ticks">${ticks}</span></label>`;
    }
    case "toggle":
      return `<label class="ac-ctl ac-toggle"><input type="checkbox" ${base}${c.default ? " checked" : ""}><span>${esc(c.label)}</span></label>`;
    case "mode-select": {
      const opts = (c.modes || []).map((/** @type {any} */ m) => `<option>${esc(m)}</option>`).join("");
      return `<label class="ac-ctl ac-mode"><span>${esc(c.label)}</span><select ${base}>${opts}</select></label>`;
    }
    case "attachments":
      return `<button type="button" class="ac-ctl ac-attach" ${base} data-max="${esc(c.max)}">📎 ${esc(c.label)}</button>`;
    default:
      return `<span ${base}>${esc(c.label || c.type)}</span>`;
  }
}

/**
 * The full composer markup for an agent: a themed container whose child order IS
 * the spec's control order, with a toolbar (every non prompt/send control), the
 * prompt row, and an examples strip. Self-contained (inline theme vars); the
 * caller supplies surrounding CSS (public/agents/preview.html or the proof
 * gallery). Pure — no DOM, safe in Node.
 * @param {any} a
 * @returns {string}
 */
export function composerMarkup(a) {
  const m = composerModel(a);
  const styleVars = Object.entries(m.theme).map(([k, v]) => `${k}:${v}`).join(";");
  const toolbar = m.controls.filter((c) => c.type !== "prompt-input" && c.type !== "send-button").map(controlMarkup).join("\n      ");
  const prompt = m.controls.find((c) => c.type === "prompt-input");
  const send = m.controls.find((c) => c.type === "send-button");
  const examples = m.examples.seed.map((q) => `<button type="button" class="ac-example" data-example>${esc(q)}</button>`).join("\n      ");
  return `<div class="agent-composer" data-agent="${esc(m.id)}" data-platform="${esc(m.platform)}" data-mode="${esc(m.mode)}" data-intro="${esc(m.intro.kind || "none")}" data-loading="${esc(m.loading.kind || "none")}" style="${styleVars}">
  <div class="ac-head"><strong class="ac-name">${esc(m.name)}</strong><span class="ac-tag">${esc(m.tagline)}</span></div>
  ${examples ? `<div class="ac-examples">\n      ${examples}\n  </div>` : ""}
  <div class="ac-toolbar">\n      ${toolbar}\n  </div>
  <div class="ac-promptrow">
      ${prompt ? controlMarkup(prompt) : ""}
      ${send ? controlMarkup(send) : ""}
  </div>
</div>`;
}

/**
 * The visual-proof check for one agent: assert every DECLARED control renders
 * into the composer markup (its data-control present) — the spec-defines-the-
 * composer contract, machine-checked. Returns {ok, missing[], html}.
 * @param {any} a
 * @returns {{ ok: boolean, id: string, missing: string[], html: string }}
 */
export function proveComposer(a) {
  const html = composerMarkup(a);
  const missing = [];
  for (const c of resolveControls(a)) {
    // Each control must appear with its type; controls that drive a field must
    // also expose that field via data-drives.
    const typeOk = html.includes(`data-control="${c.type}"`);
    const drivesOk = !c.drives || html.includes(`data-drives="${c.drives}"`);
    if (!typeOk || !drivesOk) missing.push(c.id || c.type);
  }
  return { ok: missing.length === 0, id: a?.id || "", missing, html };
}

/** @param {any} reg @param {string} id @returns {string} */
export function renderAgentShow(reg, id) {
  const a = findAgent(reg, id);
  if (!a) return `unknown agent: ${id}`;
  const q = resolveQuota(a);
  const theme = resolveTheme(a);
  const ex = resolveExamples(a);
  const lines = [
    `${a.id} — ${a.name}  (${a.platform}-tier)`,
    a.tagline ? `  ${a.tagline}` : "",
    `  derives-from: ${a.derivesFrom || "(baseplate)"}`,
    `  mode: ${a.mode || "normal"}`,
    "  controls:",
    ...resolveControls(a).map((c) => `    - ${c.id} (${c.type})${c.drives ? ` → drives \`${c.drives}\`` : ""}`),
    `  intro: ${a.intro?.kind || "(none)"}   loading: ${a.loading?.kind || "(none)"}`,
    `  theme: ${Object.entries(theme).map(([k, v]) => `${k}=${v}`).join("  ")}`,
    `  quota (share link): ${q.requests} req / ${q.window}${q.credits != null ? `, ${q.credits} credits` : ""}`,
    ex.seed.length ? `  examples:\n${ex.seed.map((s) => `    · ${s}`).join("\n")}` : "  examples: (generatable)",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

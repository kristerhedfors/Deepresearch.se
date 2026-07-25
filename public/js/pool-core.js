// @ts-check
// SHARED COMPUTE's pure core — the strict wire profile (DRSC/1) and the
// data-flow disclosure for pooled LLM completions (docs/COMPUTE-SHARING.md).
//
// DRSC/1 is a deliberately NARROW profile of the OpenAI chat-completions wire:
// a pool job may carry model + messages + two tuning params and NOTHING else.
// Tight interface, limited flexibility — a pool relays a peer's prompt to
// another user's machine, so the broker forwards a fixed, whitelisted shape
// rather than an arbitrary passthrough body. Unknown fields are STRIPPED (not
// errored) so ordinary OpenAI-compatible clients drive the surface unchanged;
// out-of-range values clamp; anything structurally wrong is rejected with a
// stable error code. `stream` is forced false by construction (v1 relays whole
// completions; design §11).
//
// The module is a PURE CORE under public/ (the bash-core.js convention): the
// Se/cure client pre-validates with the same function the Worker enforces
// with (src/pool.js imports it directly), so client and server can never
// drift. WebCrypto-free, dependency-free, Node-testable.

/** The wire-profile name, embedded in sanitized requests for auditability. */
export const POOL_WIRE_V = "DRSC/1";

// ── MUTUAL CONSENT: the ingress / egress approval vocabulary ────────────────
// A pooled completion crosses a trust boundary TWICE, and each crossing is a
// separate person's decision (owner directive, 2026-07-25):
//
//   INGRESS — someone else's prompts arriving at MY machine. The SHARER
//             answers "do I let this identity compute on my model?"
//   EGRESS  — MY prompts leaving for someone else's machine. The CONSUMER
//             answers "do I let this identity read what I send?"
//
// Neither side is implied by the other and neither is implied by holding a
// token: a token is capacity, consent is people. Both questions name a
// PLATFORM-VERIFIED identity (a signed-in account, or a labelled run-as test
// persona — never a self-asserted string), and both answers are REMEMBERED,
// so the question is asked once per identity pair and never again.

/** The three states an approval can be in, on either side. */
export const POOL_APPROVAL_STATES = ["pending", "allowed", "blocked"];

/**
 * Normalize a stored state. Rows written before mutual consent shipped carry
 * the old `active` value and mean "allowed" — mapping them here (rather than
 * migrating) keeps an existing consumer working across the deploy.
 * @param {string | null | undefined} state
 * @returns {"pending"|"allowed"|"blocked"}
 */
export function normalizeApproval(state) {
  const s = String(state || "").toLowerCase();
  if (s === "active" || s === "allowed") return "allowed";
  if (s === "blocked" || s === "denied") return "blocked";
  return "pending";
}

/**
 * The consumer key an identity/token pair is metered and remembered under.
 * A SIGNED-IN consumer is keyed by account (`u:<id>`) so the decision follows
 * the person across token re-mints and workspace links; an anonymous one is
 * keyed by the token itself (`t:<jti>`) and can only ever be as accountable
 * as that token.
 * @param {{ identityId?: string | null, jti: string }} opts
 * @returns {string}
 */
export function poolConsumerKey(opts) {
  return opts.identityId ? "u:" + String(opts.identityId) : "t:" + String(opts.jti);
}

/**
 * How a party is shown in the other party's approval question. `verified`
 * means the PLATFORM resolved this identity from a session — not that the
 * human is who they claim offline.
 * @param {{ display?: string | null, verified?: boolean, synthetic?: boolean, key?: string | null }} party
 * @returns {string}
 */
export function poolIdentityLabel(party) {
  const base = (party && party.display) || (party && party.key) || "an unidentified visitor";
  if (party && party.synthetic) return base + " (test persona)";
  if (party && party.verified) return base;
  return base + " (unverified — token holder only)";
}

/**
 * The SHARER's question: someone wants to compute on my machine.
 * @param {{ display?: string | null, verified?: boolean, synthetic?: boolean, key?: string | null }} consumer
 * @returns {{ title: string, detail: string[] }}
 */
export function poolIngressQuestion(consumer) {
  const who = poolIdentityLabel(consumer);
  return {
    title: `Let ${who} run prompts on your shared model?`,
    detail: [
      `${who} holds a token for your pool and is asking to send completions to your machine.`,
      "Everything they send will be computed by your local model. Their prompts pass through your machine; you can read them, and they know that.",
      "Your answer is remembered — you will not be asked about this identity again. You can change it later in Settings → LLM sharing.",
    ],
  };
}

/**
 * The CONSUMER's question: my prompts want to leave for someone's machine.
 * @param {{ display?: string | null, verified?: boolean, synthetic?: boolean, key?: string | null }} owner
 * @returns {{ title: string, detail: string[] }}
 */
export function poolEgressQuestion(owner) {
  const who = poolIdentityLabel(owner);
  return {
    title: `Send your prompts to ${who}'s machine?`,
    detail: [
      `Answers would be computed by ${who}'s local model, reached through this site's broker.`,
      `${who} can read everything you send through their model. Only use it for content they may see.`,
      "Your answer is remembered — you will not be asked about this pool again. You can change it later in Settings → LLM sharing.",
    ],
  };
}

/** The ONLY roles a pooled message may carry. */
export const POOL_ROLES = ["system", "user", "assistant"];

/** Caps: a pool must not be an amplifier and a job row is transient. */
export const POOL_MAX_MESSAGES = 64;
export const POOL_MAX_CONTENT_CHARS = 32_000; // per message
export const POOL_MAX_TOTAL_CHARS = 160_000; // whole conversation
export const POOL_MAX_MODEL_CHARS = 120;
export const POOL_MAX_COMPLETION_TOKENS = 8192;

/**
 * Sanitize a consumer's chat-completions body into the DRSC/1 shape.
 * Returns `{ request }` (a NEW object — never the input) or `{ error, code }`.
 * Whitelisted fields: `model` (string, required), `messages` (role/content
 * pairs, required), `temperature` (0..2, optional), `max_tokens` (positive
 * int, optional). Everything else — tools, functions, response_format,
 * logit_bias, n, user, metadata, arbitrary vendor params — is dropped.
 * @param {any} body
 * @returns {{ request: { wire: string, model: string, messages: {role: string, content: string}[], temperature?: number, max_tokens?: number, stream: false } } | { error: string, code: string }}
 */
export function sanitizePoolRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "A chat-completions object body is required.", code: "bad_body" };
  }
  const model = typeof body.model === "string" ? body.model.trim().slice(0, POOL_MAX_MODEL_CHARS) : "";
  if (!model) return { error: "model is required.", code: "bad_model" };
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return { error: "messages must be a non-empty array.", code: "bad_messages" };
  }
  if (body.messages.length > POOL_MAX_MESSAGES) {
    return { error: `messages is capped at ${POOL_MAX_MESSAGES}.`, code: "too_many_messages" };
  }
  /** @type {{role: string, content: string}[]} */
  const messages = [];
  let total = 0;
  for (const m of body.messages) {
    if (!m || typeof m !== "object") return { error: "Every message must be an object.", code: "bad_message" };
    const role = typeof m.role === "string" ? m.role : "";
    if (!POOL_ROLES.includes(role)) {
      return { error: `Message roles are limited to ${POOL_ROLES.join("/")}.`, code: "bad_role" };
    }
    // Content must be a plain string — no multimodal parts across the relay.
    if (typeof m.content !== "string") {
      return { error: "Message content must be a string.", code: "bad_content" };
    }
    const content = m.content.slice(0, POOL_MAX_CONTENT_CHARS);
    total += content.length;
    if (total > POOL_MAX_TOTAL_CHARS) {
      return { error: "The conversation is too large for a pooled job.", code: "too_large" };
    }
    messages.push({ role, content });
  }
  /** @type {{ wire: string, model: string, messages: {role: string, content: string}[], temperature?: number, max_tokens?: number, stream: false }} */
  const request = { wire: POOL_WIRE_V, model, messages, stream: false };
  if (body.temperature !== undefined && Number.isFinite(Number(body.temperature))) {
    request.temperature = Math.min(2, Math.max(0, Number(body.temperature)));
  }
  const mt = body.max_tokens !== undefined ? body.max_tokens : body.max_completion_tokens;
  if (mt !== undefined && Number.isFinite(Number(mt)) && Number(mt) > 0) {
    request.max_tokens = Math.min(POOL_MAX_COMPLETION_TOKENS, Math.floor(Number(mt)));
  }
  return { request };
}

/**
 * The OpenAI-wire body a PROVIDER actually sends to its local model — the
 * sanitized request minus our `wire` marker. Kept as a function so the
 * provider loop and tests agree on exactly what leaves the browser.
 * @param {{ wire?: string, [k: string]: any }} request a sanitizePoolRequest result
 * @returns {any}
 */
export function poolRequestToOpenAiBody(request) {
  const { wire, ...body } = request || {};
  return body;
}

/**
 * The data-flow disclosure shown to EVERY workspace participant when shared
 * compute is present (and on the sharer's own toggle). One source of truth so
 * the Se/cure pane, the share composer, and the Se/rver dashboard say the
 * same thing. Returns plain-text lines; callers render them.
 * @param {{ ownerLabel?: string | null }} [opts]
 * @returns {string[]}
 */
export function poolDataFlowNotice(opts = {}) {
  const who = opts.ownerLabel ? `${opts.ownerLabel}` : "the pool owner";
  return [
    `Shared compute is active in this workspace. Prompts you send to a shared model travel: your browser → deepresearch.se (held only while the job runs, never stored or logged) → ${who}'s machine, which computes the answer on their local model and returns it the same way.`,
    `${who} can read everything you send through the shared model. Use it only for content every participant may see.`,
    `Requests are limited to the strict DRSC/1 shape (model, messages, two tuning knobs) — nothing else about your session travels.`,
    `Curated conclusions you choose to pass along are sealed to the site's import-agent key before they leave your browser and rest as ciphertext until the workspace owner imports them in their Se/rver panel (or you can download the sealed blob and deliver it yourself).`,
  ];
}

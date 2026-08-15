// @ts-check
// THE MODERN (STATELESS) MCP REVISION — protocol 2026-07-28, served beside the
// handshake revision this server has spoken since it was built.
//
// WHAT CHANGED, AND WHY IT NEEDED ITS OWN MODULE. Revision 2026-07-28 is the
// largest rewrite of MCP since launch: the `initialize` handshake is gone, and
// with it the protocol-level session. Every request now carries its own
// protocol version, client identity and client capabilities in `_meta`, mirrors
// three of those values into HTTP headers so an intermediary can route without
// parsing the body, and every result declares a `resultType` plus — for the
// listing methods — how long it may be cached. The spec's own words:
//
//   "There is no negotiation handshake. Every request carries its protocol
//    version, and the server accepts or rejects each request independently."
//   "Servers MUST NOT rely on prior requests over the same connection to
//    establish context (e.g., capabilities, protocol version, client identity)."
//
// This module is the whole of that revision's LOGIC, and it is PURE: it imports
// nothing, touches no binding, and every function is a total function of its
// arguments. src/mcp.js keeps its file-layout rule (pure protocol at the top,
// pipeline behind a dynamic import) by importing this module statically, and
// src/mcp-modern.test.js drives every rule below without a Worker.
//
// ---- DUAL-ERA, DELIBERATELY -------------------------------------------------
//
// The spec names three kinds of implementation — MODERN (per-request metadata,
// 2026-07-28 and later), LEGACY (an `initialize` handshake, 2025-11-25 and
// earlier) and DUAL-ERA (both) — and says a dual-era server "selects its
// behavior from how the client opens": a request carrying modern `_meta` is
// served statelessly, an `initialize` request selects legacy semantics. We are
// dual-era, and must stay that way for a long while: every client that can
// reach this server today — Claude, Claude Code, ChatGPT's connector — opened
// with `initialize` at the time of writing, and the spec's own feature-lifecycle
// policy keeps a deprecated feature alive for at least twelve months. Deleting
// the handshake would take the surface offline for everything that currently
// uses it, which is the opposite of implementing the new revision.
//
// So era selection is a per-REQUEST decision (isModernRequest below), never a
// per-connection one — there are no connections to remember any more.
//
// ---- THE ONE RULE THAT IS EASY TO GET BACKWARDS -----------------------------
//
// Three different failures look alike and have three different codes, and a
// client BRANCHES on them (a modern error identifies a modern server; anything
// else makes the client fall back to `initialize`). Getting one wrong makes a
// conforming client mis-detect the whole server:
//
//   a required `_meta` field is missing        → -32602  Invalid params   (400)
//   the version is one we do not implement     → -32022  UnsupportedProtocolVersion (400)
//   a mirrored header is missing or disagrees  → -32020  HeaderMismatch   (400)
//   the method is one we do not implement      → -32601  Method not found (404, not 400)
//
// The 404 is deliberate and is not an oversight: "The JSON-RPC error body
// distinguishes this case from a `404` returned by a legacy HTTP+SSE server
// that does not host the modern MCP endpoint."

/**
 * The revision this module implements — the CURRENT protocol version as of
 * August 2026 (modelcontextprotocol.io/specification/versioning).
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * The handshake revision `initialize` still reports. Unchanged from what this
 * server has always answered, because a legacy client negotiates once and then
 * believes the answer for the rest of the session.
 */
export const LEGACY_PROTOCOL_VERSION = "2025-06-18";

/**
 * Every version we will serve, newest first — the list an
 * UnsupportedProtocolVersionError hands back and `server/discover` advertises.
 *
 * `2025-11-25` is deliberately ABSENT. We implement its SEP-973 serverInfo
 * icons, but not the rest of it, and advertising a revision we have not built
 * is how a client ends up sending requests we cannot answer. A client asking
 * for it gets -32022 naming these two, which is exactly the mechanism the
 * revision provides for saying "not that one, one of these".
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];

// ---- the reserved `_meta` keys (io.modelcontextprotocol/*) ------------------
// Required on every modern request: the protocol version and the client's
// capabilities. `clientInfo` is SHOULD, not MUST — and is explicitly untrusted
// ("self-reported by the sender and not verified by the protocol"), so nothing
// here may branch on it.
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** The one field a server SHOULD put in every result's `_meta`. */
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

// ---- the MCP-reserved error codes (-32020…-32099) ---------------------------
// "Implementations MUST NOT emit any code from this sub-range that is not
// defined by this specification and MUST use defined codes only with their
// specified meanings." Our older codes (-32700/-32600/-32601/-32602/-32603) are
// all standard JSON-RPC and are unaffected.
export const RPC_HEADER_MISMATCH = -32020;
export const RPC_MISSING_CLIENT_CAPABILITY = -32021;
export const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The mandatory discovery RPC — the modern replacement for `initialize`. */
export const DISCOVER_METHOD = "server/discover";

// ---- the mirrored HTTP headers ----------------------------------------------
export const HEADER_PROTOCOL_VERSION = "mcp-protocol-version";
export const HEADER_METHOD = "mcp-method";
export const HEADER_NAME = "mcp-name";

/**
 * The methods whose `Mcp-Name` header is REQUIRED, and which body field it
 * mirrors. We serve only `tools/call`; the other two are listed because the
 * table is the spec's, and a future primitive should not have to rediscover it.
 */
export const NAME_HEADER_SOURCE = {
  "tools/call": "name",
  "resources/read": "uri",
  "prompts/get": "name",
};

// ---- caching hints -----------------------------------------------------------
//
// `ttlMs` and `cacheScope` are REQUIRED members of every cacheable result
// (`server/discover`, `tools/list`, …), not optional hints — a listing that
// omits them is schema-invalid. `tools/call` is NOT cacheable and carries
// neither.
//
// The SCOPE is the interesting decision here, and it is not the same for the
// two results we serve:
//
//   tools/list  → "private". It is filtered by the ACCOUNT's exposure config
//                 (src/mcp-config.js), so two callers with different keys can
//                 legitimately see different tool sets. "public" would invite a
//                 shared cache to hand one account's listing to another's — the
//                 exact confusion the scope exists to prevent.
//   discover    → "public". It carries supported versions and the fact that we
//                 have tools at all: identical for every caller, with nothing
//                 account-derived in it.
//
// Neither is an access control. The spec is blunt about that ("MUST NOT rely on
// `cacheScope` alone to prevent unauthorized access"), and here the real control
// is the exposure config enforced on every call.
export const TOOLS_LIST_TTL_MS = 300_000;
export const DISCOVER_TTL_MS = 3_600_000;

/** The Base64 sentinel a client wraps a header value in when it is not plain
 * ASCII: `=?base64?{value}?=`, markers lowercase and exact. */
const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/**
 * Decode a mirrored header value, unwrapping the Base64 sentinel when present.
 * Servers "MUST decode an encoded `Mcp-Name` … value before comparing it to the
 * corresponding request body value", so a tool whose name needed encoding (or a
 * plain-ASCII name that merely LOOKS like the sentinel, which clients must also
 * encode) still compares equal.
 *
 * Undecodable input returns the raw string rather than throwing: the comparison
 * that follows will fail and produce the HeaderMismatch the caller deserves,
 * which is a better answer than a 500.
 * @param {string} raw
 * @returns {string}
 */
export function decodeHeaderValue(raw) {
  const value = typeof raw === "string" ? raw : "";
  if (!value.startsWith(SENTINEL_PREFIX) || !value.endsWith(SENTINEL_SUFFIX)) return value;
  const encoded = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length);
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Read a header case-insensitively from anything header-shaped: a Headers
 * object, or a plain object (which is what a unit test hands us).
 * @param {any} headers
 * @param {string} name lowercase header name
 * @returns {string | null}
 */
export function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const v = headers.get(name);
    return typeof v === "string" ? v : null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * The protocol version a request declares in its `_meta`, or null.
 * @param {any} params
 * @returns {string | null}
 */
export function requestProtocolVersion(params) {
  const v = params?._meta?.[META_PROTOCOL_VERSION];
  return typeof v === "string" && v ? v : null;
}

/**
 * Does this request belong to the MODERN era?
 *
 * Three signals, any of which is decisive, and one exception that outranks all
 * of them:
 *
 *   * `server/discover` exists only in the modern revision;
 *   * `_meta` declaring a protocol version is the modern envelope itself;
 *   * an `MCP-Protocol-Version` header naming the modern revision — the case
 *     where a client mirrors the header but the body is malformed, which must
 *     still be answered as a modern error rather than silently served as legacy.
 *
 * The exception: `initialize` is ALWAYS legacy. The spec's dual-era rule is that
 * "an `initialize` request selects legacy semantics", and a client that sends
 * one has already told us which era it lives in — answering it with a modern
 * error would leave it with no way forward, since legacy clients have no
 * fall-forward mechanism.
 *
 * @param {{ method: string, params?: any }} parsed
 * @param {any} [headers]
 * @returns {boolean}
 */
export function isModernRequest(parsed, headers) {
  if (!parsed || parsed.method === "initialize") return false;
  if (parsed.method === DISCOVER_METHOD) return true;
  if (requestProtocolVersion(parsed.params)) return true;
  return headerValue(headers, HEADER_PROTOCOL_VERSION) === MODERN_PROTOCOL_VERSION;
}

/**
 * A protocol error, ready for src/mcp.js to wrap in a JSON-RPC envelope at the
 * HTTP status the spec assigns it.
 * @typedef {{ code: number, message: string, data?: any, status: number }} ProtocolError
 */

/**
 * Validate one MODERN request: its `_meta`, its version, and the three mirrored
 * headers. Returns null when the request may proceed.
 *
 * ORDER MATTERS and is the spec's: metadata first (a request missing required
 * fields is malformed before anything else can be judged), then the version (a
 * version we do not implement makes every later rule moot), then the headers.
 * A client reading the FIRST error it gets should be told the most fundamental
 * thing that is wrong.
 *
 * Notifications are exempt from the header rules: "header requirements for
 * notification POSTs are not defined by this revision", and inventing a
 * requirement the spec declines to state would refuse conforming clients.
 *
 * @param {{ method: string, params?: any, isNotification?: boolean }} parsed
 * @param {any} headers the request's Headers (or a plain object, in tests)
 * @returns {ProtocolError | null}
 */
export function validateModernRequest(parsed, headers) {
  const params = parsed?.params || {};
  const meta = params._meta && typeof params._meta === "object" ? params._meta : null;

  // 1. The two REQUIRED per-request fields. "A request missing any required
  //    field is malformed; the server MUST reject it with JSON-RPC error code
  //    -32602 (Invalid params). On HTTP, the response status MUST be 400."
  //    Note this is NOT -32022: that code is only for a version we do not have.
  const version = requestProtocolVersion(params);
  if (!version) {
    return {
      code: -32602,
      message:
        `Invalid params: this request declares no protocol version. Every request must carry ` +
        `"${META_PROTOCOL_VERSION}" in params._meta (protocol ${MODERN_PROTOCOL_VERSION}).`,
      status: 400,
    };
  }
  // 2. A version we do not implement, checked BEFORE the remaining fields — and
  //    the order is load-bearing. A client speaking an OLDER modern revision may
  //    legitimately not carry a field this one requires; answering it "invalid
  //    params" tells it to fix a request it cannot fix, while -32022 hands it the
  //    list of versions it can retry with. The most fundamental thing wrong wins.
  //    The data shape is fixed by the schema (`data: { supported, requested }`,
  //    both required).
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return {
      code: RPC_UNSUPPORTED_PROTOCOL_VERSION,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version },
      status: 400,
    };
  }

  // A NOTIFICATION stops here. The spec declines to define header requirements
  // for a notification POST, and its `_meta` table describes client REQUESTS —
  // so refusing one for a field the notification schema never demanded would
  // reject conforming clients over an obligation nobody wrote down. It gets its
  // 202 like any other.
  if (parsed?.isNotification) return null;

  // `clientCapabilities` is required even though `clientInfo` is not: a
  // stateless server has no earlier request to learn the client's capabilities
  // from, so an absent field is genuinely unknown rather than merely unstated.
  // An EMPTY object is a valid answer ("supports no optional capabilities") and
  // must be accepted — only its absence is the error.
  const caps = meta ? meta[META_CLIENT_CAPABILITIES] : undefined;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    return {
      code: -32602,
      message:
        `Invalid params: this request declares no client capabilities. Every request must carry ` +
        `"${META_CLIENT_CAPABILITIES}" in params._meta — an empty object {} is valid and means ` +
        `"no optional capabilities".`,
      status: 400,
    };
  }

  // 3. The mirrored headers. Each is REQUIRED for compliance, and a mismatch is
  //    a security matter rather than a formality: an intermediary may route on
  //    the header while we execute on the body, so the two disagreeing is
  //    exactly the confusion that must not be served.
  const headerVersion = headerValue(headers, HEADER_PROTOCOL_VERSION);
  if (!headerVersion) {
    return {
      code: RPC_HEADER_MISMATCH,
      message: `Header mismatch: the required MCP-Protocol-Version header is missing (expected "${version}").`,
      status: 400,
    };
  }
  if (headerVersion !== version) {
    return {
      code: RPC_HEADER_MISMATCH,
      message:
        `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match ` +
        `body value '${version}'.`,
      status: 400,
    };
  }

  const headerMethod = headerValue(headers, HEADER_METHOD);
  if (!headerMethod) {
    return {
      code: RPC_HEADER_MISMATCH,
      message: `Header mismatch: the required Mcp-Method header is missing (expected "${parsed.method}").`,
      status: 400,
    };
  }
  if (headerMethod !== parsed.method) {
    return {
      code: RPC_HEADER_MISMATCH,
      message: `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${parsed.method}'.`,
      status: 400,
    };
  }

  const nameField = /** @type {Record<string, string>} */ (NAME_HEADER_SOURCE)[parsed.method];
  if (nameField) {
    const bodyName = typeof params[nameField] === "string" ? params[nameField] : "";
    const rawHeaderName = headerValue(headers, HEADER_NAME);
    if (rawHeaderName === null) {
      return {
        code: RPC_HEADER_MISMATCH,
        message: `Header mismatch: the required Mcp-Name header is missing (expected "${bodyName}").`,
        status: 400,
      };
    }
    const headerName = decodeHeaderValue(rawHeaderName);
    if (headerName !== bodyName) {
      return {
        code: RPC_HEADER_MISMATCH,
        message: `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${bodyName}'.`,
        status: 400,
      };
    }
  }

  return null;
}

/**
 * Stamp a result with the fields every 2026-07-28 result carries.
 *
 * Applied to EVERY result, on both eras, and that is safe in the direction that
 * matters: `resultType` and `_meta` are additive fields a legacy client ignores
 * (its own rule is that an absent `resultType` means "complete", so a present
 * one can only agree with it), while omitting them from a modern result is a
 * schema violation. One shape is also one thing to test.
 *
 * @param {any} result the method's own result object
 * @param {any} serverInfo the Implementation to report in `_meta`
 * @param {{ ttlMs?: number, cacheScope?: "public"|"private" }} [cache] the
 *   caching hints, REQUIRED for the listing methods and absent for tools/call
 * @returns {any}
 */
export function completeResult(result, serverInfo, cache) {
  /** @type {any} */
  const out = { resultType: "complete", ...result };
  if (cache && typeof cache.ttlMs === "number") {
    // "Servers MUST provide a ttlMs value that is >= 0" — a negative one is
    // clamped rather than sent, since a client would treat it as 0 anyway.
    out.ttlMs = Math.max(0, Math.round(cache.ttlMs));
    out.cacheScope = cache.cacheScope === "public" ? "public" : "private";
  }
  const meta = { ...(result?._meta || {}), [META_SERVER_INFO]: serverInfo };
  out._meta = meta;
  return out;
}

/**
 * The `server/discover` result — the mandatory RPC that replaced `initialize`.
 * A client MAY call it up front to learn what we speak; it is never required to,
 * and nothing here is remembered between requests.
 *
 * @param {any} serverInfo
 * @param {any} capabilities the same capability object `initialize` reports
 * @param {string} [instructions]
 * @returns {any}
 */
export function discoverResult(serverInfo, capabilities, instructions) {
  /** @type {any} */
  const result = { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS], capabilities };
  if (instructions) result.instructions = instructions;
  return completeResult(result, serverInfo, { ttlMs: DISCOVER_TTL_MS, cacheScope: "public" });
}

/**
 * Is this a cross-site browser request?
 *
 * The transport's first security rule is that a server "MUST validate the
 * `Origin` header on all incoming connections to prevent DNS rebinding attacks"
 * and answer 403 when it is present and invalid. The rule earns its keep here
 * for a reason specific to this server rather than for rebinding: `/mcp` is
 * reachable BOTH with a bearer credential (an external agent, which sends no
 * Origin) and with the site's own session cookie (src/index.js routes it below
 * the identity gate). A cookie-authenticated POST from someone else's page is
 * cross-site request forgery against a research budget, and the Origin header is
 * what distinguishes it.
 *
 * So the check is narrow on purpose: a request carrying its own Authorization
 * header is never refused on Origin grounds — it cannot be forged by a page that
 * does not hold the key — and a same-site Origin is always allowed. What is left
 * is exactly the dangerous case.
 *
 * @param {string | null} origin the request's Origin header
 * @param {string} host the request's own hostname
 * @param {boolean} bearer whether the request carries its own Authorization
 * @returns {boolean} true when the request must be refused with 403
 */
export function forbiddenOrigin(origin, host, bearer) {
  if (bearer) return false;
  if (typeof origin !== "string" || !origin) return false;
  let originHost = "";
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    // An unparseable Origin (including the literal "null" a sandboxed frame
    // sends) is not one we can call same-site.
    return true;
  }
  const site = String(host || "").toLowerCase();
  if (!site) return true;
  // Same host, or one label either side of it — `mcp.deepresearch.se` and the
  // apex are the same deployment and the Settings screen links between them.
  //
  // Deliberately NOT "the last two labels are the registrable domain": on a
  // preview or a fork the request host can be `<branch>.<account>.workers.dev`,
  // where that rule makes every page on `workers.dev` same-site — which is a
  // widening nobody would notice until it mattered. Walking the ACTUAL host up
  // and down cannot do that, because it is anchored to the host we are serving.
  if (originHost === site) return false;
  const parent = site.split(".").slice(1).join(".");
  if (parent && parent.includes(".") && originHost === parent) return false;
  return !originHost.endsWith(`.${site}`);
}

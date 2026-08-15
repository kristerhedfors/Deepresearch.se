#!/usr/bin/env node
// @ts-check
// LIVE integration battery for the MCP server (src/mcp.js) — rung 2 of the
// mcp-server skill's validation ladder, which until now was a paragraph of
// curl commands to be typed by hand.
//
// It speaks the real transport (JSON-RPC 2.0 over a single POST) against a
// deployed site and checks what unit tests structurally cannot: that the route
// is reachable, that the identity gate refuses correctly, that the Vectorize
// bindings are actually bound and filled, and that the literature family's
// claims hold on the real corpora rather than against a fake index.
//
// ---- the two ways in, and what each one actually proves ---------------------
//
//   --basic   BASIC_AUTH_USER / BASIC_AUTH_PASS, the break-glass credentials
//             the rest of scripts/ already uses. ZERO SETUP, and it exercises
//             the whole tool battery. What it does NOT exercise: the
//             above-the-gate path (src/mcp-api.js resolveMcpKeyIdentity) that
//             an external client takes, because break-glass satisfies
//             identify() instead. It is also quota-exempt (isSecretAdmin), so
//             it cannot prove the quota gate fires.
//
//   --key     MCP_KEY, an account-minted `mck1.` bearer. This is what Claude
//             Code and Cursor actually carry, and the ONLY way to cover key
//             resolution, the per-account exposure config, and the quota gate.
//             Mint it once at Settings → MCP server; break-glass CANNOT mint
//             one (src/mcp-api.js requireAccount rejects an identity with no
//             D1 row, which break-glass is by construction).
//
// Supply either, or both — with both, the battery runs twice and the report
// says which credential covered what. Supplying neither still runs the checks
// that need no credential, which includes the one worth having on its own: an
// unauthenticated call must come back as a JSON-RPC 401, never the sign-in
// HTML, or every MCP client reports a transport failure and its user hunts the
// wrong problem.
//
// Usage:
//   BASIC_AUTH_USER=… BASIC_AUTH_PASS=… npm run mcp:probe
//   MCP_KEY=mck1.… npm run mcp:probe
//   npm run mcp:probe -- --url https://deepresearch.se/mcp
//   npm run mcp:probe -- --deep          also run deep_research (spends real money, ~30 s)
//   npm run mcp:probe -- --only corpora,search-batch
//   npm run mcp:probe -- --json          machine-readable report
//
// Default target is https://mcp.deepresearch.se — the dedicated host's BARE
// ORIGIN, which is the URL an external client is pointed at (the `/mcp` tail
// answers there too, and is what a non-dedicated origin needs). Exit code is the number of failed
// checks (0 = clean), so it drops into a shell gate unchanged.

const DEFAULT_URL = "https://mcp.deepresearch.se";
/** The protocol revision `initialize` reports — the HANDSHAKE era, which this
 * server still speaks for every client that has not moved. Bumping it in
 * src/mcp.js should fail here. */
export const EXPECTED_PROTOCOL = "2025-06-18";
/** The stateless revision served beside it (src/mcp-modern.js), which is what a
 * `server/discover` must advertise. */
export const MODERN_PROTOCOL = "2026-07-28";
/** Every tool the server serves, in the order src/mcp.js's ALL_MCP_TOOLS fixes. */
export const EXPECTED_TOOLS = [
  "deep_research",
  "literature_search",
  "literature_fetch",
  "literature_similar",
  "literature_corpora",
  // The two OpenAI adapter tools, named exactly what ChatGPT demands. They sit
  // beside the literature four because that is what they project — and they
  // are the reason a ChatGPT connector can be added at all: without developer
  // mode, a server missing either name is refused outright.
  "search",
  "fetch",
  // The EXTENSION families, last in the list because they are last in the
  // registry. An account with their knobs off still SEES them here — the
  // exposure switch and the extension knob are different gates, and only the
  // first one filters the listing.
  "street_view_look",
  "place_nearby",
  "host_intel",
];

// Six angles on one topic — the shape literature_search exists for. Chosen to
// be answerable from BOTH corpora (arXiv's methods side, PubMed's clinical
// side) so a batch run exercises both legs rather than half of them.
export const BATCH_QUERIES = [
  "how do transformer language models handle long context windows",
  "retrieval augmented generation for biomedical question answering",
  "cross-encoder reranking versus dense retrieval quality",
  "machine learning models applied to clinical trial outcome prediction",
  "embedding models for multilingual scientific text",
  "evaluation methods for medical question answering systems",
];

// ---------------------------------------------------------------------------
// PURE helpers — argument parsing, envelope building, and one predicate per
// check. Split out so scripts/mcp-probe.test.mjs can pin what each check
// actually asserts without a network: a probe whose assertions are only
// exercised live is a probe nobody can trust when it goes red.
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv the raw process.argv.slice(2)
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, key: string, basic: string, deep: boolean, json: boolean, only: string[] }}
 */
export function parseProbeArgs(argv, env = {}) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : null;
  };
  const user = env.BASIC_AUTH_USER || env.ADMIN_USER || "";
  const pass = env.BASIC_AUTH_PASS || env.ADMIN_PASS || "";
  return {
    url: flag("--url") || env.MCP_URL || DEFAULT_URL,
    key: flag("--key") || env.MCP_KEY || "",
    basic: user && pass ? `${user}:${pass}` : "",
    deep: argv.includes("--deep"),
    json: argv.includes("--json"),
    only: (flag("--only") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * The Authorization header for one credential, or "" for the anonymous pass.
 * @param {{ kind: "key"|"basic"|"none", value?: string }} cred
 */
export function authHeader(cred) {
  if (cred.kind === "key" && cred.value) return `Bearer ${cred.value}`;
  if (cred.kind === "basic" && cred.value) return `Basic ${Buffer.from(cred.value).toString("base64")}`;
  return "";
}

/**
 * @param {number} id
 * @param {string} method
 * @param {any} [params]
 */
export function rpc(id, method, params) {
  const body = { jsonrpc: "2.0", id, method };
  if (params !== undefined) /** @type {any} */ (body).params = params;
  return body;
}

/** A tools/call envelope. */
export function toolCall(id, name, args) {
  return rpc(id, "tools/call", { name, arguments: args });
}

/**
 * A MODERN-era request body: the same envelope carrying the two `_meta` fields
 * every 2026-07-28 request must declare. `clientCapabilities` is an empty object
 * on purpose — that is the valid way to say "no optional capabilities", and a
 * server that refuses it has confused absent with empty.
 * @param {number} id
 * @param {string} method
 * @param {any} [params]
 */
export function modernRpc(id, method, params) {
  return rpc(id, method, {
    ...(params || {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
      "io.modelcontextprotocol/clientInfo": { name: "mcp-probe", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
}

/**
 * The three mirrored headers a modern POST must carry. `Mcp-Name` only for the
 * methods whose table row demands it.
 * @param {string} method
 * @param {string} [name] params.name, for tools/call
 * @returns {Record<string, string>}
 */
export function modernHeaders(method, name) {
  /** @type {Record<string, string>} */
  const headers = {
    "mcp-protocol-version": MODERN_PROTOCOL,
    "mcp-method": method,
    accept: "application/json, text/event-stream",
  };
  if (method === "tools/call" && name) headers["mcp-name"] = name;
  return headers;
}

/**
 * A check's verdict. `ok` decides the exit code; `detail` is what a human
 * reads when it goes red, so it names the observed value rather than
 * restating the expectation.
 * @typedef {{ ok: boolean, detail: string, info?: Record<string, unknown> }} Verdict
 */

/** @param {boolean} ok @param {string} detail @param {Record<string, unknown>} [info] @returns {Verdict} */
export function verdict(ok, detail, info) {
  return info ? { ok, detail, info } : { ok, detail };
}

/**
 * An unauthenticated call must be a JSON-RPC error at 401 — NOT the sign-in
 * page. HTML here is the specific failure that makes every MCP client report a
 * transport problem and send its user after the wrong bug.
 * @param {{ status: number, text: string }} res
 */
export function checkUnauthenticated(res) {
  if (res.status !== 401) return verdict(false, `expected 401, got ${res.status}`);
  const trimmed = res.text.trim();
  if (trimmed.startsWith("<")) return verdict(false, "401 carried HTML (the sign-in page) rather than a JSON-RPC error");
  try {
    const body = JSON.parse(trimmed);
    if (body.jsonrpc !== "2.0" || !body.error) return verdict(false, `401 body is not a JSON-RPC error: ${trimmed.slice(0, 120)}`);
    return verdict(true, `401 with JSON-RPC error ${body.error.code}`);
  } catch {
    return verdict(false, `401 body is not JSON: ${trimmed.slice(0, 120)}`);
  }
}

/** @param {any} result the `initialize` result */
export function checkInitialize(result) {
  if (result?.protocolVersion !== EXPECTED_PROTOCOL) {
    return verdict(false, `protocolVersion ${JSON.stringify(result?.protocolVersion)} (expected ${EXPECTED_PROTOCOL})`);
  }
  if (!result?.serverInfo?.name) return verdict(false, "no serverInfo.name");
  if (!result?.capabilities?.tools) return verdict(false, "does not advertise the tools capability");
  return verdict(true, `${result.serverInfo.name} ${result.serverInfo.version || "?"}, protocol ${result.protocolVersion}`);
}

/**
 * tools/list must match the served set exactly, in order. A SHORT list is the
 * expected shape when the account has switched tools off, so that is reported
 * as information rather than as a failure — but a tool the server does not
 * serve at all appearing here is a real defect.
 * @param {any} result
 */
export function checkToolsList(result) {
  const tools = result?.tools;
  if (!Array.isArray(tools) || !tools.length) return verdict(false, "tools/list returned no tools");
  const names = tools.map((t) => t.name);
  const unknown = names.filter((n) => !EXPECTED_TOOLS.includes(n));
  if (unknown.length) return verdict(false, `served tools this probe does not know: ${unknown.join(", ")}`);
  // Order must follow ALL_MCP_TOOLS — the next protocol revision requires
  // deterministically ordered listings, and ours are a static array.
  const expectedOrder = EXPECTED_TOOLS.filter((n) => names.includes(n));
  if (names.join(",") !== expectedOrder.join(",")) {
    return verdict(false, `tools are out of ALL_MCP_TOOLS order: ${names.join(", ")}`);
  }
  const wrongSchema = tools.filter((t) => t.inputSchema?.type !== "object" || t.input_schema !== undefined);
  if (wrongSchema.length) {
    return verdict(false, `MCP wants inputSchema, not Anthropic's input_schema: ${wrongSchema.map((t) => t.name).join(", ")}`);
  }
  const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
  const literature = names.filter((n) => n.startsWith("literature_"));
  return verdict(
    literature.length > 0,
    literature.length
      ? `${names.length}/${EXPECTED_TOOLS.length} tools${missing.length ? ` (switched off: ${missing.join(", ")})` : ""}`
      : "no literature_* tool is exposed — switch them on at Settings → MCP server",
    { names, missing },
  );
}

/**
 * The MODERN era (protocol 2026-07-28): `server/discover` must answer with the
 * five required fields, and it must list a version we actually serve.
 *
 * This is the one check a client's own probe depends on — a client that gets
 * anything but a recognized modern result here concludes the whole server is
 * legacy and stays there — so it is checked live rather than only in units.
 * @param {any} result the `server/discover` result
 */
export function checkDiscover(result) {
  const versions = result?.supportedVersions;
  if (!Array.isArray(versions) || !versions.length) return verdict(false, "no supportedVersions");
  if (!versions.includes(MODERN_PROTOCOL)) {
    return verdict(false, `supportedVersions ${versions.join(", ")} does not include ${MODERN_PROTOCOL}`);
  }
  if (result?.resultType !== "complete") return verdict(false, `resultType ${JSON.stringify(result?.resultType)}`);
  if (typeof result?.ttlMs !== "number" || result.ttlMs < 0) return verdict(false, `ttlMs ${JSON.stringify(result?.ttlMs)}`);
  if (result?.cacheScope !== "public" && result?.cacheScope !== "private") {
    return verdict(false, `cacheScope ${JSON.stringify(result?.cacheScope)}`);
  }
  if (!result?.capabilities?.tools) return verdict(false, "does not advertise the tools capability");
  return verdict(true, `speaks ${versions.join(", ")}; ttl ${result.ttlMs}ms ${result.cacheScope}`);
}

/**
 * A modern request whose mirrored header disagrees with its body MUST be
 * refused with 400 and -32020. Getting this wrong is invisible until an
 * intermediary routes on one value while the server executes the other, which is
 * the exact confusion the rule exists to prevent.
 * @param {{ status: number, body: any }} res
 */
export function checkHeaderMismatch(res) {
  if (res.status !== 400) return verdict(false, `expected 400, got ${res.status}`);
  if (res.body?.error?.code !== -32020) return verdict(false, `expected -32020, got ${JSON.stringify(res.body?.error?.code)}`);
  return verdict(true, `400 with -32020: ${String(res.body.error.message).slice(0, 80)}`);
}

/**
 * A version we do not implement MUST come back as 400 + -32022 carrying the
 * versions we do — that list is how a conforming client retries instead of
 * giving up.
 * @param {{ status: number, body: any }} res
 */
export function checkUnsupportedVersion(res) {
  if (res.status !== 400) return verdict(false, `expected 400, got ${res.status}`);
  const error = res.body?.error;
  if (error?.code !== -32022) return verdict(false, `expected -32022, got ${JSON.stringify(error?.code)}`);
  if (!Array.isArray(error?.data?.supported) || !error.data.supported.length) {
    return verdict(false, "-32022 carried no data.supported list");
  }
  return verdict(true, `400 with -32022, offering ${error.data.supported.join(", ")}`);
}

/** @param {any} body a JSON-RPC response @param {number} code */
export function checkRpcError(body, code) {
  if (!body?.error) return verdict(false, `expected a JSON-RPC error, got ${JSON.stringify(body).slice(0, 120)}`);
  if (body.error.code !== code) return verdict(false, `error code ${body.error.code} (expected ${code})`);
  return verdict(true, `error ${body.error.code}: ${body.error.message}`);
}

/**
 * Parse a tools/call result into the JSON payload the literature tools return.
 * @param {any} result
 * @returns {{ payload: any, isError: boolean } | null}
 */
export function toolPayload(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return { payload: JSON.parse(text), isError: Boolean(result.isError) };
  } catch {
    return null;
  }
}

/**
 * literature_corpora is the cheapest proof the bindings are real: a corpus
 * reporting `available` with a live vector count is one whose Vectorize
 * binding exists AND answers. An unbound corpus is a deployment fact, not a
 * failure — but BOTH being unbound means this deployment cannot serve the
 * family at all, which the caller needs to know before reading a miss.
 * @param {any} payload
 */
export function checkCorpora(payload) {
  const corpora = payload?.corpora;
  if (!Array.isArray(corpora) || corpora.length !== 2) return verdict(false, "expected two corpora");
  const lines = [];
  let live = 0;
  for (const c of corpora) {
    if (!c.available) {
      lines.push(`${c.corpus}: unavailable (${c.unavailable_reason || "?"})`);
      continue;
    }
    if (!c.coverage_window) return verdict(false, `${c.corpus} reports no coverage window`);
    const n = c.vectors_live;
    if (typeof n !== "number" || n <= 0) {
      lines.push(`${c.corpus}: bound but describe() gave ${JSON.stringify(n)}${c.describe_error ? ` — ${c.describe_error}` : ""}`);
      continue;
    }
    live++;
    lines.push(`${c.corpus}: ${n.toLocaleString("en-US")} vectors live`);
  }
  if (!payload?.retrieval?.relevance_floor && payload?.retrieval?.relevance_floor !== 0) {
    return verdict(false, "no retrieval.relevance_floor reported");
  }
  return verdict(live > 0, lines.join("; "), { live });
}

/**
 * One search result set. `expect.corpora` names the corpora that must appear;
 * an empty result is a legitimate answer from a corpus but not from a probe
 * whose queries were chosen to be answerable, so it fails here on purpose.
 * @param {any} payload
 * @param {{ queries: number, corpora?: string[], merged?: boolean }} expect
 */
export function checkSearch(payload, expect) {
  if (payload?.error) return verdict(false, `tool error: ${payload.error}`);
  const groups = payload?.queries;
  if (!Array.isArray(groups) || groups.length !== expect.queries) {
    return verdict(false, `expected ${expect.queries} query group(s), got ${groups?.length}`);
  }
  const all = groups.flatMap((g) => g.results || []);
  if (!all.length) return verdict(false, "no records above the relevance floor for any angle");
  for (const rec of all) {
    if (!rec.id || !rec.title || !rec.url) return verdict(false, `a record is missing id/title/url: ${JSON.stringify(rec).slice(0, 120)}`);
    const host = rec.corpus === "arxiv" ? "arxiv.org" : "pubmed.ncbi.nlm.nih.gov";
    if (!String(rec.url).includes(host)) return verdict(false, `${rec.corpus} record has url ${rec.url}`);
  }
  const seen = [...new Set(all.map((r) => r.corpus))].sort();
  for (const want of expect.corpora || []) {
    if (!seen.includes(want)) return verdict(false, `no ${want} records came back (saw: ${seen.join(", ") || "none"})`);
  }
  if (expect.merged && !payload.merged) return verdict(false, "a multi-angle call returned no merged ranking");
  if (expect.merged === false && payload.merged) return verdict(false, "a single-angle call returned a merged ranking");
  const scored = all.filter((r) => typeof r.score === "number").length;
  return verdict(
    true,
    `${all.length} records across ${groups.length} angle(s) from ${seen.join("+")}` +
      `, ${scored} scored, ${payload.stats?.candidates_examined ?? "?"} candidates examined`,
    { records: all.length, corpora: seen, first: all[0]?.id, reranked: payload.stats?.reranked },
  );
}

/**
 * The round trip that proves the two tools agree: an id taken from a search
 * result must fetch back as the same paper. A bogus id must come back NAMED,
 * with the coverage window that explains it — silence about a miss is what
 * makes an agent re-ask.
 * @param {any} payload
 * @param {string} wantId
 * @param {string} missId
 */
export function checkFetch(payload, wantId, missId) {
  if (payload?.error) return verdict(false, `tool error: ${payload.error}`);
  const hit = (payload?.results || []).find((r) => r.id === wantId);
  if (!hit) return verdict(false, `${wantId} did not come back from literature_fetch`);
  if (!hit.title) return verdict(false, `${wantId} came back without a title`);
  const miss = (payload?.not_found || []).find((m) => m.id === missId);
  if (!miss) return verdict(false, `the absent id ${missId} was dropped silently rather than reported`);
  if (!miss.window) return verdict(false, "a miss was reported without the coverage window that explains it");
  return verdict(true, `${wantId} → "${String(hit.title).slice(0, 60)}"; ${missId} correctly reported absent`);
}

/**
 * @param {any} payload
 * @param {string} seedId the paper the neighbourhood was searched from
 */
export function checkSimilar(payload, seedId) {
  if (payload?.error) return verdict(false, `tool error: ${payload.error}`);
  const results = payload?.results || [];
  if (!results.length) return verdict(false, "no neighbours above the floor");
  // A paper is its own nearest neighbour; returning it would waste a slot and
  // read as a result.
  if (results.some((r) => r.id === seedId)) return verdict(false, "the seed paper came back as its own neighbour");
  if (!payload?.seed?.title) return verdict(false, "no seed paper reported");
  const source = (payload.notes || []).find((n) => n.includes("Neighbourhood searched from"));
  return verdict(true, `${results.length} neighbours of "${String(payload.seed.title).slice(0, 40)}" — ${source || "no vector source noted"}`);
}

/**
 * A filter nothing can satisfy must return nothing AND disclose that filters
 * run after retrieval. The disclosure is the point: without it a caller reads
 * an empty filtered result as "the corpus holds nothing", when what happened
 * is that the bound was applied to 50 candidates.
 * @param {any} payload
 */
export function checkFilterDisclosure(payload) {
  if (payload?.error) return verdict(false, `tool error: ${payload.error}`);
  const total = (payload?.queries || []).reduce((n, g) => n + (g.results || []).length, 0);
  if (total) return verdict(false, `an impossible date bound still returned ${total} records`);
  const note = (payload?.notes || []).find((n) => n.includes("AFTER retrieval"));
  if (!note) return verdict(false, "an empty filtered result did not disclose that filters run after retrieval");
  return verdict(true, "empty, and the post-retrieval caveat travelled with it");
}

/** @param {any} result a deep_research tools/call result */
export function checkDeepResearch(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) return verdict(false, "empty answer");
  if (result.isError) return verdict(false, `tool error: ${text.slice(0, 160)}`);
  const cited = /\[\d+\]/.test(text);
  const sourced = /Sources?:/i.test(text);
  if (!sourced) return verdict(false, `answer carried no Sources list: ${text.slice(0, 160)}`);
  return verdict(true, `${text.length} chars, ${cited ? "cited" : "NO inline citations"}, Sources list present`);
}

/**
 * The batching claim, measured rather than asserted: one call carrying N
 * angles against N calls carrying one each. Network noise makes a strict
 * threshold dishonest, so this fails only when batching is actually SLOWER —
 * the claim being defended is "not N times the latency", not a fixed factor.
 * @param {number} batchMs
 * @param {number} serialMs
 * @param {number} angles
 */
export function checkBatchSpeedup(batchMs, serialMs, angles) {
  const speedup = serialMs / Math.max(1, batchMs);
  const detail =
    `${angles} angles: ${batchMs} ms batched vs ${serialMs} ms one-at-a-time — ` +
    `${speedup.toFixed(1)}× (${Math.round(serialMs / angles)} ms per serial call)`;
  return verdict(batchMs < serialMs, detail, { batchMs, serialMs, speedup: Number(speedup.toFixed(2)) });
}

/**
 * The end-of-run report. Coverage gaps are stated explicitly: a green run that
 * never exercised the key path should not read as a green run of everything.
 * @param {{ name: string, verdict: Verdict, skipped?: string }[]} results
 * @param {string[]} gaps
 */
export function summarize(results, gaps = []) {
  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.verdict.ok);
  const lines = results.map((r) =>
    r.skipped ? `  ~ ${r.name}: skipped (${r.skipped})` : `  ${r.verdict.ok ? "✓" : "✗"} ${r.name}: ${r.verdict.detail}`,
  );
  return {
    passed: ran.length - failed.length,
    failed: failed.length,
    skipped: results.length - ran.length,
    exitCode: failed.length,
    lines,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// The live run
// ---------------------------------------------------------------------------

/**
 * One JSON-RPC round trip. Returns the raw status and text too, because two
 * checks here are ABOUT the transport rather than about the result.
 * @param {string} url
 * @param {string} auth
 * @param {any} body
 * @param {{ raw?: boolean }} [opts]
 */
async function call(url, auth, body, { raw = false, headers: extra = {} } = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (auth) /** @type {any} */ (headers).authorization = auth;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: raw ? /** @type {any} */ (body) : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* left null — the caller decides whether that is a failure */
  }
  return { status: res.status, text, json };
}

/**
 * Run the battery with one credential.
 * @param {string} url
 * @param {{ kind: "key"|"basic", value: string }} cred
 * @param {{ deep: boolean, only: string[] }} opts
 */
async function runBattery(url, cred, opts) {
  const auth = authHeader(cred);
  /** @type {{ name: string, verdict: Verdict, skipped?: string }[]} */
  const results = [];
  let id = 0;
  const next = () => ++id;
  const wanted = (name) => !opts.only.length || opts.only.includes(name);
  /** @param {string} name @param {() => Promise<Verdict>} fn */
  const check = async (name, fn) => {
    if (!wanted(name)) {
      results.push({ name, verdict: verdict(true, ""), skipped: "not in --only" });
      return null;
    }
    try {
      const v = await fn();
      results.push({ name, verdict: v });
      return v;
    } catch (err) {
      results.push({ name, verdict: verdict(false, `threw: ${err instanceof Error ? err.message : String(err)}`) });
      return null;
    }
  };

  await check("initialize", async () => checkInitialize((await call(url, auth, rpc(next(), "initialize"))).json?.result));

  await check("notification", async () => {
    // A message with no `id` expects no response body; Streamable HTTP answers
    // 202 Accepted.
    const res = await call(url, auth, { jsonrpc: "2.0", method: "notifications/initialized" });
    if (res.status !== 202) return verdict(false, `expected 202, got ${res.status}`);
    if (res.text.trim()) return verdict(false, `a notification got a response body: ${res.text.slice(0, 80)}`);
    return verdict(true, "202 Accepted, no body");
  });

  const listed = await check("tools-list", async () =>
    checkToolsList((await call(url, auth, rpc(next(), "tools/list"))).json?.result),
  );
  const exposed = /** @type {string[]} */ (listed?.info?.names || EXPECTED_TOOLS);
  const has = (name) => exposed.includes(name);

  await check("bad-method", async () => checkRpcError((await call(url, auth, rpc(next(), "no/such/method"))).json, -32601));

  // ---- the MODERN era (protocol 2026-07-28) --------------------------------
  //
  // These four are what a stateless client's own opening moves look like. They
  // are checked live because a client BRANCHES on them: anything but a
  // recognized modern error makes it conclude the server is legacy and stay
  // there, and no unit test can prove the deployed edge answers this way.

  await check("discover", async () =>
    checkDiscover((await call(url, auth, modernRpc(next(), "server/discover"), { headers: modernHeaders("server/discover") })).json?.result),
  );

  await check("modern-tools-list", async () => {
    const res = await call(url, auth, modernRpc(next(), "tools/list"), { headers: modernHeaders("tools/list") });
    const result = res.json?.result;
    if (res.status !== 200) return verdict(false, `expected 200, got ${res.status}`);
    if (result?.resultType !== "complete") return verdict(false, `resultType ${JSON.stringify(result?.resultType)}`);
    if (typeof result?.ttlMs !== "number") return verdict(false, "a cacheable listing carried no ttlMs");
    if (result?.cacheScope !== "private") {
      return verdict(false, `cacheScope ${JSON.stringify(result?.cacheScope)} — the listing is per-account, so it is private`);
    }
    return checkToolsList(result);
  });

  await check("header-mismatch", async () => {
    const res = await call(url, auth, modernRpc(next(), "tools/list"), {
      headers: { ...modernHeaders("tools/list"), "mcp-method": "tools/call" },
    });
    return checkHeaderMismatch({ status: res.status, body: res.json });
  });

  await check("unsupported-version", async () => {
    const body = modernRpc(next(), "tools/list");
    body.params._meta["io.modelcontextprotocol/protocolVersion"] = "1900-01-01";
    const res = await call(url, auth, body, {
      headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "1900-01-01" },
    });
    return checkUnsupportedVersion({ status: res.status, body: res.json });
  });

  await check("bad-json", async () =>
    checkRpcError((await call(url, auth, "{not json", { raw: true })).json, -32700),
  );

  // ---- the literature family, in dependency order -------------------------

  await check("corpora", async () => {
    if (!has("literature_corpora")) return verdict(true, "not exposed on this account");
    const res = await call(url, auth, toolCall(next(), "literature_corpora", {}));
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 160)}`);
    return checkCorpora(parsed.payload);
  });

  /** @type {{ id: string, corpus: string } | null} */
  let sample = null;

  const single = await check("search-one", async () => {
    if (!has("literature_search")) return verdict(true, "not exposed on this account");
    const res = await call(
      url,
      auth,
      toolCall(next(), "literature_search", { query: BATCH_QUERIES[0], corpus: "arxiv", limit: 5 }),
    );
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 200)}`);
    const v = checkSearch(parsed.payload, { queries: 1, corpora: ["arxiv"], merged: false });
    const first = (parsed.payload.queries?.[0]?.results || [])[0];
    if (first) sample = { id: first.id, corpus: first.corpus };
    return v;
  });

  let batchRan = false;
  await check("search-batch", async () => {
    if (!has("literature_search")) return verdict(true, "not exposed on this account");
    const res = await call(url, auth, toolCall(next(), "literature_search", { queries: BATCH_QUERIES, corpus: "both", limit: 5 }));
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 200)}`);
    batchRan = true;
    return checkSearch(parsed.payload, { queries: BATCH_QUERIES.length, merged: true });
  });

  await check("batch-speedup", async () => {
    if (!has("literature_search") || !batchRan) return verdict(true, "search-batch did not run");
    // BOTH legs are timed HERE, after a warm-up, and in that order for a
    // reason. The first version timed the batch up in `search-batch` — the
    // first call to touch the PubMed index in the whole run — and compared it
    // against a serial loop that ran afterwards, warm. That is a cold-vs-warm
    // comparison dressed up as a batched-vs-serial one, and it UNDERSTATED the
    // speedup by roughly half (measured against production 2026-08-02: it
    // reported 1.4×, where a warm comparison of the same work gives ~2.9×).
    // A benchmark whose ordering biases the result is worse than none: it
    // reports a real number for a comparison nobody meant to make.
    await call(url, auth, toolCall(next(), "literature_search", { query: BATCH_QUERIES[0], corpus: "both", limit: 1 }));

    const batchStarted = Date.now();
    await call(url, auth, toolCall(next(), "literature_search", { queries: BATCH_QUERIES, corpus: "both", limit: 5 }));
    const batchMs = Date.now() - batchStarted;

    // The same angles, one call each — what an agent would otherwise pay.
    const serialStarted = Date.now();
    for (const query of BATCH_QUERIES) {
      await call(url, auth, toolCall(next(), "literature_search", { query, corpus: "both", limit: 5 }));
    }
    return checkBatchSpeedup(batchMs, Date.now() - serialStarted, BATCH_QUERIES.length);
  });

  await check("fetch-roundtrip", async () => {
    if (!has("literature_fetch")) return verdict(true, "not exposed on this account");
    if (!sample) return verdict(false, "search-one produced no id to fetch (run it, or drop --only)");
    // An id shaped like a real arXiv id but far outside the corpus window.
    const missId = "1801.00001";
    const res = await call(url, auth, toolCall(next(), "literature_fetch", { ids: [sample.id, missId] }));
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 200)}`);
    return checkFetch(parsed.payload, sample.id, missId);
  });

  await check("similar", async () => {
    if (!has("literature_similar")) return verdict(true, "not exposed on this account");
    if (!sample) return verdict(false, "search-one produced no seed id (run it, or drop --only)");
    const res = await call(url, auth, toolCall(next(), "literature_similar", { id: sample.id, corpus: "both", limit: 5 }));
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 200)}`);
    return checkSimilar(parsed.payload, sample.id);
  });

  await check("filter-disclosure", async () => {
    if (!has("literature_search")) return verdict(true, "not exposed on this account");
    const res = await call(
      url,
      auth,
      toolCall(next(), "literature_search", { query: BATCH_QUERIES[0], corpus: "arxiv", since: "2099" }),
    );
    const parsed = toolPayload(res.json?.result);
    if (!parsed) return verdict(false, `unparseable result: ${res.text.slice(0, 200)}`);
    return checkFilterDisclosure(parsed.payload);
  });

  await check("unknown-tool", async () =>
    checkRpcError((await call(url, auth, toolCall(next(), "literature_invent", {}))).json, -32602),
  );

  if (opts.deep) {
    await check("deep-research", async () => {
      if (!has("deep_research")) return verdict(true, "not exposed on this account");
      const res = await call(
        url,
        auth,
        toolCall(next(), "deep_research", { question: "What is the capital of Sweden?", time_budget_s: 15 }),
      );
      return checkDeepResearch(res.json?.result);
    });
  } else {
    results.push({ name: "deep-research", verdict: verdict(true, ""), skipped: "pass --deep (spends real money)" });
  }

  return results;
}

async function main() {
  const opts = parseProbeArgs(process.argv.slice(2), process.env);
  const url = opts.url;
  const origin = new URL(url).origin;

  /** @type {{ credential: string, results: any[] }[]} */
  const runs = [];
  /** @type {string[]} */
  const gaps = [];

  // ---- credential-free checks, always ------------------------------------
  const anon = [];
  anon.push({
    name: "unauthenticated",
    verdict: checkUnauthenticated(await call(url, "", rpc(1, "initialize"))),
  });
  // BOTH forms must answer on the dedicated host: MCP clients disagree about
  // whether the configured URL includes the path, and a wrong-URL 404 is the
  // commonest way an MCP setup fails. So probe the form the target is NOT —
  // bare origin when `--url` carried `/mcp`, `/mcp` when it didn't. Probing a
  // fixed form would be tautological once the default became the bare origin
  // (2026-08-03), and the check would silently stop covering the other one.
  if (/^mcp\./.test(new URL(url).hostname)) {
    const targetIsBare = new URL(url).pathname === "/";
    const altPath = targetIsBare ? "/mcp" : "/";
    const alt = await call(`${origin}${altPath}`, "", rpc(1, "initialize"));
    anon.push({
      name: "alt-form",
      verdict:
        alt.status === 404
          ? verdict(false, `${altPath} 404s — clients that configure that form will fail`)
          : verdict(true, `${altPath} answers too (${alt.status}, same gate as ${new URL(url).pathname})`),
    });
  } else {
    gaps.push(`the dedicated mcp. host was not probed (target was ${origin})`);
  }
  runs.push({ credential: "none", results: anon });

  const creds = [];
  if (opts.basic) creds.push(/** @type {const} */ ({ kind: "basic", value: opts.basic, label: "break-glass Basic" }));
  if (opts.key) creds.push(/** @type {const} */ ({ kind: "key", value: opts.key, label: "MCP key (Bearer)" }));

  if (!creds.length) {
    gaps.push(
      "no credential supplied — only the unauthenticated checks ran. Set BASIC_AUTH_USER/BASIC_AUTH_PASS, or MCP_KEY.",
    );
  }
  if (!opts.key) {
    gaps.push(
      "no MCP_KEY — the above-the-gate path an external client takes (src/mcp-api.js resolveMcpKeyIdentity), " +
        "the per-account exposure config and the quota gate went untested.",
    );
  }
  if (!opts.basic) gaps.push("no break-glass credentials — the below-the-gate session path went untested.");

  for (const cred of creds) {
    runs.push({ credential: cred.label, results: await runBattery(url, cred, { deep: opts.deep, only: opts.only }) });
  }

  const all = runs.flatMap((r) => r.results);
  const summary = summarize(all, gaps);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          url,
          runs: runs.map((r) => ({
            credential: r.credential,
            checks: r.results.map((c) => ({ name: c.name, ok: c.skipped ? null : c.verdict.ok, detail: c.verdict.detail, skipped: c.skipped ?? null, info: c.verdict.info ?? null })),
          })),
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          gaps,
        },
        null,
        2,
      ),
    );
    process.exit(summary.exitCode);
  }

  console.log(`MCP probe → ${url}\n`);
  for (const run of runs) {
    console.log(`[${run.credential}]`);
    for (const c of run.results) {
      console.log(c.skipped ? `  ~ ${c.name}: skipped (${c.skipped})` : `  ${c.verdict.ok ? "✓" : "✗"} ${c.name}: ${c.verdict.detail}`);
    }
    console.log("");
  }
  if (gaps.length) {
    console.log("Not covered by this run:");
    for (const g of gaps) console.log(`  · ${g}`);
    console.log("");
  }
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`);
  process.exit(summary.exitCode);
}

if (process.argv[1]?.endsWith("mcp-probe.mjs")) {
  await main();
}

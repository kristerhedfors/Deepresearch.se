// Unit tests for scripts/mcp-probe.mjs — the PURE half: argument parsing, the
// auth header, the JSON-RPC envelopes, and one predicate per live check.
//
// The point of testing a probe is that its assertions are the only thing
// standing between a live run and a false verdict, in both directions. A check
// that cannot fail is worse than no check (it reports green forever), and a
// check that fails on a legitimate shape sends someone after a bug that is not
// there. So every predicate below is exercised with a passing fixture AND with
// the specific wrong shape it exists to catch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_QUERIES,
  EXPECTED_PROTOCOL,
  EXPECTED_TOOLS,
  MODERN_PROTOCOL,
  authHeader,
  checkBatchSpeedup,
  checkCorpora,
  checkDeepResearch,
  checkDiscover,
  checkFetch,
  checkHeaderMismatch,
  checkFilterDisclosure,
  checkInitialize,
  checkRpcError,
  checkSearch,
  checkSimilar,
  checkToolsList,
  checkUnauthenticated,
  checkUnsupportedVersion,
  modernHeaders,
  modernRpc,
  parseProbeArgs,
  rpc,
  summarize,
  toolCall,
  toolPayload,
} from "./mcp-probe.mjs";

// ---------------------------------------------------------------------------
// Arguments and envelopes
// ---------------------------------------------------------------------------

test("parseProbeArgs defaults to the dedicated MCP host", () => {
  const opts = parseProbeArgs([], {});
  assert.equal(opts.url, "https://mcp.deepresearch.se");
  assert.equal(opts.key, "");
  assert.equal(opts.basic, "");
  assert.equal(opts.deep, false);
  assert.deepEqual(opts.only, []);
});

test("parseProbeArgs reads both credential families from the environment", () => {
  const opts = parseProbeArgs([], { BASIC_AUTH_USER: "u", BASIC_AUTH_PASS: "p", MCP_KEY: "mck1.abc" });
  assert.equal(opts.basic, "u:p");
  assert.equal(opts.key, "mck1.abc");
  // ADMIN_USER/ADMIN_PASS are the same break-glass secrets under their other
  // names (src/auth.js accepts either pair), so the probe accepts either too.
  assert.equal(parseProbeArgs([], { ADMIN_USER: "a", ADMIN_PASS: "b" }).basic, "a:b");
  // Half a credential is no credential — a Basic header built from one of the
  // two would just be a confusing 401.
  assert.equal(parseProbeArgs([], { BASIC_AUTH_USER: "u" }).basic, "");
});

test("flags override the environment", () => {
  const opts = parseProbeArgs(["--url", "https://deepresearch.se/mcp", "--key", "mck1.flag", "--deep", "--json", "--only", "corpora, search-one"], {
    MCP_URL: "https://ignored.example/mcp",
    MCP_KEY: "mck1.env",
  });
  assert.equal(opts.url, "https://deepresearch.se/mcp");
  assert.equal(opts.key, "mck1.flag");
  assert.equal(opts.deep, true);
  assert.equal(opts.json, true);
  assert.deepEqual(opts.only, ["corpora", "search-one"]);
});

test("authHeader builds the two credential forms and nothing for none", () => {
  assert.equal(authHeader({ kind: "key", value: "mck1.abc" }), "Bearer mck1.abc");
  assert.equal(authHeader({ kind: "basic", value: "u:p" }), `Basic ${Buffer.from("u:p").toString("base64")}`);
  assert.equal(authHeader({ kind: "none" }), "");
  assert.equal(authHeader({ kind: "key", value: "" }), "");
});

test("rpc and toolCall build well-formed JSON-RPC 2.0 messages", () => {
  assert.deepEqual(rpc(1, "initialize"), { jsonrpc: "2.0", id: 1, method: "initialize" });
  // params is omitted rather than sent as null when there is none.
  assert.equal("params" in rpc(1, "initialize"), false);
  assert.deepEqual(toolCall(7, "literature_corpora", {}), {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "literature_corpora", arguments: {} },
  });
});

test("the probe's expectations mirror the server's tool list", () => {
  // A tool added to src/mcp.js without being added here would pass tools-list
  // as "unknown tool" — which is the failure this constant exists to produce.
  assert.equal(EXPECTED_TOOLS.length, 10);
  assert.equal(EXPECTED_TOOLS[0], "deep_research");
  assert.deepEqual(EXPECTED_TOOLS.slice(1, 5), [
    "literature_search",
    "literature_fetch",
    "literature_similar",
    "literature_corpora",
  ]);
  // Six angles is the tool's advertised maximum; a seventh would be silently
  // dropped and the batch check would measure the wrong thing.
  assert.equal(BATCH_QUERIES.length, 6);
  assert.equal(new Set(BATCH_QUERIES).size, 6, "the angles must be distinct or de-duplication shrinks the batch");
  // The extension families are last, mirroring the registry order ALL_MCP_TOOLS
  // appends them in.
  assert.deepEqual(EXPECTED_TOOLS.slice(-3), ["street_view_look", "place_nearby", "host_intel"]);
});

// ---------------------------------------------------------------------------
// The MODERN era (protocol 2026-07-28)
// ---------------------------------------------------------------------------

test("a modern request carries both required _meta fields and its mirrored headers", () => {
  const body = modernRpc(7, "tools/list");
  const meta = body.params._meta;
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], MODERN_PROTOCOL);
  // An EMPTY capabilities object is the valid way to say "no optional
  // capabilities" — it must be present, not merely truthy.
  assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
  const headers = modernHeaders("tools/list");
  assert.equal(headers["mcp-protocol-version"], MODERN_PROTOCOL);
  assert.equal(headers["mcp-method"], "tools/list");
  assert.equal(headers["mcp-name"], undefined, "Mcp-Name belongs only to tools/call and friends");
  assert.equal(modernHeaders("tools/call", "deep_research")["mcp-name"], "deep_research");
});

test("checkDiscover demands the five required fields of a cacheable result", () => {
  const good = {
    resultType: "complete",
    supportedVersions: [MODERN_PROTOCOL, "2025-06-18"],
    capabilities: { tools: {} },
    ttlMs: 3600000,
    cacheScope: "public",
  };
  assert.equal(checkDiscover(good).ok, true);
  assert.equal(checkDiscover({ ...good, resultType: undefined }).ok, false);
  assert.equal(checkDiscover({ ...good, ttlMs: undefined }).ok, false);
  assert.equal(checkDiscover({ ...good, cacheScope: "sometimes" }).ok, false);
  assert.equal(checkDiscover({ ...good, supportedVersions: ["2025-06-18"] }).ok, false);
  assert.equal(checkDiscover({ ...good, capabilities: {} }).ok, false);
  assert.equal(checkDiscover(null).ok, false);
});

test("the two modern refusals are checked by status AND code", () => {
  // 400 is what a client inspects the body of; a 200 carrying the right code
  // would make it conclude the request succeeded.
  assert.equal(checkHeaderMismatch({ status: 400, body: { error: { code: -32020, message: "x" } } }).ok, true);
  assert.equal(checkHeaderMismatch({ status: 200, body: { error: { code: -32020, message: "x" } } }).ok, false);
  assert.equal(checkHeaderMismatch({ status: 400, body: { error: { code: -32602, message: "x" } } }).ok, false);

  const supported = { status: 400, body: { error: { code: -32022, data: { supported: ["2026-07-28"] } } } };
  assert.equal(checkUnsupportedVersion(supported).ok, true);
  // The `supported` list is the whole point — without it a client cannot retry.
  assert.equal(checkUnsupportedVersion({ status: 400, body: { error: { code: -32022 } } }).ok, false);
  assert.equal(checkUnsupportedVersion({ status: 400, body: { error: { code: -32020 } } }).ok, false);
});

// ---------------------------------------------------------------------------
// Transport-level checks
// ---------------------------------------------------------------------------

test("an unauthenticated call must be a JSON-RPC 401, never the sign-in page", () => {
  const good = checkUnauthenticated({
    status: 401,
    text: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Authentication required." } }),
  });
  assert.equal(good.ok, true);
  // THE failure this check exists for: HTML at 401 makes every MCP client
  // report a transport problem and send its user after the wrong bug.
  assert.equal(checkUnauthenticated({ status: 401, text: "<!doctype html><title>Sign in</title>" }).ok, false);
  assert.match(checkUnauthenticated({ status: 401, text: "<html>" }).detail, /HTML/);
  // An endpoint that lets an anonymous caller through is a worse failure still.
  assert.equal(checkUnauthenticated({ status: 200, text: "{}" }).ok, false);
  assert.equal(checkUnauthenticated({ status: 401, text: "nope" }).ok, false);
});

test("checkInitialize pins the protocol revision and the tools capability", () => {
  const ok = checkInitialize({
    protocolVersion: EXPECTED_PROTOCOL,
    serverInfo: { name: "deepresearch.se", version: "1.0.0" },
    capabilities: { tools: {} },
  });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /deepresearch\.se/);
  // A bumped revision on the server must fail here, so the probe is updated in
  // the same change rather than silently accepting either.
  assert.equal(checkInitialize({ protocolVersion: "2025-11-25", serverInfo: { name: "x" }, capabilities: { tools: {} } }).ok, false);
  assert.equal(checkInitialize({ protocolVersion: EXPECTED_PROTOCOL, capabilities: { tools: {} } }).ok, false);
  assert.equal(checkInitialize({ protocolVersion: EXPECTED_PROTOCOL, serverInfo: { name: "x" }, capabilities: {} }).ok, false);
  assert.equal(checkInitialize(undefined).ok, false);
});

const TOOL_LIST = { tools: EXPECTED_TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) };

test("checkToolsList accepts the full list and the narrowed one", () => {
  assert.equal(checkToolsList(TOOL_LIST).ok, true);
  // A SHORT list is the expected shape when an account has switched tools off,
  // so it passes and reports what is missing rather than failing.
  const narrowed = { tools: TOOL_LIST.tools.filter((t) => t.name !== "host_intel") };
  const v = checkToolsList(narrowed);
  assert.equal(v.ok, true);
  assert.deepEqual(v.info.missing, ["host_intel"]);
  assert.match(v.detail, /switched off/);
});

test("checkToolsList catches the four ways a listing goes wrong", () => {
  // 1. A tool the probe does not know — the server grew one and this file did not.
  assert.equal(checkToolsList({ tools: [...TOOL_LIST.tools, { name: "brand_new", inputSchema: { type: "object" } }] }).ok, false);
  // 2. Out of ALL_MCP_TOOLS order — the next protocol revision requires
  //    deterministically ordered listings.
  assert.equal(checkToolsList({ tools: [...TOOL_LIST.tools].reverse() }).ok, false);
  // 3. Anthropic's key instead of MCP's — the rename in src/mcp.js not applied.
  assert.equal(
    checkToolsList({ tools: [{ name: "deep_research", input_schema: { type: "object" }, inputSchema: { type: "object" } }] }).ok,
    false,
  );
  // 4. Every literature tool switched off — reported, because the probe's whole
  //    literature battery would otherwise pass by doing nothing.
  const noLit = { tools: TOOL_LIST.tools.filter((t) => !t.name.startsWith("literature_")) };
  assert.equal(checkToolsList(noLit).ok, false);
  assert.match(checkToolsList(noLit).detail, /Settings/);
  assert.equal(checkToolsList({ tools: [] }).ok, false);
});

test("checkRpcError matches the code, not merely the presence of an error", () => {
  assert.equal(checkRpcError({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }, -32601).ok, true);
  assert.equal(checkRpcError({ error: { code: -32602, message: "x" } }, -32601).ok, false);
  assert.equal(checkRpcError({ result: {} }, -32601).ok, false);
  assert.equal(checkRpcError(null, -32700).ok, false);
});

test("toolPayload unwraps the MCP text envelope into JSON", () => {
  const parsed = toolPayload({ content: [{ type: "text", text: '{"tool":"literature_corpora"}' }], isError: false });
  assert.deepEqual(parsed, { payload: { tool: "literature_corpora" }, isError: false });
  assert.equal(toolPayload({ content: [{ type: "text", text: "not json" }] }), null);
  assert.equal(toolPayload({}), null);
  assert.equal(toolPayload(undefined), null);
});

// ---------------------------------------------------------------------------
// The literature checks
// ---------------------------------------------------------------------------

const CORPORA_OK = {
  corpora: [
    { corpus: "arxiv", available: true, vectors_live: 772658, coverage_window: "months 2310–2607" },
    { corpus: "pubmed", available: true, vectors_live: 1638756, coverage_window: "a PMID window" },
  ],
  retrieval: { relevance_floor: 0.01 },
};

test("checkCorpora treats a live vector count as the binding proof", () => {
  const v = checkCorpora(CORPORA_OK);
  assert.equal(v.ok, true);
  assert.equal(v.info.live, 2);
  assert.match(v.detail, /772,658/);

  // One corpus unbound is a deployment fact, not a failure — the other still works.
  const half = {
    ...CORPORA_OK,
    corpora: [CORPORA_OK.corpora[0], { corpus: "pubmed", available: false, unavailable_reason: "no PUBMED_INDEX binding" }],
  };
  assert.equal(checkCorpora(half).ok, true);
  assert.match(checkCorpora(half).detail, /unavailable/);

  // BOTH unbound means the family cannot be served here at all.
  const none = { ...CORPORA_OK, corpora: CORPORA_OK.corpora.map((c) => ({ corpus: c.corpus, available: false })) };
  assert.equal(checkCorpora(none).ok, false);
});

test("checkCorpora catches a bound-but-empty index and a missing window", () => {
  // The failure mode that matters after a re-create: the binding resolves, so
  // `available` is true, but the index holds nothing.
  const empty = { ...CORPORA_OK, corpora: [{ ...CORPORA_OK.corpora[0], vectors_live: 0 }, CORPORA_OK.corpora[1]] };
  const v = checkCorpora(empty);
  assert.match(v.detail, /describe\(\) gave 0/);
  assert.equal(v.info.live, 1, "the other corpus still counts");
  // A corpus that stops reporting its coverage window is a real regression:
  // the window is what tells an agent how to read a miss.
  const noWindow = { ...CORPORA_OK, corpora: [{ ...CORPORA_OK.corpora[0], coverage_window: "" }, CORPORA_OK.corpora[1]] };
  assert.equal(checkCorpora(noWindow).ok, false);
  assert.equal(checkCorpora({ corpora: [] }).ok, false);
  assert.equal(checkCorpora({ corpora: CORPORA_OK.corpora }).ok, false, "no relevance floor reported");
});

const REC = (corpus, id) => ({
  corpus,
  id,
  title: `Paper ${id}`,
  url: corpus === "arxiv" ? `https://arxiv.org/abs/${id}` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
  score: 0.8,
});

test("checkSearch validates the record shape, not just the count", () => {
  const payload = {
    queries: [{ index: 0, query: "q", results: [REC("arxiv", "2401.1")] }],
    stats: { candidates_examined: 50, reranked: true },
  };
  const v = checkSearch(payload, { queries: 1, corpora: ["arxiv"], merged: false });
  assert.equal(v.ok, true);
  assert.equal(v.info.first, "2401.1");

  // A record whose URL points at the wrong corpus's host is the mapper bug
  // this catches — the shape is otherwise indistinguishable.
  const crossed = { ...payload, queries: [{ results: [{ ...REC("arxiv", "2401.1"), url: "https://pubmed.ncbi.nlm.nih.gov/2401.1/" }] }] };
  assert.equal(checkSearch(crossed, { queries: 1 }).ok, false);
  const untitled = { ...payload, queries: [{ results: [{ corpus: "arxiv", id: "2401.1", url: "https://arxiv.org/abs/2401.1" }] }] };
  assert.equal(checkSearch(untitled, { queries: 1 }).ok, false);
});

test("checkSearch fails an empty result, because the probe's angles are answerable", () => {
  // An empty result is a legitimate ANSWER from a corpus, but not from queries
  // chosen to be answerable by both — here it means retrieval is broken.
  assert.equal(checkSearch({ queries: [{ results: [] }] }, { queries: 1 }).ok, false);
  assert.equal(checkSearch({ error: "no corpus available" }, { queries: 1 }).ok, false);
  assert.equal(checkSearch({ queries: [{ results: [REC("arxiv", "1")] }] }, { queries: 6 }).ok, false, "wrong angle count");
});

test("checkSearch enforces the merged view's presence and absence", () => {
  const multi = {
    queries: [{ results: [REC("arxiv", "2401.1")] }, { results: [REC("pubmed", "111")] }],
    stats: {},
  };
  // Several angles must be merged…
  assert.equal(checkSearch(multi, { queries: 2, corpora: ["arxiv", "pubmed"], merged: true }).ok, false);
  assert.equal(checkSearch({ ...multi, merged: { count: 2, results: [] } }, { queries: 2, merged: true }).ok, true);
  // …and one angle must NOT be, since there is nothing to merge across.
  assert.equal(
    checkSearch({ queries: [{ results: [REC("arxiv", "1")] }], merged: { count: 1 } }, { queries: 1, merged: false }).ok,
    false,
  );
  // A corpus that was asked for and produced nothing is a failure, not a shrug.
  assert.equal(checkSearch(multi, { queries: 2, corpora: ["arxiv", "pubmed", "nonsense"] }).ok, false);
});

test("checkFetch pins the round trip AND the honest miss", () => {
  const payload = {
    results: [REC("arxiv", "2401.1")],
    not_found: [{ id: "1801.00001", corpus: "arxiv", reason: "not in this corpus's window", window: "months 2310–2607" }],
  };
  assert.equal(checkFetch(payload, "2401.1", "1801.00001").ok, true);
  // The id that was searched for must come back — this is what proves search
  // and fetch agree about the id space.
  assert.equal(checkFetch(payload, "2402.9", "1801.00001").ok, false);
  // Silence about a miss is what makes an agent re-ask, so a dropped id fails.
  assert.equal(checkFetch({ results: payload.results }, "2401.1", "1801.00001").ok, false);
  // …and a reported miss without its window is only half the answer.
  const noWindow = { ...payload, not_found: [{ id: "1801.00001", reason: "absent" }] };
  assert.equal(checkFetch(noWindow, "2401.1", "1801.00001").ok, false);
});

test("checkSimilar requires neighbours and excludes the seed", () => {
  const payload = {
    seed: { corpus: "arxiv", id: "2401.1", title: "Seed paper" },
    results: [REC("arxiv", "2401.2")],
    notes: ["Neighbourhood searched from the stored passage vector."],
  };
  assert.equal(checkSimilar(payload, "2401.1").ok, true);
  assert.match(checkSimilar(payload, "2401.1").detail, /stored passage vector/);
  // A paper is its own nearest neighbour; letting it through would waste a
  // result slot and read as a finding.
  assert.equal(checkSimilar({ ...payload, results: [REC("arxiv", "2401.1")] }, "2401.1").ok, false);
  assert.equal(checkSimilar({ ...payload, results: [] }, "2401.1").ok, false);
  assert.equal(checkSimilar({ ...payload, seed: {} }, "2401.1").ok, false);
});

test("checkFilterDisclosure wants an empty result AND the caveat that explains it", () => {
  const disclosed = {
    queries: [{ results: [] }],
    notes: ["Filters (since/until/categories/journals) are applied AFTER retrieval, to the top-50 reranked candidates."],
  };
  assert.equal(checkFilterDisclosure(disclosed).ok, true);
  // Empty without the caveat is the failure worth catching: a caller reads it
  // as "the corpus holds nothing" when the bound was applied to 50 candidates.
  assert.equal(checkFilterDisclosure({ queries: [{ results: [] }], notes: [] }).ok, false);
  // A filter of "since 2099" returning records means it was not applied at all.
  assert.equal(checkFilterDisclosure({ queries: [{ results: [REC("arxiv", "1")] }], notes: disclosed.notes }).ok, false);
});

test("checkDeepResearch requires a sourced answer", () => {
  assert.equal(checkDeepResearch({ content: [{ type: "text", text: "Stockholm [1].\n\nSources:\n[1] https://x" }] }).ok, true);
  // The Sources list is the pipeline's own output contract; an answer without
  // one means synthesis ran but the source registry did not.
  assert.equal(checkDeepResearch({ content: [{ type: "text", text: "Stockholm." }] }).ok, false);
  assert.equal(checkDeepResearch({ content: [{ type: "text", text: "boom" }], isError: true }).ok, false);
  assert.equal(checkDeepResearch({ content: [{ type: "text", text: "   " }] }).ok, false);
  assert.equal(checkDeepResearch(undefined).ok, false);
});

test("checkBatchSpeedup defends 'not N times the latency', not a fixed factor", () => {
  const fast = checkBatchSpeedup(2000, 9000, 6);
  assert.equal(fast.ok, true);
  assert.equal(fast.info.speedup, 4.5);
  assert.match(fast.detail, /6 angles/);
  // A modest win still passes: network noise makes any fixed threshold a
  // flaky assertion about the internet rather than about the code.
  assert.equal(checkBatchSpeedup(2000, 2400, 6).ok, true);
  // Batching being SLOWER is the only real regression, and it fails.
  assert.equal(checkBatchSpeedup(5000, 3000, 6).ok, false);
  // Never divides by zero on a sub-millisecond clock.
  assert.equal(Number.isFinite(checkBatchSpeedup(0, 100, 6).info.speedup), true);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("summarize counts skips apart from passes and exits on failures", () => {
  const s = summarize([
    { name: "a", verdict: { ok: true, detail: "fine" } },
    { name: "b", verdict: { ok: false, detail: "broken" } },
    { name: "c", verdict: { ok: true, detail: "" }, skipped: "needs --deep" },
  ]);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  // The exit code IS the failure count, so the probe drops into a shell gate.
  assert.equal(s.exitCode, 1);
  assert.match(s.lines[1], /✗ b: broken/);
  assert.match(s.lines[2], /~ c: skipped/);
  assert.equal(summarize([{ name: "a", verdict: { ok: true, detail: "" } }]).exitCode, 0);
});

test("summarize carries the coverage gaps through", () => {
  // A green run that never exercised the key path must not read as a green run
  // of everything — the gaps are part of the verdict.
  const s = summarize([{ name: "a", verdict: { ok: true, detail: "" } }], ["no MCP_KEY — the external-client path went untested"]);
  assert.equal(s.exitCode, 0);
  assert.equal(s.gaps.length, 1);
});

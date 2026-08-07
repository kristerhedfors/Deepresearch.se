// Trigger-path tests for the Shodan enrichment runner
// (src/shodan-enrichment.js) and the network layer underneath it
// (src/shodan.js's runShodanLookup / shodanGet).
//
// WHY THIS FILE EXISTS. Production evidence — chat_logs #1670, 2026-08-06,
// the verbatim question "Ports open on basalt.se" — shows the enrichment
// producing NO context block while the knob was on, the secret configured,
// and the message plainly naming a host. The Worker log for that request
// carries `maps.intent` but not a single `shodan.*` event. src/shodan.test.js
// covers only the pure `extractTargets` / `buildShodanBlock` helpers and never
// mocks fetch, so every branch between "a host was extracted" and "a block was
// appended" was unpinned. This file pins all of them.
//
// What is pinned, in the shape src/enrichment.js states as the contract:
//   * FIRES     — a step is emitted and the labeled block lands on the last
//                 user message;
//   * SILENT    — the SAME array reference comes back, no step, state
//                 untouched;
//   * FAIL-SOFT — every upstream failure (401/403/500, an empty 200, a 404,
//                 a thrown fetch, a non-JSON body) degrades to a visible
//                 "unavailable" step or an honest "no records" block, and
//                 nothing ever throws (CLAUDE.md invariant 2);
//   * BOUNDS    — MAX_LOOKUPS / MAX_PORTS / MAX_PRODUCTS / MAX_VULNS /
//                 MAX_HOSTNAMES_PER_HOST actually hold;
//   * PRIVACY   — outbound requests carry the host/IP and the key and nothing
//                 else: not the question, not a filename, not an identity
//                 (invariant 4);
//   * LANGUAGE  — the gate is host-PRESENCE, not English wording, so the
//                 Swedish twin of every firing message fires identically
//                 (invariant 6).
//
// The root cause these tests found is a /dns/resolve that answers HTTP 200
// with no usable entry for the hostname: runShodanLookup's `!lookups.length`
// early return fired BEFORE its `shodan.lookup` summary, so the whole request
// left no trace at all. That hole was closed on 2026-08-07 (the no-op now logs
// `shodan.skipped` with a reason); the describe block "the formerly-silent
// hole now names its cause in the logs" is its regression guard.
//
// The anaphora blind spot these tests also found — a host named only in an
// EARLIER turn was invisible to the gate — was closed the same day by
// src/shodan-text.js's walk-back route; the "walk-back" describe block is
// its guard, including the negative (a follow-up with no host-intel intent
// must NOT re-scan the earlier host).
//
// ONE defect is pinned here as current-and-unfixed, flagged in place: HOST_RE
// is ASCII-only, so an IDN written in Swedish letters is truncated rather
// than rejected — "räksmörgås.se" goes to Shodan as "s.se".
//
// Deliberately NOT `// @ts-check`: several fail-soft cases feed deliberately
// malformed payloads (a non-JSON body, a `vulns` object where the type says
// array, a null DNS answer) that strict types would reject by design.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { extensionEnrichments } from "./extensions.js";
import { runShodanEnrichment } from "./shodan-enrichment.js";
import { runShodanLookup } from "./shodan.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

const KEY = "shodan-test-key-do-not-log";

// The three verbatim production messages from chat_logs #1670's neighbourhood.
const PROD_FIRES = "Ports open on basalt.se";
const PROD_QUIET_1 = "Shodan";
const PROD_QUIET_2 = "Run through shodan to answer!";

// The example phrasing the capability note itself advertises
// (src/extensions.js, the shodan descriptor's `capability.text`).
const CAPABILITY_EXAMPLE =
  "what services and known vulnerabilities does deepresearch.se expose?";

// ---- harness ---------------------------------------------------------------

const DNS = /api\.shodan\.io\/dns\/resolve/;
const HOSTLOOKUP = /api\.shodan\.io\/shodan\/host\//;

/** The IP out of a `/shodan/host/{ip}` request URL. */
const ipOf = (rec) => new URL(rec.url).pathname.split("/").pop();

/**
 * Routes for the two Shodan endpoints.
 * @param {object|Response|string|null} dns what /dns/resolve answers
 * @param {Record<string, object>} hosts ip -> /shodan/host/{ip} payload
 *   (an absent ip answers 404, Shodan's "not in database")
 */
function routes(dns, hosts = {}) {
  return [
    [DNS, dns === null ? new Response("null", { status: 200 }) : dns],
    [
      HOSTLOOKUP,
      (rec) => {
        const body = hosts[ipOf(rec)];
        if (body === undefined) {
          return new Response(JSON.stringify({ error: "No information available" }), { status: 404 });
        }
        if (body instanceof Response || typeof body === "string") return body;
        return body;
      },
    ],
  ];
}

/**
 * Run the enrichment over a one-message conversation with a stubbed fetch.
 * Mirrors the canonical enrichment harness, adjusted for this runner's
 * POSITIONAL signature: (env, log, step, stepDone, conversation, slice).
 */
async function run(text, opts = {}) {
  const steps = [];
  const log = fakeLog();
  const slice = opts.slice === undefined ? { on: true, count: 0 } : opts.slice;
  const env = opts.env === undefined ? { SHODAN_API_KEY: KEY } : opts.env;
  const conversation =
    opts.conversation !== undefined ? opts.conversation : [{ role: "user", content: text }];
  return withFakeFetch(opts.routes || routes({}), async (stub) => {
    const out = await runShodanEnrichment(
      env,
      log,
      (id, label) => steps.push(["start", id, label]),
      (id, label, details) => steps.push(["done", id, label, details]),
      conversation,
      slice,
    );
    return { out, steps, log, slice, conversation, stub };
  });
}

/** The text of the last message, however its content is shaped. */
const lastText = (convo) => {
  const c = convo[convo.length - 1].content;
  return typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n");
};

/** Every log EVENT name, in order — `log.lines[i].args[0]`. */
const events = (log) => log.lines.map((l) => l.args[0]);

/** A minimal but realistic /shodan/host/{ip} payload. */
function hostPayload(ip, extra = {}) {
  return {
    ip_str: ip,
    org: "Glesys AB",
    isp: "Glesys",
    asn: "AS42708",
    city: "Falkenberg",
    country_name: "Sweden",
    last_update: "2026-08-01T11:22:33.000000",
    ports: [80, 443],
    hostnames: ["basalt.se"],
    data: [{ port: 443, product: "nginx" }],
    vulns: ["CVE-2026-1111"],
    ...extra,
  };
}

// ============================================================================
// FIRES
// ============================================================================

describe("fires — the message names a host", () => {
  test("the verbatim production message 'Ports open on basalt.se' emits a step and appends the block", async () => {
    const { out, steps, conversation, slice } = await run(PROD_FIRES, {
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
    });
    assert.notEqual(out, conversation); // a NEW array — the block landed
    assert.equal(steps[0][0], "start");
    assert.equal(steps[0][1], "shodan");
    assert.match(steps[0][2], /Shodan/);
    assert.deepEqual(steps[steps.length - 1].slice(0, 3), ["done", "shodan", "Shodan: 1 host found"]);
    const text = lastText(out);
    assert.ok(text.startsWith(PROD_FIRES), "the user's own text is preserved, block appended after");
    assert.ok(text.includes("--- Shodan host intelligence"));
    assert.ok(text.includes("--- End of Shodan host intelligence ---"));
    assert.ok(text.includes("Open ports: 80, 443"));
    assert.equal(slice.count, 1);
  });

  test("the capability note's OWN example phrasing fires", async () => {
    // If this ever goes silent, the grounded capabilities note in
    // src/prompts.js is advertising something the gate does not accept.
    const { out, steps, conversation } = await run(CAPABILITY_EXAMPLE, {
      routes: routes(
        { "deepresearch.se": "203.0.113.20" },
        { "203.0.113.20": hostPayload("203.0.113.20", { hostnames: ["deepresearch.se"] }) },
      ),
    });
    assert.notEqual(out, conversation);
    assert.equal(steps[0][1], "shodan");
    assert.ok(lastText(out).includes("deepresearch.se → 203.0.113.20"));
  });

  test("a bare public IPv4 fires with no DNS resolve at all", async () => {
    const { out, steps, stub } = await run("What is running on 8.8.8.8?", {
      routes: routes({}, { "8.8.8.8": hostPayload("8.8.8.8") }),
    });
    assert.equal(stub.matching(DNS).length, 0, "no hostnames -> no /dns/resolve call");
    assert.equal(stub.matching(HOSTLOOKUP).length, 1);
    assert.deepEqual(steps.map((s) => s[0]), ["start", "done"]);
    assert.ok(lastText(out).includes("Host 8.8.8.8 (https://www.shodan.io/host/8.8.8.8)"));
  });

  test("a hostname is resolved first, then host-looked-up, and renders as 'host → ip'", async () => {
    const { out, stub, log } = await run(PROD_FIRES, {
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
    });
    const [dnsReq] = stub.matching(DNS);
    assert.ok(dnsReq, "the hostname went to /dns/resolve");
    assert.equal(new URL(dnsReq.url).searchParams.get("hostnames"), "basalt.se");
    assert.deepEqual(stub.matching(HOSTLOOKUP).map(ipOf), ["203.0.113.10"]);
    assert.ok(lastText(out).includes("basalt.se → 203.0.113.10"));
    assert.ok(events(log).includes("shodan.lookup"));
  });

  test("mixed literal IPs and resolved hostnames dedupe into ONE lookup set", async () => {
    // 1.1.1.1 is named directly AND is what one.example resolves to: it must
    // be looked up once, and the literal wins (no `resolvedFrom` prefix).
    const { out, stub } = await run("compare 1.1.1.1 with one.example and two.example", {
      routes: routes(
        { "one.example": "1.1.1.1", "two.example": "203.0.113.30" },
        { "1.1.1.1": hostPayload("1.1.1.1"), "203.0.113.30": hostPayload("203.0.113.30") },
      ),
    });
    const looked = stub.matching(HOSTLOOKUP).map(ipOf);
    assert.deepEqual(looked, ["1.1.1.1", "203.0.113.30"]);
    assert.equal(new Set(looked).size, looked.length, "no IP looked up twice");
    const text = lastText(out);
    assert.ok(text.includes("Host 1.1.1.1 ("), "the literal IP renders without a hostname arrow");
    assert.ok(!text.includes("one.example → 1.1.1.1"));
    assert.ok(text.includes("two.example → 203.0.113.30"));
  });

  test("the block is appended to a MULTIPART user message without dropping the image part", async () => {
    const conversation = [
      {
        role: "user",
        content: [
          { type: "text", text: PROD_FIRES },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ];
    const { out } = await run(null, {
      conversation,
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
    });
    const parts = out[out.length - 1].content;
    assert.equal(parts.length, 2);
    assert.equal(parts[1].type, "image_url");
    assert.ok(parts[0].text.includes("--- Shodan host intelligence"));
  });
});

// ============================================================================
// DOES NOT FIRE — silent: same array reference, no step, state untouched
// ============================================================================

describe("silent — nothing to look up", () => {
  /** The full silence contract in one assertion set. */
  async function assertSilent(text, opts) {
    const { out, steps, conversation, slice, log, stub } = await run(text, opts);
    assert.equal(out, conversation, "the SAME array reference comes back");
    assert.deepEqual(steps, [], "no activity step is emitted");
    // The runner records that it RAN and matched nothing, so the chat_logs
    // meta can tell this apart from a turn where the knob was off (that turn
    // leaves `intent` undefined and JSON.stringify drops the key).
    assert.deepEqual(slice, { on: true, count: 0, intent: "none" });
    assert.deepEqual(stub.requests, [], "nothing goes out to Shodan");
    assert.deepEqual(log.lines, [], "nothing is logged either");
    return { out, log };
  }

  test("a message with no host at all is silent", async () => {
    await assertSilent("Tell me about the history of Rome.");
  });

  // Verbatim production messages (chat_logs #1671, #1672) that NAME the
  // service and clearly intend a lookup. With NO prior turn to walk back to
  // there is still nothing to query — inventing a target would be worse than
  // answering without one — so these stay silent. What changed on 2026-08-07
  // is that the same two messages AFTER a turn naming a host now fire; see
  // the walk-back tests below.
  test("'Shodan' alone, first message, has nothing to walk back to — silent", async () => {
    await assertSilent(PROD_QUIET_1);
  });

  test("'Run through shodan to answer!' as a first message — silent", async () => {
    await assertSilent(PROD_QUIET_2);
  });

  test("only private / loopback / link-local / CGNAT IPs is silent", async () => {
    await assertSilent("hosts: 10.0.0.1 192.168.1.1 172.16.5.5 127.0.0.1 169.254.1.1 100.64.0.1");
  });

  test("file names that look like domains are silent", async () => {
    await assertSilent("See report.pdf, diagram.png, notes.txt and data.json");
  });

  test("an earlier host with NO host-intel intent in the latest message stays silent", async () => {
    // The walk-back is gated on intent precisely so an ordinary follow-up
    // does not re-bill a lookup for a host mentioned three turns ago.
    const conversation = [
      { role: "user", content: PROD_FIRES },
      { role: "assistant", content: "Here is what I found." },
      { role: "user", content: "Who founded the company?" },
    ];
    const { out, steps, stub } = await run(null, { conversation });
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
    assert.deepEqual(stub.requests, []);
  });
});

// ============================================================================
// THE WALK-BACK — the anaphora blind spot, closed 2026-08-07
// ============================================================================

describe("walk-back — a host named in an EARLIER turn", () => {
  /** @param {string} latest */
  function convoEndingIn(latest) {
    return [
      { role: "user", content: PROD_FIRES },
      { role: "assistant", content: "Here is what I found." },
      { role: "user", content: latest },
    ];
  }

  // The two verbatim production messages that could not fire before
  // (chat_logs #1671, #1672, 2026-08-06). Both followed a turn naming
  // basalt.se, and both now resolve it.
  for (const [label, latest] of [
    ["'Shodan'", PROD_QUIET_1],
    ["'Run through shodan to answer!'", PROD_QUIET_2],
    ["an anaphoric follow-up", "And what about its open ports?"],
    ["the Swedish twin", "Och vilka portar är öppna?"],
  ]) {
    test(`${label} reaches back to the host the previous turn named`, async () => {
      const conversation = convoEndingIn(latest);
      const { out, steps, stub, slice } = await run(null, {
        conversation,
        routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
      });
      assert.equal(new URL(stub.matching(DNS)[0].url).searchParams.get("hostnames"), "basalt.se");
      assert.equal(slice.intent, "walk-back");
      assert.equal(slice.count, 1);
      assert.deepEqual(steps.map((s) => s[0]), ["start", "done"]);
      assert.match(steps[1][2], /from an earlier message/, "the label says the target was not just typed");
      assert.ok(lastText(out).includes("basalt.se → 203.0.113.10"));
    });
  }

  test("assistant turns are never walked back — a source URL is not a target", async () => {
    // An answer is full of third-party source links. Walking those back would
    // spray unrelated hosts at Shodan on every follow-up.
    const conversation = [
      { role: "user", content: "Who founded the company?" },
      { role: "assistant", content: "See https://basalt.se/en/ and https://arxiv.org/abs/1 for details." },
      { role: "user", content: "And its open ports?" },
    ];
    const { out, steps, stub } = await run(null, { conversation });
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
    assert.deepEqual(stub.requests, []);
  });
});

// ============================================================================
// FAILS SOFT — never throws, conversation unchanged, step visible
// ============================================================================

describe("fails soft — upstream errors never break the chat", () => {
  /** The unavailable contract: a step pair, an unchanged conversation. */
  function assertUnavailable({ out, steps, conversation, slice }) {
    assert.equal(out, conversation, "the conversation comes back UNCHANGED");
    assert.deepEqual(steps.map((s) => s[0]), ["start", "done"]);
    assert.equal(steps[1][2], "Shodan lookup unavailable — continuing without it");
    assert.equal(steps[1][3], undefined, "no details list on the unavailable step");
    assert.equal(slice.count, 0);
  }

  for (const status of [401, 403, 500]) {
    test(`/dns/resolve returns ${status} -> shodan.error at warn, conversation unchanged`, async () => {
      const res = await run(PROD_FIRES, {
        routes: routes(new Response("Invalid API key", { status })),
      });
      assertUnavailable(res);
      const warns = res.log.at("warn");
      assert.equal(warns.length, 1);
      assert.equal(warns[0].args[0], "shodan.error");
      assert.equal(warns[0].args[1].status, status);
      assert.equal(warns[0].args[1].path, "/dns/resolve");
      assert.ok(warns[0].args[1].detail.includes("Invalid API key"));
      // The key must never reach a log line (invariant 4).
      res.log.assertNoneLogged([KEY], assert.fail);
    });
  }

  test("/shodan/host/{ip} returns 404 for every target -> the honest 'no records' block still lands", async () => {
    const { out, steps, conversation, slice } = await run("scan 8.8.8.8", {
      routes: routes({}, {}), // every host lookup 404s
    });
    assert.notEqual(out, conversation, "a block IS appended — silence would invite hallucination");
    assert.equal(steps[1][1], "shodan");
    assert.equal(steps[1][2], "Shodan: no records for the host(s) named");
    assert.deepEqual(steps[1][3], ["8.8.8.8 — no Shodan record"]);
    assert.ok(lastText(out).includes("No Shodan records were found for: 8.8.8.8"));
    assert.equal(slice.count, 0, "shodan_hosts stays 0 when nothing was found");
  });

  test("a 404 is logged at INFO, not warn — 'not in database' is the expected case", async () => {
    const { log } = await run("scan 8.8.8.8", { routes: routes({}, {}) });
    assert.deepEqual(log.at("warn"), []);
    const infos = log.at("info").map((l) => [l.args[0], l.args[1]]);
    const err = infos.find(([e]) => e === "shodan.error");
    assert.ok(err, "the 404 is logged");
    assert.equal(err[1].status, 404);
    assert.equal(err[1].detail, "not in database");
  });

  test("some hosts found, some 404 -> the not-found tail appears alongside the found host", async () => {
    const { out, steps, slice } = await run("compare 8.8.8.8 and 1.1.1.1", {
      routes: routes({}, { "8.8.8.8": hostPayload("8.8.8.8") }),
    });
    const text = lastText(out);
    assert.ok(text.includes("Host 8.8.8.8 ("));
    assert.ok(text.includes("No Shodan records for: 1.1.1.1"));
    assert.equal(steps[1][2], "Shodan: 1 host found");
    assert.deepEqual(steps[1][3][steps[1][3].length - 1], "1.1.1.1 — no Shodan record");
    assert.equal(slice.count, 1);
  });

  test("fetch itself throws (network error / timeout) -> shodan.phase_failed warn, no exception escapes", async () => {
    const boom = () => {
      throw new Error("The operation was aborted due to timeout");
    };
    const res = await run(PROD_FIRES, { routes: [[DNS, boom], [HOSTLOOKUP, boom]] });
    assertUnavailable(res);
    const warns = res.log.at("warn");
    assert.equal(warns.length, 1);
    assert.equal(warns[0].args[0], "shodan.phase_failed");
    assert.match(warns[0].args[1].error, /aborted due to timeout/);
  });

  test("a thrown host lookup (after a successful resolve) is also contained", async () => {
    const res = await run(PROD_FIRES, {
      routes: [
        [DNS, { "basalt.se": "203.0.113.10" }],
        [HOSTLOOKUP, () => { throw new Error("connection reset"); }],
      ],
    });
    assertUnavailable(res);
    assert.equal(res.log.at("warn")[0].args[0], "shodan.phase_failed");
  });

  test("a non-JSON 200 body from /dns/resolve does not throw", async () => {
    const res = await run(PROD_FIRES, {
      routes: routes(new Response("<html>maintenance</html>", { status: 200 })),
    });
    assertUnavailable(res);
    assert.deepEqual(res.log.at("warn"), [], "a 200 is never a warn, however malformed");
  });

  test("a non-JSON 200 body from /shodan/host/{ip} does not throw", async () => {
    const { out, steps, conversation } = await run("scan 8.8.8.8", {
      routes: [[DNS, {}], [HOSTLOOKUP, new Response("<html>maintenance</html>", { status: 200 })]],
    });
    assert.notEqual(out, conversation);
    assert.equal(steps[1][2], "Shodan: no records for the host(s) named");
  });

  test("a host payload missing ip_str is dropped rather than rendered as an empty host", async () => {
    const { out, steps } = await run("scan 8.8.8.8", {
      routes: routes({}, { "8.8.8.8": { org: "Nowhere", ports: [22] } }),
    });
    assert.equal(steps[1][2], "Shodan: no records for the host(s) named");
    assert.ok(lastText(out).includes("No Shodan records were found for: 8.8.8.8"));
  });

  test("the secret being absent short-circuits the lookup (guarded upstream by extensionEnabledMap)", async () => {
    // src/settings.js's extensionEnabledMap already refuses to turn the knob
    // on without SHODAN_API_KEY, so this is defence in depth. Note the runner
    // emits its step BEFORE consulting availability, so the user sees
    // "Querying Shodan…" then "unavailable" — the log now says which cause.
    const res = await run(PROD_FIRES, { env: {} });
    assertUnavailable(res);
    assert.deepEqual(res.stub.requests, [], "nothing goes out without a key");
    assert.match(res.log.text(), /shodan\.skipped/);
    assert.match(res.log.text(), /no_api_key/);
  });
});

// ============================================================================
// THE SILENT HOLE — FIXED 2026-08-07. These tests were written against the
// broken behaviour (no log line at all, only a generic "unavailable" step),
// which is what made chat_logs #1670 undiagnosable. They now pin the
// observability that closed it.
// ============================================================================

describe("the formerly-silent hole now names its cause in the logs", () => {
  // SUSPECTED PRODUCTION FAILURE MODE (chat_logs #1670).
  //
  // /dns/resolve answers HTTP 200 with a body that has no entry for the
  // hostname — Shodan returns `{"basalt.se": null}` for a name it cannot
  // resolve, and `{}` when it declines the whole batch. shodanGet sees a 2xx
  // and logs nothing. resolveHostnames finds no string value and returns an
  // empty map. runShodanLookup then hits its `if (!lookups.length) return
  // null` early return at src/shodan.js:339 — BEFORE the `log.info(
  // "shodan.lookup", …)` on line 350. Net effect: one outbound request, zero
  // log events, and a generic "unavailable" step that names no cause.
  //
  // That is exactly the fingerprint #1670 left: `maps.intent` present, no
  // `shodan.*` of any kind. Assert it precisely so a fix has a target.
  for (const [name, body] of [
    ["an empty object", {}],
    ["a null entry for the hostname", { "basalt.se": null }],
    ["an entry that is not a string", { "basalt.se": 12345 }],
    ["an empty-string entry", { "basalt.se": "" }],
    ["a JSON null body", null],
  ]) {
    test(`/dns/resolve 200 with ${name} -> null lookup, logged as shodan.skipped`, async () => {
      const { out, steps, conversation, slice, log, stub } = await run(PROD_FIRES, {
        routes: routes(body),
      });
      // The user-visible half: a step pair with no cause named.
      assert.deepEqual(steps.map((s) => s[0]), ["start", "done"]);
      assert.equal(steps[1][2], "Shodan lookup unavailable — continuing without it");
      assert.equal(out, conversation, "conversation unchanged");
      assert.equal(slice.count, 0);
      // The observability half. Before the fix one request went out and not
      // one line came back, so `shodan_hosts: 0` in the chat_logs meta could
      // not be told apart from "the knob was off". Now the no-op says why.
      assert.equal(stub.matching(DNS).length, 1, "the resolve request DID go out");
      assert.deepEqual(events(log), ["shodan.skipped"]);
      assert.match(log.text(), /unresolved/, "the reason names the resolve, not a generic failure");
    });
  }

  test("runShodanLookup returns null for that same case (the early return, not the enrichment)", async () => {
    const log = fakeLog();
    const result = await withFakeFetch(routes({ "basalt.se": null }), () =>
      runShodanLookup({ SHODAN_API_KEY: KEY }, log, [{ role: "user", content: PROD_FIRES }]),
    );
    assert.equal(result, null);
    assert.deepEqual(events(log), ["shodan.skipped"]);
  });

  test("`shodan_hosts: 0` still cannot distinguish 'never looked up' from 'looked up, found nothing'", async () => {
    // Both branches leave slice.count at 0, so the chat_logs meta key the
    // registry derives from it (src/extensions.js logMeta) stays ambiguous on
    // its own — which is why the registry also reports `shodan_intent`, and
    // why the Worker log now carries a `shodan.skipped` reason.
    const dead = await run(PROD_FIRES, { routes: routes({}) });
    const found = await run("scan 8.8.8.8", { routes: routes({}, {}) });
    assert.equal(dead.slice.count, 0);
    assert.equal(found.slice.count, 0);
    // …and only one of them appended a block, which is the only way to tell.
    assert.equal(dead.out, dead.conversation);
    assert.notEqual(found.out, found.conversation);
  });
});

// ============================================================================
// BOUNDS
// ============================================================================

describe("bounds — fan-out and per-host detail stay capped", () => {
  test("MAX_LOOKUPS = 6 holds across direct IPs AND resolved hostnames combined", async () => {
    // 4 literal IPs (the MAX_IPS cap) + 4 hostnames (the MAX_HOSTNAMES cap)
    // resolving to 4 further distinct IPs = 8 candidates; only 6 may go out,
    // literals first.
    const text =
      "8.8.8.8 1.1.1.1 9.9.9.9 4.4.4.4 a.example b.example c.example d.example";
    const dns = {
      "a.example": "203.0.113.1",
      "b.example": "203.0.113.2",
      "c.example": "203.0.113.3",
      "d.example": "203.0.113.4",
    };
    const { stub } = await run(text, { routes: routes(dns, {}) });
    const looked = stub.matching(HOSTLOOKUP).map(ipOf);
    assert.equal(looked.length, 6, "MAX_LOOKUPS caps the combined set");
    assert.deepEqual(looked.slice(0, 4), ["8.8.8.8", "1.1.1.1", "9.9.9.9", "4.4.4.4"]);
    assert.deepEqual(looked.slice(4), ["203.0.113.1", "203.0.113.2"]);
  });

  test("six literal IPs alone would still cap at MAX_IPS=4 before MAX_LOOKUPS applies", async () => {
    const { stub } = await run("8.8.8.8 1.1.1.1 9.9.9.9 4.4.4.4 5.5.5.5 6.6.6.6", {
      routes: routes({}, {}),
    });
    assert.equal(stub.matching(HOSTLOOKUP).length, 4);
  });

  test("a fat host is truncated: 24 ports, 10 products, 15 CVEs, 6 hostnames", async () => {
    const fat = {
      ip_str: "8.8.8.8",
      org: "Fat Corp",
      // 40 ports, deliberately unsorted and with a duplicate.
      ports: [...Array.from({ length: 40 }, (_, i) => 40 - i), 40],
      hostnames: Array.from({ length: 12 }, (_, i) => `h${i}.example`),
      vulns: Array.from({ length: 30 }, (_, i) => `CVE-2026-${1000 + i}`),
      data: Array.from({ length: 25 }, (_, i) => ({ port: 1000 + i, product: `prod${i}` })),
      last_update: "2026-08-01T11:22:33.000000",
    };
    const { out, steps } = await run("scan 8.8.8.8", { routes: routes({}, { "8.8.8.8": fat }) });
    const text = lastText(out);
    const ports = text.match(/ {2}Open ports: (.*)/)[1].split(", ");
    assert.equal(ports.length, 24, "MAX_PORTS");
    assert.deepEqual(ports.slice(0, 3), ["1", "2", "3"], "sorted ascending, deduped");
    const services = text.match(/ {2}Services: (.*)/)[1].split(", ");
    assert.equal(services.length, 10, "MAX_PRODUCTS");
    assert.equal(services[0], "prod0 (:1000)", "the product label carries its port");
    const cves = text.match(/ {2}Known CVEs: (.*)/)[1].split(", ");
    assert.equal(cves.length, 15, "MAX_VULNS");
    const names = text.match(/ {2}Hostnames: (.*)/)[1].split(", ");
    assert.equal(names.length, 6, "MAX_HOSTNAMES_PER_HOST");
    assert.ok(text.includes("Last seen by Shodan: 2026-08-01"), "the timestamp is date-only");
    assert.equal(steps[1][3][0], "8.8.8.8 — 24 ports, Fat Corp, 15 CVEs");
  });

  test("Shodan's `vulns` normalises from BOTH an array and a CVE-keyed object", async () => {
    const asArray = await run("scan 8.8.8.8", {
      routes: routes({}, { "8.8.8.8": hostPayload("8.8.8.8", { vulns: ["CVE-2026-9001", "CVE-2026-9002"] }) }),
    });
    assert.ok(lastText(asArray.out).includes("Known CVEs: CVE-2026-9001, CVE-2026-9002"));

    const asObject = await run("scan 8.8.8.8", {
      routes: routes({}, {
        "8.8.8.8": hostPayload("8.8.8.8", {
          vulns: {
            "CVE-2026-9001": { verified: false, cvss: 7.5 },
            "CVE-2026-9002": { verified: true, cvss: 9.8 },
          },
        }),
      }),
    });
    assert.ok(lastText(asObject.out).includes("Known CVEs: CVE-2026-9001, CVE-2026-9002"));

    const junk = await run("scan 8.8.8.8", {
      routes: routes({}, { "8.8.8.8": hostPayload("8.8.8.8", { vulns: "CVE-2026-9001" }) }),
    });
    assert.ok(!lastText(junk.out).includes("Known CVEs"), "a string `vulns` yields none, not characters");
  });
});

// ============================================================================
// PRIVACY — invariant 4: the wire carries the host and the key, nothing else
// ============================================================================

describe("privacy — only the host/IP crosses the wire", () => {
  test("no outbound request carries the question, a filename, or any identity", async () => {
    const question =
      "Ports open on basalt.se — cross-check against my attached audit notes.docx for Acme Health, patient roster included";
    const { stub, log } = await run(question, {
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
      slice: { on: true, count: 0 },
    });
    assert.ok(stub.requests.length >= 2, "requests actually went out");
    stub.assertNoneCarry(
      [
        "Ports open on",
        "cross-check",
        "audit notes.docx",
        "Acme Health",
        "patient roster",
        "user-1@example.test",
        "sess_abc123",
      ],
      assert.fail,
    );
    // Every request is api.shodan.io and nothing else.
    assert.deepEqual(stub.hosts(), ["api.shodan.io"]);
    // Positively: the host/IP and the key ARE what is sent.
    const [dnsReq] = stub.matching(DNS);
    assert.equal(new URL(dnsReq.url).searchParams.get("hostnames"), "basalt.se");
    assert.equal(new URL(dnsReq.url).searchParams.get("key"), KEY);
    assert.deepEqual([...new URL(dnsReq.url).searchParams.keys()].sort(), ["hostnames", "key"]);
    const [hostReq] = stub.matching(HOSTLOOKUP);
    assert.deepEqual([...new URL(hostReq.url).searchParams.keys()], ["key"]);
    // And the key never appears in a log line.
    log.assertNoneLogged([KEY], assert.fail);
  });

  test("outbound requests are plain GETs with no body and no custom headers", async () => {
    const { stub } = await run(PROD_FIRES, {
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
    });
    for (const r of stub.requests) {
      assert.equal(r.method, "GET");
      assert.equal(r.body, "");
      assert.ok(!("authorization"/** the key rides the query string */ in r.headers));
      assert.ok(!("cookie" in r.headers));
    }
  });

  test("the error path does not leak the question into the log either", async () => {
    const question = "Ports open on basalt.se for the Acme Health engagement";
    const { log } = await run(question, {
      routes: routes(new Response("Invalid API key", { status: 401 })),
    });
    log.assertNoneLogged(["Acme Health", "engagement", KEY], assert.fail);
  });
});

// ============================================================================
// LANGUAGE INDEPENDENCE — invariant 6
// ============================================================================

describe("language independence — the gate is host presence, not English wording", () => {
  // The Shodan gate has NO phrase list by construction: extractTargets reads
  // IP/FQDN shapes only. These tests exist to make that property load-bearing,
  // so a later "only fire when the message sounds like a security question"
  // change cannot land English-only (or at all) unnoticed.
  const PAIRS = [
    ["Ports open on basalt.se", "vilka portar är öppna på basalt.se?"],
    [
      "what services and known vulnerabilities does deepresearch.se expose?",
      "vilka tjänster och kända sårbarheter exponerar deepresearch.se?",
    ],
    ["which ports are open on 8.8.8.8", "öppna portar på 8.8.8.8"],
    ["scan basalt.se please", "kolla säkerheten för basalt.se tack"],
  ];

  const dns = { "basalt.se": "203.0.113.10", "deepresearch.se": "203.0.113.20" };
  const hosts = {
    "203.0.113.10": hostPayload("203.0.113.10"),
    "203.0.113.20": hostPayload("203.0.113.20"),
    "8.8.8.8": hostPayload("8.8.8.8"),
  };

  for (const [en, sv] of PAIRS) {
    test(`EN/SV parity: "${en}" ⇄ "${sv}"`, async () => {
      const a = await run(en, { routes: routes(dns, hosts) });
      const b = await run(sv, { routes: routes(dns, hosts) });
      // Same step sequence, same lookup set, same host lines.
      assert.deepEqual(a.steps.map((s) => [s[0], s[1], s[2]]), b.steps.map((s) => [s[0], s[1], s[2]]));
      assert.deepEqual(a.stub.matching(HOSTLOOKUP).map(ipOf), b.stub.matching(HOSTLOOKUP).map(ipOf));
      assert.equal(a.slice.count, b.slice.count);
      assert.equal(a.slice.count, 1);
    });
  }

  test("a Swedish message with NO host stays silent, exactly like its English twin", async () => {
    const en = await run("Tell me about the history of Rome.");
    const sv = await run("Berätta om Roms historia.");
    assert.deepEqual(en.steps, []);
    assert.deepEqual(sv.steps, []);
    assert.equal(sv.out, sv.conversation);
  });

  test("å/ä/ö adjacent to the target do not break extraction (the JS \\b trap)", async () => {
    // JS `\b` treats å/ä/ö as NON-word characters, which silently breaks
    // bilingual gates elsewhere in the repo. Here IPV4_RE's `\b` and the
    // ASCII-only HOST_RE both survive a Swedish letter immediately before the
    // target — pin it, because it is not obvious.
    const ip = await run("portar på8.8.8.8?", { routes: routes({}, { "8.8.8.8": hostPayload("8.8.8.8") }) });
    assert.equal(ip.stub.matching(HOSTLOOKUP).length, 1);
    const host = await run("kolla på basalt.se", {
      routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
    });
    assert.deepEqual(host.stub.matching(DNS).map((r) => new URL(r.url).searchParams.get("hostnames")), [
      "basalt.se",
    ]);
  });

  // Was a DEFECT until 2026-08-07. HOST_RE's label class is ASCII (`[a-z0-9-]`,
  // and /i does not extend that to å/ä/ö), so an IDN written in Swedish letters
  // was not rejected — it was TRUNCATED at the last non-ASCII character and the
  // tail queried as if it were the host: "räksmörgås.se" went to Shodan as
  // "s.se". A wrong host, quietly queried and leaked outward. extractTargets
  // now refuses any match preceded by a letter or digit.
  test("an IDN in Swedish letters yields NO target rather than a truncated one", async () => {
    const { out, steps, conversation, stub } = await run("vilka portar är öppna på räksmörgås.se?", {
      routes: routes({ "s.se": "203.0.113.99" }, { "203.0.113.99": hostPayload("203.0.113.99") }),
    });
    assert.deepEqual(stub.requests, [], "nothing goes out — least of all `s.se`");
    assert.deepEqual(steps, []);
    assert.equal(out, conversation);
  });

  test("the truncation guard does not cost ordinary hosts", async () => {
    // The guard fires on a letter/digit immediately before the match, so a
    // host after a space, a slash, a quote or an opening paren still resolves.
    for (const text of [
      "ports open on basalt.se",
      "see https://basalt.se/en/ for ports",
      'the host "basalt.se" — open ports?',
      "(basalt.se) open ports",
    ]) {
      const { stub } = await run(text, {
        routes: routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
      });
      assert.equal(
        new URL(stub.matching(DNS)[0].url).searchParams.get("hostnames"),
        "basalt.se",
        text,
      );
    }
  });
});

// ============================================================================
// WIRING — through the extension registry, not the runner directly
// ============================================================================

describe("wiring — the extension registry actually reaches this runner", () => {
  const shodanEntry = () => extensionEnrichments().find((e) => e.id === "shodan");

  test("the registry exposes a `shodan` enrichment", () => {
    assert.ok(shodanEntry(), "extensionEnrichments() carries the shodan entry");
  });

  test("`enabled` follows slice.on", () => {
    const e = shodanEntry();
    assert.equal(e.enabled({ ext: { shodan: { on: true, count: 0 } } }), true);
    assert.equal(e.enabled({ ext: { shodan: { on: false, count: 0 } } }), false);
    assert.equal(e.enabled({ ext: {} }), false);
    assert.equal(e.enabled({}), false);
  });

  test("with the knob OFF the runner is never reached — no step, no request", async () => {
    const e = shodanEntry();
    const state = { ext: { shodan: { on: false, count: 0 } } };
    assert.equal(e.enabled(state), false);
    // And if something did call run() anyway, prove nothing was consumed by
    // asserting through the same path the pipeline uses.
    const steps = [];
    await withFakeFetch(routes({}), async (stub) => {
      if (e.enabled(state)) {
        await e.run({
          env: { SHODAN_API_KEY: KEY },
          log: fakeLog(),
          emit() {},
          step: (id, label) => steps.push([id, label]),
          stepDone: (id, label) => steps.push([id, label]),
          conversation: [{ role: "user", content: PROD_FIRES }],
          state,
        });
      }
      assert.deepEqual(stub.requests, []);
    });
    assert.deepEqual(steps, []);
  });

  test("with the knob ON the runner fires through the registry and writes slice.count back", async () => {
    const e = shodanEntry();
    const state = { ext: { shodan: { on: true, count: 0 } } };
    const conversation = [{ role: "user", content: PROD_FIRES }];
    const steps = [];
    const out = await withFakeFetch(
      routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
      () =>
        e.run({
          env: { SHODAN_API_KEY: KEY },
          log: fakeLog(),
          emit() {},
          step: (id, label) => steps.push(["start", id, label]),
          stepDone: (id, label) => steps.push(["done", id, label]),
          conversation,
          state,
        }),
    );
    assert.equal(steps[0][1], "shodan");
    assert.notEqual(out, conversation);
    // slice.count is what becomes the `shodan_hosts` chat_logs meta key.
    assert.equal(state.ext.shodan.count, 1);
  });

  test("logMeta turns the written-back count into `shodan_hosts`", async () => {
    const { extensionLogMeta } = await import("./extensions.js");
    assert.equal(extensionLogMeta({ ext: { shodan: { on: true, count: 3 } } }).shodan_hosts, 3);
    assert.equal(extensionLogMeta({ ext: { shodan: { on: true, count: 0 } } }).shodan_hosts, 0);
    assert.equal(extensionLogMeta({ ext: {} }).shodan_hosts, 0);
  });

  test("logMeta reports the deciding matcher as `shodan_intent`, and DROPS it when the knob was off", async () => {
    // The disambiguation chat_logs #1670 lacked: `shodan_hosts: 0` alone is
    // the same number whether the runner never ran or ran and matched
    // nothing. `shodan_intent` separates them — absent vs "none" vs a route
    // name — but only because JSON.stringify drops an undefined value, so the
    // key must stay UNDEFINED (not "", not null) on the knob-off path.
    const { extensionLogMeta } = await import("./extensions.js");
    const off = extensionLogMeta({ ext: { shodan: { on: false, count: 0 } } });
    assert.equal(off.shodan_intent, undefined, "never ran -> no key at all");
    assert.ok(!("shodan_intent" in JSON.parse(JSON.stringify(off))), "and it really is dropped");
    assert.equal(
      extensionLogMeta({ ext: { shodan: { on: true, count: 0, intent: "none" } } }).shodan_intent,
      "none",
      "ran, matched nothing",
    );
    for (const intent of ["latest-host", "walk-back", "org-search", "filter-query"]) {
      assert.equal(
        extensionLogMeta({ ext: { shodan: { on: true, count: 1, intent } } }).shodan_intent,
        intent,
      );
    }
  });

  test("a real run's write-back is what logMeta then reports (end to end through the registry)", async () => {
    const { extensionLogMeta } = await import("./extensions.js");
    const e = shodanEntry();
    const state = { ext: { shodan: { on: true, count: 0 } } };
    await withFakeFetch(
      routes({ "basalt.se": "203.0.113.10" }, { "203.0.113.10": hostPayload("203.0.113.10") }),
      () =>
        e.run({
          env: { SHODAN_API_KEY: KEY },
          log: fakeLog(),
          emit() {},
          step() {},
          stepDone() {},
          conversation: [{ role: "user", content: PROD_FIRES }],
          state,
        }),
    );
    const meta = extensionLogMeta(state);
    assert.equal(meta.shodan_hosts, 1);
    assert.equal(meta.shodan_intent, "latest-host");
  });
});

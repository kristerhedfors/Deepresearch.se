// Unit tests for shodan.js's pure logic: target extraction (public-IP/hostname
// de-noising, caps) and the key-gated availability check.
//
// The NETWORK-CLIENT layer (runShodanLookup / the shodanGet request shape) is
// exercised at the bottom of this file with a stubbed fetch; the full
// trigger-path contract — fires / silent / fail-soft / bounds / privacy /
// Swedish parity — lives in src/shodan-enrichment.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractTargets, shodanAvailable, buildShodanBlock, runShodanLookup, SHODAN_RELEVANCE_NOTE } from "./shodan.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

test("shodanAvailable reflects the SHODAN_API_KEY secret", () => {
  assert.equal(shodanAvailable({}), false);
  assert.equal(shodanAvailable({ SHODAN_API_KEY: "" }), false);
  assert.equal(shodanAvailable({ SHODAN_API_KEY: "k" }), true);
});

test("extractTargets pulls public IPv4 addresses", () => {
  const { ips } = extractTargets("What is running on 8.8.8.8 and 1.1.1.1?");
  assert.deepEqual(ips, ["8.8.8.8", "1.1.1.1"]);
});

test("extractTargets skips private, loopback, link-local and reserved IPs", () => {
  const { ips } = extractTargets(
    "hosts: 10.0.0.1 192.168.1.1 172.16.5.5 127.0.0.1 169.254.1.1 224.0.0.1 100.64.0.1 0.0.0.0",
  );
  assert.deepEqual(ips, []);
});

test("extractTargets rejects out-of-range octets", () => {
  const { ips } = extractTargets("not an ip: 999.1.1.1 and 256.256.256.256");
  assert.deepEqual(ips, []);
});

test("extractTargets dedupes and caps IPs at 4", () => {
  const { ips } = extractTargets("9.9.9.9 9.9.9.9 8.8.8.8 1.1.1.1 4.4.4.4 5.5.5.5 6.6.6.6");
  assert.equal(ips.length, 4);
  assert.equal(new Set(ips).size, ips.length); // deduped
});

test("extractTargets pulls hostnames, including from a URL", () => {
  const { hostnames } = extractTargets("Look at example.com and https://scan.example.org/path");
  assert.ok(hostnames.includes("example.com"));
  assert.ok(hostnames.includes("scan.example.org"));
});

test("extractTargets ignores file names that look like domains", () => {
  const { hostnames } = extractTargets("See report.pdf, diagram.png, notes.txt and data.json");
  assert.deepEqual(hostnames, []);
});

test("extractTargets skips an email address's domain", () => {
  const { hostnames } = extractTargets("mail me at alice@corp.example and check corp.example directly");
  // The bare mention of corp.example is kept; the @-prefixed one is skipped,
  // and dedup means it appears once at most.
  assert.deepEqual(hostnames, ["corp.example"]);
});

test("extractTargets returns empties for host-free text", () => {
  assert.deepEqual(extractTargets("Tell me about the history of Rome."), { ips: [], hostnames: [] });
  assert.deepEqual(extractTargets(""), { ips: [], hostnames: [] });
  assert.deepEqual(extractTargets(null), { ips: [], hostnames: [] });
});

test("extractTargets caps hostnames at 4", () => {
  const { hostnames } = extractTargets("a.com b.com c.com d.com e.com f.com");
  assert.equal(hostnames.length, 4);
});

test("extractTargets lowercases hostnames and trims a trailing dot", () => {
  const { hostnames } = extractTargets("Scan Example.COM. now");
  assert.deepEqual(hostnames, ["example.com"]);
});

// ---- buildShodanBlock — the labeled context block --------------------------

const HOST = {
  ip: "104.21.12.87",
  resolvedFrom: "deepresearch.se",
  org: "Cloudflare, Inc.",
  isp: "Cloudflare, Inc.",
  asn: "AS13335",
  location: "San Francisco, US",
  os: null,
  hostnames: ["www.example.com"],
  ports: [80, 443],
  products: ["nginx"],
  vulns: [],
  lastUpdate: "2026-07-01",
};

test("buildShodanBlock renders host lines inside the labeled block", () => {
  const block = buildShodanBlock([HOST], []);
  assert.ok(block.includes("--- Shodan host intelligence"));
  assert.ok(block.includes("--- End of Shodan host intelligence ---"));
  assert.ok(block.includes("deepresearch.se → 104.21.12.87"));
  assert.ok(block.includes("Open ports: 80, 443"));
});

test("buildShodanBlock frames the data as background context, not part of the ask", () => {
  // The instruction-following guard: a question that merely CONTAINS a
  // hostname must not get infrastructure commentary bolted onto its answer
  // (test point #3's verdict note, 2026-07-15).
  const withHosts = buildShodanBlock([HOST], []);
  assert.ok(withHosts.includes(SHODAN_RELEVANCE_NOTE));
  assert.ok(SHODAN_RELEVANCE_NOTE.includes("not part of the user's request"));
  assert.ok(SHODAN_RELEVANCE_NOTE.includes("do not") && SHODAN_RELEVANCE_NOTE.includes("mention"));
});

test("buildShodanBlock's empty-result block stays honest AND carries the relevance note", () => {
  const block = buildShodanBlock([], ["ghost.example (203.0.113.9)"]);
  assert.ok(block.includes("No Shodan records were found for: ghost.example (203.0.113.9)"));
  assert.ok(block.includes(SHODAN_RELEVANCE_NOTE));
});

test("buildShodanBlock appends the not-found tail when some hosts resolved", () => {
  const block = buildShodanBlock([HOST], ["ghost.example (203.0.113.9)"]);
  assert.ok(block.includes("No Shodan records for: ghost.example (203.0.113.9)"));
});

// ---- the network client: runShodanLookup / the shodanGet request shape -----
//
// Everything above is pure. These pin the REST layer nothing used to touch:
// how the two endpoints are called, in what order, and what the orchestrator
// hands back. The enrichment's own contract is in shodan-enrichment.test.js.

const KEY = "shodan-key-for-request-shape-tests";
const DNS = /\/dns\/resolve/;
const HOSTLOOKUP = /\/shodan\/host\//;
const ipOf = (rec) => new URL(rec.url).pathname.split("/").pop();

/** @param {string} text */
const convo = (text) => [{ role: "user", content: text }];

function payload(ip, extra = {}) {
  return {
    ip_str: ip,
    org: "Glesys AB",
    ports: [443, 80],
    hostnames: [],
    data: [{ port: 443, product: "nginx" }],
    ...extra,
  };
}

/** Runs runShodanLookup against stubbed routes; returns { result, log, stub }. */
async function lookup(text, routes, env = { SHODAN_API_KEY: KEY }) {
  const log = fakeLog();
  return withFakeFetch(routes, async (stub) => ({
    result: await runShodanLookup(env, log, convo(text)),
    log,
    stub,
  }));
}

describe("runShodanLookup — the REST layer", () => {
  test("returns null (and calls nothing) without the key", async () => {
    const { result, stub, log } = await lookup("scan 8.8.8.8", [], {});
    assert.equal(result, null);
    assert.deepEqual(stub.requests, []);
    // The no-op names its cause (added 2026-08-07) rather than being silent.
    assert.match(log.text(), /shodan\.skipped/);
    assert.match(log.text(), /no_api_key/);
  });

  test("returns null (and calls nothing) when the message names no target", async () => {
    const { result, stub } = await lookup("Tell me about the history of Rome.", []);
    assert.equal(result, null);
    assert.deepEqual(stub.requests, []);
  });

  test("hits api.shodan.io over https with the key in the query string", async () => {
    const { stub } = await lookup("scan 8.8.8.8", [[HOSTLOOKUP, payload("8.8.8.8")]]);
    const [req] = stub.requests;
    assert.equal(new URL(req.url).origin, "https://api.shodan.io");
    assert.equal(new URL(req.url).pathname, "/shodan/host/8.8.8.8");
    assert.equal(new URL(req.url).searchParams.get("key"), KEY);
  });

  test("batches every hostname into ONE /dns/resolve call, comma-joined", async () => {
    const { stub } = await lookup("check a.example, b.example and c.example", [
      [DNS, { "a.example": "203.0.113.1", "b.example": "203.0.113.2", "c.example": "203.0.113.3" }],
      [HOSTLOOKUP, (rec) => payload(ipOf(rec))],
    ]);
    const dns = stub.matching(DNS);
    assert.equal(dns.length, 1, "one resolve call, not one per hostname");
    assert.equal(
      new URL(dns[0].url).searchParams.get("hostnames"),
      "a.example,b.example,c.example",
    );
    assert.equal(stub.matching(HOSTLOOKUP).length, 3);
  });

  test("returns the full result shape and logs one shodan.lookup summary", async () => {
    const { result, log } = await lookup("scan basalt.se", [
      [DNS, { "basalt.se": "203.0.113.10" }],
      [HOSTLOOKUP, payload("203.0.113.10")],
    ]);
    assert.deepEqual(Object.keys(result).sort(), ["block", "count", "details", "durationMs", "ips"]);
    assert.equal(result.count, 1);
    assert.deepEqual(result.ips, ["203.0.113.10"]);
    assert.equal(result.details.length, 1);
    assert.ok(result.block.includes("basalt.se → 203.0.113.10"));
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
    const summary = log.lines.find((l) => l.args[0] === "shodan.lookup");
    assert.ok(summary, "the one-line summary is emitted on the success path");
    assert.deepEqual(
      { targets: summary.args[1].targets, hosts: summary.args[1].hosts, hostnames_resolved: summary.args[1].hostnames_resolved },
      { targets: 1, hosts: 1, hostnames_resolved: 1 },
    );
  });

  test("every host lookup 404ing still returns a count:0 result, not null", async () => {
    const { result } = await lookup("scan 8.8.8.8 and 1.1.1.1", [
      [HOSTLOOKUP, new Response("No information available", { status: 404 })],
    ]);
    assert.ok(result, "a result IS returned so the block can say so honestly");
    assert.equal(result.count, 0);
    assert.deepEqual(result.ips, []);
    assert.deepEqual(result.details, ["8.8.8.8 — no Shodan record", "1.1.1.1 — no Shodan record"]);
    assert.ok(result.block.includes("No Shodan records were found for: 8.8.8.8, 1.1.1.1"));
  });

  test("host lookups fan out in parallel, not in series", async () => {
    let inFlight = 0;
    let peak = 0;
    const { result } = await lookup("scan 8.8.8.8 1.1.1.1 9.9.9.9", [
      [
        HOSTLOOKUP,
        async (rec) => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return payload(ipOf(rec));
        },
      ],
    ]);
    assert.equal(result.count, 3);
    assert.equal(peak, 3, "Promise.all issues all three at once");
  });

  test("a non-404 error from a host lookup warns and degrades that host only", async () => {
    const { result, log } = await lookup("scan 8.8.8.8 and 1.1.1.1", [
      [
        HOSTLOOKUP,
        (rec) =>
          ipOf(rec) === "8.8.8.8"
            ? payload("8.8.8.8")
            : new Response("Rate limit reached", { status: 429 }),
      ],
    ]);
    assert.equal(result.count, 1);
    const warn = log.at("warn").find((l) => l.args[0] === "shodan.error");
    assert.ok(warn);
    assert.equal(warn.args[1].status, 429);
    assert.equal(warn.args[1].path, "/shodan/host/1.1.1.1");
    assert.ok(result.block.includes("No Shodan records for: 1.1.1.1"));
    // Invariant 4: the key never reaches a log line.
    log.assertNoneLogged([KEY], assert.fail);
  });

  test("the error `detail` is truncated to 200 characters", async () => {
    const { log } = await lookup("scan 8.8.8.8", [
      [HOSTLOOKUP, new Response("x".repeat(5000), { status: 500 })],
    ]);
    const warn = log.at("warn").find((l) => l.args[0] === "shodan.error");
    assert.equal(warn.args[1].detail.length, 200);
  });
});

// Unit tests for shodan.js's pure logic: target extraction (public-IP/hostname
// de-noising, caps) and the key-gated availability check.
//
// The NETWORK-CLIENT layer (runShodanLookup / the shodanGet request shape) is
// exercised at the bottom of this file with a stubbed fetch; the full
// trigger-path contract — fires / silent / fail-soft / bounds / privacy /
// Swedish parity — lives in src/shodan-enrichment.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SHODAN_RELEVANCE_NOTE,
  buildShodanBlock,
  countHosts,
  cveInfo,
  domainInfo,
  extractTargets,
  productCves,
  runShodanLookup,
  runShodanSearch,
  searchHosts,
  shodanAvailable,
  summarizeVuln,
} from "./shodan.js";
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

// ============================================================================
// THE BROADER LEGS (2026-08-16) — count, domain and CVE
// ============================================================================
//
// Each of these is what one MCP tool calls, and each returns a discriminated
// result rather than the enrichment's bare `null`, so the assertions here are
// mostly about the REASON a failure gives: the whole point of the shape is that
// "no host matches that" and "the plan is out of query credits" stop looking
// alike to a caller.

const COUNT = /\/shodan\/host\/count/;
const SEARCH = /\/shodan\/host\/search/;
const DOMAIN = /\/dns\/domain\//;
const CVE_ONE = /cvedb\.shodan\.io\/cve\//;
const CVE_MANY = /cvedb\.shodan\.io\/cves/;

/** @param {Array<[any, unknown]>} routes */
function withRoutes(routes, fn, env = { SHODAN_API_KEY: KEY }) {
  const log = fakeLog();
  return withFakeFetch(routes, async (stub) => fn({ env, log, stub }));
}

describe("countHosts — the credit-free population leg", () => {
  test("asks for the requested facets in Shodan's field:n syntax and folds the answer", async () => {
    await withRoutes([[COUNT, { total: 91234, facets: { country: [{ value: "SE", count: 500 }, { value: "DE", count: 300 }] } }]], async ({ env, log, stub }) => {
      const found = await countHosts(env, log, "product:nginx", ["country", "port"]);
      assert.equal(found.ok, true);
      assert.equal(found.total, 91234);
      assert.deepEqual(found.facets, [
        { field: "country", values: [{ value: "SE", count: 500 }, { value: "DE", count: 300 }] },
      ]);
      const url = new URL(stub.requests[0].url);
      assert.equal(url.pathname, "/shodan/host/count");
      assert.equal(url.searchParams.get("query"), "product:nginx");
      // `field:n` is how Shodan is asked for the top n values of a field.
      assert.equal(url.searchParams.get("facets"), "country:5,port:5");
      // The count endpoint returns hosts to nobody: `minify` has no meaning
      // here and sending it would be one more thing to be wrong about.
      assert.equal(url.searchParams.get("minify"), null);
    });
  });

  test("no facets means no facets parameter at all", async () => {
    await withRoutes([[COUNT, { total: 12 }]], async ({ env, log, stub }) => {
      const found = await countHosts(env, log, "port:22");
      assert.equal(found.ok, true);
      assert.deepEqual(found.facets, []);
      assert.equal(new URL(stub.requests[0].url).searchParams.get("facets"), null);
    });
  });

  test("an error body becomes a reason a caller can act on, not a bare failure", async () => {
    const body = JSON.stringify({ error: "Insufficient query credits" });
    await withRoutes([[COUNT, new Response(body, { status: 401 })]], async ({ env, log }) => {
      const found = await countHosts(env, log, "port:22");
      assert.equal(found.ok, false);
      // The distinction the whole result shape exists for: this is an operator
      // problem, not an empty result set, and a caller told only "nothing came
      // back" would retry it forever.
      assert.match(found.reason, /Insufficient query credits/);
    });
  });

  test("a missing key and an empty query refuse before any request", async () => {
    await withRoutes([], async ({ log, stub }) => {
      const noKey = await countHosts({}, log, "port:22");
      assert.equal(noKey.ok, false);
      assert.equal(noKey.skipped, "no_api_key");
      const noQuery = await countHosts({ SHODAN_API_KEY: KEY }, log, "   ");
      assert.equal(noQuery.skipped, "empty_query");
      assert.deepEqual(stub.requests, []);
    });
  });
});

describe("searchHosts — paging and the host cap", () => {
  test("page 1 sends no page parameter; a later page does", async () => {
    await withRoutes([[SEARCH, { total: 900, matches: [] }]], async ({ env, log, stub }) => {
      await searchHosts(env, log, "port:443", {});
      assert.equal(new URL(stub.requests[0].url).searchParams.get("page"), null);
      await searchHosts(env, log, "port:443", { page: 3 });
      assert.equal(new URL(stub.requests[1].url).searchParams.get("page"), "3");
    });
  });

  test("maxHosts widens the sample past the enrichment's own cap", async () => {
    const matches = Array.from({ length: 12 }, (_v, i) => ({ ip_str: `203.0.113.${i}`, port: 443 }));
    await withRoutes([[SEARCH, { total: 4000, matches }]], async ({ env, log }) => {
      const narrow = await searchHosts(env, log, "port:443", {});
      assert.equal(narrow.ok && narrow.hosts.length, 8, "the default is the enrichment's cap");
      const wide = await searchHosts(env, log, "port:443", { maxHosts: 10 });
      assert.equal(wide.ok && wide.hosts.length, 10);
      assert.equal(wide.ok && wide.total, 4000, "the total is the population, never the sample");
    });
  });

  test("the enrichment's own runShodanSearch still degrades to null on a failure", async () => {
    // The whole reason searchHosts was split out: a chat turn's only sensible
    // degradation is "no context block", and that contract is unchanged.
    await withRoutes([[SEARCH, new Response("nope", { status: 500 })]], async ({ env, log }) => {
      assert.equal(await runShodanSearch(env, log, "port:443"), null);
    });
  });
});

describe("domainInfo — subdomains and stored DNS records", () => {
  const PAYLOAD = {
    domain: "example.com",
    tags: ["ipv6", "mail"],
    subdomains: ["www", "mail"],
    data: [
      { subdomain: "", type: "A", value: "203.0.113.9", last_seen: "2026-07-01T10:00:00.000000" },
      { subdomain: "www", type: "A", value: "203.0.113.9", last_seen: "2026-07-02T10:00:00.000000" },
      { subdomain: "mail", type: "MX", value: "mx.example.com" },
    ],
    more: true,
  };

  test("record names are made fully qualified, including the apex", async () => {
    await withRoutes([[DOMAIN, PAYLOAD]], async ({ env, log, stub }) => {
      const found = await domainInfo(env, log, "Example.com");
      assert.equal(found.ok, true);
      assert.equal(found.domain, "example.com");
      assert.equal(new URL(stub.requests[0].url).pathname, "/dns/domain/example.com");
      // An empty subdomain is the apex, and a record rendered for "" has lost
      // the thing it was about.
      assert.deepEqual(found.records.map((r) => r.name), ["example.com", "www.example.com", "mail.example.com"]);
      assert.deepEqual(found.records[0].lastSeen, "2026-07-01");
      assert.equal(found.records[2].lastSeen, "", "a record with no timestamp says so rather than inventing one");
      assert.deepEqual(found.tags, ["ipv6", "mail"]);
      assert.equal(found.more, true);
    });
  });

  test("the subdomain TOTAL survives the display cap", async () => {
    const many = { ...PAYLOAD, subdomains: Array.from({ length: 120 }, (_v, i) => `s${i}`) };
    await withRoutes([[DOMAIN, many]], async ({ env, log }) => {
      const found = await domainInfo(env, log, "example.com");
      assert.equal(found.subdomainTotal, 120, "the count is the finding");
      assert.equal(found.subdomains.length, 40, "the list is only the illustration");
    });
  });

  test("a record-type filter and a page travel as parameters", async () => {
    await withRoutes([[DOMAIN, PAYLOAD]], async ({ env, log, stub }) => {
      await domainInfo(env, log, "example.com", { type: "mx", page: 2 });
      const url = new URL(stub.requests[0].url);
      assert.equal(url.searchParams.get("type"), "MX");
      assert.equal(url.searchParams.get("page"), "2");
    });
  });

  test("a domain Shodan has never seen comes back as a reason, not a throw", async () => {
    await withRoutes([[DOMAIN, new Response("No information available", { status: 404 })]], async ({ env, log }) => {
      const found = await domainInfo(env, log, "nothing.example");
      assert.equal(found.ok, false);
      assert.match(found.reason, /not in the database/);
    });
  });
});

describe("cveInfo and productCves — the keyless vulnerability database", () => {
  const LOG4SHELL = {
    cve_id: "CVE-2021-44228",
    summary: "Apache Log4j2 JNDI features do not protect against attacker controlled LDAP. Versions listed below.",
    cvss: 10,
    epss: 0.97,
    kev: true,
    ransomware_campaign: "Known",
    published_time: "2021-12-10T10:15:00",
    propose_action: "Upgrade to 2.17.1.",
    cpes: ["cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*", "cpe:2.3:a:apache:log4j:2.15.0:*:*:*:*:*:*:*"],
  };

  test("a CVE lookup carries NO api key — this database is free and keyless", async () => {
    await withRoutes([[CVE_ONE, LOG4SHELL]], async ({ env, log, stub }) => {
      const found = await cveInfo(env, log, "cve-2021-44228");
      assert.equal(found.ok, true);
      assert.equal(found.vuln.id, "CVE-2021-44228");
      assert.equal(found.vuln.kev, true);
      assert.equal(found.vuln.cvss, 10);
      assert.equal(found.vuln.published, "2021-12-10");
      // The CPE strings are machine identifiers; the vendor and product
      // segments are the only parts a person hears as words. Duplicates across
      // versions collapse.
      assert.deepEqual(found.vuln.products, ["apache log4j"]);
    // The CPE list is alphabetical, so the kept products are the
    // alphabetically-first ones — the total travels beside them so a renderer
    // cannot state a sample as the population (live read, 2026-08-16: six of
    // 147 for this CVE).
    assert.equal(found.vuln.productTotal, 1);
      assert.equal(stub.requests.length, 1);
      assert.equal(new URL(stub.requests[0].url).origin, "https://cvedb.shodan.io");
      assert.equal(new URL(stub.requests[0].url).searchParams.get("key"), null);
      stub.assertNoneCarry([KEY], assert.fail);
    });
  });

  test("the CVE database works on a server with no Shodan credential at all", async () => {
    await withRoutes([[CVE_ONE, LOG4SHELL]], async ({ log }) => {
      const found = await cveInfo({}, log, "CVE-2021-44228");
      assert.equal(found.ok, true);
    }, {});
  });

  test("an unknown id says so about the id, rather than about the request", async () => {
    await withRoutes([[CVE_ONE, new Response("{}", { status: 404 })]], async ({ env, log }) => {
      const found = await cveInfo(env, log, "CVE-1999-0001");
      assert.equal(found.ok, false);
      assert.match(found.reason, /no record of CVE-1999-0001/);
    });
  });

  test("a product search ranks by EPSS and can be narrowed to known-exploited", async () => {
    await withRoutes([[CVE_MANY, { cves: [LOG4SHELL, { ...LOG4SHELL, cve_id: "CVE-2021-45046", epss: 0.5 }] }]], async ({ env, log, stub }) => {
      const found = await productCves(env, log, { product: "log4j", kevOnly: true, limit: 5 });
      assert.equal(found.ok, true);
      assert.equal(found.vulns.length, 2);
      assert.equal(found.subject, "log4j");
      const url = new URL(stub.requests[0].url);
      // Sorting by EPSS is what makes the answer about what is being exploited
      // rather than about what merely scores highly.
      assert.equal(url.searchParams.get("sort_by_epss"), "true");
      assert.equal(url.searchParams.get("is_kev"), "true");
      assert.equal(url.searchParams.get("product"), "log4j");
      assert.equal(url.searchParams.get("limit"), "5");
    });
  });

  test("an unscored vulnerability keeps its severities null rather than zero", async () => {
    // 0 is a real CVSS score and "unscored" is not it; a summary that reports
    // a missing figure as 0.0 has invented a finding.
    const vuln = summarizeVuln({ cve_id: "CVE-2030-1", summary: "x", cvss: null, epss: undefined });
    assert.equal(vuln.cvss, null);
    assert.equal(vuln.epss, null);
    assert.equal(vuln.kev, false);
    assert.deepEqual(vuln.products, []);
    assert.equal(vuln.productTotal, 0);
  });

  test("every distinct product is COUNTED even though only a few are kept", async () => {
    const cpes = Array.from({ length: 30 }, (_v, i) => `cpe:2.3:a:vendor${i}:product${i}:1.0:*:*:*:*:*:*:*`);
    const vuln = summarizeVuln({ cve_id: "CVE-2030-2", cpes });
    assert.equal(vuln.products.length, 6, "only a handful are speakable");
    assert.equal(vuln.productTotal, 30, "but the whole list is counted");
  });
});

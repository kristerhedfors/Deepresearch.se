// Unit tests for src/shodan-tools.js — the pure half of the host-intelligence
// MCP tool: target parsing and the spoken renderers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CVE_INTEL_TOOL,
  DOMAIN_INTEL_TOOL,
  FACET_FIELDS,
  HOST_INTEL_TOOL,
  HOST_SEARCH_TOOL,
  MAX_CVES,
  MAX_FACET_FIELDS,
  MAX_HOSTS,
  MAX_SEARCH_HOSTS,
  MAX_SURVEY_HOSTS,
  SHODAN_MCP_TOOLS,
  clampCount,
  clampHostLimit,
  parseCveId,
  parseDomain,
  parseFacets,
  parseHosts,
  parentDomain,
  renderCveAnswer,
  renderDomainAnswer,
  renderHostAnswer,
  renderHostLine,
  renderProductCveAnswer,
  renderSearchAnswer,
  renderSurveyAnswer,
} from "./shodan-tools.js";

test("addresses and hostnames are sorted into the two lists the lookup takes", () => {
  const { ips, hostnames } = parseHosts(["8.8.8.8", "example.com", "2001:db8::1"]);
  assert.deepEqual(ips, ["8.8.8.8", "2001:db8::1"]);
  assert.deepEqual(hostnames, ["example.com"]);
});

test("a model's idea of a list is accepted in every shape it produces", () => {
  assert.deepEqual(parseHosts("8.8.8.8, example.com").hostnames, ["example.com"]);
  assert.deepEqual(parseHosts("8.8.8.8 example.com").ips, ["8.8.8.8"]);
  // A pasted URL is a hostname with decoration; taking the host out of it beats
  // refusing something the caller clearly meant.
  assert.deepEqual(parseHosts(["https://example.com/path?q=1"]).hostnames, ["example.com"]);
  assert.deepEqual(parseHosts(["Example.COM."]).hostnames, ["example.com"]);
  assert.deepEqual(parseHosts([]), { ips: [], hostnames: [] });
  assert.deepEqual(parseHosts(undefined), { ips: [], hostnames: [] });
  assert.deepEqual(parseHosts(42), { ips: [], hostnames: [] });
});

test("duplicates collapse and the total is capped", () => {
  assert.deepEqual(parseHosts(["8.8.8.8", "8.8.8.8"]).ips, ["8.8.8.8"]);
  const many = parseHosts(Array.from({ length: 20 }, (_v, i) => `host${i}.example.com`));
  assert.equal(many.hostnames.length, MAX_HOSTS);
  // Bare words with no dot are neither an address nor a hostname — each one
  // would otherwise cost a DNS round trip to learn nothing.
  assert.deepEqual(parseHosts(["localhost", "router"]), { ips: [], hostnames: [] });
});

test("the search limit clamps rather than refusing", () => {
  assert.equal(clampHostLimit(3), 3);
  assert.equal(clampHostLimit(0), MAX_SEARCH_HOSTS);
  assert.equal(clampHostLimit(999), MAX_SEARCH_HOSTS);
  assert.equal(clampHostLimit("two"), MAX_SEARCH_HOSTS);
});

test("the lookup answer distinguishes a host with no record from one with no ports", () => {
  const found = renderHostAnswer({
    targets: 2,
    details: ["8.8.8.8 — 2 open ports: 53/domain, 443/https"],
    notFound: ["example.com"],
  });
  assert.match(found, /8\.8\.8\.8/);
  // "No record" and "closed" are different findings, and a summary that blurs
  // them is worse than none.
  assert.match(found, /not in their index, not that the host is closed/);
  assert.match(renderHostAnswer({ targets: 1, details: [], notFound: [] }), /returned nothing/);
});

test("a search answer says how many matched, not just how many were listed", () => {
  const text = renderSearchAnswer({
    query: "product:nginx",
    details: ["1.2.3.4 — nginx 1.24", "5.6.7.8 — nginx 1.18"],
    count: 2,
    total: 91234,
  });
  assert.match(text, /about 91234 hosts/);
  assert.match(text, /here are 2/);
  // Without the total, a handful of hosts reads as a claim about the internet.
  const small = renderSearchAnswer({ query: "x", details: ["1.2.3.4 — thing"], count: 1, total: 1 });
  assert.match(small, /matches 1 host for/);
  assert.match(renderSearchAnswer({ query: "x", details: [], count: 0, total: 0 }), /no hosts matching/);
});

test("the schema offers both shapes and requires neither", () => {
  assert.equal(HOST_INTEL_TOOL.name, "host_intel");
  assert.ok(HOST_INTEL_TOOL.input_schema.properties.hosts);
  assert.ok(HOST_INTEL_TOOL.input_schema.properties.query);
  assert.deepEqual(HOST_INTEL_TOOL.input_schema.required, []);
  // The description must say what this does NOT do: a caller's model reading
  // "host intelligence" could reasonably assume it scans something.
  assert.match(HOST_INTEL_TOOL.description, /Nothing is scanned or probed/);
});

// ============================================================================
// THE BROADER FAMILY (2026-08-16) — host_search, domain_intel, cve_intel
// ============================================================================

test("every tool in the family says what it does NOT do", () => {
  assert.deepEqual(
    SHODAN_MCP_TOOLS.map((t) => t.name),
    ["host_intel", "host_search", "domain_intel", "cve_intel"],
  );
  for (const tool of SHODAN_MCP_TOOLS) {
    assert.equal(tool.input_schema.type, "object");
    assert.ok(tool.description.length > 80, `${tool.name} needs a description written for a calling model`);
  }
  // A caller's model reading "host intelligence" could reasonably assume
  // something gets probed. Both tools that reach live infrastructure data say
  // otherwise in the description the model actually sees.
  assert.match(HOST_SEARCH_TOOL.description, /Nothing is scanned/);
  // The search tool is useless without the filter vocabulary: a guessed filter
  // name returns an empty result set with no clue why.
  assert.match(HOST_SEARCH_TOOL.description, /port:/);
  assert.match(HOST_SEARCH_TOOL.description, /country:/);
  assert.deepEqual(HOST_SEARCH_TOOL.input_schema.required, ["query"]);
  assert.deepEqual(DOMAIN_INTEL_TOOL.input_schema.required, ["domain"]);
  // cve_intel takes either shape, so it can require neither.
  assert.deepEqual(CVE_INTEL_TOOL.input_schema.required, []);
});

test("facet fields are validated against the offered list, not forwarded", () => {
  assert.deepEqual(parseFacets(["country", "port"]).fields, ["country", "port"]);
  assert.deepEqual(parseFacets("country, org").fields, ["country", "org"]);
  // Shodan rejects the WHOLE request for one bad facet, so a guess is dropped
  // here rather than costing the count as well as the breakdown.
  const guessed = parseFacets(["country", "hostname", "banner"]);
  assert.deepEqual(guessed.fields, ["country"]);
  assert.deepEqual(guessed.dropped, ["hostname", "banner"]);
  // `field:n` is Shodan's own "top n values" form; the field is what is checked.
  assert.deepEqual(parseFacets(["port:10"]).fields, ["port"]);
  assert.deepEqual(parseFacets(["country", "country"]).fields, ["country"]);
  assert.equal(parseFacets(FACET_FIELDS.concat(FACET_FIELDS)).fields.length, MAX_FACET_FIELDS);
  assert.deepEqual(parseFacets(undefined), { fields: [], dropped: [] });
});

test("a domain is taken out of whatever shape it arrives in", () => {
  assert.equal(parseDomain("Example.COM"), "example.com");
  assert.equal(parseDomain("https://www.example.com/path?q=1"), "www.example.com");
  assert.equal(parseDomain("alice@example.com"), "example.com");
  assert.equal(parseDomain("example.com."), "example.com");
  // An address is a different tool's question, and a bare label is not a domain.
  assert.equal(parseDomain("8.8.8.8"), "");
  assert.equal(parseDomain("localhost"), "");
  assert.equal(parseDomain(""), "");
  assert.equal(parseDomain(42), "");
});

test("the parent domain is exactly one level up, never a walk to the TLD", () => {
  assert.equal(parentDomain("www.example.com"), "example.com");
  // example.co.uk is a domain and co.uk is not, and nothing short of a
  // public-suffix list can tell those apart — so this stops after one step.
  assert.equal(parentDomain("www.example.co.uk"), "example.co.uk");
  assert.equal(parentDomain("example.com"), "");
});

test("a CVE id is normalized, and a non-id is refused rather than guessed at", () => {
  assert.equal(parseCveId("CVE-2021-44228"), "CVE-2021-44228");
  // A caller reading one out of a host record often drops the prefix.
  assert.equal(parseCveId("2021-44228"), "CVE-2021-44228");
  assert.equal(parseCveId("cve 2021-44228"), "CVE-2021-44228");
  assert.equal(parseCveId("log4shell"), "");
  assert.equal(parseCveId("CVE-21-4"), "");
  assert.equal(parseCveId(""), "");
});

test("the survey answer leads with the population, not with the sample", () => {
  const text = renderSurveyAnswer({
    query: "product:nginx",
    total: 91234,
    counted: true,
    page: 1,
    facets: [{ field: "country", values: [{ value: "US", count: 4102 }, { value: "DE", count: 991 }] }],
    hosts: ["203.0.113.1 at Glesys AB: ports 80, 443 open."],
    countOnly: false,
    dropped: [],
  });
  // The number of matching hosts is the finding; the handful described is an
  // illustration of it. An answer that opens with one machine has told the
  // listener that one is the answer.
  assert.ok(text.indexOf("91234") < text.indexOf("203.0.113.1"));
  assert.match(text, /By country, the largest are US with 4102 and DE with 991/);
  assert.match(text, /Here is one of them/);
});

test("count_only reports the breakdown and describes no hosts", () => {
  const text = renderSurveyAnswer({
    query: "port:22",
    total: 5,
    counted: true,
    page: 1,
    facets: [],
    hosts: ["203.0.113.1"],
    countOnly: true,
    dropped: [],
  });
  assert.match(text, /matches 5 hosts/);
  assert.doesNotMatch(text, /203\.0\.113\.1/);
});

test("an unrecognized facet is reported with the fields that would have worked", () => {
  const text = renderSurveyAnswer({
    query: "port:22", total: 1, counted: true, page: 1, facets: [], hosts: [], countOnly: true,
    dropped: ["banner"],
  });
  assert.match(text, /banner is not a field/);
  assert.match(text, /country/);
});

test("a page past the end is not the same finding as no matches", () => {
  const empty = renderSurveyAnswer({ query: "x", total: 0, counted: true, page: 1, facets: [], hosts: [], countOnly: false, dropped: [] });
  assert.match(empty, /Nothing in Shodan's index matches/);
  const past = renderSurveyAnswer({ query: "x", total: 400, counted: true, page: 9, facets: [], hosts: [], countOnly: false, dropped: [] });
  assert.match(past, /No hosts came back on page 9, though the query itself matches/);
});

test("a host clause reads as a sentence, with the CVE count before the ids", () => {
  const line = renderHostLine({
    ip: "203.0.113.1",
    org: "Glesys AB",
    location: "Falkenberg, Sweden",
    hostnames: ["web.example.se"],
    ports: [80, 443],
    products: ["nginx"],
    vulns: ["CVE-2021-44228", "CVE-2021-45046"],
  });
  assert.match(line, /203\.0\.113\.1, which answers to web\.example\.se at Glesys AB in Falkenberg, Sweden/);
  // How bad comes before which: a listener needs the count first.
  assert.ok(line.indexOf("2 known vulnerabilities") < line.indexOf("CVE-2021-44228"));
  assert.match(line, /\.$/);
  // A bare host with nothing known is still a sentence, not a fragment.
  assert.equal(renderHostLine({ ip: "203.0.113.2" }), "203.0.113.2.");
});

test("the domain answer leads with the subdomain count and dates its own records", () => {
  const text = renderDomainAnswer({
    domain: "example.com",
    asked: "",
    tags: ["mail"],
    subdomains: ["www", "mail"],
    subdomainTotal: 120,
    records: [{ name: "www.example.com", type: "A", value: "203.0.113.9", lastSeen: "2026-07-02" }],
    more: true,
    type: "",
  });
  assert.match(text, /Shodan knows 120 subdomains of example\.com, among them www and mail/);
  assert.match(text, /www\.example\.com A points to 203\.0\.113\.9, last seen 2026-07-02/);
  assert.match(text, /more records than fit on this page/);
  // Said once, at the end: a listener who does not know these are stored
  // observations will read a stale record as current.
  assert.match(text, /not a live DNS lookup/);
});

test("answering about a different name than the one asked about is stated, never silent", () => {
  const text = renderDomainAnswer({
    domain: "example.com",
    asked: "www.example.com",
    tags: [],
    subdomains: [],
    subdomainTotal: 0,
    records: [],
    more: false,
    type: "",
  });
  assert.match(text, /www\.example\.com is not a domain Shodan tracks on its own, so this is example\.com/);
});

test("the CVE answer keeps severity and exploitation probability apart", () => {
  const text = renderCveAnswer({
    id: "CVE-2021-44228",
    summary: "Apache Log4j2 JNDI features do not protect against attacker controlled LDAP.",
    cvss: 10,
    epss: 0.97,
    kev: true,
    ransomware: "Known",
    published: "2021-12-10",
    products: ["apache log4j"],
    action: "Upgrade to 2.17.1.",
  });
  // CVSS says how bad it would be, EPSS says how likely it is to happen, and
  // reporting one as the other is the commonest way this misleads.
  assert.match(text, /CVSS severity of 10 out of 10/);
  assert.match(text, /EPSS score of 97%, the estimated chance it is exploited in the wild in the next 30 days/);
  assert.match(text, /known-exploited list/);
  assert.match(text, /ransomware/);
  assert.match(text, /Upgrade to 2\.17\.1/);
});

test("an unscored vulnerability simply omits the scores", () => {
  const text = renderCveAnswer({
    id: "CVE-2030-0001", summary: "Something.", cvss: null, epss: null,
    kev: false, ransomware: "", published: "", products: [], action: "",
  });
  assert.equal(text, "CVE-2030-0001: Something.");
});

test("a product listing says how it is ranked, and an empty one says why it might be", () => {
  const text = renderProductCveAnswer({
    subject: "log4j",
    kevOnly: false,
    vulns: [
      { id: "CVE-2021-44228", summary: "JNDI features do not protect against LDAP. Affected versions follow.", cvss: 10, epss: 0.97, kev: true, ransomware: "", published: "" },
    ],
  });
  assert.match(text, /most likely to be exploited first/);
  assert.match(text, /CVE-2021-44228 — severity 10, 97% exploitation probability, known exploited/);
  // Only the first clause of the summary: the rest is a version table nobody
  // can hear.
  assert.doesNotMatch(text, /Affected versions follow/);
  const none = renderProductCveAnswer({ subject: "nginx", kevOnly: false, vulns: [] });
  assert.match(none, /try the exact product name a banner reports/);
  const noKev = renderProductCveAnswer({ subject: "nginx", kevOnly: true, vulns: [] });
  assert.match(noKev, /no known-exploited vulnerabilities/);
});

test("counts clamp rather than refuse, in both directions", () => {
  assert.equal(clampCount(3, MAX_CVES), 3);
  assert.equal(clampCount(999, MAX_CVES), MAX_CVES);
  assert.equal(clampCount(0, MAX_SURVEY_HOSTS), MAX_SURVEY_HOSTS);
  assert.equal(clampCount("many", MAX_SURVEY_HOSTS), MAX_SURVEY_HOSTS);
});

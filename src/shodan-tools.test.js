// Unit tests for src/shodan-tools.js — the pure half of the host-intelligence
// MCP tool: target parsing and the spoken renderers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_INTEL_TOOL,
  MAX_HOSTS,
  MAX_SEARCH_HOSTS,
  clampHostLimit,
  parseHosts,
  renderHostAnswer,
  renderSearchAnswer,
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

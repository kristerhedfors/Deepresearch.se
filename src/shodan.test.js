import { test } from "node:test";
import assert from "node:assert/strict";

import { extractTargets, shodanAvailable } from "./shodan.js";

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

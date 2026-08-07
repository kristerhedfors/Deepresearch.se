// @ts-check
// Shodan host-intelligence integration ("Shodan MCP" in the UI) — an
// opt-in per-user knob (src/settings.js's `shodan_mcp`, default OFF).
//
// The research pipeline (src/pipeline.js) has no function calling, so this
// is wired the same deterministic way as the reverse-geocoder
// (src/geocode.js): when the knob is on and the SHODAN_API_KEY secret is
// configured, the Worker deterministically extracts any IP addresses and
// hostnames from the latest user message and resolves them into structured
// infrastructure data (open ports, running services, organization, ASN,
// hosting location, and known CVEs) via Shodan's REST API. That data is
// appended to the conversation as one labeled context block every
// downstream phase (triage/search/synthesis/direct) can reason and search
// with — never silently blended into the user's own text.
//
// Runs server-side, same as Berget/Exa/Nominatim: Worker-mediated so it's
// logged, timeout-bounded, and the API key never reaches the browser. The
// only thing that crosses the wire to Shodan is the host/IP itself — never
// the user's question, filename, or any account/session identifier.
//
// Fails soft in every branch: a missing key, a bad target, a Shodan
// timeout/error, or a host simply not present in Shodan's database all
// degrade to "no host intelligence" rather than blocking or delaying the
// chat. Shodan lookups are enrichment, never a hard requirement.

import { textOf, lastUserMessage } from "./conversation.js";
import { extractTargets } from "./shodan-text.js";

// Target extraction moved to shodan-text.js (2026-08-07), which is where the
// file's own header always said it belonged — "split out of shodan.js the same
// way googlemaps-text.js was split out of googlemaps.js". Until then this
// module was the one holding it, so shodan-text.js had to import BACK from the
// network client and was the only `-text.js` in the repo that was not a leaf.
// Re-exported here so the import surface (shodan.test.js) is unchanged.
export { extractTargets };

const SHODAN_BASE = "https://api.shodan.io";
const TIMEOUT_MS = 8000;
// Bounds on how much one message can fan out to Shodan — keeps credit spend
// and CPU/latency predictable regardless of how many host-shaped tokens a
// message happens to contain. The extraction-side caps (MAX_HOSTNAMES,
// MAX_IPS) sit with extractTargets in shodan-text.js.
const MAX_LOOKUPS = 6; // unique IPs actually host-looked-up (direct + resolved)
// Per-host detail caps for the context block — a busy host can carry
// hundreds of ports/banners/CVEs; a research summary needs a readable subset.
const MAX_PORTS = 24;
const MAX_PRODUCTS = 10;
const MAX_VULNS = 15;
const MAX_HOSTNAMES_PER_HOST = 6;

/** @param {import('./types.js').Env} env */
export function shodanAvailable(env) {
  return !!env.SHODAN_API_KEY;
}

/** @typedef {import('./shodan-text.js').ShodanTargets} ShodanTargets */
/**
 * One host normalized down to the fields a research summary uses.
 * @typedef {object} ShodanHost
 * @property {string} ip
 * @property {string | null} resolvedFrom hostname the IP came from, if any
 * @property {string} org
 * @property {string} isp
 * @property {string} asn
 * @property {string} os
 * @property {string} location
 * @property {string} lastUpdate ISO date (YYYY-MM-DD), or ""
 * @property {number[]} ports
 * @property {string[]} hostnames
 * @property {string[]} products
 * @property {string[]} vulns known CVE ids
 */

// ---- Shodan REST calls -----------------------------------------------------

/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} path REST path under SHODAN_BASE
 * @param {Record<string, string>} params query params (the API key is added here)
 * @returns {Promise<any | null>} parsed JSON, or null on 404/error
 */
async function shodanGet(env, log, path, params) {
  const qs = new URLSearchParams({ ...params, key: String(env.SHODAN_API_KEY || "") });
  const url = `${SHODAN_BASE}${path}?${qs}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    // 404 = host simply isn't in Shodan's database (the common, expected
    // "no data" case); anything else is a real error worth a warn.
    const detail = resp.status === 404 ? "not in database" : await resp.text().catch(() => "");
    log[resp.status === 404 ? "info" : "warn"]("shodan.error", {
      path,
      status: resp.status,
      detail: typeof detail === "string" ? detail.slice(0, 200) : "",
    });
    return null;
  }
  return resp.json().catch(() => null);
}

// Batch-resolves hostnames to IPs (Shodan's DNS resolve endpoint costs no
// query credits). Returns a Map hostname -> ip (only successful resolves).
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string[]} hostnames
 * @returns {Promise<Map<string, string>>}
 */
async function resolveHostnames(env, log, hostnames) {
  const out = new Map();
  if (!hostnames.length) return out;
  const data = await shodanGet(env, log, "/dns/resolve", { hostnames: hostnames.join(",") });
  if (data && typeof data === "object") {
    for (const host of hostnames) {
      const ip = data[host];
      if (typeof ip === "string" && ip) out.set(host, ip);
    }
  }
  return out;
}

// Normalizes Shodan's /shodan/host/{ip} payload into the fields a research
// summary actually uses, all bounded. Shodan's `vulns` can be an array or an
// object keyed by CVE; both are handled.
/**
 * @param {any} data raw /shodan/host/{ip} payload
 * @param {string | null} resolvedFrom hostname the IP came from, if any
 * @returns {ShodanHost}
 */
function summarizeHost(data, resolvedFrom) {
  const ports = Array.isArray(data.ports)
    ? [...new Set(data.ports.filter((/** @type {unknown} */ p) => Number.isFinite(p)))].sort((/** @type {number} */ a, /** @type {number} */ b) => a - b).slice(0, MAX_PORTS)
    : [];
  const hostnames = Array.isArray(data.hostnames)
    ? data.hostnames.filter((/** @type {unknown} */ h) => typeof h === "string").slice(0, MAX_HOSTNAMES_PER_HOST)
    : [];
  const vulnsRaw = Array.isArray(data.vulns)
    ? data.vulns
    : data.vulns && typeof data.vulns === "object"
      ? Object.keys(data.vulns)
      : [];
  const vulns = vulnsRaw.filter((/** @type {unknown} */ v) => typeof v === "string").slice(0, MAX_VULNS);
  // Distinct product names from the banner list (minify=false keeps `data`).
  const products = [];
  const seenProd = new Set();
  for (const banner of Array.isArray(data.data) ? data.data : []) {
    const name = typeof banner?.product === "string" ? banner.product.trim() : "";
    if (!name || seenProd.has(name)) continue;
    seenProd.add(name);
    const label = Number.isFinite(banner?.port) ? `${name} (:${banner.port})` : name;
    if (products.length < MAX_PRODUCTS) products.push(label);
  }
  return {
    ip: data.ip_str || "",
    resolvedFrom: resolvedFrom || null,
    org: typeof data.org === "string" ? data.org : "",
    isp: typeof data.isp === "string" ? data.isp : "",
    asn: typeof data.asn === "string" ? data.asn : "",
    os: typeof data.os === "string" ? data.os : "",
    location: [data.city, data.country_name].filter((s) => typeof s === "string" && s).join(", "),
    lastUpdate: typeof data.last_update === "string" ? data.last_update.slice(0, 10) : "",
    ports,
    hostnames,
    products,
    vulns,
  };
}

// Renders one summarized host as compact, readable lines for the context
// block. Deliberately plain text — the same convention as geocode.js's and
// the client's own metadata blocks.
/** @param {ShodanHost} h */
function renderHost(h) {
  const header = h.resolvedFrom ? `${h.resolvedFrom} → ${h.ip}` : h.ip;
  const lines = [`Host ${header} (https://www.shodan.io/host/${h.ip}):`];
  if (h.org || h.isp) lines.push(`  Organization: ${[h.org, h.isp && h.isp !== h.org ? `ISP ${h.isp}` : ""].filter(Boolean).join(" · ")}`);
  if (h.asn) lines.push(`  ASN: ${h.asn}`);
  if (h.location) lines.push(`  Location: ${h.location}`);
  if (h.os) lines.push(`  OS: ${h.os}`);
  if (h.hostnames.length) lines.push(`  Hostnames: ${h.hostnames.join(", ")}`);
  if (h.ports.length) lines.push(`  Open ports: ${h.ports.join(", ")}`);
  if (h.products.length) lines.push(`  Services: ${h.products.join(", ")}`);
  if (h.vulns.length) lines.push(`  Known CVEs: ${h.vulns.join(", ")}`);
  if (h.lastUpdate) lines.push(`  Last seen by Shodan: ${h.lastUpdate}`);
  return lines.join("\n");
}

// The block must present itself as background data, not as part of the ask:
// without this line, a compute-style question that merely CONTAINS a hostname
// (e.g. "hash the text deepresearch.se") gets an answer padded with
// unrequested infrastructure commentary (test point #3's verdict note,
// 2026-07-15 — the instruction-following complaint).
export const SHODAN_RELEVANCE_NOTE =
  "This lookup ran automatically because the message names a host — it is background context, " +
  "not part of the user's request. Use it only if the question is actually about this host's " +
  "infrastructure, services, or security posture; otherwise ignore it entirely and do not " +
  "mention it in the answer.";

// Assembles the labeled context block from the summarized hosts + the
// not-found list. Pure — exported for unit tests.
/**
 * @param {ShodanHost[]} hosts
 * @param {string[]} notFound
 */
export function buildShodanBlock(hosts, notFound) {
  if (!hosts.length) {
    return (
      "\n\n--- Shodan host intelligence ---\n" +
      `No Shodan records were found for: ${notFound.join(", ")}. ` +
      "These hosts are not in Shodan's database (or were not reachable when last scanned).\n" +
      SHODAN_RELEVANCE_NOTE +
      "\n--- End of Shodan host intelligence ---"
    );
  }
  let body = hosts.map(renderHost).join("\n\n");
  if (notFound.length) body += `\n\nNo Shodan records for: ${notFound.join(", ")}.`;
  return (
    "\n\n--- Shodan host intelligence (live infrastructure data from Shodan.io) ---\n" +
    body +
    "\n" +
    SHODAN_RELEVANCE_NOTE +
    "\n--- End of Shodan host intelligence ---"
  );
}

// A one-line summary of a host for the UI activity step's expandable list.
/** @param {ShodanHost} h */
function hostDetailLine(h) {
  const bits = [];
  if (h.ports.length) bits.push(`${h.ports.length} port${h.ports.length === 1 ? "" : "s"}`);
  if (h.org) bits.push(h.org);
  if (h.vulns.length) bits.push(`${h.vulns.length} CVE${h.vulns.length === 1 ? "" : "s"}`);
  const head = h.resolvedFrom ? `${h.resolvedFrom} (${h.ip})` : h.ip;
  return bits.length ? `${head} — ${bits.join(", ")}` : head;
}

// Orchestrates the whole lookup for one message's worth of targets. Returns
// null when there is nothing to do or nothing resolved, otherwise:
//   { block, details, count, ips, durationMs }
// where `block` is the labeled context text to append to the conversation
// and `details` are the per-host one-liners for the UI step.
//
// `targets` lets the caller supply the hosts rather than have them re-read
// off the latest message — that is how the walk-back route (shodan-text.js)
// hands over a host an EARLIER turn named. Omitted, it extracts from the
// latest user message exactly as before.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {import('./types.js').Conversation} conversation
 * @param {ShodanTargets} [targets] hosts to look up, instead of re-extracting
 * @returns {Promise<{ block: string, details: string[], count: number, ips: string[], durationMs: number } | null>}
 */
export async function runShodanLookup(env, log, conversation, targets) {
  const startedAt = Date.now();
  if (!shodanAvailable(env)) {
    log.info("shodan.skipped", { reason: "no_api_key" });
    return null;
  }
  const supplied = targets && (targets.ips?.length || targets.hostnames?.length);
  const lastUser = supplied ? "" : textOf(lastUserMessage(conversation)?.content);
  const { ips, hostnames } = supplied
    ? { ips: targets.ips || [], hostnames: targets.hostnames || [] }
    : extractTargets(lastUser);
  if (!ips.length && !hostnames.length) {
    log.info("shodan.skipped", { reason: "no_targets" });
    return null;
  }

  const resolved = await resolveHostnames(env, log, hostnames);
  // Build the ordered set of unique IPs to look up, remembering which
  // hostname (if any) each came from, so the summary can show "host → ip".
  const lookups = []; // { ip, resolvedFrom }
  const seen = new Set();
  for (const ip of ips) {
    if (seen.has(ip) || lookups.length >= MAX_LOOKUPS) continue;
    seen.add(ip);
    lookups.push({ ip, resolvedFrom: null });
  }
  for (const [host, ip] of resolved) {
    if (seen.has(ip) || lookups.length >= MAX_LOOKUPS) continue;
    seen.add(ip);
    lookups.push({ ip, resolvedFrom: host });
  }
  if (!lookups.length) {
    // THE SILENT HOLE THAT COST AN INVESTIGATION (2026-08-07). A hostname-only
    // ask whose /dns/resolve came back 200 with nothing usable died here
    // logging absolutely nothing, so `shodan_hosts: 0` in the chat_logs meta
    // was indistinguishable from "the knob was off" and from "Shodan has no
    // record" — see chat_logs #1670. Every no-op on this path now says so.
    log.info("shodan.skipped", {
      reason: "unresolved",
      hostnames: hostnames.length,
      resolved: resolved.size,
    });
    return null;
  }

  const results = await Promise.all(
    lookups.map(async ({ ip, resolvedFrom }) => {
      const data = await shodanGet(env, log, `/shodan/host/${ip}`, {});
      return data ? summarizeHost(data, resolvedFrom) : null;
    }),
  );
  const hosts = /** @type {ShodanHost[]} */ (results.filter((h) => h && h.ip));

  const durationMs = Date.now() - startedAt;
  log.info("shodan.lookup", {
    duration_ms: durationMs,
    targets: lookups.length,
    hosts: hosts.length,
    hostnames_resolved: resolved.size,
  });

  // Note any targets that returned nothing so the context block is honest
  // about coverage rather than silently omitting a host the user named.
  const foundIps = new Set(hosts.map((h) => h.ip));
  const notFound = lookups.filter((l) => !foundIps.has(l.ip)).map((l) => (l.resolvedFrom ? `${l.resolvedFrom} (${l.ip})` : l.ip));

  if (!hosts.length) {
    // Every target came back empty — still surface that, so the model
    // doesn't hallucinate infrastructure Shodan has no record of.
    const block = buildShodanBlock([], notFound);
    return { block, details: notFound.map((t) => `${t} — no Shodan record`), count: 0, ips: [], durationMs };
  }

  return {
    block: buildShodanBlock(hosts, notFound),
    details: hosts.map(hostDetailLine).concat(notFound.map((t) => `${t} — no Shodan record`)),
    count: hosts.length,
    ips: hosts.map((h) => h.ip),
    durationMs,
  };
}

// ---- the search leg --------------------------------------------------------
//
// The host lookup above answers "what is on THIS machine". The search leg
// answers "which machines belong to this ORGANIZATION" — the question
// "find open ports at <company>" actually asks, and the one the integration
// could not answer at all before 2026-08-07 (chat_logs #1670-#1672: a user
// who names a company rather than a host got web-scraped shodan.io pages
// instead of Shodan data, with the wrong IP in the answer).
//
// The query is never the user's sentence: shodan-text.js rebuilds it from
// recognized filter tokens or a single extracted organization name, so the
// minimum-request posture holds on a route whose input is free text.

// How many search matches to fold in. Shodan bills one query credit per
// page of 100; one page is plenty for a research context block, and the
// per-host cap keeps the block readable.
const MAX_SEARCH_HOSTS = 8;

/**
 * One host as the search endpoint describes it — a thinner shape than
 * ShodanHost, because /shodan/host/search returns banners rather than the
 * merged host record.
 * @typedef {object} ShodanSearchHost
 * @property {string} ip
 * @property {string} org
 * @property {string} location
 * @property {string[]} hostnames
 * @property {number[]} ports
 * @property {string[]} products
 * @property {string[]} vulns
 */

/**
 * Folds the banner list Shodan's search returns into one entry per IP.
 * Pure — exported for unit tests.
 * @param {any} data raw /shodan/host/search payload
 * @returns {ShodanSearchHost[]}
 */
export function summarizeSearch(data) {
  /** @type {Map<string, ShodanSearchHost>} */
  const byIp = new Map();
  for (const m of Array.isArray(data?.matches) ? data.matches : []) {
    const ip = typeof m?.ip_str === "string" ? m.ip_str : "";
    if (!ip) continue;
    if (!byIp.has(ip)) {
      if (byIp.size >= MAX_SEARCH_HOSTS) continue;
      byIp.set(ip, {
        ip,
        org: typeof m.org === "string" ? m.org : "",
        location: [m?.location?.city, m?.location?.country_name].filter((s) => typeof s === "string" && s).join(", "),
        hostnames: [],
        ports: [],
        products: [],
        vulns: [],
      });
    }
    const host = /** @type {ShodanSearchHost} */ (byIp.get(ip));
    if (Number.isFinite(m.port) && !host.ports.includes(m.port) && host.ports.length < MAX_PORTS) host.ports.push(m.port);
    for (const h of Array.isArray(m.hostnames) ? m.hostnames : []) {
      if (typeof h === "string" && !host.hostnames.includes(h) && host.hostnames.length < MAX_HOSTNAMES_PER_HOST) host.hostnames.push(h);
    }
    const product = typeof m.product === "string" ? m.product.trim() : "";
    if (product && !host.products.includes(product) && host.products.length < MAX_PRODUCTS) host.products.push(product);
    const vulnsRaw = Array.isArray(m.vulns) ? m.vulns : m.vulns && typeof m.vulns === "object" ? Object.keys(m.vulns) : [];
    for (const v of vulnsRaw) {
      if (typeof v === "string" && !host.vulns.includes(v) && host.vulns.length < MAX_VULNS) host.vulns.push(v);
    }
  }
  for (const host of byIp.values()) host.ports.sort((a, b) => a - b);
  return [...byIp.values()];
}

/** @param {ShodanSearchHost} h */
function renderSearchHost(h) {
  const lines = [`Host ${h.ip} (https://www.shodan.io/host/${h.ip}):`];
  if (h.org) lines.push(`  Organization: ${h.org}`);
  if (h.location) lines.push(`  Location: ${h.location}`);
  if (h.hostnames.length) lines.push(`  Hostnames: ${h.hostnames.join(", ")}`);
  if (h.ports.length) lines.push(`  Open ports: ${h.ports.join(", ")}`);
  if (h.products.length) lines.push(`  Services: ${h.products.join(", ")}`);
  if (h.vulns.length) lines.push(`  Known CVEs: ${h.vulns.join(", ")}`);
  return lines.join("\n");
}

/**
 * The labeled context block for a search. Says what was searched for and how
 * many matches the whole query has, so the model can be honest about a
 * result set that was truncated. Pure — exported for unit tests.
 * @param {string} query the query that was run
 * @param {ShodanSearchHost[]} hosts
 * @param {number} total Shodan's total match count for the query
 */
export function buildShodanSearchBlock(query, hosts, total) {
  if (!hosts.length) {
    return (
      "\n\n--- Shodan host intelligence ---\n" +
      `A Shodan search for \`${query}\` returned no hosts. Nothing in Shodan's database matches it.\n` +
      SHODAN_RELEVANCE_NOTE +
      "\n--- End of Shodan host intelligence ---"
    );
  }
  const shown = hosts.length;
  const scope =
    Number.isFinite(total) && total > shown
      ? `Showing ${shown} of ${total} hosts matching \`${query}\`.`
      : `${shown} host${shown === 1 ? "" : "s"} matching \`${query}\`.`;
  return (
    "\n\n--- Shodan host intelligence (live search results from Shodan.io) ---\n" +
    `${scope}\n\n` +
    hosts.map(renderSearchHost).join("\n\n") +
    "\n" +
    SHODAN_RELEVANCE_NOTE +
    "\n--- End of Shodan host intelligence ---"
  );
}

/** @param {ShodanSearchHost} h */
function searchDetailLine(h) {
  const bits = [];
  if (h.ports.length) bits.push(`${h.ports.length} port${h.ports.length === 1 ? "" : "s"}`);
  if (h.hostnames.length) bits.push(h.hostnames[0]);
  if (h.vulns.length) bits.push(`${h.vulns.length} CVE${h.vulns.length === 1 ? "" : "s"}`);
  return bits.length ? `${h.ip} — ${bits.join(", ")}` : h.ip;
}

/**
 * Runs one Shodan search. Fails soft in every branch, exactly like the host
 * lookup: a missing key, a rejected query, an error or an empty result set
 * all degrade to "no host intelligence" rather than touching the chat.
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} query the rebuilt query (never the user's sentence)
 * @returns {Promise<{ block: string, details: string[], count: number, ips: string[], durationMs: number } | null>}
 */
export async function runShodanSearch(env, log, query) {
  const startedAt = Date.now();
  if (!shodanAvailable(env)) {
    log.info("shodan.skipped", { reason: "no_api_key" });
    return null;
  }
  const q = String(query || "").trim();
  if (!q) {
    log.info("shodan.skipped", { reason: "empty_query" });
    return null;
  }
  const data = await shodanGet(env, log, "/shodan/host/search", { query: q, minify: "true" });
  const durationMs = Date.now() - startedAt;
  if (!data) {
    log.info("shodan.skipped", { reason: "search_failed", duration_ms: durationMs });
    return null;
  }
  const hosts = summarizeSearch(data);
  const total = Number.isFinite(data.total) ? data.total : hosts.length;
  log.info("shodan.search", { duration_ms: durationMs, hosts: hosts.length, total, query_chars: q.length });
  return {
    block: buildShodanSearchBlock(q, hosts, total),
    details: hosts.length ? hosts.map(searchDetailLine) : [`${q} — no matching hosts`],
    count: hosts.length,
    ips: hosts.map((h) => h.ip),
    durationMs,
  };
}

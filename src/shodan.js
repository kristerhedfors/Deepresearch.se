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
// Shodan's vulnerability database is a SEPARATE service on its own host, and
// unlike everything else here it takes no key and costs no credits. It is in
// this module rather than one of its own because it answers the question the
// host lookup opens and cannot close: a host record names CVE ids and nothing
// else, so a caller handed "CVE-2021-44228" has been told a number, not a
// finding.
const CVEDB_BASE = "https://cvedb.shodan.io";
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
// Bounds for the broader legs added for the MCP tools (2026-08-16). Each one is
// what an answer READ ALOUD can carry, not what the API can return: the caller
// these serve has no screen to scroll.
const MAX_FACETS = 5; // fields one count may be broken down by
const FACET_VALUES = 5; // top values reported per field
const MAX_SUBDOMAINS = 40;
const MAX_DNS_RECORDS = 40;
const MAX_TAGS = 10;
const MAX_VULN_RECORDS = 10;
const MAX_VULN_PRODUCTS = 6;

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
 * The outcome of one REST call, with the reason a failure failed.
 *
 * `reason` exists because "no host matches that" and "this server's Shodan plan
 * is out of query credits" are the same `null` to every caller of shodanGet,
 * and they call for opposite next moves — one is an answer, the other is an
 * operator problem a caller should stop retrying. Shodan states which it is in
 * a JSON `{"error": …}` body that was being read only into a log line.
 * @typedef {{ ok: true, data: any } | { ok: false, status: number, reason: string }} ShodanResult
 */

/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} path REST path under SHODAN_BASE
 * @param {Record<string, string>} params query params (the API key is added here)
 * @returns {Promise<ShodanResult>}
 */
async function shodanRequest(env, log, path, params) {
  const qs = new URLSearchParams({ ...params, key: String(env.SHODAN_API_KEY || "") });
  return jsonRequest(log, `${SHODAN_BASE}${path}?${qs}`, path);
}

/**
 * One GET returning parsed JSON, with the failure reason read out of the body.
 * Shared by the keyed API and the keyless CVE database — the two differ in
 * their host and their credentials, not in how a failure has to be handled.
 * @param {import('./types.js').Logger} log
 * @param {string} url the fully built URL (key included, where there is one)
 * @param {string} path the log-safe path — a URL carries the key, a path does not
 * @returns {Promise<ShodanResult>}
 */
async function jsonRequest(log, url, path) {
  // A THROWN fetch (timeout, dead socket) is deliberately NOT caught here. The
  // enrichment contains it one level up as `shodan.phase_failed` and has since
  // this integration shipped — chat_logs and the debugging playbook both read
  // that key — and on the tool side src/mcp.js already turns a throw into an
  // isError result. Catching it here would move a pinned log line for nothing.
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    // 404 = host simply isn't in Shodan's database (the common, expected
    // "no data" case); anything else is a real error worth a warn.
    const body = resp.status === 404 ? "not in database" : await resp.text().catch(() => "");
    const detail = typeof body === "string" ? body.slice(0, 200) : "";
    log[resp.status === 404 ? "info" : "warn"]("shodan.error", { path, status: resp.status, detail });
    return { ok: false, status: resp.status, reason: apiErrorText(detail, resp.status) };
  }
  const data = await resp.json().catch(() => null);
  if (data === null) return { ok: false, status: resp.status, reason: "returned something unreadable" };
  return { ok: true, data };
}

/**
 * The human half of an error body. Shodan answers `{"error": "Insufficient
 * query credits"}`; anything else falls back to the status, because echoing an
 * HTML error page into a spoken answer is worse than saying nothing precise.
 * @param {string} detail
 * @param {number} status
 * @returns {string}
 */
function apiErrorText(detail, status) {
  try {
    const parsed = JSON.parse(detail);
    const message = typeof parsed?.error === "string" ? parsed.error.trim() : "";
    if (message) return message;
  } catch {
    /* not JSON — fall through to the status */
  }
  if (status === 404) return "not in the database";
  if (status === 401 || status === 403) return "refused the request (the API key is missing, wrong, or out of credits)";
  if (status === 429) return "rate-limited the request";
  return `failed with status ${status}`;
}

/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} path REST path under SHODAN_BASE
 * @param {Record<string, string>} params query params (the API key is added here)
 * @returns {Promise<any | null>} parsed JSON, or null on 404/error
 */
async function shodanGet(env, log, path, params) {
  const result = await shodanRequest(env, log, path, params);
  return result.ok ? result.data : null;
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
 * @param {number} [maxHosts] how many distinct hosts to keep (default MAX_SEARCH_HOSTS)
 * @returns {ShodanSearchHost[]}
 */
export function summarizeSearch(data, maxHosts = MAX_SEARCH_HOSTS) {
  const cap = Number.isFinite(maxHosts) && maxHosts > 0 ? Math.floor(maxHosts) : MAX_SEARCH_HOSTS;
  /** @type {Map<string, ShodanSearchHost>} */
  const byIp = new Map();
  for (const m of Array.isArray(data?.matches) ? data.matches : []) {
    const ip = typeof m?.ip_str === "string" ? m.ip_str : "";
    if (!ip) continue;
    if (!byIp.has(ip)) {
      if (byIp.size >= cap) continue;
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
 * @returns {Promise<{ block: string, details: string[], count: number, total: number, ips: string[], durationMs: number } | null>}
 */
export async function runShodanSearch(env, log, query) {
  const startedAt = Date.now();
  const found = await searchHosts(env, log, query, {});
  const durationMs = Date.now() - startedAt;
  if (!found.ok) {
    // A preflight refusal (no key, empty query) has already said so; only the
    // request's own failure is still unlogged here.
    if (!found.skipped) log.info("shodan.skipped", { reason: "search_failed", duration_ms: durationMs });
    return null;
  }
  const { hosts, total } = found;
  log.info("shodan.search", { duration_ms: durationMs, hosts: hosts.length, total, query_chars: found.query.length });
  return {
    block: buildShodanSearchBlock(found.query, hosts, total),
    details: hosts.length ? hosts.map(searchDetailLine) : [`${found.query} — no matching hosts`],
    count: hosts.length,
    // Shodan's own count of MATCHING hosts, which is normally far larger than
    // the handful summarizeSearch keeps. Returned beside `count` (2026-08-15)
    // because a caller reporting the sample as the population turns a handful of
    // hosts into a claim about the internet — buildShodanSearchBlock has always
    // said both, and a caller that renders its own text needs the same figure.
    total,
    ips: hosts.map((h) => h.ip),
    durationMs,
  };
}

// ---- the broader API: search, count, domains and vulnerabilities -----------
//
// Everything below answers a question the two legs above cannot, and every one
// of them exists because the MCP surface asked for it (2026-08-16): the tools
// there are called by an agent with no conversation to enrich and no screen to
// render to, so they need the population figure, the breakdown, the domain's
// own map of itself, and what a CVE id actually means.
//
// They share one shape and it is deliberately NOT the enrichment's. The
// enrichment returns `null` for every failure, because a chat turn's only
// sensible degradation is "no context block". A tool has to SAY something, and
// "no host matches that" and "the plan is out of query credits" are opposite
// findings, so each of these returns a discriminated result carrying the reason.

/**
 * The shape every leg below returns: an answer, or a reason there is none.
 * @template T
 * @typedef {({ ok: true } & T) | { ok: false, reason: string, skipped?: string }} ShodanLeg
 */

/**
 * One field a count was broken down by, and its top values.
 * @typedef {object} ShodanFacet
 * @property {string} field e.g. "country", "port", "org"
 * @property {Array<{ value: string, count: number }>} values
 */

/**
 * One stored DNS observation.
 * @typedef {object} ShodanDnsRecord
 * @property {string} name the fully qualified name ("www.example.com")
 * @property {string} type A, AAAA, MX, NS, TXT, CNAME, …
 * @property {string} value
 * @property {string} lastSeen ISO date (YYYY-MM-DD), or ""
 */

/**
 * One vulnerability as Shodan's CVE database describes it.
 * @typedef {object} ShodanVuln
 * @property {string} id
 * @property {string} summary
 * @property {number | null} cvss 0–10 severity, or null when unscored
 * @property {number | null} epss probability of exploitation in the next 30 days
 * @property {boolean} kev on CISA's Known Exploited Vulnerabilities list
 * @property {string} ransomware known ransomware campaign use, or ""
 * @property {string} published ISO date (YYYY-MM-DD), or ""
 * @property {string[]} products affected products, from the CPE list
 * @property {number} productTotal distinct products the CPE list names, before truncation
 * @property {string} action the mitigation Shodan proposes, or ""
 */

/**
 * Folds Shodan's facet payload into the ordered field → values shape.
 * Pure — exported for unit tests.
 * @param {any} raw the `facets` object of a /shodan/host/count payload
 * @returns {ShodanFacet[]}
 */
export function summarizeFacets(raw) {
  if (!raw || typeof raw !== "object") return [];
  /** @type {ShodanFacet[]} */
  const out = [];
  for (const [field, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) continue;
    const values = rows
      .filter((r) => r && (typeof r.value === "string" || Number.isFinite(r.value)) && Number.isFinite(r.count))
      .slice(0, FACET_VALUES)
      .map((r) => ({ value: String(r.value), count: Number(r.count) }));
    if (values.length) out.push({ field, values });
    if (out.length >= MAX_FACETS) break;
  }
  return out;
}

/**
 * Folds the DNS record list into one bounded, de-duplicated set.
 *
 * The subdomain field is RELATIVE and may be empty (the apex), so the
 * fully-qualified name is assembled here rather than by every reader — an
 * answer that says "the record for '' " has lost the thing it was about.
 * Pure — exported for unit tests.
 * @param {any} rows the `data` array of a /dns/domain payload
 * @param {string} [domain] the domain the records belong to
 * @returns {ShodanDnsRecord[]}
 */
export function summarizeDnsRecords(rows, domain = "") {
  /** @type {ShodanDnsRecord[]} */
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const type = typeof row?.type === "string" ? row.type.toUpperCase() : "";
    const value = typeof row?.value === "string" ? row.value : "";
    if (!type || !value) continue;
    const sub = typeof row?.subdomain === "string" ? row.subdomain : "";
    const name = sub && domain ? `${sub}.${domain}` : sub || domain;
    const key = `${name}|${type}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      type,
      value,
      lastSeen: typeof row?.last_seen === "string" ? row.last_seen.slice(0, 10) : "",
    });
    if (out.length >= MAX_DNS_RECORDS) break;
  }
  return out;
}

/**
 * Normalizes one CVEDB record. The two severity numbers are kept SEPARATE and
 * both are optional: CVSS says how bad it would be, EPSS says how likely it is
 * to happen, and a summary that reports one as the other is the commonest way
 * a vulnerability answer misleads.
 * Pure — exported for unit tests.
 * @param {any} data
 * @param {string} fallbackId the id asked for, when the payload omits it
 * @returns {ShodanVuln}
 */
export function summarizeVuln(data, fallbackId = "") {
  const row = data && typeof data === "object" ? data : {};
  const num = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
  // The CPE strings are machine identifiers ("cpe:2.3:a:apache:log4j:2.14.1:…");
  // the vendor and product segments are the only parts a person hears as words.
  //
  // THE WHOLE LIST IS COUNTED even though only the first few are kept, and that
  // is not tidiness. CVEDB returns the CPE list in ALPHABETICAL order, so the
  // handful kept are the alphabetically-first products rather than the most
  // affected ones — a live read of CVE-2021-44228 (2026-08-16) opens "apache
  // log4j, apple xcode, bentley synchro, cisco automated_subsea_tuning…" out of
  // several hundred. Naming six of those without the total states a sample as
  // the population, which is the same error `total` exists to prevent on a
  // search.
  const products = [];
  const seenProduct = new Set();
  for (const cpe of Array.isArray(row.cpes) ? row.cpes : []) {
    if (typeof cpe !== "string") continue;
    const parts = cpe.split(":");
    const label = [parts[3], parts[4]].filter((p) => p && p !== "*").join(" ");
    if (!label || seenProduct.has(label)) continue;
    seenProduct.add(label);
    if (products.length < MAX_VULN_PRODUCTS) products.push(label);
  }
  const published = typeof row.published_time === "string" ? row.published_time.slice(0, 10) : "";
  return {
    id: typeof row.cve_id === "string" && row.cve_id ? row.cve_id.toUpperCase() : fallbackId,
    summary: typeof row.summary === "string" ? row.summary.trim() : "",
    cvss: num(row.cvss),
    epss: num(row.epss),
    kev: row.kev === true,
    ransomware: typeof row.ransomware_campaign === "string" ? row.ransomware_campaign.trim() : "",
    published,
    products,
    productTotal: seenProduct.size,
    action: typeof row.propose_action === "string" ? row.propose_action.trim() : "",
  };
}

/**
 * Whichever of these two is missing is what a caller has to fix, and neither is
 * worth an outbound request to discover.
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} what the argument being validated, for the log line
 * @param {string} value
 * @returns {{ ok: false, reason: string, skipped: string } | null}
 */
function preflight(env, log, what, value) {
  if (!shodanAvailable(env)) {
    log.info("shodan.skipped", { reason: "no_api_key" });
    return { ok: false, reason: "host intelligence is not configured on this server", skipped: "no_api_key" };
  }
  if (!value) {
    log.info("shodan.skipped", { reason: `empty_${what}` });
    return { ok: false, reason: `no ${what} was given`, skipped: `empty_${what}` };
  }
  return null;
}

/** Shodan pages results at 100 matches each; page 1 is the default and the
 * only one the enrichment ever asks for.
 * @param {unknown} page
 * @returns {number}
 */
function clampPage(page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.min(20, Math.round(n));
}

/**
 * The raw search leg: hosts matching a query, with paging.
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {{ page?: number, maxHosts?: number }} [opts]
 * @returns {Promise<ShodanLeg<{ query: string, hosts: ShodanSearchHost[], total: number, page: number }>>}
 */
export async function searchHosts(env, log, query, opts) {
  const q = String(query || "").trim();
  const bad = preflight(env, log, "query", q);
  if (bad) return bad;
  const page = clampPage(opts?.page);
  /** @type {Record<string, string>} */
  const params = { query: q, minify: "true" };
  if (page > 1) params.page = String(page);
  const result = await shodanRequest(env, log, "/shodan/host/search", params);
  if (!result.ok) return { ok: false, reason: `the search ${result.reason}` };
  const total = Number.isFinite(result.data?.total) ? result.data.total : 0;
  return { ok: true, query: q, page, total, hosts: summarizeSearch(result.data, opts?.maxHosts) };
}

/**
 * How many hosts match, broken down by whichever fields were asked for.
 *
 * This is the one leg here that costs NO query credits — Shodan bills the
 * search that returns hosts, not the count that does not — which is what makes
 * "how much of the internet looks like this" a question worth asking often. It
 * is also the only shape in the whole integration that answers about a
 * POPULATION rather than about machines, so nothing about it is a sample.
 *
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {string[]} [facets] fields to break the count down by, e.g. ["country", "port"]
 * @returns {Promise<ShodanLeg<{ query: string, total: number, facets: ShodanFacet[] }>>}
 */
export async function countHosts(env, log, query, facets) {
  const q = String(query || "").trim();
  const bad = preflight(env, log, "query", q);
  if (bad) return bad;
  /** @type {Record<string, string>} */
  const params = { query: q };
  const wanted = (facets || []).filter((f) => typeof f === "string" && f).slice(0, MAX_FACETS);
  // `field:n` is Shodan's own syntax for "the top n values of this field".
  if (wanted.length) params.facets = wanted.map((f) => (f.includes(":") ? f : `${f}:${FACET_VALUES}`)).join(",");
  const result = await shodanRequest(env, log, "/shodan/host/count", params);
  if (!result.ok) return { ok: false, reason: `the count ${result.reason}` };
  const total = Number.isFinite(result.data?.total) ? result.data.total : 0;
  log.info("shodan.count", { total, facets: wanted.length, query_chars: q.length });
  return { ok: true, query: q, total, facets: summarizeFacets(result.data?.facets) };
}

/**
 * A domain's own map of itself: the subdomains Shodan has seen and the DNS
 * records behind them.
 *
 * Why this is not just a search. `hostname:example.com` finds hosts Shodan has
 * SCANNED; this reads Shodan's DNS database, which knows subdomains that were
 * never scanned at all — so the two disagree, and the disagreement is the
 * finding. Nothing here is resolved live by us: these are stored observations.
 *
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} domain a registrable domain, e.g. "example.com"
 * @param {{ type?: string, page?: number }} [opts] restrict to one record type
 * @returns {Promise<ShodanLeg<{ domain: string, tags: string[], subdomains: string[], records: ShodanDnsRecord[], subdomainTotal: number, more: boolean }>>}
 */
export async function domainInfo(env, log, domain, opts) {
  const name = String(domain || "").trim().toLowerCase();
  const bad = preflight(env, log, "domain", name);
  if (bad) return bad;
  /** @type {Record<string, string>} */
  const params = {};
  const type = String(opts?.type || "").trim().toUpperCase();
  if (type) params.type = type;
  const page = clampPage(opts?.page);
  if (page > 1) params.page = String(page);
  const result = await shodanRequest(env, log, `/dns/domain/${encodeURIComponent(name)}`, params);
  if (!result.ok) {
    // 404 here is the ordinary "Shodan has never seen this domain", and the
    // reason text already says so — but it is an ANSWER, not a breakdown, and
    // the caller has to be able to tell those apart.
    return { ok: false, reason: `the domain lookup ${result.reason}` };
  }
  const data = result.data || {};
  const canonical = typeof data.domain === "string" && data.domain ? data.domain : name;
  const records = summarizeDnsRecords(data.data, canonical);
  const subdomains = Array.isArray(data.subdomains)
    ? data.subdomains.filter((/** @type {unknown} */ s) => typeof s === "string")
    : [];
  log.info("shodan.domain", { subdomains: subdomains.length, records: records.length });
  return {
    ok: true,
    domain: canonical,
    tags: Array.isArray(data.tags) ? data.tags.filter((/** @type {unknown} */ t) => typeof t === "string").slice(0, MAX_TAGS) : [],
    // The full count travels beside the truncated list for the same reason the
    // search's `total` does: a caller that says "12 subdomains" when the answer
    // is 812 has reported its own cap as a finding about the domain.
    subdomainTotal: subdomains.length,
    subdomains: subdomains.slice(0, MAX_SUBDOMAINS),
    records,
    more: data.more === true,
  };
}

/**
 * One CVE, from Shodan's vulnerability database.
 *
 * Keyless and free — CVEDB takes no API key at all — so this is the one leg
 * here that works on a server with no Shodan credential. It is still gated on
 * the account's Shodan knob, because the knob is consent to reach that third
 * party and a free request is still a request.
 *
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} cve a CVE id, e.g. "CVE-2021-44228"
 * @returns {Promise<ShodanLeg<{ vuln: ShodanVuln }>>}
 */
export async function cveInfo(env, log, cve) {
  const id = String(cve || "").trim().toUpperCase();
  if (!id) return { ok: false, reason: "no CVE id was given", skipped: "empty_cve" };
  const result = await jsonRequest(log, `${CVEDB_BASE}/cve/${encodeURIComponent(id)}`, `/cve/${id}`);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.status === 404 ? `there is no record of ${id} in Shodan's vulnerability database` : `the lookup ${result.reason}`,
    };
  }
  log.info("shodan.cve", { cve: id });
  return { ok: true, vuln: summarizeVuln(result.data, id) };
}

/**
 * The vulnerabilities affecting a product, most exploitable first.
 *
 * `sort_by_epss` is what makes the answer useful rather than merely long: EPSS
 * is the probability a vulnerability is exploited in the wild in the next 30
 * days, so it ranks by what is actually happening rather than by severity —
 * which is the same trap sorting a literature by citations falls into.
 *
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {{ product?: string, cpe23?: string, kevOnly?: boolean, limit?: number }} opts
 * @returns {Promise<ShodanLeg<{ subject: string, vulns: ShodanVuln[], kevOnly: boolean }>>}
 */
export async function productCves(env, log, opts) {
  const product = String(opts?.product || "").trim();
  const cpe23 = String(opts?.cpe23 || "").trim();
  if (!product && !cpe23) return { ok: false, reason: "no product was given", skipped: "empty_product" };
  const limit = Math.min(MAX_VULN_RECORDS, Math.max(1, Math.round(Number(opts?.limit) || MAX_VULN_RECORDS)));
  const qs = new URLSearchParams({ count: "false", limit: String(limit), sort_by_epss: "true" });
  if (cpe23) qs.set("cpe23", cpe23);
  else qs.set("product", product);
  if (opts?.kevOnly) qs.set("is_kev", "true");
  const result = await jsonRequest(log, `${CVEDB_BASE}/cves?${qs}`, "/cves");
  if (!result.ok) return { ok: false, reason: `the vulnerability search ${result.reason}` };
  const rows = Array.isArray(result.data?.cves) ? result.data.cves : [];
  const vulns = rows.slice(0, limit).map((/** @type {any} */ row) => summarizeVuln(row, ""));
  log.info("shodan.product_cves", { results: vulns.length, kev_only: !!opts?.kevOnly });
  return { ok: true, subject: cpe23 || product, vulns, kevOnly: !!opts?.kevOnly };
}

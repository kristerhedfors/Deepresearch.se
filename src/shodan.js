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

const SHODAN_BASE = "https://api.shodan.io";
const TIMEOUT_MS = 8000;
// Bounds on how much one message can fan out to Shodan — keeps credit spend
// and CPU/latency predictable regardless of how many host-shaped tokens a
// message happens to contain.
const MAX_HOSTNAMES = 4;
const MAX_IPS = 4;
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

/**
 * The publicly-routable IPv4s and hostnames extracted from one message.
 * @typedef {{ ips: string[], hostnames: string[] }} ShodanTargets
 */
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

// ---- target extraction (pure — exported for unit tests) --------------------

// File extensions that the FQDN pattern would otherwise mistake for a
// hostname (e.g. "report.pdf", "diagram.png"). The label after the final
// dot is checked against this set and dropped if it matches.
const FILE_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "txt", "md", "rtf", "odt", "csv", "xlsx", "xls", "pptx", "ppt",
  "png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tiff", "ico", "heic",
  "mp3", "mp4", "mov", "avi", "wav", "webm", "mkv",
  "zip", "tar", "gz", "rar", "7z",
  "js", "ts", "css", "html", "htm", "json", "xml", "yaml", "yml", "py", "rb", "go", "rs", "sh",
]);

const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
// A hostname is one or more dot-separated DNS labels ending in an alphabetic
// TLD of 2-24 chars. Case-insensitive; the URL/email-boundary handling is
// done by inspecting the surrounding characters below.
const HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}/gi;

// True for an IPv4 that is private, loopback, link-local, multicast, or
// otherwise not a publicly routable address worth (or possible) to query on
// Shodan. Wasting a query credit on 192.168.x.x also leaks nothing useful.
/**
 * @param {number} a first octet
 * @param {number} b second octet
 */
function isPublicIpv4(a, b) {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  return true;
}

// Extracts publicly-routable IPv4s and plausible hostnames from free text.
// Deduped, capped, and de-noised (private IPs, file names, email addresses,
// and any hostname that is really just an IP are all excluded). Returns
// { ips, hostnames }.
/**
 * @param {unknown} text free text to scan
 * @returns {ShodanTargets}
 */
export function extractTargets(text) {
  const raw = typeof text === "string" ? text : "";
  const ips = [];
  const seenIp = new Set();
  for (const m of raw.matchAll(IPV4_RE)) {
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (octets.some((o) => o > 255)) continue;
    if (!isPublicIpv4(octets[0], octets[1])) continue;
    const ip = octets.join(".");
    if (seenIp.has(ip)) continue;
    seenIp.add(ip);
    if (ips.length < MAX_IPS) ips.push(ip);
  }

  const hostnames = [];
  const seenHost = new Set();
  for (const m of raw.matchAll(HOST_RE)) {
    const host = m[0].toLowerCase().replace(/\.$/, "");
    // Skip an email address's domain (the char before the match is '@').
    if (m.index > 0 && raw[m.index - 1] === "@") continue;
    // Skip anything that is actually a dotted IP (already handled above).
    if (/^\d+(\.\d+)+$/.test(host)) continue;
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (FILE_EXTENSIONS.has(tld)) continue;
    if (seenHost.has(host)) continue;
    seenHost.add(host);
    if (hostnames.length < MAX_HOSTNAMES) hostnames.push(host);
  }
  return { ips, hostnames };
}

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
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {import('./types.js').Conversation} conversation
 * @returns {Promise<{ block: string, details: string[], count: number, ips: string[], durationMs: number } | null>}
 */
export async function runShodanLookup(env, log, conversation) {
  const startedAt = Date.now();
  if (!shodanAvailable(env)) return null;
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  const { ips, hostnames } = extractTargets(lastUser);
  if (!ips.length && !hostnames.length) return null;

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
  if (!lookups.length) return null;

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

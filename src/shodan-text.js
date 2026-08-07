// @ts-check
// The pure text side of the Shodan integration — the deterministic language
// analysis that decides WHAT (if anything) to ask Shodan about, split out of
// shodan.js the same way googlemaps-text.js was split out of googlemaps.js.
// Everything here is pure and Node-testable (shodan-text.test.js).
//
// Why this module exists (2026-08-07). Until now the integration had NO
// intent gate at all: it looked up whatever host the LATEST user message
// happened to contain, and nothing else. Three consequences showed up in
// production (chat_logs #1670-#1672, 2026-08-06):
//
//   - "Ports open on basalt.se"      — fired (a host is present)
//   - "Shodan"                       — could not fire: names the service, no host
//   - "Run through shodan to answer!" — could not fire, same reason
//
// So there was no way to ASK for host intelligence; you could only name a
// host and hope. This module adds the three missing routes — an intent gate
// (EN + SV, invariant 6), a walk-back to the host an EARLIER turn named, and
// a Shodan SEARCH query built from explicit filter syntax or a company name
// — while leaving the original host-in-the-latest-message route untouched and
// intent-free, so nothing that fired before stops firing.
//
// Privacy (invariant 4): only the candidate these functions extract ever
// crosses the wire to Shodan — a host, an IP, or a filter query assembled
// from recognized `key:value` tokens. Never the message, never the
// conversation, never a filename or an account identifier. The search route
// deliberately rebuilds its query from matched tokens rather than forwarding
// the user's sentence, so the minimum-request posture survives a route that
// takes free text as its input.

import { textOf, lastUserMessage } from "./conversation.js";

/** @typedef {import('./types.js').Conversation} Conversation */

// Bounds on how much one message can fan out to Shodan — keeps credit spend
// and CPU/latency predictable regardless of how many host-shaped tokens a
// message happens to contain.
const MAX_HOSTNAMES = 4;
const MAX_IPS = 4;

/**
 * The publicly-routable IPv4s and hostnames extracted from one message.
 * @typedef {{ ips: string[], hostnames: string[] }} ShodanTargets
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
    // Skip a TRUNCATED tail of a longer token. HOST_RE's label class is
    // ASCII-only and /i does not extend it to å/ä/ö, so an internationalized
    // domain matched only from its last ASCII run: "räksmörgås.se" yielded
    // "s.se" — not a miss but a WRONG host, quietly queried on Shodan and
    // leaked outward (found by shodan-enrichment.test.js, 2026-08-07). Any
    // letter or digit immediately before the match means we are looking at
    // the tail of something bigger, so there is no host here to query.
    if (m.index > 0 && /[\p{L}\p{N}]/u.test(raw[m.index - 1])) continue;
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

/**
 * What pickShodanTarget resolves a conversation turn into — the contract
 * between the matchers here and the runner in shodan-enrichment.js.
 *
 * `kind: "hosts"` carries literal lookup targets; `kind: "search"` carries a
 * Shodan search query. `followUp` marks a target recovered from an earlier
 * turn rather than named in the latest message. `intent` is the deciding
 * matcher's name — a diagnostic that rides into the chat_logs meta as
 * `shodan_intent`, mirroring the `maps_intent` routing trace.
 * @typedef {{
 *   kind: "hosts" | "search",
 *   ips: string[],
 *   hostnames: string[],
 *   query: string,
 *   followUp: boolean,
 *   intent: string,
 * }} ShodanTarget
 */

// How far back the walk-back is willing to look for a host the user named
// earlier. Bounded so a long conversation can't turn one vague follow-up into
// a scan of everything ever mentioned.
const WALK_BACK_TURNS = 12;
// Bounds on the search route, for the same reason the lookup route has
// MAX_LOOKUPS: predictable credit spend and a readable context block.
const MAX_FILTER_TOKENS = 6;
const MAX_QUERY_CHARS = 200;
const MAX_ORG_WORDS = 4;

// ---- the intent gate (EN + SV — CLAUDE.md invariant 6) ---------------------
//
// Swedish alternatives use lookaround boundaries, never `\b`: JS defines `\b`
// over [A-Za-z0-9_], so `\böppna portar\b` can never match — the boundary
// before "ö" needs a word character and there isn't one. The failure is
// silent (the English half keeps matching), which is exactly how invariant 6
// dies unnoticed. Same trap as aadr-core.js and europepmc.js; the parity
// tests in shodan-text.test.js fail if `\b` comes back.

/** Naming the service itself — the strongest possible signal of intent. */
const SHODAN_NAMED = /(?<![\p{L}\p{N}_])shodan(?![\p{L}\p{N}_])/iu;

// Every Swedish alternative carrying å/ä/ö also lists its ASCII-typed twin
// (öppna/oppna, tjänster/tjanster, sårbara/sarbara): a Swedish speaker on a
// US keyboard types the ASCII form constantly, and a half-applied fallback
// set is invariant 6 failing on exactly the users it was written for.
// `[\p{L}]*` is the suffix wildcard, never `\w*` — `\w` stops at the first
// accented letter, so `tjänster\w*` cannot reach "tjänsterna".

/** Ports. */
const PORT_SUBJECT =
  /\b(open ports?|ports? (?:are )?open|which ports?|what ports?|exposed ports?|listening ports?|network ports?|port scan[\p{L}]*|portscan[\p{L}]*)\b|(?<![\p{L}\p{N}_])((?:öppna|oppna) portar[\p{L}]*|(?:öppen|oppen) port[\p{L}]*|portar[\p{L}]* (?:som (?:är|ar) )?(?:öppna|oppna)|vilka portar[\p{L}]*|exponerade portar[\p{L}]*|lyssnande portar[\p{L}]*|portskanning[\p{L}]*|portscanning[\p{L}]*|(?:nätverksportar|natverksportar)[\p{L}]*)(?![\p{L}\p{N}_])/iu;

/** Services and banners running on a host. */
const SERVICE_SUBJECT =
  /\b(running services?|services? (?:are )?running|exposed services?|what(?:'s| is) running on|which services?|service banners?|banner grab[\p{L}]*|exposed to the internet|internet[-\s]?facing)\b|(?<![\p{L}\p{N}_])((?:tjänster|tjanster)[\p{L}]* som (?:körs|kors|lyssnar)|exponerade (?:tjänster|tjanster)[\p{L}]*|vilka (?:tjänster|tjanster)[\p{L}]*|vad (?:som )?(?:körs|kors) (?:på|pa)|(?:tjänstebanner|tjanstebanner)[\p{L}]*|exponerad[\p{L}]* mot internet|internetexponerad[\p{L}]*|(?:internetvänd|internetvand)[\p{L}]*)(?![\p{L}\p{N}_])/iu;

/** The attack-surface / OSINT framing. */
const SURFACE_SUBJECT =
  /\b(attack surface|attack[-\s]?surface management|asm\b|osint|external footprint|external exposure|internet exposure|exposure management|host intelligence)\b|(?<![\p{L}\p{N}_])((?:attackyta|angreppsyta)[\p{L}]*|extern[\p{L}]* exponering[\p{L}]*|exponeringsyta[\p{L}]*|fotavtryck[\p{L}]* (?:på|pa) internet)(?![\p{L}\p{N}_])/iu;

/** Known vulnerabilities ATTACHED to a host, not vulnerability talk generally. */
const VULN_SUBJECT =
  /\b(known cves?|known vulnerabilit(?:y|ies)|cve[-\s]?\d{4}|unpatched services?|vulnerable services?)\b|(?<![\p{L}\p{N}_])((?:kända|kanda) cve[\p{L}]*|(?:kända|kanda) (?:sårbarhet|sarbarhet)[\p{L}]*|(?:sårbara|sarbara) (?:tjänster|tjanster)[\p{L}]*|opatchade (?:tjänster|tjanster)[\p{L}]*)(?![\p{L}\p{N}_])/iu;

/**
 * Does this message want host intelligence?
 *
 * Deliberately NOT required for the original host-in-the-latest-message
 * route — that one still fires on host presence alone, so nothing that
 * worked before this module stops working. The gate exists to ENABLE the
 * three new routes (filter query, walk-back, org search), each of which
 * reaches further than the message in front of it and so needs to be asked
 * for rather than guessed at.
 * @param {unknown} text the latest user message
 * @returns {boolean}
 */
export function shodanIntent(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return false;
  return (
    SHODAN_NAMED.test(s) ||
    PORT_SUBJECT.test(s) ||
    SERVICE_SUBJECT.test(s) ||
    SURFACE_SUBJECT.test(s) ||
    VULN_SUBJECT.test(s)
  );
}

// ---- route 1: explicit Shodan filter syntax --------------------------------

// The Shodan search filters worth honouring when a user types them straight
// into the chat. Anything not on this list is dropped rather than forwarded,
// so an unrecognized `key:value` can never become an outbound query term.
const SEARCH_FILTERS = [
  "org", "hostname", "port", "product", "ssl", "net", "country", "city",
  "asn", "os", "vuln", "http.title", "http.status", "isp", "before", "after",
];
const FILTER_RE = new RegExp(
  String.raw`(?<![\w.])(` + SEARCH_FILTERS.map((f) => f.replace(".", "\\.")).join("|") +
    String.raw`)\s*:\s*("[^"]{1,80}"|'[^']{1,80}'|[^\s"']{1,80})`,
  "gi",
);

/**
 * Pulls explicit Shodan filter syntax out of a message and rebuilds a query
 * from the recognized tokens only. Returns "" when the message carries none.
 *
 * The rebuild is the privacy-relevant part: the user's sentence never
 * crosses the wire, only the filters they actually typed.
 * @param {unknown} text
 * @returns {string}
 */
export function extractSearchFilters(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return "";
  const parts = [];
  const seen = new Set();
  for (const m of s.matchAll(FILTER_RE)) {
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    // Normalize to a double-quoted value when it carries whitespace, so the
    // rebuilt query means what the user typed.
    const quotedByUser = /^["']/.test(value);
    const bare = value.replace(/^["']|["']$/g, "");
    if (!bare) continue;
    // Re-quote when the value carries whitespace, and KEEP the quotes the user
    // typed even on a single word — `http.title:"login"` is an exact-phrase
    // query to Shodan and `http.title:login` is not, so dropping them would
    // change what was asked.
    value = /\s/.test(bare) || quotedByUser ? `"${bare.replace(/"/g, "")}"` : bare;
    const token = `${key}:${value}`;
    if (seen.has(token)) continue;
    seen.add(token);
    if (parts.length < MAX_FILTER_TOKENS) parts.push(token);
  }
  // Trim on TOKEN boundaries, never mid-value: a raw slice at 200 chars can
  // chop a quoted value in half and emit a malformed filter, which Shodan
  // would then answer for a query nobody wrote.
  const out = [];
  let used = 0;
  for (const token of parts) {
    const cost = used ? token.length + 1 : token.length;
    if (used + cost > MAX_QUERY_CHARS) break;
    used += cost;
    out.push(token);
  }
  return out.join(" ");
}

// ---- route 2: the walk-back ------------------------------------------------

/**
 * The host/IP an EARLIER user turn named, for a follow-up that only says
 * "and its open ports?". Walks user turns newest-first, skipping the latest
 * one (that is route 0's job), and stops at the first turn that names
 * anything. Assistant turns are deliberately NOT scanned: an answer is full
 * of source URLs, and walking those back would spray unrelated third-party
 * hosts at Shodan on every follow-up.
 * @param {Conversation} conversation
 * @returns {{ ips: string[], hostnames: string[] } | null}
 */
export function walkBackHost(conversation) {
  const msgs = Array.isArray(conversation) ? conversation : [];
  const userTurns = msgs.filter((m) => m && m.role === "user");
  // Drop the latest turn — the caller has already looked there.
  const earlier = userTurns.slice(0, -1).slice(-WALK_BACK_TURNS);
  for (let i = earlier.length - 1; i >= 0; i--) {
    const { ips, hostnames } = extractTargets(textOf(earlier[i].content));
    if (ips.length || hostnames.length) return { ips, hostnames };
  }
  return null;
}

// ---- route 3: the organization search --------------------------------------

// Company-form suffixes that make a capitalized run unambiguously an
// organization. Deliberately broad across the jurisdictions this site sees.
const ORG_SUFFIX =
  /(?:AB|ABp?|Inc\.?|Ltd\.?|LLC|L\.L\.C\.|GmbH|A\/S|ApS|AS|Oyj?|B\.?V\.?|N\.?V\.?|S\.?A\.?|S\.?p\.?A\.?|PLC|Corp\.?|Corporation|Company|Holdings?|Group|Gruppen|Koncernen)/;

// The preposition cues that introduce a target organization, EN + SV.
const ORG_CUE =
  /(?:\b(?:at|for|against|about|belonging to|owned by|of)\s+|(?<![\p{L}\p{N}_])(?:hos|mot|för|till|tillhör|tillhörande|ägs av|om)(?![\p{L}\p{N}_])\s+)/iu;

// Capitalized runs that are never an organization. Without this, "Ports open
// on Monday" resolves an org called "Monday" and bills a Shodan search for
// it. Kept short on purpose — the suffix and quote routes carry most of the
// real traffic and need no stoplist at all.
const ORG_STOPWORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag",
  "januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti",
  "september", "oktober", "november", "december",
  "internet", "shodan", "google", "the internet", "i", "we", "you", "it",
  "sweden", "sverige", "europe", "europa", "usa", "eu",
]);

/**
 * A company name to search Shodan's `org:` facet for, when the message asks
 * for host intelligence but names no host at all. Three ways in, most
 * confident first: a quoted name, a name carrying a company-form suffix, or
 * a capitalized run introduced by a preposition cue.
 *
 * Conservative by construction — a miss costs a less specific answer, a
 * false fire spends a Shodan query credit on a company nobody asked about.
 * @param {unknown} text
 * @returns {string}
 */
export function extractOrgQuery(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return "";

  /** @param {string} raw */
  const clean = (raw) => {
    const name = raw.replace(/[\s,.;:!?]+$/, "").replace(/^[\s,.;:"']+/, "").trim();
    if (name.length < 2 || name.length > 60) return "";
    if (ORG_STOPWORDS.has(name.toLowerCase())) return "";
    // A hostname is route 0/2's business, never an org search.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) return "";
    if (name.split(/\s+/).length > MAX_ORG_WORDS) return "";
    return name;
  };

  // (a) an explicitly quoted name
  const quoted = s.match(/["“']([^"”']{2,60})["”']/);
  if (quoted) {
    const name = clean(quoted[1]);
    if (name) return name;
  }

  // (b) a capitalized run ending in a company-form suffix
  const suffixed = s.match(
    new RegExp(
      String.raw`((?:\p{Lu}[\p{L}\p{N}&.-]*\s+){0,3}\p{Lu}[\p{L}\p{N}&.-]*\s+` + ORG_SUFFIX.source + String.raw`)(?![\p{L}])`,
      "u",
    ),
  );
  if (suffixed) {
    const name = clean(suffixed[1]);
    if (name) return name;
  }

  // (c) a preposition cue followed by a capitalized run
  const cued = s.match(
    new RegExp(ORG_CUE.source + String.raw`(\p{Lu}[\p{L}\p{N}&.-]*(?:\s+\p{Lu}[\p{L}\p{N}&.-]*){0,2})`, "iu"),
  );
  if (cued) {
    const name = clean(cued[1]);
    if (name) return name;
  }
  return "";
}

// ---- the matcher registry --------------------------------------------------

/**
 * The ordered matchers. Each takes the built context and returns a
 * ShodanTarget or null; the first hit wins and its name becomes the
 * `intent` diagnostic. Order matters: explicit filter syntax outranks a
 * bare host mention (a user who typed `hostname:example.com port:443` wants
 * the search, not one host lookup), and the intent-free host route outranks
 * everything that reaches beyond the latest message.
 */
const MATCHERS = [
  {
    name: "filter-query",
    // Typed filter syntax is its own intent signal: nobody writes
    // `hostname:x port:443` by accident. One token still wants the intent
    // gate (a lone `port:80` can turn up in ordinary prose about a config
    // file); two or more is unambiguous on its own.
    /** @param {{ last: string, hasIntent: boolean, conversation: Conversation }} c */
    match: (c) => {
      const query = extractSearchFilters(c.last);
      if (!query) return null;
      const tokens = query.split(" ").length;
      if (!c.hasIntent && tokens < 2) return null;
      return target("search", { query, intent: "filter-query" });
    },
  },
  {
    name: "latest-host",
    /** @param {{ last: string }} c */
    match: (c) => {
      const { ips, hostnames } = extractTargets(c.last);
      if (!ips.length && !hostnames.length) return null;
      return target("hosts", { ips, hostnames, intent: "latest-host" });
    },
  },
  {
    name: "walk-back",
    /** @param {{ hasIntent: boolean, conversation: Conversation }} c */
    match: (c) => {
      if (!c.hasIntent) return null;
      const found = walkBackHost(c.conversation);
      if (!found) return null;
      return target("hosts", { ...found, followUp: true, intent: "walk-back" });
    },
  },
  {
    name: "org-search",
    /** @param {{ last: string, hasIntent: boolean }} c */
    match: (c) => {
      if (!c.hasIntent) return null;
      const org = extractOrgQuery(c.last);
      if (!org) return null;
      return target("search", { query: `org:"${org}"`, intent: "org-search" });
    },
  },
];

/**
 * @param {"hosts" | "search"} kind
 * @param {Partial<ShodanTarget>} fields
 * @returns {ShodanTarget}
 */
function target(kind, fields) {
  return {
    kind,
    ips: [],
    hostnames: [],
    query: "",
    followUp: false,
    intent: "",
    ...fields,
  };
}

/**
 * Resolves one conversation turn into what to ask Shodan, or null for
 * "nothing to do". The single entry point the enrichment runner uses.
 * @param {Conversation} conversation
 * @returns {ShodanTarget | null}
 */
export function pickShodanTarget(conversation) {
  const last = textOf(lastUserMessage(conversation)?.content);
  const ctx = { last, hasIntent: shodanIntent(last), conversation };
  for (const m of MATCHERS) {
    const hit = m.match(ctx);
    if (hit) return hit;
  }
  return null;
}

/** The matcher names, for the diagnostics vocabulary and its tests. */
export const SHODAN_MATCHER_NAMES = MATCHERS.map((m) => m.name);

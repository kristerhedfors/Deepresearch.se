// @ts-check
// THE HOST-INTELLIGENCE MCP TOOL — what an internet-facing host is running,
// asked directly rather than through a research turn.
//
// The Cyber agent already consults Shodan when a turn names a host
// (src/shodan-enrichment.js); this exposes the same lookup as a tool an external
// agent can call on its own. One tool, two shapes: a LOOKUP of named hosts
// (IPs or hostnames, resolved first) and a SEARCH over Shodan's index. They are
// one tool rather than two because they answer the same question at different
// grain — "what is on this host" and "which hosts look like this" — and a
// surface aimed at voice callers cannot afford a tool zoo.
//
// PURE — imports nothing. The schema, the target parsing and the spoken
// renderer live here; every call that reaches Shodan lives in
// src/extension-tools-run.js behind a dynamic import, which is what keeps
// src/mcp.js free of this service's name (invariant 7).
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not scan anything: every field it
// reports was already collected by Shodan and is served from their index. It
// sends the host or the query and nothing else — no conversation, no account,
// no question text — which is the same minimum the enrichment sends.

/** Hosts per call. More than a handful is a survey, and each one is a separate
 * billed lookup plus (for a hostname) a DNS resolve. */
export const MAX_HOSTS = 5;

/** Hosts reported from a search. The underlying summarizer already truncates;
 * this is what a spoken answer can carry. */
export const MAX_SEARCH_HOSTS = 5;

export const HOST_INTEL_TOOL = {
  name: "host_intel",
  description:
    "What an internet-facing host is running, from Shodan's index — open ports, service " +
    "banners, product and version where known, and any CVEs Shodan has already associated " +
    "with it. Pass `hosts` (IP addresses or hostnames, which are resolved first) to look up " +
    "specific machines, or `query` to search Shodan's index with its own query syntax " +
    "(e.g. `product:nginx country:SE`). Nothing is scanned or probed: every field is a " +
    "record Shodan already holds. Returns a spoken summary — for a caller reading aloud, " +
    "ask about one host at a time.",
  input_schema: {
    type: "object",
    properties: {
      hosts: {
        type: "array",
        items: { type: "string" },
        description: `IP addresses or hostnames to look up (up to ${MAX_HOSTS}). Hostnames are resolved to addresses first.`,
      },
      query: {
        type: "string",
        description:
          "A Shodan search query in Shodan's own syntax, e.g. `port:5432 org:\"Example AB\"`. Use instead " +
          "of `hosts` when you are looking for machines rather than at one.",
      },
      limit: {
        type: "number",
        description: `How many matching hosts to report for a search (1–${MAX_SEARCH_HOSTS}, default ${MAX_SEARCH_HOSTS}).`,
        default: MAX_SEARCH_HOSTS,
      },
    },
    required: [],
  },
};

export const SHODAN_MCP_TOOLS = [HOST_INTEL_TOOL];

/**
 * Split the `hosts` argument into the two lists the lookup takes. Accepts an
 * array or a comma/space-separated string, because a model handed a "list"
 * argument produces both.
 *
 * The IP test is deliberately loose (four dotted numbers, or something with a
 * colon that looks like IPv6): the lookup resolves hostnames anyway, so a
 * misfiled entry costs one DNS round trip rather than a wrong answer.
 *
 * @param {unknown} value
 * @returns {{ ips: string[], hostnames: string[] }}
 */
export function parseHosts(value) {
  /** @type {string[]} */
  const raw = Array.isArray(value)
    ? value.map((v) => String(v || ""))
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : [];
  /** @type {string[]} */
  const ips = [];
  /** @type {string[]} */
  const hostnames = [];
  const seen = new Set();
  for (const entry of raw) {
    // A pasted URL is a hostname with decoration; take the host out of it rather
    // than refusing something a caller clearly meant.
    const cleaned = String(entry || "")
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .replace(/[/?#].*$/, "")
      .replace(/^\[|\]$/g, "")
      .replace(/[.,;]+$/, "")
      .toLowerCase();
    if (!cleaned || seen.has(cleaned) || ips.length + hostnames.length >= MAX_HOSTS) continue;
    seen.add(cleaned);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned)) ips.push(cleaned);
    else if (cleaned.includes(":") && /^[0-9a-f:]+$/.test(cleaned)) ips.push(cleaned);
    else if (cleaned.includes(".")) hostnames.push(cleaned);
  }
  return { ips, hostnames };
}

/**
 * Clamp the search result count.
 * @param {unknown} limit
 * @returns {number}
 */
export function clampHostLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return MAX_SEARCH_HOSTS;
  return Math.min(MAX_SEARCH_HOSTS, Math.max(1, Math.round(n)));
}

/**
 * One detail line as a spoken sentence: the em-dash the block builder uses reads
 * as a pause, and a terminal stop is what separates one host from the next in
 * the ear.
 * @param {string} line
 * @returns {string}
 */
function sentence(line) {
  const text = String(line || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Turn the lookup's per-host one-liners into something speakable.
 *
 * The underlying detail lines are already terse and factual, so this mostly
 * frames them and says the one thing a listener cannot infer from silence: how
 * many of the hosts asked about were actually found. "No record" and "no open
 * ports" are different findings and a summary that blurs them is worse than
 * none.
 *
 * @param {{ targets: number, details: string[], notFound: string[] }} found
 * @returns {string}
 */
export function renderHostAnswer(found) {
  const lines = [];
  if (found.details.length) {
    lines.push(
      found.details.length === 1
        ? "Shodan has a record for this host."
        : `Shodan has records for ${found.details.length} of the ${found.targets} hosts asked about.`,
    );
    // Each host gets its own sentence. Joined with a bare space, two hosts run
    // together into one unparseable line the moment they are read aloud —
    // "…443/https 5.6.7.8 — 1 open port…" is where a listener loses the thread.
    for (const detail of found.details) lines.push(`${sentence(detail)}`);
  }
  if (found.notFound.length) {
    lines.push(
      `Shodan has no record for ${found.notFound.join(", ")} — which means it is not in their index, not that the host is closed.`,
    );
  }
  if (!lines.length) return "Shodan returned nothing for those hosts.";
  return lines.join(" ");
}

/**
 * The search answer. `total` is Shodan's own count of matches, which is usually
 * far larger than the handful reported — saying so is the difference between a
 * sample and a claim about the internet.
 * @param {{ query: string, details: string[], count: number, total: number }} found
 * @returns {string}
 */
export function renderSearchAnswer(found) {
  if (!found.count) return `Shodan found no hosts matching ${found.query}.`;
  const head =
    found.total > found.count
      ? `Shodan matches about ${found.total} hosts for ${found.query}; here are ${found.count}.`
      : `Shodan matches ${found.count} host${found.count === 1 ? "" : "s"} for ${found.query}.`;
  return [head, ...found.details.map(sentence)].join(" ");
}

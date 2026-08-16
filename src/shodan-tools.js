// @ts-check
// THE HOST-INTELLIGENCE MCP TOOLS — what is out there on the internet, asked
// directly rather than through a research turn.
//
// The Cyber agent already consults Shodan when a turn names a host
// (src/shodan-enrichment.js); this exposes that index as tools an external agent
// can call on its own. FOUR of them, and the split is by the QUESTION each one
// answers rather than by which endpoint it happens to call:
//
//   host_intel    what is on THESE machines — named hosts, IPs or hostnames.
//   host_search   which machines look like THIS, and how many there are in
//                 total, broken down by country, port, product or organization.
//   domain_intel  what a DOMAIN is made of — its subdomains and DNS records,
//                 including ones that were never scanned.
//   cve_intel     what a VULNERABILITY is, and which ones affect a product.
//
// The first three widened from one tool on 2026-08-16, on the owner's ask to
// expose more of the API than the OSINT host lookup. The line held while doing
// it is the surface's own (the mcp-server skill): a tool earns its place when a
// caller WITHOUT A SCREEN needs its answer, so each one returns spoken prose and
// none returns a table, a file tree or a URL list. What did NOT get exposed is
// as deliberate: Shodan's on-demand SCAN endpoints, network alerts and account
// management. This surface reads an index; it does not touch anyone's machines,
// and a tool that did would be a different promise entirely.
//
// PURE — imports nothing. The schemas, the argument parsing and the spoken
// renderers live here; every call that reaches Shodan lives in
// src/extension-tools-run.js behind a dynamic import, which is what keeps
// src/mcp.js free of this service's name (invariant 7).
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not scan anything: every field it
// reports was already collected by Shodan and is served from their index. It
// sends the host, the query, the domain or the CVE id and nothing else — no
// conversation, no account, no question text — which is the same minimum the
// enrichment sends.

/** Hosts per call. More than a handful is a survey, and each one is a separate
 * billed lookup plus (for a hostname) a DNS resolve. */
export const MAX_HOSTS = 5;

/** Hosts reported from a search. The underlying summarizer already truncates;
 * this is what a spoken answer can carry. */
export const MAX_SEARCH_HOSTS = 5;

/** Hosts reported from the dedicated SEARCH tool. Higher than the shortcut
 * above because a caller that reached for host_search asked to survey rather
 * than to glance — but still a number a listener can hold. */
export const MAX_SURVEY_HOSTS = 10;

/** Fields one search may be broken down by. Five is what the underlying count
 * leg keeps, and more than that read aloud is a spreadsheet. */
export const MAX_FACET_FIELDS = 5;

/** Vulnerabilities reported for a product. */
export const MAX_CVES = 10;

/** Subdomains named in a spoken answer. A big domain has hundreds; the COUNT is
 * the finding, and the list is the illustration. */
export const MAX_SPOKEN_SUBDOMAINS = 12;

/** DNS records named in a spoken answer. */
export const MAX_SPOKEN_RECORDS = 10;

/**
 * The facet fields worth offering, with what each one answers. This is a
 * SELECTOR over Shodan's own facet vocabulary rather than the whole of it: the
 * full list runs to dozens, most of them meaningless read aloud, and a model
 * handed everything picks worse than one handed the useful subset.
 */
export const FACET_FIELDS = ["country", "org", "port", "product", "asn", "city", "os", "vuln"];

/**
 * The query filters a caller most often needs, in Shodan's own syntax. Stated
 * in the schema rather than fetched from `/shodan/host/search/filters`, which
 * would be one more round trip to learn a list that changes about once a year —
 * and a caller that guesses a filter name gets an empty result set with no clue
 * why. Naming them here is what makes the broader search usable at all.
 */
export const QUERY_FILTER_HINT =
  "Shodan's syntax is `filter:value` terms ANDed together, with bare words matching the raw banner text. " +
  "The filters that carry most questions: `port:`, `product:`, `version:`, `os:`, `hostname:`, `net:` (a CIDR " +
  "range), `org:`, `asn:`, `country:` (two-letter code), `city:`, `ssl:` and `ssl.cert.subject.cn:`, `http.title:`, " +
  "`http.status:`, `vuln:` (a CVE id), `has_screenshot:true`, `tag:`, and `before:`/`after:` (dd/mm/yyyy). " +
  'Quote values containing spaces: `org:"Example AB"`. A leading `-` negates a term.';

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
          "A Shodan search query in Shodan's own syntax, e.g. `port:5432 org:\"Example AB\"`. A shortcut for " +
          "a quick look; use the `host_search` tool when you want more matches, a later page, or a " +
          "breakdown of how many hosts match in total.",
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

export const HOST_SEARCH_TOOL = {
  name: "host_search",
  description:
    "Search Shodan's index of internet-facing machines, and count how many match. Two answers from one " +
    "call: a sample of matching hosts (address, organization, location, open ports, service and version, " +
    "known CVEs), and — with `facets` — the TOTAL number of matching hosts broken down by country, port, " +
    "product or organization, which is how to answer 'how many' and 'where' rather than 'which'. " +
    "Use this for populations (an organization's exposed machines, a product's install base, a " +
    "vulnerability's spread); use `host_intel` when you already know which machines you mean. " +
    "Nothing is scanned: every record was collected by Shodan beforehand and may be weeks old. " +
    QUERY_FILTER_HINT,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The Shodan search query, e.g. `product:nginx country:SE port:443` or `vuln:CVE-2021-44228 org:\"Example AB\"`. Required.",
      },
      facets: {
        type: "array",
        items: { type: "string", enum: FACET_FIELDS },
        description:
          `Break the total match count down by these fields (up to ${MAX_FACET_FIELDS}): ` +
          `${FACET_FIELDS.join(", ")}. Counting is free and covers every match, not just the sample — ask for ` +
          "facets whenever the question is about scale or distribution.",
      },
      count_only: {
        type: "boolean",
        description:
          "Return only the totals and the breakdown, with no individual hosts. Cheaper and faster, and the " +
          "right shape when the question is 'how many' rather than 'which ones'.",
        default: false,
      },
      limit: {
        type: "number",
        description: `How many matching hosts to describe (1–${MAX_SURVEY_HOSTS}, default ${MAX_SURVEY_HOSTS}).`,
        default: MAX_SURVEY_HOSTS,
      },
      page: {
        type: "number",
        description:
          "Which page of matches to sample, 100 matches per page (default 1). Each page after the first is a " +
          "separate billed search, so page only when the first page genuinely did not answer the question.",
        default: 1,
      },
    },
    required: ["query"],
  },
};

export const DOMAIN_INTEL_TOOL = {
  name: "domain_intel",
  description:
    "What a domain is made of, from Shodan's DNS database: the subdomains they have observed, the DNS " +
    "records behind them (A, AAAA, MX, NS, TXT, CNAME), and the tags they carry. This is the attack-surface " +
    "question — how many names a domain has and where they point — and it reaches names that were never " +
    "scanned, so it finds hosts a search for `hostname:` will miss. Nothing is resolved live and nothing is " +
    "probed: these are stored observations, and one can be out of date. Returns a spoken summary.",
  input_schema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description:
          "The registrable domain, e.g. `example.com` — not a full hostname and not a URL, though both are " +
          "accepted and reduced. Required.",
      },
      type: {
        type: "string",
        description:
          "Restrict to one DNS record type (A, AAAA, CNAME, MX, NS, TXT, SOA). Omit for all of them.",
      },
      page: {
        type: "number",
        description: "Which page of records to read, for a domain with more than one page of them (default 1).",
        default: 1,
      },
    },
    required: ["domain"],
  },
};

export const CVE_INTEL_TOOL = {
  name: "cve_intel",
  description:
    "What a vulnerability actually is, from Shodan's CVE database. Pass `cve` for one identifier — summary, " +
    "CVSS severity, EPSS (the probability it is exploited in the wild in the next 30 days), whether it is on " +
    "CISA's known-exploited list, whether ransomware crews use it, the affected products, and the proposed " +
    "action. Or pass `product` for the vulnerabilities affecting a piece of software, ranked by EPSS so the " +
    "answer leads with what is being exploited rather than with what merely scores highly. " +
    "This is the tool that closes the loop after `host_intel` or `host_search` reports a bare CVE id.",
  input_schema: {
    type: "object",
    properties: {
      cve: {
        type: "string",
        description: "A single CVE identifier, e.g. `CVE-2021-44228`. The `CVE-` prefix is optional.",
      },
      product: {
        type: "string",
        description:
          "A product name, e.g. `nginx` or `log4j`, to list the vulnerabilities affecting it. Use instead of `cve`.",
      },
      kev_only: {
        type: "boolean",
        description:
          "With `product`, report only vulnerabilities on CISA's Known Exploited Vulnerabilities list — the " +
          "ones with confirmed exploitation, rather than the ones that merely could be.",
        default: false,
      },
      limit: {
        type: "number",
        description: `How many vulnerabilities to report for a product (1–${MAX_CVES}, default ${MAX_CVES}).`,
        default: MAX_CVES,
      },
    },
    required: [],
  },
};

export const SHODAN_MCP_TOOLS = [HOST_INTEL_TOOL, HOST_SEARCH_TOOL, DOMAIN_INTEL_TOOL, CVE_INTEL_TOOL];

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
  return clampCount(limit, MAX_SEARCH_HOSTS);
}

/**
 * Clamp a count argument to 1…max, defaulting rather than refusing. A model
 * that asks for 50 wants "as many as you can", not an error.
 * @param {unknown} value
 * @param {number} max
 * @returns {number}
 */
export function clampCount(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(max, Math.max(1, Math.round(n)));
}

/**
 * The facet fields to break a count down by. Unknown fields are DROPPED rather
 * than passed through: Shodan rejects the whole request for one bad facet, so
 * forwarding a guess would lose the count as well as the breakdown.
 * @param {unknown} value an array, or a comma-separated string
 * @returns {{ fields: string[], dropped: string[] }}
 */
export function parseFacets(value) {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v || ""))
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : [];
  /** @type {string[]} */
  const fields = [];
  /** @type {string[]} */
  const dropped = [];
  for (const entry of raw) {
    // `port:10` is Shodan's "top 10 values" form; the field is what gets checked.
    const cleaned = String(entry || "").trim().toLowerCase();
    if (!cleaned) continue;
    const field = cleaned.split(":")[0];
    if (!FACET_FIELDS.includes(field)) {
      if (!dropped.includes(cleaned)) dropped.push(cleaned);
      continue;
    }
    if (fields.includes(field) || fields.length >= MAX_FACET_FIELDS) continue;
    fields.push(field);
  }
  return { fields, dropped };
}

/**
 * A domain name out of whatever a caller passed — a URL, a hostname, an email
 * address, or the domain itself.
 * @param {unknown} value
 * @returns {string}
 */
export function parseDomain(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]*@/, "") // an email address is a domain with a person in front
    .replace(/[/?#].*$/, "")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  // A bare label is not a domain, and an address is a different tool's question.
  if (!cleaned.includes(".") || /^[\d.]+$/.test(cleaned)) return "";
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return "";
  return cleaned;
}

/**
 * The name one level up, or "" when there is none.
 *
 * Why this exists: `/dns/domain` answers about a REGISTRABLE domain, and a
 * caller who has been reading host records naturally passes the hostname they
 * were just told about ("www.example.com"), which answers 404. Rather than
 * refuse, the runner retries one level up — and it is one level, not a walk to
 * the TLD, because `example.co.uk` is a domain and `co.uk` is not, and no
 * amount of label counting can tell those apart without a public-suffix list.
 * @param {string} domain
 * @returns {string}
 */
export function parentDomain(domain) {
  const labels = String(domain || "").split(".").filter(Boolean);
  return labels.length > 2 ? labels.slice(1).join(".") : "";
}

/**
 * Normalize a CVE identifier. The `CVE-` prefix is optional because a caller
 * reading one out of a host record often drops it.
 * @param {unknown} value
 * @returns {string}
 */
export function parseCveId(value) {
  const cleaned = String(value || "").trim().toUpperCase().replace(/^CVE[-\s]*/, "");
  const match = /^(\d{4})-(\d{4,7})$/.exec(cleaned);
  return match ? `CVE-${match[1]}-${match[2]}` : "";
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

// ---------------------------------------------------------------------------
// host_search — the population, the breakdown, and a sample
// ---------------------------------------------------------------------------

/**
 * One searched host as a spoken clause. Richer than the enrichment's detail
 * line because this tool's whole answer is the hosts, where the enrichment's is
 * a context block the model reads for itself.
 * @param {{ ip: string, org?: string, location?: string, hostnames?: string[], ports?: number[], products?: string[], vulns?: string[] }} host
 * @returns {string}
 */
export function renderHostLine(host) {
  const parts = [];
  const name = host.hostnames?.length ? `${host.ip}, which answers to ${host.hostnames[0]}` : host.ip;
  parts.push(name);
  if (host.org) parts.push(`at ${host.org}`);
  if (host.location) parts.push(`in ${host.location}`);
  const head = parts.join(" ");
  const tail = [];
  if (host.ports?.length) tail.push(`ports ${host.ports.join(", ")} open`);
  if (host.products?.length) tail.push(`running ${host.products.join(", ")}`);
  // The CVE count leads and the identifiers follow: a listener needs to know
  // how bad before they need to know which.
  if (host.vulns?.length) {
    tail.push(`${host.vulns.length} known ${host.vulns.length === 1 ? "vulnerability" : "vulnerabilities"}, ${host.vulns.slice(0, 3).join(", ")}`);
  }
  return sentence(tail.length ? `${head}: ${tail.join("; ")}` : head);
}

/**
 * One facet as a spoken clause: "the top countries are the United States with
 * 4,102, Germany with 991…". Read aloud, a field name and a bare list of pairs
 * is unparseable, so each value is given its count in words of its own.
 * @param {{ field: string, values: Array<{ value: string, count: number }> }} facet
 * @returns {string}
 */
function renderFacet(facet) {
  const label = FACET_LABELS[facet.field] || facet.field;
  const values = facet.values.map((v) => `${v.value} with ${v.count}`);
  return sentence(`By ${label}, the largest are ${listPhrase(values)}`);
}

/** Field id → what it is called out loud.
 * @type {Record<string, string>} */
const FACET_LABELS = {
  country: "country",
  org: "organization",
  port: "open port",
  product: "product",
  asn: "network",
  city: "city",
  os: "operating system",
  vuln: "known vulnerability",
};

/**
 * "a, b and c" — the spoken form of a list. A comma before the last item reads
 * as another item.
 * @param {string[]} items
 * @returns {string}
 */
function listPhrase(items) {
  const list = items.filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * The host_search answer.
 *
 * The TOTAL leads and the sample follows, always, and that ordering is the
 * whole point of the tool: the number of matching hosts is the finding, and the
 * handful described is an illustration of it. A summary that opens with three
 * machines has already told the listener that three is the answer.
 *
 * @param {{
 *   query: string,
 *   total: number,
 *   counted: boolean,
 *   page: number,
 *   facets: Array<{ field: string, values: Array<{ value: string, count: number }> }>,
 *   hosts: string[],
 *   countOnly: boolean,
 *   dropped: string[]
 * }} found where `counted` says a real (credit-free) count ran rather than the
 *   total coming off the search, `hosts` are rendered host clauses, and
 *   `dropped` are facet fields that were not recognized
 * @returns {string}
 */
export function renderSurveyAnswer(found) {
  const lines = [];
  const total = Number.isFinite(found.total) ? found.total : 0;
  if (!total) {
    lines.push(`Nothing in Shodan's index matches ${found.query}.`);
  } else {
    lines.push(`Shodan matches ${total} host${total === 1 ? "" : "s"} for ${found.query}.`);
  }
  for (const facet of found.facets || []) lines.push(renderFacet(facet));
  if (!found.countOnly && found.hosts?.length) {
    const shown = found.hosts.length;
    if (total > shown) {
      lines.push(
        found.page > 1
          ? `Here ${shown === 1 ? "is one" : `are ${shown}`} of them, from page ${found.page} of the matches.`
          : `Here ${shown === 1 ? "is one" : `are ${shown}`} of them.`,
      );
    }
    lines.push(...found.hosts);
  } else if (!found.countOnly && total > 0) {
    // A total with no sample is what a later page past the end looks like, and
    // it is a different thing from no matches at all.
    lines.push(
      found.page > 1
        ? `No hosts came back on page ${found.page}, though the query itself matches — try an earlier page.`
        : "No individual hosts came back for it.",
    );
  }
  if (found.dropped?.length) {
    lines.push(
      sentence(
        `${listPhrase(found.dropped)} ${found.dropped.length === 1 ? "is not a field" : "are not fields"} this can break the count down by; ` +
          `the ones it can are ${listPhrase(FACET_FIELDS)}`,
      ),
    );
  }
  return lines.join(" ");
}

// ---------------------------------------------------------------------------
// domain_intel
// ---------------------------------------------------------------------------

/**
 * The domain answer. The subdomain COUNT leads for the same reason the match
 * total does in a search: it is the attack-surface figure, and the names are
 * the illustration.
 * @param {{
 *   domain: string,
 *   asked: string,
 *   tags: string[],
 *   subdomains: string[],
 *   subdomainTotal: number,
 *   records: Array<{ name: string, type: string, value: string, lastSeen: string }>,
 *   more: boolean,
 *   type: string
 * }} found where `asked` is the name the caller passed when it differed from
 *   the one that answered, and `type` is a record-type filter when one applied
 * @returns {string}
 */
export function renderDomainAnswer(found) {
  const lines = [];
  if (found.asked && found.asked !== found.domain) {
    lines.push(`${found.asked} is not a domain Shodan tracks on its own, so this is ${found.domain}.`);
  }
  const total = found.subdomainTotal || 0;
  if (total) {
    const named = found.subdomains.slice(0, MAX_SPOKEN_SUBDOMAINS);
    const head = `Shodan knows ${total} subdomain${total === 1 ? "" : "s"} of ${found.domain}`;
    lines.push(
      named.length && named.length < total
        ? sentence(`${head}, among them ${listPhrase(named)}`)
        : named.length
          ? sentence(`${head}: ${listPhrase(named)}`)
          : sentence(head),
    );
  } else {
    lines.push(`Shodan knows no subdomains of ${found.domain}.`);
  }
  if (found.tags?.length) lines.push(sentence(`It is tagged ${listPhrase(found.tags)}`));

  const records = found.records || [];
  if (records.length) {
    const byType = new Map();
    for (const r of records) byType.set(r.type, (byType.get(r.type) || 0) + 1);
    const typeSummary = [...byType.entries()].map(([type, n]) => `${n} ${type}`);
    lines.push(
      sentence(
        found.type
          ? `It has ${records.length} ${found.type} record${records.length === 1 ? "" : "s"} on this page`
          : `The records on this page are ${listPhrase(typeSummary)}`,
      ),
    );
    for (const r of records.slice(0, MAX_SPOKEN_RECORDS)) {
      lines.push(sentence(`${r.name} ${r.type} points to ${r.value}${r.lastSeen ? `, last seen ${r.lastSeen}` : ""}`));
    }
    if (records.length > MAX_SPOKEN_RECORDS) {
      lines.push(`${records.length - MAX_SPOKEN_RECORDS} further records were not read out.`);
    }
  } else if (found.type) {
    lines.push(`It has no ${found.type} records in Shodan's database.`);
  }
  if (found.more) lines.push("There are more records than fit on this page — ask for the next page to continue.");
  // Said once, at the end, because every clause above is a stored observation
  // and a listener who does not know that will read a stale record as current.
  lines.push("These are records Shodan has collected over time, not a live DNS lookup, so one can be out of date.");
  return lines.join(" ");
}

// ---------------------------------------------------------------------------
// cve_intel
// ---------------------------------------------------------------------------

/**
 * The two severity numbers as a spoken clause. They mean different things —
 * CVSS is how bad it would be, EPSS is how likely it is to happen — and the
 * commonest way a vulnerability answer misleads is by reporting one as the
 * other, so each is named where it is said.
 * @param {{ cvss: number | null, epss: number | null }} vuln
 * @returns {string[]}
 */
function severityBits(vuln) {
  /** @type {string[]} */
  const bits = [];
  if (vuln.cvss !== null && vuln.cvss !== undefined) bits.push(`a CVSS severity of ${vuln.cvss} out of 10`);
  const epss = epssPercent(vuln.epss);
  if (epss) bits.push(`an EPSS score of ${epss}, the estimated chance it is exploited in the wild in the next 30 days`);
  return bits;
}

/**
 * EPSS as a percentage a person can weigh — "0.0432" is a number nobody can.
 *
 * The rounding is capped deliberately. EPSS is a probability and never reaches
 * 1, but a live read of CVE-2021-44228 returns 0.99999, which rounds to a flat
 * "100%" — a certainty the model does not claim and this tool must not invent.
 * The other end matters as much: a small probability rounded to "0%" reads as
 * "will not happen", so anything non-zero keeps a decimal.
 * @param {number | null | undefined} epss
 * @returns {string} the formatted percentage, or "" when there is no score
 */
export function epssPercent(epss) {
  if (epss === null || epss === undefined || !Number.isFinite(Number(epss))) return "";
  const value = Number(epss);
  if (value >= 0.995) return "over 99%";
  if (value >= 0.01) return `${Math.round(value * 100)}%`;
  const tenths = Math.round(value * 1000) / 10;
  return tenths > 0 ? `${tenths}%` : "under 0.1%";
}

/** The exploitation status, which outranks any score a caller might act on.
 * @param {{ kev: boolean, ransomware: string }} vuln
 * @returns {string}
 */
function exploitationClause(vuln) {
  const bits = [];
  if (vuln.kev) bits.push("it is on CISA's known-exploited list, so exploitation has been confirmed in the wild");
  if (vuln.ransomware && !/^unknown$/i.test(vuln.ransomware)) bits.push("it is known to be used in ransomware campaigns");
  return bits.length ? sentence(capitalize(listPhrase(bits))) : "";
}

/** @param {string} text */
function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * One vulnerability, in full.
 *
 * THE ORDER IS THE DESIGN, and it changed on 2026-08-16 after a live read.
 * CVEDB summaries open with an affected-version table — CVE-2021-44228's runs
 * to 90 words before it says what the flaw does — and putting that first meant
 * a listener heard a version list for fifteen seconds before reaching "severity
 * 10, confirmed exploited in the wild". The two figures a caller acts on lead
 * now, and the prose follows them.
 * @param {{ id: string, summary: string, cvss: number | null, epss: number | null, kev: boolean, ransomware: string, published: string, products: string[], productTotal?: number, action: string }} vuln
 * @returns {string}
 */
export function renderCveAnswer(vuln) {
  const lines = [];
  const head = `${vuln.id}${vuln.published ? `, published ${vuln.published}` : ""}`;
  const bits = severityBits(vuln);
  if (bits.length) {
    lines.push(sentence(`${head}, carries ${listPhrase(bits)}`));
    const exploited = exploitationClause(vuln);
    if (exploited) lines.push(exploited);
    if (vuln.summary) lines.push(sentence(`The flaw itself: ${vuln.summary}`));
  } else {
    // Nothing scored it, so there is no headline to lead with and the summary
    // IS the answer — folded into the opening rather than announced, which is
    // how it read before the reordering and still reads best here.
    lines.push(sentence(vuln.summary ? `${head}: ${vuln.summary}` : head));
    const exploited = exploitationClause(vuln);
    if (exploited) lines.push(exploited);
  }
  if (vuln.products?.length) {
    // The CPE list is ALPHABETICAL, so these are the alphabetically-first
    // products and not the most affected ones. Naming six of several hundred
    // without the total states a sample as the population.
    const total = Number(vuln.productTotal) || vuln.products.length;
    const extra = total - vuln.products.length;
    lines.push(
      sentence(
        extra > 0
          ? `It affects ${total} products in all, among them ${listPhrase(vuln.products)}`
          : `It affects ${listPhrase(vuln.products)}`,
      ),
    );
  }
  // The proposed action often restates the summary in different words; it is
  // kept only when it adds something, since hearing the same finding twice is
  // how a spoken answer loses a listener.
  if (vuln.action && !restates(vuln.action, vuln.summary)) lines.push(sentence(vuln.action));
  return lines.join(" ");
}

/**
 * Does this text say what the other one already said? A cheap content-word
 * overlap, deliberately: the two fields are written by the same hand from the
 * same finding, so near-duplication is common and exact duplication is rare.
 *
 * WHERE THE THRESHOLD COMES FROM, and how thin the evidence is. Two points,
 * both measured on 2026-08-16: CVE-2021-44228's `propose_action` restates its
 * summary at **0.67** (the five unshared words are "contains", "where",
 * "allowing", plus "remote code execution" where the summary says "execute
 * arbitrary code"), while an action that genuinely adds a remediation lands
 * near **0.4**. 0.6 sits in that gap. It is ONE observed restatement, so treat
 * a future miss as a reason to re-measure rather than to nudge the number —
 * and note the `size < 4` guard means a short action ("Upgrade to 2.17.1.")
 * is never dropped, which is the case where being wrong would cost most.
 * @param {string} text
 * @param {string} against
 * @returns {boolean}
 */
function restates(text, against) {
  // Split on everything that is not a letter or digit. Keeping `.` as a word
  // character (for version numbers) silently broke this: almost every
  // sentence-final word carried its full stop, so "execution." never matched
  // "execution" and the overlap never reached the threshold.
  const words = (/** @type {string} */ s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 4),
    );
  const a = words(text);
  const b = words(against);
  if (a.size < 4 || b.size < 4) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / a.size >= 0.6;
}

/**
 * The vulnerabilities affecting a product, most exploitable first.
 * @param {{ subject: string, vulns: Array<{ id: string, summary: string, cvss: number | null, epss: number | null, kev: boolean, ransomware: string, published: string }>, kevOnly: boolean }} found
 * @returns {string}
 */
export function renderProductCveAnswer(found) {
  if (!found.vulns.length) {
    return found.kevOnly
      ? `Shodan's database lists no known-exploited vulnerabilities for ${found.subject}.`
      : `Shodan's database lists no vulnerabilities for ${found.subject}. Either the name does not match a product it tracks, or there are none — try the exact product name a banner reports.`;
  }
  const n = found.vulns.length;
  const lines = [
    `Shodan lists ${n} ${found.kevOnly ? "known-exploited " : ""}vulnerabilit${n === 1 ? "y" : "ies"} for ${found.subject}, ` +
      `most likely to be exploited first.`,
  ];
  for (const vuln of found.vulns) {
    const bits = [];
    if (vuln.cvss !== null && vuln.cvss !== undefined) bits.push(`severity ${vuln.cvss}`);
    const epss = epssPercent(vuln.epss);
    if (epss) bits.push(`${epss} exploitation probability`);
    if (vuln.kev) bits.push("known exploited");
    const head = `${vuln.id}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
    // The summary is a paragraph in the record; one clause of it is what a
    // listener can hold between one identifier and the next.
    lines.push(sentence(vuln.summary ? `${head}: ${firstClause(vuln.summary)}` : head));
  }
  return lines.join(" ");
}

/**
 * The first sentence of a summary, bounded. CVE summaries open with the
 * finding and continue into version tables nobody can hear.
 * @param {string} text
 * @returns {string}
 */
function firstClause(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const stop = clean.indexOf(". ");
  const first = stop > 0 ? clean.slice(0, stop) : clean;
  return first.length > 240 ? `${first.slice(0, 237).trimEnd()}…` : first;
}

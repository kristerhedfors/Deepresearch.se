// Unit tests for the Shodan language gate (src/shodan-text.js) — the module
// that decides WHAT (if anything) the Shodan integration is asked about.
//
// Why this file is exhaustive. Until 2026-08-07 the integration had no intent
// gate: it looked up whatever host the latest user message happened to
// contain and had no other way in. Production showed exactly what that costs
// (chat_logs #1670-#1672, 2026-08-06):
//
//   #1670  "Ports open on basalt.se"        — fired (a host is present)
//   #1671  "Shodan"                          — could not fire: no host
//   #1672  "Run through shodan to answer!"   — could not fire: no host
//
// All three verbatim messages are pinned below against the routes that now
// serve them, so the regression is traceable from the log id. Alongside them
// sits the verbatim #612 message (2026-07-24) which DID work before the gate
// existed — pinned so we can prove the fix did not change what already worked.
//
// The other three things this file exists to hold still:
//
//   1. CLAUDE.md invariant 6 (Swedish parity). Every subject group is tested
//      as EN⇄SV pairs, ASCII-typed Swedish included, plus a dedicated subtest
//      for the `\b` trap — JS defines `\b` over [A-Za-z0-9_], so a Swedish
//      alternative starting or ending in å/ä/ö is silently dead inside
//      `\b(...)\b` while the English half keeps passing.
//   2. CLAUDE.md invariant 4 (privacy). Only what these functions extract ever
//      crosses the wire, so: unrecognized `key:value` tokens must be DROPPED
//      from the rebuilt query, and the walk-back must never read assistant
//      turns (an answer is full of third-party source URLs).
//   3. Route precedence. SHODAN_MATCHER_NAMES is the order, and the
//      intent-free `latest-host` route must stay intent-free.
//
// No `// @ts-check`: the junk-input subtests deliberately feed null,
// undefined, numbers and objects through parameters typed as strings and
// conversations, which is the point of those tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SHODAN_MATCHER_NAMES,
  extractOrgQuery,
  extractSearchFilters,
  pickShodanTarget,
  shodanIntent,
  walkBackHost,
} from "./shodan-text.js";

/** One user turn — the shape the enrichment runner passes in. */
const u = (content) => [{ role: "user", content }];

// ---------------------------------------------------------------------------
// shodanIntent
// ---------------------------------------------------------------------------

test("shodanIntent — English forms across all five subject groups", async (t) => {
  await t.test("naming the service itself", () => {
    for (const s of [
      "Shodan",
      "Run through shodan to answer!",
      "use SHODAN for this",
      "can you check shodan.io",
      "something shodan-like",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("ports", () => {
    for (const s of [
      "open ports",
      "which ports are open",
      "what ports are open on it",
      "port scan",
      "portscan the host",
      "exposed ports",
      "listening ports",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("services and banners", () => {
    for (const s of [
      "what's running on that box",
      "what is running on it",
      "exposed services",
      "running services",
      "which services",
      "service banners",
      "banner grab",
      "internet-facing",
      "internet facing hosts",
      "exposed to the internet",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("attack surface / OSINT", () => {
    for (const s of [
      "attack surface",
      "attack-surface management",
      "OSINT",
      "external footprint",
      "internet exposure",
      "exposure management",
      "host intelligence",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("known vulnerabilities attached to a host", () => {
    for (const s of [
      "known CVEs",
      "known vulnerabilities",
      "CVE-2021-44228",
      "cve 2021 44228",
      "vulnerable services",
      "unpatched services",
    ]) assert.equal(shodanIntent(s), true, s);
  });
});

test("shodanIntent — Swedish parity (invariant 6), as EN⇄SV pairs", async (t) => {
  // Each pair is [English, Swedish]. Written as pairs on purpose (the
  // discipline in src/europepmc.test.js): an English-only addition to a
  // subject group is then visibly missing its twin rather than quietly
  // passing.
  await t.test("ports", () => {
    for (const [en, sv] of [
      ["open ports", "öppna portar"],
      ["which ports are open", "vilka portar är öppna"],
      ["the ports are open", "portar som är öppna"],
      ["port scan", "portskanning"],
      ["portscan", "portscanning"],
      ["exposed ports", "exponerade portar"],
      ["listening ports", "lyssnande portar"],
      ["an open port", "en öppen port"],
    ]) {
      assert.equal(shodanIntent(en), true, `EN: ${en}`);
      assert.equal(shodanIntent(sv), true, `SV: ${sv}`);
    }
  });

  await t.test("services", () => {
    for (const [en, sv] of [
      ["exposed services", "exponerade tjänster"],
      ["running services", "tjänster som körs"],
      ["what is running on the server", "vad körs på servern"],
      ["which services", "vilka tjänster"],
      ["service banners", "tjänstebanner"],
      ["internet-facing", "internetexponerad"],
      ["exposed to the internet", "exponerad mot internet"],
    ]) {
      assert.equal(shodanIntent(en), true, `EN: ${en}`);
      assert.equal(shodanIntent(sv), true, `SV: ${sv}`);
    }
  });

  await t.test("attack surface", () => {
    for (const [en, sv] of [
      ["attack surface", "attackyta"],
      ["attack surface", "angreppsyta"],
      ["internet exposure", "extern exponering"],
      ["exposure management", "exponeringsyta"],
      ["external footprint", "fotavtryck på internet"],
    ]) {
      assert.equal(shodanIntent(en), true, `EN: ${en}`);
      assert.equal(shodanIntent(sv), true, `SV: ${sv}`);
    }
  });

  await t.test("vulnerabilities", () => {
    for (const [en, sv] of [
      ["known vulnerabilities", "kända sårbarheter"],
      ["known CVEs", "kända CVE"],
      ["vulnerable services", "sårbara tjänster"],
      ["unpatched services", "opatchade tjänster"],
    ]) {
      assert.equal(shodanIntent(en), true, `EN: ${en}`);
      assert.equal(shodanIntent(sv), true, `SV: ${sv}`);
    }
  });

  await t.test("Swedish definite and inflected forms", () => {
    // A gate that only knows the indefinite singular is a gate that misses
    // most of the way Swedes actually type.
    for (const s of [
      "de öppna portarna",
      "portarna som är öppna",
      "nätverksportarna",
      "attackytan",
      "angreppsytan",
      "de kända sårbarheterna",
      "exponerade tjänsterna",
      "vilka portar är öppna på servern",
      "företagets angreppsyta",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("Swedish alternatives that carry the group on their own", () => {
    // These two have no English twin in the gate today — "network ports" and
    // "external exposure" fire nothing, while "nätverksportar" and "extern
    // exponering" do. Pinned on the Swedish side only: the missing English
    // wording is reported as a gap, not blessed here by asserting it false.
    for (const s of ["nätverksportar", "extern exponering"]) {
      assert.equal(shodanIntent(s), true, s);
    }
  });

  await t.test("ASCII-typed Swedish (English keyboard, no å/ä/ö)", () => {
    // A Swedish user on a US keyboard types "oppna portar", not "öppna
    // portar". EVERY Swedish alternative carrying å/ä/ö must have its ASCII
    // twin, in every subject group — a half-applied fallback set (the state
    // of the SERVICE and VULN groups until 2026-08-07) is invariant 6 failing
    // on exactly the users the fallbacks were written for.
    for (const s of [
      // ports
      "oppna portar",
      "oppen port",
      "natverksportar",
      "vilka portar ar oppna",
      "portar som ar oppna",
      "portscanning",
      // services
      "tjanster som kors",
      "exponerade tjanster",
      "vilka tjanster",
      "vad kors pa servern",
      "tjanstebanner",
      "internetvand",
      // attack surface
      "extern exponering",
      "fotavtryck pa internet",
      // vulnerabilities
      "kanda cve",
      "kanda sarbarheter",
      "sarbara tjanster",
      "opatchade tjanster",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("reverse parity: Swedish alternatives have English twins too", () => {
    // Invariant 6 is usually broken the other way round, which makes these
    // easy to miss: "nätverksportar" and "extern exponering" fired while
    // "network ports" and "external exposure" did not (found 2026-08-07).
    for (const [sv, en] of [
      ["nätverksportar", "network ports"],
      ["extern exponering", "external exposure"],
      ["fotavtryck på internet", "external footprint"],
    ]) {
      assert.equal(shodanIntent(sv), true, sv);
      assert.equal(shodanIntent(en), true, en);
    }
  });

  await t.test("Swedish definite and inflected suffixes survive the wildcard", () => {
    // `[\p{L}]*`, never `\w*` — `\w` stops at the first accented letter, so
    // `tjänster\w*` could not reach "tjänsterna".
    for (const s of [
      "vilka tjänsterna körs",
      "exponerade tjänsterna",
      "attackytan",
      "angreppsytan",
      "portskanningen",
    ]) assert.equal(shodanIntent(s), true, s);
  });
});

test("shodanIntent — the \\b trap: å/ä/ö at a word edge (invariant 6)", async (t) => {
  // JS `\b` is defined over [A-Za-z0-9_]. In `/\böppna portar\b/` the leading
  // boundary needs a word character immediately before "ö" — and in " öppna
  // portar" there is a space, so the alternative can NEVER match. The failure
  // is silent: the English half of the same regex keeps matching, every
  // English test stays green, and invariant 6 dies unnoticed.
  //
  // shodan-text.js therefore uses `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])`
  // lookarounds instead. Every string below has a SPACE (or nothing) before a
  // leading å/ä/ö, or a trailing å/ä/ö — exactly the cases that regress if
  // someone rewrites the gate with `\b`.
  await t.test("a leading ö after a space still matches", () => {
    for (const s of [
      " öppna portar",
      "visa öppna portar",
      "hitta öppna nätverksportar",
      "har vi öppna portar",
      "en öppen port",
    ]) assert.equal(shodanIntent(s), true, JSON.stringify(s));
  });

  await t.test("a leading å/ä after a space still matches", () => {
    for (const s of [
      "vilka ärenden — ägs av oss: ändå, öppna portar",
      "finns ändå öppna portar",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("a Swedish word before the keyword still matches", () => {
    // "vår attackyta": the char before "attackyta" is a space preceded by
    // "vår" — a `\b`-based gate with the Swedish alternatives inside the same
    // group breaks on precisely this shape.
    for (const s of [
      "vår attackyta",
      "vår angreppsyta",
      "våra öppna portar",
      "företagets kända sårbarheter",
      "hela vår exponeringsyta",
    ]) assert.equal(shodanIntent(s), true, s);
  });

  await t.test("a trailing å/ä/ö keyword at end of string still matches", () => {
    for (const s of [
      "vad körs på",
      "kolla fotavtryck på internet",
    ]) assert.equal(shodanIntent(s), true, s);
  });
});

test("shodanIntent — negatives", async (t) => {
  await t.test("ordinary research questions (EN)", () => {
    for (const s of [
      "what is the capital of France",
      "explain the history of the Hanseatic League",
      "summarise this paper on photosynthesis",
      "who founded the company",
    ]) assert.equal(shodanIntent(s), false, s);
  });

  await t.test("ordinary research questions (SV)", () => {
    for (const s of [
      "vad är huvudstaden i Frankrike",
      "hur fungerar fotosyntes",
      "berätta om Hansan",
      "vem grundade företaget",
    ]) assert.equal(shodanIntent(s), false, s);
  });

  await t.test("general security talk with no host framing", () => {
    for (const s of [
      "how do I write secure code",
      "is TLS 1.3 secure",
      "vad är bra säkerhet",
      "explain the difference between symmetric and asymmetric crypto",
      "hur fungerar en brandvägg",
    ]) assert.equal(shodanIntent(s), false, s);
  });

  await t.test("words that merely CONTAIN a keyword", () => {
    // "transport"/"reportage" contain "port"; "rapportera"/"exporterade"
    // contain "porter"/"portera"; "important" contains "port". A gate written
    // without boundaries fires on all of them.
    for (const s of [
      "transport",
      "reportage",
      "important",
      "rapportera",
      "exporterade",
      "the transport layer",
      "important reportage about transport",
      "en rapportering om exporterade varor",
      "vi ska rapportera om transporterna",
    ]) assert.equal(shodanIntent(s), false, s);
  });

  await t.test("the service name inside a longer word does not fire", () => {
    for (const s of ["shodanesque", "preshodan", "MySHODANX"]) {
      assert.equal(shodanIntent(s), false, s);
    }
  });

  await t.test("junk input returns false without throwing", () => {
    for (const bad of [null, undefined, "", 0, 42, {}, [], () => {}, NaN]) {
      assert.equal(shodanIntent(bad), false, String(bad));
    }
    assert.equal(shodanIntent("x".repeat(20000)), false);
  });
});

// ---------------------------------------------------------------------------
// extractSearchFilters
// ---------------------------------------------------------------------------

test("extractSearchFilters", async (t) => {
  await t.test("pulls every recognized filter key", () => {
    for (const [input, expected] of [
      ["org:Bahnhof", "org:Bahnhof"],
      ["hostname:example.com", "hostname:example.com"],
      ["port:443", "port:443"],
      ["product:nginx", "product:nginx"],
      ["ssl:true", "ssl:true"],
      ["net:1.2.3.0/24", "net:1.2.3.0/24"],
      ["country:SE", "country:SE"],
      ["city:Stockholm", "city:Stockholm"],
      ["asn:AS8473", "asn:AS8473"],
      ["os:linux", "os:linux"],
      ["vuln:CVE-2021-44228", "vuln:CVE-2021-44228"],
      ["http.title:login", "http.title:login"],
      ["http.status:200", "http.status:200"],
      ["isp:Telia", "isp:Telia"],
      ["before:01/01/2024", "before:01/01/2024"],
      ["after:01/01/2023", "after:01/01/2023"],
    ]) assert.equal(extractSearchFilters(input), expected, input);
  });

  await t.test("single and double quoted values, spaces re-quoted", () => {
    assert.equal(extractSearchFilters('org:"Basalt AB"'), 'org:"Basalt AB"');
    assert.equal(extractSearchFilters("org:'Basalt AB'"), 'org:"Basalt AB"');
    assert.equal(
      extractSearchFilters('http.title:"admin login"'),
      'http.title:"admin login"',
    );
    // Quotes the user typed SURVIVE even on a single word: `http.title:"login"`
    // is an exact-phrase query to Shodan and `http.title:login` is not, so
    // stripping them would change what was asked (fixed 2026-08-07).
    assert.equal(extractSearchFilters('http.title:"login"'), 'http.title:"login"');
    // An unquoted single word stays unquoted.
    assert.equal(extractSearchFilters("http.title:login"), "http.title:login");
    assert.equal(
      extractSearchFilters('org:"Basalt AB" port:443'),
      'org:"Basalt AB" port:443',
    );
  });

  await t.test("the key is normalized to lower case, spacing tolerated", () => {
    assert.equal(extractSearchFilters("ORG:Bahnhof"), "org:Bahnhof");
    assert.equal(extractSearchFilters("port : 443"), "port:443");
  });

  await t.test(
    "PRIVACY: unrecognized keys are dropped entirely (invariant 4)",
    () => {
      // The rebuilt query is the ONLY thing that crosses the wire to Shodan.
      // An unrecognized `key:value` must never survive the rebuild — which is
      // what stops a message like "password:hunter2" being forwarded to a
      // third party because it happened to be shaped like a filter.
      for (const [input, expected] of [
        ["foo:bar port:443", "port:443"],
        ["password:hunter2 port:80", "port:80"],
        ["key:secret hostname:x.se", "hostname:x.se"],
        ["token:abc123 apikey:zzz secret:shh", ""],
        ["foo:bar", ""],
      ]) {
        const out = extractSearchFilters(input);
        assert.equal(out, expected, input);
      }
      const out = extractSearchFilters(
        "foo:bar password:hunter2 key:secret org:Bahnhof",
      );
      for (const leaked of ["foo", "bar", "password", "hunter2", "key", "secret"]) {
        assert.ok(!out.includes(leaked), `${leaked} leaked into "${out}"`);
      }
      assert.equal(out, "org:Bahnhof");
    },
  );

  await t.test("dedupes identical tokens", () => {
    assert.equal(extractSearchFilters("port:443 port:443 port:80"), "port:443 port:80");
    assert.equal(
      extractSearchFilters('org:"Basalt AB" org:"Basalt AB"'),
      'org:"Basalt AB"',
    );
  });

  await t.test("caps at 6 tokens", () => {
    const out = extractSearchFilters(
      "port:1 port:2 port:3 port:4 port:5 port:6 port:7 port:8",
    );
    assert.equal(out.split(" ").length, 6);
    assert.equal(out, "port:1 port:2 port:3 port:4 port:5 port:6");
  });

  await t.test("caps the query at 200 chars on a TOKEN boundary, never mid-value", () => {
    // A raw slice at 200 would chop a value in half and emit a malformed
    // filter, which Shodan would then answer for a query nobody wrote
    // (fixed 2026-08-07). Tokens are dropped whole instead.
    const long = ["org", "isp", "city", "product", "os", "hostname"]
      .map((k) => `${k}:${"a".repeat(60)}`)
      .join(" ");
    const out = extractSearchFilters(long);
    assert.ok(out.length <= 200, `${out.length} <= 200`);
    for (const token of out.split(" ")) {
      assert.match(token, /^[a-z.]+:a{60}$/, `whole token: ${token}`);
    }
  });

  await t.test("a key:value inside a URL is not a filter (the (?<![\\w.]) guard)", () => {
    // Without the lookbehind, "https://example.com:443/x" yields a bogus
    // `port`-shaped token from the URL's port and the site starts querying
    // Shodan for whatever a cited link happened to contain.
    assert.equal(extractSearchFilters("https://example.com:443/x"), "");
    assert.equal(extractSearchFilters("http://host:80"), "");
    assert.equal(extractSearchFilters("ftp://x.se:21"), "");
    // A real filter alongside a URL still survives.
    assert.equal(
      extractSearchFilters("see https://example.com:443/x for port:443"),
      "port:443",
    );
  });

  await t.test("no filters, empty values, and junk return an empty string", () => {
    for (const bad of [
      "",
      "no filters here at all",
      "vad är öppna portar egentligen",
      "org:",
      'org:""',
      null,
      undefined,
      0,
      42,
      {},
      [],
      () => {},
    ]) assert.equal(extractSearchFilters(bad), "", String(bad));
  });
});

// ---------------------------------------------------------------------------
// walkBackHost
// ---------------------------------------------------------------------------

test("walkBackHost", async (t) => {
  await t.test("finds the host an earlier USER turn named", () => {
    const conversation = [
      { role: "user", content: "Tell me about basalt.se" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "Shodan" },
    ];
    assert.deepEqual(walkBackHost(conversation), { ips: [], hostnames: ["basalt.se"] });
  });

  await t.test("newest-first: the most recent earlier turn wins", () => {
    const conversation = [
      { role: "user", content: "first, example.org" },
      { role: "user", content: "actually basalt.se" },
      { role: "user", content: "open ports?" },
    ];
    assert.deepEqual(walkBackHost(conversation), { ips: [], hostnames: ["basalt.se"] });
  });

  await t.test("finds IPs too", () => {
    const conversation = [
      { role: "user", content: "look at 8.8.8.8" },
      { role: "user", content: "open ports?" },
    ];
    assert.deepEqual(walkBackHost(conversation), { ips: ["8.8.8.8"], hostnames: [] });
  });

  await t.test(
    "PRIVACY: assistant turns are never scanned, so cited source URLs are never walked back",
    () => {
      // An answer is full of third-party source URLs. If the walk-back read
      // assistant turns, every vague follow-up ("open ports?") would spray
      // arxiv.org, basalt.se and whatever else the last answer cited at
      // Shodan — a third party the user never pointed at. Invariant 4: the
      // minimum leaves the Worker, and only what the USER named is a target.
      const conversation = [
        { role: "user", content: "tell me about that company" },
        {
          role: "assistant",
          content:
            "Sources: https://basalt.se/en/ , https://arxiv.org/abs/2401.00001 , " +
            "https://www.bahnhof.se/about and 93.184.216.34",
        },
        { role: "user", content: "and what else did they publish" },
        {
          role: "assistant",
          content: "See https://example.com/report and https://scholar.google.com/x",
        },
        { role: "user", content: "open ports?" },
      ];
      assert.equal(walkBackHost(conversation), null);
    },
  );

  await t.test("skips the LATEST user turn (route 0 owns it)", () => {
    // The host is only in the newest turn, which latest-host already handles.
    assert.equal(walkBackHost(u("Ports open on basalt.se")), null);
    assert.equal(
      walkBackHost([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "Ports open on basalt.se" },
      ]),
      null,
    );
  });

  await t.test("bounded to the last 12 earlier user turns", () => {
    const withHostAtOldest = (n) => {
      const conversation = [{ role: "user", content: "start at basalt.se" }];
      for (let i = 1; i < n; i++) conversation.push({ role: "user", content: `turn ${i}` });
      return conversation;
    };
    // 20 turns: the oldest falls outside the window, so nothing is found —
    // one vague follow-up can't turn a long conversation into a scan of
    // everything ever mentioned.
    assert.equal(walkBackHost(withHostAtOldest(20)), null);
    // The exact boundary: 13 turns leaves 12 earlier ones (the oldest is the
    // 12th), 14 pushes it out.
    assert.deepEqual(walkBackHost(withHostAtOldest(13)), {
      ips: [],
      hostnames: ["basalt.se"],
    });
    assert.equal(walkBackHost(withHostAtOldest(14)), null);
  });

  await t.test("multipart content is read through textOf", () => {
    const conversation = [
      { role: "user", content: [{ type: "text", text: "about basalt.se" }] },
      { role: "user", content: "open ports?" },
    ];
    assert.deepEqual(walkBackHost(conversation), { ips: [], hostnames: ["basalt.se"] });
  });

  await t.test("junk conversations return null without throwing", () => {
    for (const bad of [
      undefined,
      null,
      "not an array",
      42,
      {},
      [],
      [{ role: "assistant", content: "basalt.se" }],
      [{ role: "user", content: "open ports" }],
      [null, undefined, { role: "user" }, { role: "user", content: "open ports" }],
      [{ role: "user", content: 42 }, { role: "user", content: "open ports" }],
      [{ role: "user", content: {} }, { role: "user", content: "open ports" }],
      [{ content: "basalt.se" }, { role: "user", content: "open ports" }],
    ]) assert.equal(walkBackHost(bad), null, JSON.stringify(bad));
  });
});

// ---------------------------------------------------------------------------
// extractOrgQuery
// ---------------------------------------------------------------------------

test("extractOrgQuery", async (t) => {
  await t.test("an explicitly quoted name", () => {
    assert.equal(extractOrgQuery('attack surface of "Basalt AB"'), "Basalt AB");
    assert.equal(extractOrgQuery("öppna portar hos 'Bahnhof'"), "Bahnhof");
    assert.equal(extractOrgQuery('"Alpha Beta Gamma Delta"'), "Alpha Beta Gamma Delta");
  });

  await t.test("company-form suffixes across jurisdictions", () => {
    for (const [input, expected] of [
      ["attack surface of Basalt AB", "Basalt AB"],
      ["OSINT on Acme Inc", "Acme Inc"],
      ["open ports at Foo Ltd", "Foo Ltd"],
      ["exposure of Bar LLC", "Bar LLC"],
      ["known CVEs at Siemens GmbH", "Siemens GmbH"],
      ["attack surface for Maersk A/S", "Maersk A/S"],
      ["OSINT on Nokia Oy", "Nokia Oy"],
      ["exposed services at Tesco PLC", "Tesco PLC"],
      ["port scan of Acme Corp", "Acme Corp"],
      ["attack surface of Volvo Group", "Volvo Group"],
      ["attackyta för Bonnier Gruppen", "Bonnier Gruppen"],
    ]) assert.equal(extractOrgQuery(input), expected, input);
  });

  await t.test("preposition cues, English", () => {
    for (const [input, expected] of [
      ["open ports at Basalt", "Basalt"],
      ["scan for Basalt", "Basalt"],
      ["check against Basalt", "Basalt"],
      ["hosts owned by Basalt", "Basalt"],
    ]) assert.equal(extractOrgQuery(input), expected, input);
  });

  await t.test("preposition cues, Swedish (invariant 6)", () => {
    for (const [input, expected] of [
      ["portar hos Bahnhof", "Bahnhof"],
      ["attackyta mot Basalt", "Basalt"],
      ["exponering för Basalt", "Basalt"],
      ["servrar tillhör Basalt", "Basalt"],
      ["system ägs av Basalt", "Basalt"],
    ]) assert.equal(extractOrgQuery(input), expected, input);
  });

  await t.test(
    "the verbatim production phrasing resolves to the company, not the host",
    () => {
      assert.equal(
        extractOrgQuery("Hitta öppna nätverksportar mot Basalt AB hos Bahnhof"),
        "Basalt AB",
      );
    },
  );

  await t.test("the weekday/month stoplist", () => {
    // Without it, "Ports open on Monday" resolves an org called "Monday" and
    // bills a Shodan search credit for it.
    for (const s of [
      "Ports open on Monday",
      "portar öppna på måndag",
      "attack surface at Monday",
      "OSINT for December",
      "attackyta mot Sverige",
      "OSINT for Sweden",
      "attack surface at Google",
      "portar hos Internet",
    ]) assert.equal(extractOrgQuery(s), "", s);
  });

  await t.test("a bare hostname is the host route's business, not an org search", () => {
    for (const s of ["at example.com", "hos basalt.se", '"basalt.se"', "for sub.domain.co.uk"]) {
      assert.equal(extractOrgQuery(s), "", s);
    }
  });

  await t.test("length bounds: >4 words, 1 char, 61+ chars", () => {
    assert.equal(extractOrgQuery('"One Two Three Four Five"'), "");
    assert.equal(extractOrgQuery("Alpha Beta Gamma Delta Group"), "");
    assert.equal(extractOrgQuery("at A"), "");
    assert.equal(extractOrgQuery('"A"'), "");
    assert.equal(extractOrgQuery(`"${"B".repeat(61)}"`), "");
    // The boundary on the other side: 60 chars is still accepted.
    assert.equal(extractOrgQuery(`"${"B".repeat(60)}"`), "B".repeat(60));
  });

  await t.test("junk input returns an empty string without throwing", () => {
    for (const bad of [null, undefined, "", 0, 42, {}, [], () => {}, NaN]) {
      assert.equal(extractOrgQuery(bad), "", String(bad));
    }
    assert.equal(extractOrgQuery("x".repeat(20000)), "");
  });
});

// ---------------------------------------------------------------------------
// pickShodanTarget + the matcher registry
// ---------------------------------------------------------------------------

test("SHODAN_MATCHER_NAMES is the precedence order", () => {
  // The order IS the contract: explicit filter syntax outranks a bare host
  // mention, and the intent-free host route outranks everything that reaches
  // beyond the latest message. These names also ride into chat_logs meta as
  // `shodan_intent`, so renaming one breaks the diagnostics vocabulary.
  assert.deepEqual(SHODAN_MATCHER_NAMES, [
    "filter-query",
    "latest-host",
    "walk-back",
    "org-search",
  ]);
});

test("pickShodanTarget — the three verbatim production messages", async (t) => {
  await t.test('chat_logs #1670 (2026-08-06): "Ports open on basalt.se"', () => {
    const got = pickShodanTarget(u("Ports open on basalt.se"));
    assert.ok(got, "must resolve a target");
    assert.equal(got.intent, "latest-host");
    assert.equal(got.kind, "hosts");
    assert.deepEqual(got.hostnames, ["basalt.se"]);
    assert.deepEqual(got.ips, []);
    assert.equal(got.followUp, false);
  });

  await t.test('chat_logs #1671 (2026-08-06): a bare "Shodan" follow-up', () => {
    // Before this module existed the message named no host, so nothing could
    // fire at all — there was no way to ASK for host intelligence.
    const got = pickShodanTarget([
      { role: "user", content: "Tell me about basalt.se" },
      { role: "assistant", content: "Basalt is a Swedish security company." },
      { role: "user", content: "Shodan" },
    ]);
    assert.ok(got, "must resolve a target");
    assert.equal(got.intent, "walk-back");
    assert.equal(got.kind, "hosts");
    assert.deepEqual(got.hostnames, ["basalt.se"]);
    assert.equal(got.followUp, true);
  });

  await t.test('chat_logs #1672 (2026-08-06): "Run through shodan to answer!"', () => {
    const got = pickShodanTarget([
      { role: "user", content: "Tell me about basalt.se" },
      { role: "assistant", content: "Basalt is a Swedish security company." },
      { role: "user", content: "Run through shodan to answer!" },
    ]);
    assert.ok(got, "must resolve a target");
    assert.equal(got.intent, "walk-back");
    assert.equal(got.kind, "hosts");
    assert.deepEqual(got.hostnames, ["basalt.se"]);
    assert.equal(got.followUp, true);
  });

  await t.test(
    "chat_logs #612 (2026-07-24) still routes exactly as it did before the gate",
    () => {
      // This one WORKED before shodan-text.js existed, via the original
      // host-in-the-latest-message route. It names an org AND a host AND
      // carries intent, so it is the sharpest available proof that adding the
      // org-search route did not steal traffic from the host route.
      const got = pickShodanTarget(
        u(
          "Hitta öppna nätverksportar mot Basalt AB, basalt.se hos Bahnhof. " +
            "OSINT attack surface management",
        ),
      );
      assert.ok(got, "must resolve a target");
      assert.equal(got.intent, "latest-host", "must NOT become an org-search");
      assert.equal(got.kind, "hosts");
      assert.deepEqual(got.hostnames, ["basalt.se"]);
      assert.equal(got.query, "");
    },
  );
});

test("pickShodanTarget — route precedence", async (t) => {
  await t.test("two filter tokens beat a bare host mention", () => {
    const got = pickShodanTarget(u("hostname:example.com port:443 and also basalt.se"));
    assert.equal(got.intent, "filter-query");
    assert.equal(got.kind, "search");
    assert.equal(got.query, "hostname:example.com port:443");
    assert.deepEqual(got.hostnames, []);
  });

  await t.test("ONE filter token needs the intent gate", () => {
    // A lone `port:8080` turns up in ordinary prose about a config file.
    assert.equal(pickShodanTarget(u("the config uses port:8080")), null);
    const got = pickShodanTarget(u("which ports are open — try port:8080"));
    assert.equal(got.intent, "filter-query");
    assert.equal(got.query, "port:8080");
  });

  await t.test("latest-host fires with NO intent at all (deliberately unchanged)", () => {
    // The original route is intent-FREE so nothing that fired before this
    // module stops firing. The cost is a host lookup on a message that never
    // asked for one — which is exactly what SHODAN_RELEVANCE_NOTE exists to
    // handle downstream, not something to "fix" with a gate here.
    const got = pickShodanTarget(u("hash the text deepresearch.se"));
    assert.ok(got, "an intent-free host mention must still resolve");
    assert.equal(got.intent, "latest-host");
    assert.deepEqual(got.hostnames, ["deepresearch.se"]);
    assert.equal(shodanIntent("hash the text deepresearch.se"), false);
  });

  await t.test("walk-back requires intent", () => {
    const earlier = { role: "user", content: "tell me about basalt.se" };
    assert.equal(
      pickShodanTarget([earlier, { role: "user", content: "and what about their pricing" }]),
      null,
    );
    const got = pickShodanTarget([earlier, { role: "user", content: "öppna portar?" }]);
    assert.equal(got.intent, "walk-back");
    assert.equal(got.followUp, true);
  });

  await t.test("org-search requires intent", () => {
    assert.equal(pickShodanTarget(u("tell me about Basalt AB")), null);
    const got = pickShodanTarget(u("attack surface of Basalt AB"));
    assert.equal(got.intent, "org-search");
    assert.equal(got.kind, "search");
    assert.equal(got.query, 'org:"Basalt AB"');
  });

  await t.test("org-search is last: a host anywhere outranks a company name", () => {
    const got = pickShodanTarget(u("attack surface of Basalt AB at basalt.se"));
    assert.equal(got.intent, "latest-host");
  });

  await t.test("Swedish routes the same as English", () => {
    const sv = pickShodanTarget(u("Vilka öppna portar har Basalt AB?"));
    assert.equal(sv.intent, "org-search");
    assert.equal(sv.query, 'org:"Basalt AB"');
    const en = pickShodanTarget(u("Which open ports does Basalt AB have?"));
    assert.equal(en.intent, "org-search");
    assert.equal(en.query, 'org:"Basalt AB"');
  });
});

test("pickShodanTarget — returns null for nothing to do", async (t) => {
  await t.test("an ordinary question", () => {
    for (const s of [
      "what is the capital of France",
      "vad är huvudstaden i Frankrike",
      "summarise the Hanseatic League for me",
    ]) assert.equal(pickShodanTarget(u(s)), null, s);
  });

  await t.test("intent, but no host and no org anywhere", () => {
    for (const s of [
      "what are the open ports",
      "vilka portar är öppna",
      "run a port scan",
      "Shodan",
      "attack surface",
      "Ports open on Monday",
      "portar öppna på måndag",
    ]) assert.equal(pickShodanTarget(u(s)), null, s);
  });

  await t.test("a URL-only message yields no filter token", () => {
    // The URL's :443 must not become a `port:` filter; the hostname route
    // still picks the host up, which is the intended reading.
    const got = pickShodanTarget(u("check https://example.com:443/x"));
    assert.equal(got.intent, "latest-host");
    assert.equal(got.query, "");
  });

  await t.test("junk conversations return null without throwing", () => {
    // NOTE: null/undefined/{}/42 as the WHOLE conversation are not covered
    // here — they currently throw inside lastUserMessage. Reported as a
    // fail-soft gap (invariant 2) rather than pinned as correct.
    for (const bad of [
      [],
      "open ports on basalt.se",
      [{ role: "assistant", content: "basalt.se" }],
      [null, undefined, { role: "user" }],
      [{ role: "user", content: 42 }],
      [{ role: "user", content: {} }],
      [{ content: "open ports on basalt.se" }],
      u("x".repeat(20000)),
      u(""),
    ]) assert.equal(pickShodanTarget(bad), null, JSON.stringify(bad));
  });
});

test("pickShodanTarget — every returned target has the full ShodanTarget shape", () => {
  const cases = [
    u("hostname:example.com port:443"), // filter-query
    u("Ports open on basalt.se"), // latest-host
    [
      { role: "user", content: "tell me about basalt.se" },
      { role: "user", content: "open ports?" },
    ], // walk-back
    u("attack surface of Basalt AB"), // org-search
    u("open ports on 8.8.8.8"), // latest-host, IP
  ];
  const seen = new Set();
  for (const conversation of cases) {
    const got = pickShodanTarget(conversation);
    assert.ok(got, JSON.stringify(conversation));
    assert.deepEqual(
      Object.keys(got).sort(),
      ["followUp", "hostnames", "intent", "ips", "kind", "query"],
      "all six fields present, and no extras",
    );
    assert.ok(["hosts", "search"].includes(got.kind), got.kind);
    assert.ok(Array.isArray(got.ips));
    assert.ok(Array.isArray(got.hostnames));
    assert.ok(got.ips.every((x) => typeof x === "string"));
    assert.ok(got.hostnames.every((x) => typeof x === "string"));
    assert.equal(typeof got.query, "string");
    assert.equal(typeof got.followUp, "boolean");
    assert.equal(typeof got.intent, "string");
    assert.ok(
      SHODAN_MATCHER_NAMES.includes(got.intent),
      `intent "${got.intent}" is not a registered matcher name`,
    );
    // A hosts target carries no query; a search target carries no hosts.
    if (got.kind === "hosts") {
      assert.equal(got.query, "");
      assert.ok(got.ips.length || got.hostnames.length);
    } else {
      assert.ok(got.query);
      assert.deepEqual(got.ips, []);
      assert.deepEqual(got.hostnames, []);
    }
    seen.add(got.intent);
  }
  // The five cases above exercise all four matchers.
  assert.deepEqual([...seen].sort(), [
    "filter-query",
    "latest-host",
    "org-search",
    "walk-back",
  ]);
});

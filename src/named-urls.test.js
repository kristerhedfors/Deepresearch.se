// Unit tests for direct web browsing of the URLs a message names
// (src/named-urls.js).
//
// The defect this module was written for (feedback #67, chat_logs #1729,
// 2026-08-13): a question carrying five explicit URLs, each with its own
// instruction ("check last release, supported CUDA versions"; "assess commit
// recency"), was answered with "the `avtomaton/barracuda` fork was not
// retrieved by any of the angles run" after fifteen search angles. The
// pipeline could only rediscover pages through the search index; it could not
// simply READ one it had been handed.
//
// So the properties pinned here are, in order of what would hurt most:
//
//   1. Extraction. A URL in prose, in a markdown list, in parentheses, at the
//      end of a sentence — all of them, deduped, capped, and NOT the local
//      network (an SSRF vector that is also never a citable source).
//   2. Fail-soft (invariant 2). Every upstream failure mode — a 404, a
//      timeout, a PDF, a giant body, a socket error — degrades to "one source
//      fewer" and never throws.
//   3. Privacy (invariant 4). What leaves the Worker is a GET to the URL the
//      user typed, and nothing else: no conversation, no identity, no cookies.
//
// Deliberately no `// @ts-check`: the junk-input subtests feed null,
// numbers and objects through parameters typed as strings.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  MAX_NAMED_URLS,
  extractNamedUrls,
  highlightsOf,
  readNamedUrls,
  titleOf,
} from "./named-urls.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

/** The verbatim URL block from chat_logs #1729. */
const PROD_67 = `I'm evaluating the feasibility of modernizing BarraCUDA.

	•	https://seqbarracuda.sourceforge.net/ — Canonical BarraCUDA project.
	•	https://github.com/avtomaton/barracuda — GitHub fork. Assess commit recency.
	•	https://sourceforge.net/p/seqbarracuda/wiki/seqbarracuda-meth/ — Methylation variant.
	•	https://arxiv.org/abs/1505.07855 and https://biodatamining.biomedcentral.com/articles/10.1186/s13040-017-0149-1 — prior art.
	•	https://link.springer.com/article/10.1186/1756-0500-5-27 — Original paper.`;

const html = (title, body) =>
  new Response(`<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** A body long enough to clear the 80-char floor. */
const LONG = "BarraCUDA is a CUDA port of the BWA-aln short-read aligner. ".repeat(6);

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

describe("extractNamedUrls", () => {
  test("the verbatim production message yields its URLs in order", () => {
    const got = extractNamedUrls(PROD_67);
    assert.deepEqual(got, [
      "https://seqbarracuda.sourceforge.net/",
      "https://github.com/avtomaton/barracuda",
      "https://sourceforge.net/p/seqbarracuda/wiki/seqbarracuda-meth/",
      "https://arxiv.org/abs/1505.07855",
      "https://biodatamining.biomedcentral.com/articles/10.1186/s13040-017-0149-1",
      "https://link.springer.com/article/10.1186/1756-0500-5-27",
    ]);
  });

  test("sentence punctuation is not part of the URL", () => {
    for (const [input, expected] of [
      ["see https://example.com/a.", "https://example.com/a"],
      ["see https://example.com/a, and more", "https://example.com/a"],
      ["see https://example.com/a; next", "https://example.com/a"],
      ["(https://example.com/a)", "https://example.com/a"],
      ["[https://example.com/a]", "https://example.com/a"],
      ["is it https://example.com/a?", "https://example.com/a"],
    ]) assert.deepEqual(extractNamedUrls(input), [expected], input);
  });

  test("balanced brackets INSIDE a URL survive", () => {
    // A Wikipedia disambiguation URL really does end in ")".
    assert.deepEqual(
      extractNamedUrls("https://en.wikipedia.org/wiki/Mercury_(planet)"),
      ["https://en.wikipedia.org/wiki/Mercury_(planet)"],
    );
  });

  test("deduped, with the fragment ignored", () => {
    assert.deepEqual(
      extractNamedUrls("https://example.com/a https://example.com/a#top https://example.com/a"),
      ["https://example.com/a"],
    );
  });

  test("capped so a pasted wall of links cannot fan out without bound", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`).join(" ");
    assert.equal(extractNamedUrls(many).length, MAX_NAMED_URLS);
  });

  test("the local network is never fetched (SSRF, and never a source)", () => {
    for (const s of [
      "http://localhost:8787/admin",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.9/",
      "http://169.254.169.254/latest/meta-data/",
      "http://printer.local/",
    ]) assert.deepEqual(extractNamedUrls(s), [], s);
  });

  test("only http(s) — not mailto, ftp, file, javascript, data", () => {
    for (const s of [
      "mailto:someone@example.com",
      "ftp://example.com/file",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>",
    ]) assert.deepEqual(extractNamedUrls(s), [], s);
  });

  test("a message with no links yields nothing", () => {
    assert.deepEqual(extractNamedUrls("What is the current status of BarraCUDA?"), []);
    assert.deepEqual(extractNamedUrls("go to example.com for details"), []);
  });

  test("junk input returns [] without throwing", () => {
    for (const bad of [null, undefined, "", 0, 42, {}, [], () => {}, NaN]) {
      assert.deepEqual(extractNamedUrls(bad), [], String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

describe("titleOf / highlightsOf", () => {
  test("prefers <title>, falls back to <h1>, then to the URL", () => {
    assert.equal(titleOf("<html><title>Real Title</title></html>", "https://x.test/a"), "Real Title");
    assert.equal(titleOf("<html><body><h1>Heading</h1></body></html>", "https://x.test/a"), "Heading");
    assert.equal(titleOf("<html><body>nothing</body></html>", "https://x.test/a/b"), "x.test/a/b");
    assert.equal(titleOf("", "https://x.test/"), "x.test");
  });

  test("entities in a title are decoded, not shown raw", () => {
    assert.equal(titleOf("<title>Tom &amp; Jerry &#8212; page</title>", "https://x.test/"), "Tom & Jerry — page");
  });

  test("highlights are bounded slices, and empty text yields none", () => {
    assert.deepEqual(highlightsOf(""), []);
    const h = highlightsOf("x".repeat(50_000));
    assert.ok(h.length <= 3, "at most three slices");
    assert.ok(h.every((s) => s.length <= 1200), "each slice bounded");
  });
});

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

describe("readNamedUrls", () => {
  test("reads the pages and returns them in the order the user wrote them", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/one\.test/, html("First Page", LONG)],
        [/two\.test/, html("Second Page", LONG)],
      ],
      () => readNamedUrls({}, log, ["https://one.test/a", "https://two.test/b"]),
    );
    assert.equal(out.items.length, 2);
    assert.deepEqual(out.items.map((i) => i.title), ["First Page", "Second Page"]);
    assert.equal(out.attempted, 2);
    assert.ok(out.items[0].highlights.length >= 1, "the page text comes back as highlights");
    assert.match(out.items[0].highlights[0], /BarraCUDA is a CUDA port/);
  });

  test("only a GET to the named URL leaves the Worker (invariant 4)", async () => {
    const log = fakeLog();
    const { stub } = await withFakeFetch([[/one\.test/, html("T", LONG)]], async (stub) => {
      await readNamedUrls({}, log, ["https://one.test/a"]);
      return { stub };
    });
    assert.equal(stub.requests.length, 1);
    const rec = stub.requests[0];
    assert.equal(rec.url, "https://one.test/a");
    assert.equal(rec.body, "", "no body — nothing about the conversation is sent");
    assert.equal(rec.headers.cookie, undefined, "no cookies");
    assert.equal(rec.headers.authorization, undefined, "no credentials");
    assert.equal(rec.headers.referer, undefined, "no referrer");
  });

  test("a page that 404s is skipped, the rest still come back", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/gone\.test/, new Response("nope", { status: 404 })],
        [/ok\.test/, html("Fine", LONG)],
      ],
      () => readNamedUrls({}, log, ["https://gone.test/a", "https://ok.test/b"]),
    );
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].title, "Fine");
    assert.equal(out.attempted, 2, "the attempt is still counted, so the step can say 1 of 2");
  });

  test("a non-document response is skipped rather than parsed as prose", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [[/pdf\.test/, new Response("%PDF-1.7 binary…", { status: 200, headers: { "content-type": "application/pdf" } })]],
      () => readNamedUrls({}, log, ["https://pdf.test/paper.pdf"]),
    );
    assert.deepEqual(out.items, []);
    assert.match(log.text(), /content_type/);
  });

  test("a socket error is one source fewer, never a throw (invariant 2)", async () => {
    const log = fakeLog();
    const out = await readNamedUrls({}, log, ["https://boom.test/a"]).catch((e) => {
      assert.fail(`must not reject: ${e}`);
    });
    // No fetch stub installed for this host in this test's scope; the real
    // fetch fails offline, which is exactly the branch under test.
    assert.deepEqual(out.items, []);
    assert.equal(out.attempted, 1);
  });

  test("an almost-empty page is not registered as a source", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [[/thin\.test/, html("Thin", "hi")]],
      () => readNamedUrls({}, log, ["https://thin.test/a"]),
    );
    assert.deepEqual(out.items, []);
    assert.match(log.text(), /too_short/);
  });

  test("plain text is read as-is; HTML is stripped to prose", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/txt\.test/, new Response(LONG, { status: 200, headers: { "content-type": "text/plain" } })],
        [/html\.test/, html("H", `<script>bad()</script><p>${LONG}</p>`)],
      ],
      () => readNamedUrls({}, log, ["https://txt.test/a", "https://html.test/b"]),
    );
    assert.equal(out.items.length, 2);
    assert.doesNotMatch(out.items[1].highlights.join(" "), /<script>|bad\(\)/, "scripts never reach the digest");
  });

  test("an empty list does no work at all", async () => {
    const log = fakeLog();
    const out = await readNamedUrls({}, fakeLog(), []);
    assert.deepEqual(out, { items: [], durationMs: 0, attempted: 0 });
    assert.deepEqual(log.lines, []);
  });

  test("the list is capped even if the caller passes more", async () => {
    const log = fakeLog();
    const urls = Array.from({ length: 20 }, (_, i) => `https://x${i}.test/`);
    const out = await withFakeFetch([[/x\d+\.test/, html("T", LONG)]], () =>
      readNamedUrls({}, log, urls),
    );
    assert.equal(out.attempted, MAX_NAMED_URLS);
  });
});

// ---------------------------------------------------------------------------
// The host guard, closed on both halves (2026-08-14).
//
// Probing the guard after PR #441 merged found the NAME rules — and only the
// name rules — bypassable by one character, and the redirect chain unchecked
// past the first hop. Both are the same mistake in different places: the
// address that was judged was not the address that got fetched.
// ---------------------------------------------------------------------------

describe("the host guard survives a fully-qualified name", () => {
  // `localhost.` resolves to `localhost` but is not string-equal to it, and
  // `box.local.` does not END in `.local`. So every name rule missed them
  // while the IP rules held — the trailing dot is now stripped where the
  // brackets already were, so a rule added later inherits the normalization.
  test("a trailing dot does not smuggle a private name past the guard", () => {
    for (const s of [
      "http://localhost./x",
      "http://localhost.:8787/admin",
      "http://LocalHost./x",
      "http://foo.internal./x",
      "http://box.local./x",
      "http://thing.home.arpa./x",
      "http://localhost../x",
    ]) assert.deepEqual(extractNamedUrls(s), [], s);
  });

  test("and a public host is still read, dot or no dot", () => {
    assert.deepEqual(extractNamedUrls("https://example.com./page"), ["https://example.com./page"]);
    assert.deepEqual(extractNamedUrls("https://example.com/page"), ["https://example.com/page"]);
  });
});

describe("redirects are judged hop by hop, not just at the address typed", () => {
  const html = (t) => new Response(`<title>${t}</title><p>${"word ".repeat(400)}</p>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const to = (loc) => new Response(null, { status: 302, headers: { location: loc } });

  test("a public URL that redirects INTO the local network is refused", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/^https:\/\/ok\.test\/$/, to("http://169.254.169.254/latest/meta-data/")],
        [/169\.254/, html("metadata")],
      ],
      () => readNamedUrls({}, log, ["https://ok.test/"]),
    );
    assert.deepEqual(out.items, [], "nothing is read from behind the redirect");
    assert.match(log.text(), /redirect_private/, "and the refusal is logged as such");
  });

  test("an ordinary redirect is still followed", async () => {
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/^http:\/\/ok\.test\/$/, to("https://ok.test/final")],
        [/^https:\/\/ok\.test\/final$/, html("Arrived")],
      ],
      () => readNamedUrls({}, log, ["http://ok.test/"]),
    );
    assert.equal(out.items.length, 1, "http->https is the common case and must keep working");
    assert.equal(out.items[0].title, "Arrived");
  });

  test("a relative Location is resolved against the hop it came from", async () => {
    // The check is only meaningful if `/next` inherits the previous host —
    // refusing it for having none would break half the web instead.
    const log = fakeLog();
    const out = await withFakeFetch(
      [
        [/^https:\/\/ok\.test\/a$/, to("/b")],
        [/^https:\/\/ok\.test\/b$/, html("Relative")],
      ],
      () => readNamedUrls({}, log, ["https://ok.test/a"]),
    );
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].title, "Relative");
  });

  test("a redirect loop ends rather than running forever", async () => {
    const log = fakeLog();
    const out = await withFakeFetch([[/^https:\/\/loop\.test\//, to("https://loop.test/again")]], () =>
      readNamedUrls({}, log, ["https://loop.test/"]),
    );
    assert.deepEqual(out.items, []);
    assert.match(log.text(), /redirect_limit/);
  });

  test("a redirect to a non-http scheme is refused", async () => {
    const log = fakeLog();
    const out = await withFakeFetch([[/^https:\/\/ok\.test\/$/, to("file:///etc/passwd")]], () =>
      readNamedUrls({}, log, ["https://ok.test/"]),
    );
    assert.deepEqual(out.items, []);
    assert.match(log.text(), /redirect_scheme/);
  });
});

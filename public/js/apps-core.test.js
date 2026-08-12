// Unit tests for the published-apps pure core (public/js/apps-core.js): the
// listing row, the search/sort the API and the page share, the file-edit plans,
// and the display formatters.
//
// The core exists because the /apps/ management surface and GET /api/apps must
// agree — a title cap or an ownership rule that means one thing server-side and
// another in the browser is a 403 on a button the page decided to show. So each
// test below says WHAT WOULD BREAK if the rule went, not merely what it returns.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_BUILD_FILES, MAX_BUILD_FILE_BYTES, MAX_BUILD_TOTAL_BYTES } from "./sdk-core.js";
import {
  APP_SORTS,
  APP_TITLE_MAX,
  appMatches,
  appSummary,
  appUrl,
  canManageApp,
  formatBytes,
  formatWhen,
  checkFileEdit,
  normalizeAppTitle,
  planFileEdit,
  planFileRemove,
  renderAppsText,
  selectApps,
} from "./apps-core.js";

// A fixed clock. Every relative-time assertion below passes `now` explicitly:
// reading Date.now() inside a test makes the suite fail at whatever minute the
// boundary happens to be crossed, which is the worst kind of flake to debug.
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- appSummary -----------------------------------------------------------

test("appSummary flattens the meta publishBuild wrote", () => {
  const row = appSummary("sokratisk-handledare", {
    title: "Sokratisk handledare",
    createdAt: NOW - 2 * DAY,
    owner: "u-42",
    files: [
      { p: "index.html", s: 1200 },
      { p: "app.js", s: 3400 },
      { p: "style.css", s: 400 },
    ],
  });
  assert.deepEqual(row, {
    slug: "sokratisk-handledare",
    title: "Sokratisk handledare",
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    owner: "u-42",
    files: 3,
    bytes: 5000,
    url: "/app/sokratisk-handledare/",
  });
});

test("appSummary falls back to the slug when there is no usable title", () => {
  // The slug is what the URL says, so it is never a lie. A row rendering as an
  // empty string is a row nobody can click, rename or delete.
  assert.equal(appSummary("my-app", {}).title, "my-app");
  assert.equal(appSummary("my-app", { title: "   " }).title, "my-app");
  assert.equal(appSummary("my-app", { title: 42 }).title, "my-app");
  assert.equal(appSummary("my-app", { title: null }).title, "my-app");
});

test("appSummary caps and collapses a stored title exactly as a rename would", () => {
  // Otherwise a title written by an older publish could exceed the cap the
  // rename form enforces, and every save would silently shorten it.
  const row = appSummary("s", { title: `  Two   lines\nof title  ` });
  assert.equal(row.title, "Two lines of title");
  assert.equal(appSummary("s", { title: "x".repeat(500) }).title.length, APP_TITLE_MAX);
});

test("appSummary: updatedAt falls back to createdAt for an app nobody has edited", () => {
  // Only the /apps surface writes updatedAt. Without the fallback, every app
  // published by the pipeline would sort as epoch 0 — i.e. last — under any
  // ordering that reads updatedAt, which is the opposite of the truth.
  const fresh = appSummary("s", { createdAt: NOW - HOUR });
  assert.equal(fresh.updatedAt, fresh.createdAt);
  const edited = appSummary("s", { createdAt: NOW - DAY, updatedAt: NOW - HOUR });
  assert.equal(edited.createdAt, NOW - DAY);
  assert.equal(edited.updatedAt, NOW - HOUR);
  // A zero/negative/garbage stamp is "unknown", not a date in 1970.
  for (const bad of [0, -1, "soon", null, undefined, NaN]) {
    const row = appSummary("s", { createdAt: bad, updatedAt: bad });
    assert.equal(row.createdAt, 0);
    assert.equal(row.updatedAt, 0);
  }
});

test("appSummary sums only the sizes that are sizes", () => {
  const row = appSummary("s", {
    files: [{ p: "index.html", s: 100 }, { p: "a.js" }, { p: "b.js", s: "big" }, { p: "c.js", s: -50 }, null],
  });
  assert.equal(row.bytes, 100);
  // The COUNT still includes them: five entries were published, and a file
  // whose size R2 never recorded is still a file the owner can delete.
  assert.equal(row.files, 5);
});

test("appSummary keeps a build with a broken meta LISTABLE", () => {
  // This tolerance is the whole reason the page can clean up after a failed
  // publish. If a malformed meta threw (or produced no row), the only surface
  // able to delete the orphaned R2 objects would be the one hiding them.
  for (const junk of [null, undefined, "", "not json", 0, [], { files: "nope" }, { files: null }]) {
    const row = appSummary("broken-build", junk);
    assert.equal(row.slug, "broken-build");
    assert.equal(row.title, "broken-build");
    assert.equal(row.owner, "");
    assert.equal(row.files, 0);
    assert.equal(row.bytes, 0);
    assert.equal(row.createdAt, 0);
    assert.equal(row.updatedAt, 0);
    assert.equal(row.url, "/app/broken-build/");
  }
});

test("appSummary only trusts a string owner", () => {
  // owner is compared against the session id; a number or object leaking into
  // that comparison is an ownership check made on a coincidence.
  assert.equal(appSummary("s", { owner: 7 }).owner, "");
  assert.equal(appSummary("s", { owner: { id: "u1" } }).owner, "");
  assert.equal(appSummary("s", { owner: "u1" }).owner, "u1");
});

test("appUrl is the one place the published path is spelled", () => {
  assert.equal(appUrl("demo"), "/app/demo/");
  assert.equal(appSummary("demo", {}).url, appUrl("demo"));
});

// ---- normalizeAppTitle ----------------------------------------------------

test("normalizeAppTitle collapses whitespace and trims", () => {
  assert.equal(normalizeAppTitle("  Sokratisk   handledare  "), "Sokratisk handledare");
  assert.equal(normalizeAppTitle("line\none\ttwo"), "line one two");
  assert.equal(normalizeAppTitle("plain"), "plain");
});

test("normalizeAppTitle caps at APP_TITLE_MAX, matching publishBuild", () => {
  // The cap is restated client-side so a rename is refused at the boundary
  // rather than accepted and silently truncated on the way to R2.
  assert.equal(APP_TITLE_MAX, 120);
  assert.equal(normalizeAppTitle("x".repeat(APP_TITLE_MAX)).length, APP_TITLE_MAX);
  assert.equal(normalizeAppTitle("x".repeat(APP_TITLE_MAX + 50)).length, APP_TITLE_MAX);
});

test("normalizeAppTitle returns '' for anything that is not usable text", () => {
  // "" is the caller's signal for LEAVE IT ALONE. If a non-string came back as
  // "undefined" or null, a PATCH with a missing field would rename the app to
  // garbage instead of only changing what was sent.
  for (const bad of [undefined, null, 42, {}, [], true, () => {}]) {
    assert.equal(normalizeAppTitle(bad), "");
  }
  assert.equal(normalizeAppTitle(""), "");
  assert.equal(normalizeAppTitle("   \n\t "), "");
});

// ---- canManageApp ---------------------------------------------------------

test("canManageApp: the owner may manage their own app", () => {
  assert.equal(canManageApp({ owner: "u1" }, { id: "u1" }), true);
  // Ids arrive as D1 numbers in one place and dataset strings in another —
  // comparing them as strings is what stops a real owner being told 403.
  assert.equal(canManageApp({ owner: "7" }, { id: 7 }), true);
});

test("canManageApp: an admin may manage anyone's app", () => {
  assert.equal(canManageApp({ owner: "u1" }, { id: "u2", role: "admin" }), true);
  // Admin wins even where there is no owner to match — the orphaned-build case
  // the /apps page exists to clean up.
  assert.equal(canManageApp({}, { role: "admin" }), true);
});

test("canManageApp: a stranger may not", () => {
  assert.equal(canManageApp({ owner: "u1" }, { id: "u2" }), false);
  assert.equal(canManageApp({ owner: "u1" }, { id: "u2", role: "user" }), false);
  assert.equal(canManageApp({ owner: "u1" }, { id: "u2", role: "Admin" }), false, "role match is exact");
});

test("canManageApp: an app with no owner is nobody's but an admin's", () => {
  // Without the Boolean(app.owner) guard, "" === "" would hand every ownerless
  // build to every signed-in account with no id — the worst possible default.
  assert.equal(canManageApp({}, { id: "u1" }), false);
  assert.equal(canManageApp({ owner: "" }, { id: "" }), false);
  assert.equal(canManageApp({ owner: "" }, {}), false);
  assert.equal(canManageApp({ owner: "u1" }, {}), false, "a session with no id owns nothing");
});

test("canManageApp: null inputs are refusals, not throws", () => {
  // Called from a render pass while the account probe is still in flight.
  assert.equal(canManageApp(null, { id: "u1", role: "admin" }), false);
  assert.equal(canManageApp({ owner: "u1" }, null), false);
  assert.equal(canManageApp(null, null), false);
  assert.equal(canManageApp(undefined, undefined), false);
});

// ---- appMatches -----------------------------------------------------------

const SOK = { slug: "sokratisk-handledare", title: "Sökratisk handledare" };

test("appMatches is case-insensitive", () => {
  assert.equal(appMatches(SOK, "HANDLEDARE"), true);
  assert.equal(appMatches({ title: "Café Chat" }, "CAFÉ"), true);
});

test("appMatches folds diacritics, so a Swedish title is as findable as an English one", () => {
  // Invariant 6. Typing ö on a phone keyboard, or pasting a title out of a
  // document that used a decomposed é, must not be the difference between
  // finding your app and concluding it was deleted.
  assert.equal(appMatches(SOK, "sokratisk"), true);
  assert.equal(appMatches(SOK, "Sökratisk"), true);
  assert.equal(appMatches({ title: "Café" }, "cafe"), true);
  assert.equal(appMatches({ title: "Cafe" }, "café"), true);
  assert.equal(appMatches({ title: "Ärlig rådgivare" }, "arlig radgivare"), true);
  // Composed and decomposed spellings of the same word both match.
  assert.equal(appMatches({ title: "över" }, "över"), true);
});

test("appMatches searches the slug as well as the title", () => {
  // The slug is what the URL and the chat transcript show, so it is often the
  // only string the owner remembers.
  assert.equal(appMatches(SOK, "handledare"), true);
  assert.equal(appMatches({ slug: "quiz-generator", title: "Frågesport" }, "quiz"), true);
  assert.equal(appMatches({ slug: "quiz-generator", title: "Frågesport" }, "fragesport"), true);
});

test("appMatches: an empty query matches everything", () => {
  // The unfiltered listing is the default view; a blank box that hid every row
  // would read as "you have no apps".
  for (const q of ["", "   ", "\n", undefined, null]) {
    assert.equal(appMatches(SOK, q), true, `blank query ${JSON.stringify(q)} matches`);
    assert.equal(appMatches({}, q), true);
    assert.equal(appMatches(null, q), true);
  }
});

test("appMatches says no when it means no", () => {
  assert.equal(appMatches(SOK, "tokemon"), false);
  assert.equal(appMatches({}, "anything"), false);
  assert.equal(appMatches(null, "anything"), false);
});

// ---- selectApps -----------------------------------------------------------

const APPS = [
  { slug: "bok", title: "Bok", createdAt: NOW - 3 * DAY, bytes: 5000 },
  { slug: "arlig", title: "Ärlig", createdAt: NOW - 1 * DAY, bytes: 100 },
  { slug: "zebra", title: "Zebra", createdAt: NOW - 2 * DAY, bytes: 90000 },
];
const slugs = (rows) => rows.map((a) => a.slug);

test("selectApps sorts newest first by default", () => {
  // The app you just built is the one you came to the page for.
  assert.deepEqual(slugs(selectApps(APPS)), ["arlig", "zebra", "bok"]);
  assert.deepEqual(slugs(selectApps(APPS, { sort: "new" })), ["arlig", "zebra", "bok"]);
});

test("selectApps sorts oldest first, largest first", () => {
  assert.deepEqual(slugs(selectApps(APPS, { sort: "old" })), ["bok", "zebra", "arlig"]);
  assert.deepEqual(slugs(selectApps(APPS, { sort: "size" })), ["zebra", "bok", "arlig"]);
});

test("selectApps: the name sort uses Swedish collation", () => {
  // Under `sv`, Ä is its own letter at the END of the alphabet. Under the
  // runner's default locale it collates as A and lands FIRST — so this test is
  // the only thing standing between a Swedish reader and a list that looks
  // unsorted to them.
  assert.deepEqual(slugs(selectApps(APPS, { sort: "name" })), ["bok", "zebra", "arlig"]);
  const defaultLocale = [...APPS].sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(slugs(defaultLocale), ["arlig", "bok", "zebra"], "the un-localed sort disagrees");
  assert.ok("Ärlig".localeCompare("Zebra", "sv") > 0);
});

test("selectApps: equal names and equal sizes fall back to newest-first", () => {
  // Without a tiebreak, two apps of the same name (or the same rounded size)
  // would swap places between renders on a stable-sort technicality.
  const same = [
    { slug: "a", title: "Same", createdAt: NOW - 5 * DAY, bytes: 10 },
    { slug: "b", title: "Same", createdAt: NOW - 1 * DAY, bytes: 10 },
  ];
  assert.deepEqual(slugs(selectApps(same, { sort: "name" })), ["b", "a"]);
  assert.deepEqual(slugs(selectApps(same, { sort: "size" })), ["b", "a"]);
});

test("selectApps: an unknown sort falls back to `new` rather than to nothing", () => {
  // ?sort= comes off a query string, so it is user input. A typo must give the
  // default listing, never an empty page or a random order.
  for (const bad of ["oldest", "NEW", "", " new", 42, null, undefined, ["new"]]) {
    assert.deepEqual(slugs(selectApps(APPS, { sort: bad })), ["arlig", "zebra", "bok"], `sort=${String(bad)}`);
  }
  assert.deepEqual(slugs(selectApps(APPS, {})), ["arlig", "zebra", "bok"]);
  assert.deepEqual(APP_SORTS, ["new", "old", "name", "size"]);
});

test("selectApps composes the filter with the sort", () => {
  // The API's ?q= and the page's search box run this same function, which is
  // why a search result cannot be ordered differently in the two places.
  const rows = selectApps(APPS, { q: "r", sort: "old" });
  assert.deepEqual(slugs(rows), ["zebra", "arlig"]);
  assert.deepEqual(slugs(selectApps(APPS, { q: "arlig" })), ["arlig"]);
  assert.deepEqual(slugs(selectApps(APPS, { q: "Ärlig", sort: "size" })), ["arlig"]);
  assert.deepEqual(selectApps(APPS, { q: "nothing-matches" }), []);
});

test("selectApps is inert on junk and leaves the caller's array alone", () => {
  assert.deepEqual(selectApps(null), []);
  assert.deepEqual(selectApps(undefined, { sort: "name" }), []);
  assert.deepEqual(selectApps("nope"), []);
  const original = slugs(APPS);
  selectApps(APPS, { sort: "name" });
  assert.deepEqual(slugs(APPS), original, "sorting the listing must not reorder the caller's data");
  // Rows missing the sort keys still list, at the bottom of a newest-first view.
  assert.deepEqual(slugs(selectApps([...APPS, { slug: "bare" }])).at(-1), "bare");
});

// ---- planFileEdit ---------------------------------------------------------

const APP_FILES = () => [
  { path: "index.html", content: "<h1>hello</h1>" },
  { path: "app.js", content: "console.log(1);" },
];

test("planFileEdit replaces an existing file in place", () => {
  // publishBuild is whole-collection: what you do not resend is PRUNED. So an
  // edit has to hand back every file, not the one that changed.
  const out = planFileEdit(APP_FILES(), "app.js", "console.log(2);");
  assert.deepEqual(out, {
    files: [
      { path: "index.html", content: "<h1>hello</h1>" },
      { path: "app.js", content: "console.log(2);" },
    ],
  });
});

test("planFileEdit appends a new file at the end", () => {
  const out = planFileEdit(APP_FILES(), "style.css", "body{}");
  assert.equal(out.files.length, 3);
  assert.deepEqual(out.files[2], { path: "style.css", content: "body{}" });
});

test("planFileEdit matches on the SANITIZED path, so './app.js' is not a second copy", () => {
  // Two entries at the same effective R2 key would publish one of them at
  // random and count double against the size cap.
  const out = planFileEdit(APP_FILES(), "./app.js", "x");
  assert.equal(out.files.length, 2);
  assert.deepEqual(out.files[1], { path: "app.js", content: "x" });
});

test("planFileEdit rejects a path that could escape the build", () => {
  // Same rule as write_file: the path becomes an R2 key segment and a URL path.
  for (const bad of ["../evil.html", "/etc/passwd.html", ".hidden.js", "a/../../b.js", "", "   ", "no-extension", "run.exe", "a b.js", 42, null, undefined]) {
    const out = planFileEdit(APP_FILES(), bad, "x");
    assert.equal(out.files, undefined, `rejected ${JSON.stringify(bad)}`);
    assert.match(String(out.error), /path/i);
  }
});

test("planFileEdit rejects non-string content", () => {
  // An editor that saved `undefined` would publish the four characters "null"
  // as the app's script and the app would 200 while doing nothing.
  for (const bad of [undefined, null, 42, {}, ["x"], true]) {
    const out = planFileEdit(APP_FILES(), "app.js", bad);
    assert.equal(out.files, undefined);
    assert.match(String(out.error), /text/i);
  }
  assert.ok(planFileEdit(APP_FILES(), "app.js", "").files, "an empty file is legal");
});

test("planFileEdit rejects a file over the per-file cap", () => {
  const ok = planFileEdit(APP_FILES(), "big.js", "x".repeat(MAX_BUILD_FILE_BYTES));
  assert.ok(ok.files, "exactly at the cap is allowed");
  const over = planFileEdit(APP_FILES(), "big.js", "x".repeat(MAX_BUILD_FILE_BYTES + 1));
  assert.equal(over.files, undefined);
  assert.match(String(over.error), /per-file size cap/);
});

test("planFileEdit measures BYTES, not characters", () => {
  // A UTF-8 emoji is four bytes. Counting `.length` would let an edit through
  // that R2 then refuses, turning a size error into a failed publish.
  const chars = Math.floor(MAX_BUILD_FILE_BYTES / 4);
  const over = planFileEdit(APP_FILES(), "big.js", "😀".repeat(chars + 1));
  assert.equal(over.files, undefined);
  assert.match(String(over.error), /per-file size cap/);
});

test("planFileEdit rejects an edit that would exceed the file-count cap", () => {
  const many = [{ path: "index.html", content: "<h1>x</h1>" }];
  for (let i = 1; i < MAX_BUILD_FILES; i++) many.push({ path: `f${i}.js`, content: "x" });
  assert.equal(many.length, MAX_BUILD_FILES);
  // Replacing one of the existing files at the cap is still fine.
  assert.ok(planFileEdit(many, "f1.js", "y").files);
  const over = planFileEdit(many, "one-too-many.js", "y");
  assert.equal(over.files, undefined);
  assert.match(String(over.error), /file-count cap/);
});

test("planFileEdit rejects an edit that would exceed the TOTAL cap", () => {
  const chunk = "x".repeat(MAX_BUILD_FILE_BYTES);
  const full = [{ path: "index.html", content: chunk }];
  for (let i = 1; i < MAX_BUILD_TOTAL_BYTES / MAX_BUILD_FILE_BYTES; i++) full.push({ path: `f${i}.js`, content: chunk });
  // Exactly at the total is allowed — an app sitting on the cap must still be
  // editable, or it can never be shrunk back down.
  assert.ok(planFileEdit(full, "f1.js", chunk).files);
  const over = planFileEdit(full, "extra.js", "x");
  assert.equal(over.files, undefined);
  assert.match(String(over.error), /total size cap/);
  // …and shrinking a file at the cap works.
  assert.ok(planFileEdit(full, "f1.js", "x").files);
});

test("planFileEdit refuses a plan that would leave no index.html", () => {
  // /app/<slug>/ serves index.html. An app without one is published and 404s
  // at its own URL, which is indistinguishable from a broken deploy.
  const noEntry = [{ path: "app.js", content: "x" }];
  const out = planFileEdit(noEntry, "app.js", "y");
  assert.equal(out.files, undefined);
  assert.match(String(out.error), /index\.html/);
  // Adding the entry point to such an app is exactly how you fix it.
  assert.ok(planFileEdit(noEntry, "index.html", "<h1>x</h1>").files);
});

test("planFileEdit tolerates a missing/garbage current list", () => {
  assert.ok(planFileEdit(null, "index.html", "<h1>x</h1>").files);
  assert.equal(planFileEdit(undefined, "app.js", "x").files, undefined, "…but still needs an entry point");
});

// ---- planFileRemove -------------------------------------------------------

test("planFileRemove drops the named file and keeps the rest", () => {
  const out = planFileRemove([...APP_FILES(), { path: "style.css", content: "body{}" }], "app.js");
  assert.deepEqual(out, {
    files: [
      { path: "index.html", content: "<h1>hello</h1>" },
      { path: "style.css", content: "body{}" },
    ],
  });
  // Sanitized before matching, same as the edit path.
  assert.equal(planFileRemove([...APP_FILES(), { path: "style.css", content: "b" }], "./app.js").files.length, 2);
});

test("planFileRemove refuses to remove index.html", () => {
  // The refusal is checked BEFORE the file list, so it holds even for an app
  // whose entry point is somehow already missing.
  const out = planFileRemove(APP_FILES(), "index.html");
  assert.equal(out.files, undefined);
  assert.match(String(out.error), /entry point/);
  assert.match(String(planFileRemove([{ path: "app.js", content: "x" }], "index.html").error), /entry point/);
});

test("planFileRemove refuses an unknown path", () => {
  // Reporting success for a delete that removed nothing would leave the page
  // showing a file that is still there after the reload.
  const out = planFileRemove(APP_FILES(), "nope.js");
  assert.equal(out.files, undefined);
  assert.match(String(out.error), /No such file/i);
});

test("planFileRemove refuses an invalid path outright", () => {
  for (const bad of ["../x.js", "/x.js", "x.exe", "", null, 42]) {
    const out = planFileRemove(APP_FILES(), bad);
    assert.equal(out.files, undefined);
    assert.match(String(out.error), /path/i);
  }
});

test("planFileRemove refuses to empty the app", () => {
  // A build with zero files is not an app, and the publish that produced it
  // would leave an unreachable meta row behind.
  const out = planFileRemove([{ path: "solo.js", content: "x" }], "solo.js");
  assert.equal(out.files, undefined);
  assert.match(String(out.error), /at least one file/);
});

test("planFileRemove tolerates a missing current list", () => {
  const out = planFileRemove(null, "app.js");
  assert.equal(out.files, undefined);
  assert.match(String(out.error), /No such file/i);
});

// ---- formatBytes ----------------------------------------------------------

test("formatBytes scales at the unit boundaries", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 kB");
  assert.equal(formatBytes(1536), "1.5 kB");
  // One decimal below 10 kB, none above — a listing of "9.8 kB / 412 kB" reads;
  // "9.8 kB / 412.3 kB" is a column of noise.
  assert.equal(formatBytes(10 * 1024 - 1), "10.0 kB");
  assert.equal(formatBytes(10 * 1024), "10 kB");
  assert.equal(formatBytes(1024 * 1024 - 1), "1024 kB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(MAX_BUILD_TOTAL_BYTES), "1.9 MB");
});

test("formatBytes blanks what it cannot measure rather than printing NaN", () => {
  for (const bad of [undefined, NaN, -1, "big", {}, [1, 2], Infinity]) {
    assert.equal(formatBytes(bad), "—", `em dash for ${String(bad)}`);
  }
  // null and "" are ABSENCE, not zero, even though Number() turns both into 0.
  // Printing "0 B" for a byte count nobody supplied states that the app is
  // empty, which is a different claim from "not measured" — and the second one
  // is the true one.
  assert.equal(formatBytes(null), "—");
  assert.equal(formatBytes(""), "—");
  // A real zero still says zero: an app of zero bytes is a broken state worth
  // showing out loud.
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes("2048"), "2.0 kB");
});

// ---- formatWhen -----------------------------------------------------------

test("formatWhen climbs the units with `now` supplied by the caller", () => {
  assert.equal(formatWhen(NOW, NOW), "just now");
  assert.equal(formatWhen(NOW - 89 * SEC, NOW), "just now");
  assert.equal(formatWhen(NOW - 90 * SEC, NOW), "2 min ago");
  assert.equal(formatWhen(NOW - 45 * MIN, NOW), "45 min ago");
  assert.equal(formatWhen(NOW - 89 * MIN, NOW), "89 min ago");
  assert.equal(formatWhen(NOW - 90 * MIN, NOW), "2 h ago");
  assert.equal(formatWhen(NOW - 35 * HOUR, NOW), "35 h ago");
  assert.equal(formatWhen(NOW - 36 * HOUR, NOW), "2 days ago");
  assert.equal(formatWhen(NOW - 44 * DAY, NOW), "44 days ago");
  assert.equal(formatWhen(NOW - 45 * DAY, NOW), "2 months ago");
  assert.equal(formatWhen(NOW - 510 * DAY, NOW), "17 months ago");
  assert.equal(formatWhen(NOW - 540 * DAY, NOW), "2 years ago");
  assert.equal(formatWhen(NOW - 1100 * DAY, NOW), "3 years ago");
});

test("formatWhen never renders a negative age", () => {
  // Clocks disagree: a browser a minute behind the Worker would otherwise show
  // "-1 min ago" on the app that was just published.
  assert.equal(formatWhen(NOW + 5 * MIN, NOW), "just now");
  assert.equal(formatWhen(NOW + 10 * DAY, NOW), "just now");
});

test("formatWhen says 'unknown' for a stamp that is not one", () => {
  // The malformed-meta row (createdAt 0) reaches here. "unknown" is honest;
  // "20976 days ago" — the epoch — is a fact about 1970, not about the app.
  for (const bad of [0, -1, NaN, undefined, null, "", "yesterday", {}]) {
    assert.equal(formatWhen(bad, NOW), "unknown", `unknown for ${String(bad)}`);
  }
  assert.equal(formatWhen(appSummary("s", {}).createdAt, NOW), "unknown");
});

test("formatWhen defaults `now` to the real clock", () => {
  // The default exists so callers that do not care need not pass one; the
  // tests above never rely on it.
  assert.equal(formatWhen(Date.now()), "just now");
});

// ---- renderAppsText -------------------------------------------------------

test("renderAppsText says so when there is nothing, in one line", () => {
  // The ?format=text reader is an agent. "No published apps." is unambiguous;
  // an empty body is indistinguishable from a failed request.
  assert.equal(renderAppsText([], NOW), "No published apps.\n");
  assert.equal(renderAppsText(null, NOW), "No published apps.\n");
  assert.equal(renderAppsText("nope", NOW), "No published apps.\n");
});

test("renderAppsText prints slug, URL, file count, size and age per app", () => {
  const rows = [
    appSummary("sokratisk-handledare", {
      title: "Sokratisk handledare",
      createdAt: NOW - 2 * DAY,
      owner: "u1",
      files: [{ p: "index.html", s: 1200 }, { p: "app.js", s: 3400 }],
    }),
    appSummary("solo", { title: "Solo", createdAt: NOW - 90 * MIN, files: [{ p: "index.html", s: 500 }] }),
  ];
  const text = renderAppsText(rows, NOW);
  assert.equal(
    text,
    [
      "2 published apps",
      "",
      "sokratisk-handledare  Sokratisk handledare",
      "    /app/sokratisk-handledare/  ·  2 files  ·  4.5 kB  ·  2 days ago",
      "solo  Solo",
      "    /app/solo/  ·  1 file  ·  500 B  ·  2 h ago",
      "",
    ].join("\n"),
  );
  // The load-bearing pieces, spelled out so a reformat cannot quietly drop one.
  assert.match(text, /sokratisk-handledare/);
  assert.match(text, /\/app\/sokratisk-handledare\//);
  assert.match(text, /2 files/);
  assert.match(text, /1 file\b/, "singular for one file");
});

test("renderAppsText counts one app in the singular", () => {
  const one = renderAppsText([appSummary("solo", { createdAt: NOW, files: [{ p: "index.html", s: 1 }] })], NOW);
  assert.match(one, /^1 published app\n/);
});

test("renderAppsText renders a broken build rather than hiding it", () => {
  // Same reason as appSummary's tolerance: the agent reading this listing is
  // often the one being asked to clean the broken build up.
  const text = renderAppsText([appSummary("broken", null)], NOW);
  assert.match(text, /broken {2}broken/);
  assert.match(text, /0 files/);
  assert.match(text, /unknown/);
  assert.ok(text.endsWith("\n"));
});

// ---- checkFileEdit ---------------------------------------------------------
// The browser's half of the edit rules. It must answer EXACTLY what
// planFileEdit answers, from sizes rather than contents — that equivalence is
// the reason the page can refuse an over-cap save without downloading the app.

test("checkFileEdit gives the same verdict as planFileEdit, from sizes alone", () => {
  const files = [
    { path: "index.html", content: "x".repeat(1000) },
    { path: "app.js", content: "y".repeat(2000) },
  ];
  const sizes = files.map((f) => ({ path: f.path, size: f.content.length }));
  for (const [path, content] of [
    ["app.js", "z".repeat(50)],
    ["new.css", "body{}"],
    ["../escape.js", "nope"],
    ["app.js", "z".repeat(MAX_BUILD_FILE_BYTES + 1)],
    ["app.js", 42],
  ]) {
    const planned = planFileEdit(files, path, content);
    const checked = checkFileEdit(sizes, path, content);
    assert.equal(
      "error" in planned,
      "error" in checked,
      `verdicts disagree for ${String(path)} — the page would offer what the API refuses`,
    );
    if ("error" in planned && "error" in checked) assert.equal(planned.error, checked.error);
  }
});

test("checkFileEdit weighs the collection, not just the file being saved", () => {
  // The whole point of passing the listing: a file that fits on its own can
  // still take the app over the total cap.
  const half = Math.floor(MAX_BUILD_TOTAL_BYTES / 2);
  const sizes = [
    { path: "index.html", size: half },
    { path: "big.js", size: half },
  ];
  const over = checkFileEdit(sizes, "extra.js", "x".repeat(1000));
  assert.ok("error" in over && /total size cap/.test(over.error));
  // Shrinking an existing file makes room again — the row is REPLACED, not added.
  assert.ok(!("error" in checkFileEdit(sizes, "big.js", "x")));
});

test("checkFileEdit counts a new path against the file cap but a replacement not", () => {
  const sizes = Array.from({ length: MAX_BUILD_FILES }, (_, i) => ({
    path: i === 0 ? "index.html" : `f${i}.js`,
    size: 10,
  }));
  assert.ok(!("error" in checkFileEdit(sizes, "f1.js", "replaced")), "replacing keeps the count");
  const added = checkFileEdit(sizes, "one-too-many.js", "x");
  assert.ok("error" in added && /file-count cap/.test(added.error));
});

test("checkFileEdit refuses a set with no index.html", () => {
  const sizes = [{ path: "app.js", size: 10 }];
  const out = checkFileEdit(sizes, "app.js", "still no entry point");
  assert.ok("error" in out && /index\.html/.test(out.error));
});

test("checkFileEdit reports the sanitized path and the byte size it measured", () => {
  // The caller writes both back into its own state, so a path that was
  // normalised on the way through must come back normalised.
  const out = checkFileEdit([{ path: "index.html", size: 5 }], "index.html", "sm\u00f6rg\u00e5s");
  assert.deepEqual(out, { path: "index.html", size: 9 }, "7 characters, but å and ö are two bytes each in UTF-8");
});

test("planFileRemove reads only the path, so a size listing works too", () => {
  // The page holds [{path, size}], the server holds [{path, content}]; both
  // call this and both get their own row shape back.
  const listing = [
    { path: "index.html", size: 10 },
    { path: "extra.css", size: 4 },
  ];
  const out = planFileRemove(listing, "extra.css");
  assert.deepEqual(out, { files: [{ path: "index.html", size: 10 }] });
});

test("renderAppsText names an edit only when there has been one", () => {
  // updatedAt exists so an edited app is findable; printing it on every row
  // (where it equals the build date) would be noise on the untouched majority.
  const fresh = renderAppsText([appSummary("a", { createdAt: NOW - 2 * DAY, files: [] })], NOW);
  assert.doesNotMatch(fresh, /edited/, "an app nobody touched carries no edit stamp");
  const edited = renderAppsText(
    [appSummary("b", { createdAt: NOW - 200 * DAY, updatedAt: NOW - 2 * DAY, files: [] })],
    NOW,
  );
  assert.match(edited, /7 months ago {2}· {2}edited 2 days ago/);
});

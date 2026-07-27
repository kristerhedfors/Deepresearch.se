// The INTRO PHASE contract — the sequence a first-time visitor walks before
// they are inside a tier with a composer in front of them.
//
// The landing page is an APPROVED BASELINE (owner directive, 2026-07-26): we
// do not go back to an earlier front door, and the whole intro phase is
// tightly controlled from here on. `docs/INTRO-BASELINE.md` is the
// specification — §2 what the intro consists of, §4 the rules it obeys, §5 the
// mechanism holding each rule in place. This file is that §5 column.
//
// Division of labour with the neighbouring suites:
//   - `landing.test.js`     — the landing page's OWN structure (root routing,
//                             the overlay's order and length, the shared
//                             diagrams, the timeline card).
//   - `static-pages.test.js`— the repo-wide inline-script id guard.
//   - THIS FILE             — the CROSS-SURFACE rules: the baseline mark, the
//                             doors, the first-visit state, the fail-soft
//                             discipline, the no-LLM promise, honest framing,
//                             and the document's own accuracy.
//
// Nothing here executes a page; these are structural pins that fail when the
// intro moves, so moving it stays a deliberate act.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPublicAsset } from "./assets.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const DOC_PATH = "docs/INTRO-BASELINE.md";
const DOC = read(DOC_PATH);
const LANDING = read("public/welcome/index.html");
const CURE = read("public/cure/index.html");
const DRC = read("public/cure/drc.js");
const APP = read("public/js/app.js");
const ROUTER = read("src/index.js");

// Every file that carries a piece of the intro must point at the document, so
// a session editing one of them finds the contract before changing it.
const INTRO_SURFACES = {
  "public/welcome/index.html": LANDING,
  "public/cure/index.html": CURE,
  "public/js/app.js": APP,
  "src/index.js": ROUTER,
};

describe("the baseline mark", () => {
  test("the landing carries the APPROVED marker and points at the contract", () => {
    // The mark itself. Removing it is how "we are not going back" quietly
    // becomes "someone rewrote the front door".
    assert.match(LANDING, /INTRO BASELINE — APPROVED \(owner directive, 2026-07-26\)/);
    assert.match(LANDING, /not going back to\s+an earlier landing/i);
    assert.ok(LANDING.includes(DOC_PATH), "the landing must name the contract document");
  });

  test("the document records the directive and the baseline commit", () => {
    assert.match(DOC, /owner directive, 2026-07-26/i);
    assert.match(DOC, /\*\*`600c7300`\*\*/, "the baseline commit must stay pinned in §0");
    for (const heading of [
      "## 0. The mark",
      "## 2. What the intro consists of",
      "## 4. The rules the intro obeys",
      "## 5. How each rule is ensured",
      "## 6. Changing the intro",
    ]) {
      assert.ok(DOC.includes(heading), `the contract lost its "${heading}" section`);
    }
  });

  test("every intro surface points back at the document", () => {
    for (const [name, src] of Object.entries(INTRO_SURFACES)) {
      assert.ok(src.includes(DOC_PATH), `${name} must reference ${DOC_PATH}`);
    }
  });

  test("the paths the document names all exist", () => {
    // Cheap drift guard: a contract that describes files nobody has is worse
    // than no contract. Only repo-relative paths are checked — URL paths
    // (/js/…, /architecture/…) are the browser's view, not the tree's.
    const paths = new Set(
      [...DOC.matchAll(/`((?:public|src|docs|scripts)\/[A-Za-z0-9._/-]+)`/g)].map((m) => m[1]),
    );
    assert.ok(paths.size >= 15, `only ${paths.size} repo paths found — the file map went missing`);
    for (const p of paths) {
      assert.ok(existsSync(join(ROOT, p)), `${DOC_PATH} names ${p}, which does not exist`);
    }
  });
});

describe("R2 — the front door is served in place", () => {
  test("the root branch sits BEFORE any auth challenge and serves /welcome/", () => {
    const branch = ROUTER.indexOf('url.pathname === "/" && (request.method === "GET"');
    const challenge = ROUTER.indexOf("loginPage(\"\")");
    assert.ok(branch > -1, "the unauthenticated root branch is gone");
    assert.ok(challenge > branch, "the root must be answered before the sign-in fallback");
  });
});

describe("R9 — every door the intro offers is reachable without an account", () => {
  // Each internal href on the landing, with the mechanism that serves it. A
  // NEW door has to be added here, which is the point: it forces the question
  // "is this reachable signed out?" at the moment the link is added, not after
  // a visitor hits a 401 two clicks into the introduction.
  const PRE_AUTH_ROUTES = {
    // path → the literal the router must still contain for it
    "/cure": 'url.pathname === "/cure"',
    "/cure/help/": 'url.pathname === "/cure/help/"',
    "/login": 'url.pathname === "/login"',
  };

  const doors = [...new Set([...LANDING.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]))]
    .map((h) => h.split("?")[0]);

  test("the landing still offers the doors the contract lists", () => {
    for (const expected of ["/cure", "/story/", "/architecture/", "/pulse/", "/build/", "/cure/help/", "/help/", "/login"]) {
      assert.ok(doors.includes(expected), `the landing dropped its ${expected} door`);
    }
  });

  for (const door of [...new Set([...LANDING.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1].split("?")[0]))]) {
    test(`${door} is public`, () => {
      if (isPublicAsset(new URL("https://deepresearch.se" + door), "GET")) return;
      const literal = PRE_AUTH_ROUTES[door];
      assert.ok(
        literal,
        `${door} is neither a public asset nor a known pre-auth route — an auth wall inside the intro`,
      );
      assert.ok(ROUTER.includes(literal), `the pre-auth route for ${door} is gone from src/index.js`);
    });
  }
});

describe("R7 — no language model anywhere in the intro", () => {
  test("the signed-out helper is the prepackaged responder, badged as such", () => {
    assert.match(LANDING, /import \{ matchCanned \} from "\/js\/canned-faq\.js"/);
    assert.match(LANDING, /matchCanned\(q, \{ tier: "drs" \}\)/);
    assert.match(LANDING, /askbadge/, "every canned reply must carry the not-the-model badge");
    assert.match(LANDING, /prepackaged answers/i, "…and the block must say so in words");
  });

  test("the landing never calls the chat pipeline", () => {
    assert.doesNotMatch(LANDING, /\/api\/chat/, "the front door is signed out — there is no model to call");
  });

  test("the ask demo keeps the five ids its inline module looks up", () => {
    for (const id of ["askdemo", "askchips", "askmsgs", "askform", "askinput"]) {
      assert.ok(LANDING.includes(`id="${id}"`), `#${id} is load-bearing — the module throws without it`);
    }
  });
});

describe("R6 — decoration never blocks", () => {
  const ANIMATED = {
    "public/welcome/index.html": LANDING,
    "public/cure/drc.js": DRC,
    "public/js/app.js": APP,
  };

  for (const [name, src] of Object.entries(ANIMATED)) {
    test(`${name} honours prefers-reduced-motion`, () => {
      assert.match(src, /prefers-reduced-motion: reduce/);
    });

    test(`${name} keeps the ?anim=1 replay override`, () => {
      assert.match(src, /\[\?&\]anim=/, "?anim=1 is the supported way to re-watch and verify an intro");
    });
  }

  test("the landing's mascot has a watchdog behind transitionend", () => {
    assert.match(LANDING, /setTimeout\(arrive, \d+\)/, "transitionend can be swallowed — the arrival must not depend on it");
  });

  test("Se/cure paints its chrome regardless of the intro", () => {
    // An earlier head guard held the UI hidden until the animation signalled
    // done, so a stalled intro left a blank khaki screen. The head carries no
    // inline script at all now, and says why.
    const head = CURE.slice(0, CURE.indexOf("<body"));
    assert.equal(
      [...head.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].length,
      0,
      "an inline head script is how the chrome-hiding guard came back",
    );
    assert.match(head, /deliberately no "hide the chrome until the intro plays"\s+head script/);
  });

  test("Se/cure's glass pane does not auto-open on a first visit", () => {
    // 2026-07-12 onboarding directive: new users land in the composer.
    assert.match(DRC, /\$\("intro"\)\.hidden = true;[\s\S]{0,400}?dr_intro_seen/);
    assert.match(DRC, /\$\("input"\)\.focus\(\)/);
  });
});

describe("the first-visit state (§3)", () => {
  const KEY_OWNER = {
    dr_welcome_seen: ["public/welcome/index.html", LANDING],
    dr_umbrella_seen_v2: ["public/cure/drc.js", DRC],
    dr_secure_intro_seen: ["public/cure/drc.js", DRC],
    dr_intro_seen: ["public/cure/drc.js", DRC],
    dr_rver_intro_seen: ["public/js/app.js", APP],
  };

  for (const [key, [name, src]] of Object.entries(KEY_OWNER)) {
    test(`${key} still gates its surface in ${name}`, () => {
      assert.ok(src.includes(key), `${name} no longer knows about ${key}`);
      assert.ok(DOC.includes(key), `${DOC_PATH} §3 must list ${key}`);
    });
  }

  test("every intro storage access is wrapped — blocked storage means 'unseen', never a throw", () => {
    const NAMES = [...Object.keys(KEY_OWNER), "UMBRELLA_SEEN_KEY", "SEEN_KEY"];
    for (const [name, src] of Object.entries({
      "public/welcome/index.html": LANDING,
      "public/cure/drc.js": DRC,
      "public/js/app.js": APP,
    })) {
      for (const m of src.matchAll(/localStorage\.(?:get|set)Item\(([^)]*)\)/g)) {
        if (!NAMES.some((k) => m[1].includes(k))) continue;
        const before = src.slice(Math.max(0, m.index - 800), m.index);
        assert.match(
          before,
          /try\s*\{/,
          `${name}: localStorage.…(${m[1]}) is not inside a try — blocked storage would break the intro`,
        );
      }
    }
  });

  test("an intro is marked seen only after it actually PLAYED", () => {
    // A browser gets ONE first visit. A module that fails to load must not
    // burn it — the flag is set from the completion path, not the gate.
    assert.match(
      DRC,
      /const markUmbrellaSeen = \(\) => \{[\s\S]{0,300}?setItem\(UMBRELLA_SEEN_KEY/,
      "Se/cure must set the umbrella flag from its completion handler",
    );
    const onDone = APP.indexOf("onDone:");
    const setSeen = APP.indexOf("localStorage.setItem(SEEN_KEY");
    assert.ok(onDone > -1 && setSeen > onDone, "Se/rver must set its flag inside onDone, not at the gate");
  });
});

describe("R11 — the intro says the uncomfortable parts out loud", () => {
  test("the landing states experimental, invite-only, and not a product", () => {
    assert.match(LANDING, /still experimental and nowhere\s+near production-ready/);
    assert.match(LANDING, /invite-only research project/);
    assert.match(LANDING, /awaits? the\s+operator's approval/);
    assert.match(LANDING, /Not a commercial product; never placed on the market/);
  });

  test("the first-visit overlay carries the 'doesn't' half", () => {
    const card = LANDING.slice(LANDING.indexOf('<div id="wintro"'), LANDING.indexOf('<div id="mascot"'));
    assert.match(card, /no ads, no trackers, not a commercial\s+product/);
    assert.match(card, /approval-gated/);
  });

  test("Se/cure's greeter repeats it on arrival", () => {
    assert.match(CURE, /A research project, not a product/);
    assert.match(CURE, /don't rely on it for any real-world use/i);
  });
});

describe("R5 — branding inside the intro", () => {
  const USER_FACING = { "public/welcome/index.html": LANDING, "public/cure/index.html": CURE };

  for (const [name, src] of Object.entries(USER_FACING)) {
    test(`${name} writes the tiers as the full wordmark`, () => {
      // The slash gets its own span so its spacing can be measured, never
      // eyeballed (the slash-spacing skill).
      assert.match(src, /Se<span class="sl">\/<\/span>(cure|rver)/);
    });

    test(`${name} keeps the internal acronyms out of user-facing copy`, () => {
      const visible = src
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script[\s\S]*?<\/script>/g, "")
        .replace(/<style[\s\S]*?<\/style>/g, "");
      assert.doesNotMatch(visible, /\b(DRC|DRS)\b/, "DRC/DRS are internal names — never shown to a visitor");
    });
  }
});

// @ts-check
// The SDK-mode SHOWCASE GALLERY — a curated library of single-shot chatbot
// builds, surfaced in the left library pane (the history drawer) when the
// chat mode is SDK (the green "lovable distiller"). Each entry is a ready-to-
// send build brief: pick one and it drops into the composer in SDK mode, so a
// single send distills this site's Se/cure tier into that self-contained
// chatbot flavour and publishes it at a live `/app/<slug>/` URL.
//
// The point of the gallery is to SHOW what one send can produce. The reference
// model is Claude Sonnet 5 over the API (SHOWCASE_REF) — the briefs are written
// and sized for what that model reliably single-shots; the header names it and
// nudges the user to pick it in the model list. Every brief describes a
// CLIENT-SIDE flavour (calls the model on the user's own key, in-memory state
// only) so the build upholds Se/cure's privacy invariants — the same posture
// the opaque-origin `/app/<slug>/` sandbox enforces (sdk-mode skill).
//
// Pure and Node-safe: the catalog + lookups carry no DOM/fetch and are
// unit-tested in sdk-showcase.test.js; renderShowcaseGallery is the ONE
// DOM-touching export and guards every access so importing this in tests is
// harmless.

/**
 * The reference model the gallery is calibrated for. Named in the header so a
 * user knows which model single-shots these cleanly; kept in sync with the
 * Anthropic catalog id (src/anthropic.js).
 */
export const SHOWCASE_REF = { model: "claude-sonnet-5", label: "Claude Sonnet 5" };

/**
 * @typedef {{ id: string, title: string, blurb: string, prompt: string }} ShowcaseItem
 * @typedef {{ group: string, items: ShowcaseItem[] }} ShowcaseGroup
 */

// Every brief ends on the same quiet client-side reminder so the single send
// lands a proper Se/cure flavour even though buildSdkContextBlock already
// teaches the invariants — repetition here is cheap insurance for the one-shot.
const CLIENT_TAIL =
  "Ship it as one self-contained page that calls the model on the user's own API key, keeps all state in memory, and needs no server.";

/**
 * The showcase catalog: grouped so the gallery reads as a small library, not a
 * wall of prompts. IDs are stable slugs (used as list keys and for lookup); do
 * not renumber — append. Keep each blurb to one line and each prompt to a
 * couple of sentences: a single-shot brief that over-specifies tends to
 * out-run what one send can finish.
 * @type {ShowcaseGroup[]}
 */
export const SDK_SHOWCASE = [
  {
    group: "Learn & tutor",
    items: [
      {
        id: "socratic-tutor",
        title: "Socratic tutor",
        blurb: "Teaches by asking, never just telling.",
        prompt:
          "Build a Socratic tutor chatbot: the user names any subject and it teaches by asking one guiding question at a time, nudging them to reach each insight themselves instead of handing over the answer. Calm single-column UI. " +
          CLIENT_TAIL,
      },
      {
        id: "flashcard-coach",
        title: "Flashcard coach",
        blurb: "Turns a topic into a quiz-yourself deck.",
        prompt:
          "Build a flashcard coach: the user pastes notes or names a topic, the bot generates a deck of question/answer cards and drills them one at a time, revealing the answer on tap and asking the user to rate recall. " +
          CLIENT_TAIL,
      },
      {
        id: "phrasebook-coach",
        title: "Travel phrasebook",
        blurb: "A pocket coach for a new language.",
        prompt:
          "Build a travel phrasebook chatbot: the user picks a target language and a situation (ordering food, asking directions), and it gives the phrase, a phonetic hint, and a likely reply to expect — then quizzes them back. " +
          CLIENT_TAIL,
      },
    ],
  },
  {
    group: "Build & debug",
    items: [
      {
        id: "rubber-duck",
        title: "Rubber-duck debugger",
        blurb: "Talks you through your own bug.",
        prompt:
          "Build a rubber-duck debugging chatbot: the user pastes code and a symptom, and it asks the sharpening questions a good pair-programmer would — what did you expect, what changed, what have you ruled out — before offering a hypothesis. Monospace-friendly UI. " +
          CLIENT_TAIL,
      },
      {
        id: "regex-explainer",
        title: "Regex explainer",
        blurb: "Reads any pattern back in plain English.",
        prompt:
          "Build a regex explainer chatbot: the user pastes a regular expression and it explains each piece in plain English, flags common gotchas, and offers a couple of test strings that match and don't. " +
          CLIENT_TAIL,
      },
      {
        id: "sql-helper",
        title: "SQL sketch pad",
        blurb: "Describe the query, get the SQL.",
        prompt:
          "Build a SQL helper chatbot: the user describes their tables and what they want to know, and it drafts the query, explains the joins, and suggests an index if the query looks slow. " +
          CLIENT_TAIL,
      },
    ],
  },
  {
    group: "Write & pitch",
    items: [
      {
        id: "cover-letter",
        title: "Cover-letter tailor",
        blurb: "Matches your CV to one job post.",
        prompt:
          "Build a cover-letter tailor: the user pastes a résumé and a job posting, and it drafts a focused one-page letter that maps their real experience onto the posting's must-haves, in a tone the user picks (plain, warm, formal). " +
          CLIENT_TAIL,
      },
      {
        id: "tone-shifter",
        title: "Email tone-shifter",
        blurb: "Rewrites a draft in the register you want.",
        prompt:
          "Build an email tone-shifter: the user pastes a rough draft and picks a target tone (warmer, firmer, more concise, more formal), and it rewrites the email while keeping every fact intact and shows a one-line note on what it changed. " +
          CLIENT_TAIL,
      },
      {
        id: "dungeon-master",
        title: "Story dungeon master",
        blurb: "An endless choose-your-path adventure.",
        prompt:
          "Build a text-adventure dungeon master: it opens a short scene, offers the user 3 choices plus a free-text option, and narrates the consequences turn by turn, keeping a light running memory of the story so far. " +
          CLIENT_TAIL,
      },
    ],
  },
  {
    group: "Think & decide",
    items: [
      {
        id: "devils-advocate",
        title: "Devil's advocate",
        blurb: "Stress-tests an idea before you commit.",
        prompt:
          "Build a devil's-advocate chatbot: the user states a plan or belief, and it argues the strongest honest case against it — the failure modes, the missing evidence, the second-order costs — then asks what would change their mind. " +
          CLIENT_TAIL,
      },
      {
        id: "decision-matrix",
        title: "Decision helper",
        blurb: "Weighs options against what you value.",
        prompt:
          "Build a decision-helper chatbot: the user lists a few options and what matters to them, and it walks through a simple weighted trade-off out loud, scores each option, and names the closest call and why. " +
          CLIENT_TAIL,
      },
      {
        id: "standup-summarizer",
        title: "Standup summarizer",
        blurb: "Turns rambling notes into a crisp update.",
        prompt:
          "Build a standup summarizer: the user pastes messy notes from their day and it returns a tidy three-line update — done / doing / blocked — plus one suggested next step, ready to paste into a team channel. " +
          CLIENT_TAIL,
      },
    ],
  },
];

/**
 * Flatten the catalog to a single list (each item tagged with its group) —
 * used for lookup and by the data-integrity tests.
 * @returns {(ShowcaseItem & { group: string })[]}
 */
export function showcaseItems() {
  return SDK_SHOWCASE.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));
}

/**
 * Find one showcase brief by its stable id.
 * @param {string} id
 * @returns {(ShowcaseItem & { group: string }) | undefined}
 */
export function findShowcase(id) {
  return showcaseItems().find((it) => it.id === id);
}

/**
 * Render the gallery into a container. The ONLY DOM-touching export; every
 * access is guarded so a Node import (tests) is a no-op returning 0.
 * @param {Element | null | undefined} container
 * @param {(item: ShowcaseItem & { group: string }) => void} onPick called with
 *   the picked brief when a card is clicked (app.js prefills the composer)
 * @returns {number} how many cards were rendered (0 if there's no DOM)
 */
export function renderShowcaseGallery(container, onPick) {
  if (!container || typeof container.appendChild !== "function") return 0;
  const doc = container.ownerDocument;
  if (!doc) return 0;
  container.textContent = "";

  const head = doc.createElement("div");
  head.className = "showcase-head";
  const h = doc.createElement("strong");
  h.textContent = "SDK Showcase";
  const sub = doc.createElement("p");
  sub.className = "showcase-sub";
  sub.textContent = `Single-shot chatbots to build — sized for ${SHOWCASE_REF.label}. Pick one, then send.`;
  head.appendChild(h);
  head.appendChild(sub);
  container.appendChild(head);

  let count = 0;
  for (const grp of SDK_SHOWCASE) {
    const gh = doc.createElement("div");
    gh.className = "showcase-group";
    gh.textContent = grp.group;
    container.appendChild(gh);
    for (const it of grp.items) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "showcase-card";
      btn.dataset.id = it.id;
      const title = doc.createElement("span");
      title.className = "showcase-title";
      title.textContent = it.title;
      const blurb = doc.createElement("span");
      blurb.className = "showcase-blurb";
      blurb.textContent = it.blurb;
      btn.appendChild(title);
      btn.appendChild(blurb);
      const item = { ...it, group: grp.group };
      btn.addEventListener("click", () => {
        try {
          onPick && onPick(item);
        } catch {
          /* a pick handler throwing must not wedge the gallery */
        }
      });
      container.appendChild(btn);
      count += 1;
    }
  }
  return count;
}

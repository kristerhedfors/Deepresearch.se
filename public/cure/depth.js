// @ts-check
// The DRC depth view: "this very reasoning" — the tier's trust-boundary
// argument — explorable by ZOOM instead of by links. The whole argument is
// a tree of fragments written at EIGHT depths (a one-line thesis down to
// wire formats and key sizes, the way research summaries of different
// depths would put it), all pre-fetched and hardcoded here: nothing you
// read in the view was fetched because you zoomed, which is itself the
// point the view is making.
//
// The user experience (2026-07-12 directive), designed as follows:
//   - There are NO links. The view is one continuous document.
//   - SCROLLING inside the view does not move the page — it compresses or
//     expands the reasoning: deeper fragments grow out of (and shrink back
//     into) the sentence they elaborate, smoothly, by font-scale, so the
//     text literally compresses to nothing rather than popping.
//   - PINCHING (touch, or a trackpad pinch = ctrl+wheel) zooms with the
//     focus EXACTLY at the pinch point: the fragment under your fingers is
//     measured before and after the zoom and the scroll position corrected
//     so it stays put on screen while its context expands around it.
//   - A one-finger drag (or the scrollbar) pans the document normally.
//   - A depth gauge (8 ticks, right edge) shows where between depth 1 and
//     depth 8 you are; ticks jump straight to a depth, +/− step by one —
//     the accessible, gesture-free path to every level.
//   - Zoom is CONTINUOUS (1.0–8.0): a fragment at depth d is fully open at
//     zoom ≥ d, absent below d−1, and partially compressed in between.
//
// Structured like every DRC module: a PURE core (the fragment tree, the
// reveal/zoom math — everything above `openDepthView`) that runs in Node
// for the unit suite (public/js/depth-view.test.js), and a DOM layer that
// only ever runs in the browser. No dependencies, no server involvement.

// ---- the depths (pure) --------------------------------------------------------------

export const MAX_DEPTH = 8;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = MAX_DEPTH;

/** @param {number} v */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smoothstep, matching the umbrella intro's ramps — zoom has no velocity
 * kinks at depth boundaries.
 * @param {number} v */
const smooth = (v) => {
  v = clamp01(v);
  return v * v * (3 - 2 * v);
};

/** @param {number} z */
export function clampZoom(z) {
  const v = Number.isFinite(z) ? z : MIN_ZOOM;
  return v < MIN_ZOOM ? MIN_ZOOM : v > MAX_ZOOM ? MAX_ZOOM : v;
}

/**
 * How revealed a fragment at `depth` is at `zoom`: 1 fully open, 0 fully
 * compressed away. Depth 1 (the thesis) is always open; depth d opens
 * across zoom (d−1)…d, so integer zoom k shows exactly depths 1…k in full.
 * @param {number} depth @param {number} zoom
 */
export function revealAt(depth, zoom) {
  if (depth <= 1) return 1;
  return smooth(clampZoom(zoom) - (depth - 1));
}

/**
 * Wheel → zoom: scrolling up (or a trackpad pinch out, which arrives as
 * ctrl+wheel with negative deltas) expands; scrolling down compresses.
 * ~500 px of wheel travel crosses one depth. deltaMode 1 (lines) and 2
 * (pages) are normalized to pixels.
 * @param {number} zoom @param {number} deltaY @param {number} [deltaMode]
 */
export function wheelZoom(zoom, deltaY, deltaMode = 0) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 120 : deltaY;
  return clampZoom(clampZoom(zoom) - px * 0.002);
}

/**
 * Pinch → zoom: `ratio` is the finger-distance ratio between two gesture
 * frames; doubling the spread opens two more depths. Degenerate ratios
 * (0, negative, NaN) leave the zoom unchanged.
 * @param {number} zoom @param {number} ratio
 */
export function pinchZoom(zoom, ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return clampZoom(zoom);
  return clampZoom(clampZoom(zoom) + Math.log2(ratio) * 2);
}

/** The gauge's 0..1 fill for a zoom level. @param {number} zoom */
export function gaugeFill(zoom) {
  return (clampZoom(zoom) - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);
}

// ---- the reasoning itself (pure, pre-fetched by construction) -----------------------

// One tree, eight depths. Each node: {id, text, kids?}. The text at depth
// d elaborates its parent — the same argument, at the next level of
// magnification. Everything is plain text: the no-links rule is enforced
// by the data shape (there is nowhere to put a link).
/** @typedef {{id: string, text: string, kids?: DepthFragment[]}} DepthFragment */

/** @type {DepthFragment[]} */
export const DEPTH_FRAGMENTS = [
  {
    id: "thesis",
    text:
      "DRC runs deep research with exactly ONE external dataflow: the model calls from your " +
      "browser to the provider you chose — OpenAI, Berget, or a local endpoint you run yourself. " +
      "Everything else is verifiable code.",
    kids: [
      {
        id: "boundary",
        text:
          "The boundary. One bidirectional flow leaves this page: HTTPS requests from your browser " +
          "to your configured model provider, and its streamed replies back. Nothing else goes out; " +
          "nothing else comes in.",
        kids: [
          {
            id: "choices",
            text:
              "Three places to put it: OpenAI (the large US API), Berget (EU-hosted models), or " +
              "Local — any OpenAI-compatible server you run yourself. The choice is a dropdown, " +
              "not a commitment.",
            kids: [
              {
                id: "cors",
                text:
                  "Why exactly these: a hosted provider must allow direct browser calls (CORS). " +
                  "OpenAI and Berget do. A provider that doesn't would need a proxy — and a proxy " +
                  "is a server back inside the boundary this tier exists to keep empty.",
                kids: [
                  {
                    id: "corsdetail",
                    text:
                      "CORS is enforced by your browser, not promised by anyone: a cross-origin call " +
                      "the provider hasn't allowed dies at the preflight. Anthropic's API, for " +
                      "example, sets no such headers — so it cannot join this tier, and no goodwill " +
                      "can change that from this side.",
                  },
                ],
              },
            ],
          },
          {
            id: "crosses",
            text:
              "What crosses the boundary: your question, the research phases' working notes, and " +
              "your API key in the Authorization header — sent to your provider and to nowhere else.",
            kids: [
              {
                id: "wire",
                text:
                  "The wire, concretely: POST {endpoint}/chat/completions carrying the model id and " +
                  "messages, answers streamed back as server-sent events; GET {endpoint}/models to " +
                  "list what your key can use. The Local entry speaks the same shape — with " +
                  "localhost, this 'external' flow is a loopback.",
                kids: [
                  {
                    id: "sse",
                    text:
                      "Streams arrive as data: lines; the parser tolerates partial lines, and an idle " +
                      "stream is abandoned after 90 seconds rather than hanging the page. Nothing in " +
                      "a stream is executed — it is text, rendered through a sanitizer.",
                    kids: [
                      {
                        id: "sanitize",
                        text:
                          "Rendering detail: model output is Markdown, parsed and then sanitized " +
                          "(DOMPurify) before it touches the document — a provider gone rogue can " +
                          "shout at you, but it cannot script this page.",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "nevercrosses",
            text:
              "What never crosses: this site's server sees no keys, no messages, no projects. " +
              "'No logging' here is structural, not policy — there is nothing in the path to log.",
            kids: [
              {
                id: "static",
                text:
                  "This site's entire role in DRC: hand out static files and public replay JSONs. It " +
                  "is not in the model path, the storage path, or the retrieval path — remove it " +
                  "after page load and a conversation would still run.",
                kids: [
                  {
                    id: "verify5",
                    text:
                      "Check it yourself, no trust required: open the browser's network tab and run a " +
                      "question. You will see this site's static files, then your provider's domain — " +
                      "and nothing else, ever.",
                    kids: [
                      {
                        id: "nobuild",
                        text:
                          "No build step means no gap between source and artifact: the file your " +
                          "browser fetched is the file in the repository, byte for byte — plain ES " +
                          "modules, readable in devtools as written.",
                        kids: [
                          {
                            id: "diff7",
                            text:
                              "Reproduce it: fetch the modules (drc-core, drc-providers, drc-research, " +
                              "drc-store) with curl, hash them, and compare against the repository at " +
                              "the deployed commit. The whole tier is a few thousand lines — an " +
                              "afternoon's read, not a leap of faith.",
                            kids: [
                              {
                                id: "hash8",
                                text:
                                  "One-liner: curl -s deepresearch.se/js/drc-providers.js | sha256sum — " +
                                  "match it against the repo. That file is the provider list: the " +
                                  "registry you just audited is, verbatim, the only place this page " +
                                  "can ever send your words.",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "rest",
        text:
          "The rest. Research orchestration, storage, retrieval — all of it is client-side code, " +
          "served as static files. What you can read is what runs.",
        kids: [
          {
            id: "sealed",
            text:
              "Storage: chats, keys and your endpoint choice are sealed with AES-256-GCM under a " +
              "secret only you hold, and rest in this browser's local storage — ciphertext at rest, " +
              "on your own disk.",
            kids: [
              {
                id: "hkdf",
                text:
                  "The key hierarchy: one 160-bit secret (the DR1-… string in your password manager) " +
                  "→ HKDF-SHA-256 with independent info strings → a public project reference, a " +
                  "storage id, and the AES key. No derived value reveals any other, or the secret.",
                kids: [
                  {
                    id: "gcm",
                    text:
                      "Sealing detail: AES-256-GCM with a fresh 12-byte IV on every write. GCM " +
                      "authenticates as it encrypts — a tampered blob fails to open at all rather " +
                      "than opening wrong.",
                    kids: [
                      {
                        id: "iv",
                        text:
                          "Why the fresh IV matters: GCM's guarantees collapse if an IV ever repeats " +
                          "under a key. Fresh randomness per seal, and one key per project secret, " +
                          "keep every (key, IV) pair unique.",
                        kids: [
                          {
                            id: "derive7",
                            text:
                              "Derivation detail: the HKDF info strings are frozen constants, so ref, " +
                              "storage id and key live in disjoint derivation spaces — publishing the " +
                              "reference (it's in your /my/… link) leaks nothing about the key.",
                            kids: [
                              {
                                id: "bits8",
                                text:
                                  "The numbers: a 160-bit secret in Crockford base32 (no I/L/O/U; " +
                                  "common misreads forgiven on input), an 80-bit public reference, a " +
                                  "160-bit storage id, a 256-bit AES key — each derived independently " +
                                  "via HKDF-SHA-256 with distinct info strings.",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "pipeline",
            text:
              "Research: the deep-research pipeline — triage, knowledge harvest, gap audit, " +
              "synthesis, validation — runs as plain model calls orchestrated by code in this tab, " +
              "not by a service.",
            kids: [
              {
                id: "nofc",
                text:
                  "Deterministic by design: no function calling, no tool magic — every phase is a " +
                  "plain JSON-mode or streamed completion, auditable request by request in the " +
                  "network tab, and it works on any model, local ones included.",
                kids: [
                  {
                    id: "failsoft",
                    text:
                      "Helper phases fail soft: a broken triage degrades to a direct answer; a failed " +
                      "gap audit or validation never breaks the reply. Determinism is what makes the " +
                      "failure modes enumerable enough to promise that.",
                    kids: [
                      {
                        id: "split",
                        text:
                          "Split routing detail: planning phases run on a fixed cheap model, synthesis " +
                          "on the model you picked — a cost discipline that never widens the boundary, " +
                          "because both run on the same key to the same host. (A local server usually " +
                          "serves one model, so there the split collapses to your chosen model.)",
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "retrieval",
            text:
              "Retrieval: project recall (RAG) is computed in the tab over material that is already " +
              "here — like these very fragments, pre-fetched with the page. No lookup service is " +
              "consulted.",
            kids: [
              {
                id: "fragments",
                text:
                  "Pre-fetched by design: retrieval corpora — this reasoning at its eight depths " +
                  "included — ship with the page and are ranked locally. Nothing you are reading was " +
                  "fetched because you zoomed; zooming only re-weights what was already in your hands.",
                kids: [
                  {
                    id: "surface",
                    text:
                      "The audit surface is kept deliberately small: a handful of ES modules, each " +
                      "independently unit-tested, two vendored renderer libraries, zero runtime " +
                      "dependencies fetched from CDNs.",
                    kids: [
                      {
                        id: "tests",
                        text:
                          "The same files run in Node's test runner: the derivations, the sealing, the " +
                          "full pipeline against a mock provider. The properties this view describes " +
                          "are asserted by tests, not just narrated by prose.",
                        kids: [
                          {
                            id: "node7",
                            text:
                              "Run them yourself: node --test over the public modules — File, Blob and " +
                              "WebCrypto are standard Node globals now, so the browser code executes " +
                              "unmodified, no mocking layer in between.",
                            kids: [
                              {
                                id: "prop8",
                                text:
                                  "Properties the suite pins, for example: sealed blobs never contain " +
                                  "key material or endpoint URLs in readable form; the same secret " +
                                  "always derives the same ids; a tampered archive throws; every " +
                                  "pipeline phase carries your key to exactly one host.",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "meaning",
        text:
          "What this buys. You never hand this site your content on trust. You place trust once — " +
          "at the provider — and you can move it, or collapse it onto your own hardware.",
        kids: [
          {
            id: "movable",
            text:
              "Movable trust: the provider is a per-session choice. Switch the dropdown and the same " +
              "research flows to a different company, a different jurisdiction — the code around it " +
              "does not change.",
            kids: [
              {
                id: "samecode",
                text:
                  "Literally the same code: the same phases, the same wire shape, a different base " +
                  "URL. The registry entry IS the entire difference between providers — one " +
                  "declarative object per choice.",
              },
            ],
          },
          {
            id: "collapsible",
            text:
              "Collapsible trust: point the Local endpoint at your own machine and the one external " +
              "dataflow never leaves it. The boundary and your hardware's edge coincide.",
            kids: [
              {
                id: "localhost",
                text:
                  "Any OpenAI-compatible server qualifies: Ollama, llama.cpp, vLLM, LM Studio, or a " +
                  "gateway you host. On localhost even the model call is a loopback — the research " +
                  "is then, in the strict sense, fully offline.",
              },
            ],
          },
          {
            id: "honest",
            text:
              "The honest limits: whichever provider you chose still reads what you send it, and " +
              "your browser must be running untampered code. The boundary is narrow and yours — " +
              "not magical.",
            kids: [
              {
                id: "threat",
                text:
                  "Threat model, plainly: a malicious update of this page's own code could exfiltrate " +
                  "— that is true of every web page ever served. Verifiability is the counterweight: " +
                  "small modules, no build step, nothing loaded from third parties, so the code can " +
                  "actually be checked rather than merely trusted.",
              },
            ],
          },
        ],
      },
    ],
  },
];

/**
 * Depth-first flatten with computed depths (document order — exactly the
 * order the DOM layer renders).
 * @param {DepthFragment[]} [nodes] @param {number} [depth]
 * @returns {{id: string, depth: number, text: string, kids: DepthFragment[]}[]}
 */
export function flattenFragments(nodes = DEPTH_FRAGMENTS, depth = 1) {
  const out = [];
  for (const n of nodes) {
    out.push({ id: n.id, depth, text: n.text, kids: n.kids || [] });
    out.push(...flattenFragments(n.kids || [], depth + 1));
  }
  return out;
}

// ---- the DOM layer (browser only) ----------------------------------------------------

let built = false;
let zoom = 2; // opens with the thesis and its three branches — both zoom directions visible

/** Non-null getElementById: the view's markup is static in index.html.
 * @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {DepthFragment[]} nodes @param {number} depth @param {HTMLElement} into */
function buildFragmentDom(nodes, depth, into) {
  for (const n of nodes) {
    const frag = document.createElement("div");
    frag.className = "frag";
    frag.dataset.d = String(depth);
    const text = document.createElement("div");
    text.className = "frag-text";
    text.textContent = n.text;
    frag.appendChild(text);
    if (n.kids?.length) {
      const kids = document.createElement("div");
      kids.className = "fkids";
      buildFragmentDom(n.kids, depth + 1, kids);
      frag.appendChild(kids);
    }
    into.appendChild(frag);
  }
}

// The deepest currently-visible fragment under viewport y — the focal
// anchor a zoom must hold still.
/** @param {number} y */
function anchorAt(y) {
  let best = null;
  let bestDepth = 0;
  let nearest = null;
  let nearestDist = Infinity;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ ($("depthbody").querySelectorAll(".frag"))) {
    const d = Number(el.dataset.d);
    if (revealAt(d, zoom) < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 1) continue;
    if (y >= r.top && y <= r.bottom) {
      if (d >= bestDepth) {
        best = el;
        bestDepth = d;
      }
    } else {
      const dist = y < r.top ? r.top - y : y - r.bottom;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = el;
      }
    }
  }
  return best || nearest;
}

/** Apply a new zoom, keeping the fragment at viewport `focalY` fixed.
 * @param {number} z @param {?number} [focalY] */
function applyZoom(z, focalY) {
  zoom = clampZoom(z);
  const scroll = $("depthscroll");
  const anchor = focalY != null ? anchorAt(focalY) : null;
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  const body = $("depthbody");
  for (let d = 2; d <= MAX_DEPTH; d++) {
    body.style.setProperty("--r" + d, String(revealAt(d, zoom).toFixed(4)));
  }
  if (anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - before;
  // The gauge: marker position + tick states + the accessible label.
  const ticks = $("depthticks");
  ticks.style.setProperty("--fill", String(gaugeFill(zoom)));
  for (const [i, el] of [...ticks.querySelectorAll(".dtick")].entries()) {
    el.classList.toggle("on", i + 1 <= zoom + 0.0001);
  }
  ticks.setAttribute("aria-valuenow", zoom.toFixed(1));
  $("depthlabel").textContent = "depth " + zoom.toFixed(1) + " / " + MAX_DEPTH;
}

function buildOnce() {
  if (built) return;
  built = true;
  buildFragmentDom(DEPTH_FRAGMENTS, 1, $("depthbody"));

  const scroll = $("depthscroll");
  const viewportMidY = () => {
    const r = scroll.getBoundingClientRect();
    return r.top + r.height / 2;
  };

  const ticks = $("depthticks");
  ticks.setAttribute("role", "slider");
  ticks.setAttribute("aria-label", "Reasoning depth");
  ticks.setAttribute("aria-valuemin", String(MIN_ZOOM));
  ticks.setAttribute("aria-valuemax", String(MAX_ZOOM));
  for (let d = 1; d <= MAX_DEPTH; d++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dtick";
    b.title = "Depth " + d;
    b.addEventListener("click", () => applyZoom(d, viewportMidY()));
    ticks.appendChild(b);
  }

  // Wheel (and trackpad pinch, which arrives as ctrl+wheel): zoom at the
  // cursor. The view has no wheel-scrolling of its own — scroll IS zoom.
  scroll.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      applyZoom(wheelZoom(zoom, e.deltaY, e.deltaMode), e.clientY);
    },
    { passive: false },
  );

  // Touch pinch: two pointers tracked by hand; the midpoint is the focus.
  // touch-action: pan-y keeps one-finger drags native (panning the
  // document) while pinches are delivered here.
  const pointers = new Map();
  let lastDist = 0;
  scroll.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    pointers.set(e.pointerId, e);
    lastDist = 0;
  });
  scroll.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, e);
      if (pointers.size !== 2) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const midY = (a.clientY + b.clientY) / 2;
      if (lastDist > 0) {
        e.preventDefault();
        applyZoom(pinchZoom(zoom, dist / lastDist), midY);
      }
      lastDist = dist;
    },
    { passive: false },
  );
  const drop = (/** @type {PointerEvent} */ e) => {
    pointers.delete(e.pointerId);
    lastDist = 0;
  };
  scroll.addEventListener("pointerup", drop);
  scroll.addEventListener("pointercancel", drop);

  $("depthin").addEventListener("click", () => applyZoom(zoom + 1, viewportMidY()));
  $("depthout").addEventListener("click", () => applyZoom(zoom - 1, viewportMidY()));
  $("depthclose").addEventListener("click", closeDepthView);
  document.addEventListener("keydown", (e) => {
    if ($("depthview").hidden) return;
    if (e.key === "Escape") closeDepthView();
    else if (e.key === "+" || e.key === "ArrowUp") applyZoom(zoom + 0.5, viewportMidY());
    else if (e.key === "-" || e.key === "ArrowDown") applyZoom(zoom - 0.5, viewportMidY());
  });
}

export function openDepthView() {
  if (typeof document === "undefined" || !$("depthview")) return;
  buildOnce();
  $("depthview").hidden = false;
  applyZoom(zoom, null);
}

export function closeDepthView() {
  const view = $("depthview");
  if (view) view.hidden = true;
}

// Research-activity UI: the step bars streamed during a run (searches and
// generic pipeline steps), the stats footer, and the end-of-run collapse
// into a single expandable summary bar. All functions operate on the `turn`
// object created by turns.js; scrolling is the caller's concern.

import { mapsEmbedKey } from "./settings.js";

// ---- Street View SDK panorama + current-view (POV) capture ------------------
//
// The inline Street View is a real Maps JavaScript API StreetViewPanorama
// (the Street View SDK) rather than a Maps Embed iframe, because ONLY the SDK
// exposes where the user has panned/moved (pano id, position, heading, pitch,
// zoom) — an Embed iframe is cross-origin and reports nothing. The current
// POV is tracked here and stream.js sends it as `street_view_pov` with every
// following /api/chat query, so the server can capture and reason about the
// exact frame on the user's screen. If the SDK can't load (e.g. the browser
// key isn't enabled for the Maps JavaScript API), the old iframe renders as a
// fallback — navigable, just without POV capture.

let currentPov = null; // the view the user last panned/moved to (this session)
let mapsApiPromise = null; // lazy one-time SDK load
let sdkAuthFailed = false; // Google rejected the key for the JS API (gm_authFailure)
const panoFallbacks = new Set(); // per-panorama "replace me with the iframe" closures

// What stream.js attaches to the next /api/chat body, or null when no live
// panorama exists (fresh session, iframe fallback, reloaded conversation).
export function getStreetViewPov() {
  return currentPov;
}

// New chat / switching conversations: the panorama on screen no longer
// belongs to the conversation being sent, so its POV must not ride along.
export function resetStreetViewPov() {
  currentPov = null;
}

// The SDK script can load fine and STILL fail afterwards: Google validates
// the key asynchronously and, on rejection (key not enabled for the Maps
// JavaScript API, referer not allowed, invalid key), paints a "Sorry!
// Something went wrong." panel INTO the map container and calls the global
// gm_authFailure hook — the script's onerror never fires (a reported bug:
// that error panel sat where the panorama should be). Hook it once: replace
// every live panorama with the Embed iframe fallback, drop the now-dead POV,
// and route all future renders straight to the iframe.
function installAuthFailureHook() {
  if (globalThis.__drGmAuthHooked) return;
  globalThis.__drGmAuthHooked = true;
  globalThis.gm_authFailure = () => {
    sdkAuthFailed = true;
    currentPov = null; // no live panorama ⇒ no current view to send
    for (const fallback of panoFallbacks) {
      try {
        fallback();
      } catch {
        // best-effort — a failed swap just leaves Google's error panel
      }
    }
    panoFallbacks.clear();
  };
}

// Loads the Maps JS SDK once, on demand (only when a streetview_embed event
// actually arrives). Uses the documented async bootstrap (loading=async +
// callback). A failed load clears the promise so a later turn can retry.
function loadMapsApi(key) {
  if (globalThis.google?.maps?.StreetViewPanorama) return Promise.resolve(globalThis.google.maps);
  if (!mapsApiPromise) {
    mapsApiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("maps js sdk timeout")), 10_000);
      globalThis.__drMapsReady = () => {
        clearTimeout(timer);
        resolve(globalThis.google?.maps || null);
      };
      const s = document.createElement("script");
      const params = new URLSearchParams({ key, v: "weekly", loading: "async", callback: "__drMapsReady" });
      s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
      s.async = true;
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error("maps js sdk failed to load"));
      };
      document.head.appendChild(s);
    }).catch((err) => {
      mapsApiPromise = null; // allow a retry on a later turn
      throw err;
    });
  }
  return mapsApiPromise;
}

// Convert the SDK's zoom to the Street View Static API's fov so the captured
// frame matches what's on screen (zoom 0 ≈ 180° wide, zoom 1 ≈ 90°, each
// level halves it; Static accepts 10-120).
function zoomToFov(zoom) {
  const z = Number.isFinite(Number(zoom)) ? Number(zoom) : 1;
  return Math.round(Math.min(120, Math.max(10, 180 / Math.pow(2, z))));
}

// Interactive Street View, from a `streetview_embed` status event. Unlike the
// activity steps (which collapse when the run finishes), this is inserted
// into the turn body so it PERSISTS beside the answer. Uses the browser key
// from /api/settings (referrer-locked) — no key means no inline panorama,
// just the keyless Street View link the answer already carries. Live-session
// only: a reloaded conversation shows the answer + link, not the panorama
// (same as the step traces).
export function renderStreetViewEmbed(turn, s) {
  const key = mapsEmbedKey();
  if (!key || !turn?.el || turn._svEmbed) return;
  const lat = Number(s.lat);
  const lng = Number(s.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const wrap = document.createElement("div");
  wrap.className = "streetview-embed";
  const label = document.createElement("div");
  label.className = "streetview-embed-label";
  label.textContent = "Street View — drag to look around";
  const box = document.createElement("div");
  box.className = "streetview-pano";
  wrap.append(label, box);
  turn.el.insertBefore(wrap, turn.stats);
  turn._svEmbed = wrap;

  // The Embed-iframe fallback for every way the SDK can fail (script load
  // error, timeout, missing class, async key rejection) — still navigable,
  // just without the current-view capture.
  const renderIframeFallback = () => {
    const iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.allow = "fullscreen";
    iframe.title = "Google Street View";
    const params = new URLSearchParams({ key, location: `${lat},${lng}` });
    if (Number.isFinite(Number(s.heading))) params.set("heading", String(Number(s.heading)));
    if (Number.isFinite(Number(s.pitch))) params.set("pitch", String(Number(s.pitch)));
    iframe.src = `https://www.google.com/maps/embed/v1/streetview?${params}`;
    box.replaceChildren(iframe);
    label.textContent = "Street View — drag to look around";
  };

  // Google already rejected this key for the JS API — don't render its error
  // panel again, go straight to the iframe.
  if (sdkAuthFailed) {
    renderIframeFallback();
    return;
  }
  installAuthFailureHook();

  loadMapsApi(key)
    .then((maps) => {
      if (sdkAuthFailed) throw new Error("maps js auth failed");
      if (!maps?.StreetViewPanorama) throw new Error("StreetViewPanorama unavailable");
      const pano = new maps.StreetViewPanorama(box, {
        position: { lat, lng },
        // Heading/pitch ride along on the POV path (the panorama continues
        // exactly where the user's captured current view was) — absent on an
        // address lookup, where north/level is the neutral start.
        pov: {
          heading: Number.isFinite(Number(s.heading)) ? Number(s.heading) : 0,
          pitch: Number.isFinite(Number(s.pitch)) ? Number(s.pitch) : 0,
        },
        zoom: 1,
        addressControl: false,
        fullscreenControl: true,
      });
      // Track the CURRENT view — a new panorama (a later lookup) simply takes
      // over the shared slot, matching "the street view on screen".
      const record = () => {
        try {
          const pos = pano.getPosition();
          const pov = pano.getPov();
          if (!pos || !pov) return;
          currentPov = {
            panoId: typeof pano.getPano() === "string" ? pano.getPano() : "",
            lat: pos.lat(),
            lng: pos.lng(),
            heading: Math.round(((Number(pov.heading) % 360) + 360) % 360) || 0,
            pitch: Math.round(Number(pov.pitch) || 0),
            fov: zoomToFov(pano.getZoom()),
          };
        } catch {
          // POV capture is best-effort — the panorama itself keeps working.
        }
      };
      pano.addListener("pov_changed", record);
      pano.addListener("position_changed", record);
      pano.addListener("pano_changed", record);
      record();
      label.textContent = "Street View — drag to look around; follow-up questions see your current view";
      // If Google rejects the key AFTER the panorama rendered (gm_authFailure
      // fires whenever), this closure swaps it for the working iframe.
      panoFallbacks.add(renderIframeFallback);
    })
    .catch(renderIframeFallback);
}

// The snapped Street View frames the server's vision helper reasoned about,
// from a `streetview_frames` status event — rendered as a captioned thumbnail
// strip in the turn body so the user sees the SAME imagery the model saw.
// Persists beside the answer like the embed (and like it, is live-session
// only: a reloaded conversation keeps the answer + link, not the images).
export function renderStreetViewFrames(turn, s) {
  if (!turn?.el) return;
  const frames = (Array.isArray(s.frames) ? s.frames : []).filter(
    (f) => typeof f?.url === "string" && f.url.startsWith("data:image/"),
  );
  if (!frames.length) return;
  if (turn._svFrames) turn._svFrames.remove(); // one strip per turn — last event wins

  const wrap = document.createElement("div");
  wrap.className = "streetview-frames";
  const label = document.createElement("div");
  label.className = "streetview-embed-label";
  label.textContent = `Street View — ${s.query || "resolved location"}`;
  const strip = document.createElement("div");
  strip.className = "streetview-frames-strip";
  for (const f of frames) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = f.url;
    img.loading = "lazy";
    // A frame carries either a cardinal direction ("north") or a free-form
    // label ("your current view" — the POV capture path).
    const caption = f.label || (f.dir ? `looking ${f.dir}` : "");
    img.alt = caption ? `Street View — ${caption}` : "Street View";
    fig.appendChild(img);
    if (caption) {
      const cap = document.createElement("figcaption");
      cap.textContent = caption;
      fig.appendChild(cap);
    }
    strip.appendChild(fig);
  }
  wrap.append(label, strip);
  // Before the embed if one is already rendered, else before the stats footer.
  turn.el.insertBefore(wrap, turn._svEmbed || turn.stats);
  turn._svFrames = wrap;
}

// Compacts a status event before it enters the per-turn research log (the
// "Copy research JSON" source): `streetview_frames` carries whole JPEG data
// URLs — hundreds of KB that would bloat the export — so only the frame count
// and directions are recorded, and `quiz` carries the full question set —
// several KB already persisted in the conversation's embeds registry — so
// only its title and question count are. Everything else passes through
// unchanged. Pure — unit-tested in activity.test.js.
export function sanitizeResearchEvent(s) {
  if (s?.type === "streetview_frames") {
    const frames = Array.isArray(s.frames) ? s.frames : [];
    return { type: s.type, query: s.query, frames: frames.length, directions: frames.map((f) => f?.dir || f?.label || "") };
  }
  if (s?.type === "quiz") {
    return {
      type: s.type,
      title: s.quiz?.title || "",
      questions: Array.isArray(s.quiz?.questions) ? s.quiz.questions.length : 0,
    };
  }
  return s;
}

// Generic pipeline steps (plan / gap check / synthesis / validation).
export function startGenericStep(turn, id, label) {
  const details = document.createElement("details");
  details.className = "step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const lab = document.createElement("span");
  lab.textContent = label;
  summary.append(spin, lab);
  details.appendChild(summary);
  details.addEventListener("click", (e) => {
    if (!details.classList.contains("expandable")) e.preventDefault();
  });
  turn.activity.appendChild(details);
  turn.steps[id] = { details, summary, label: lab };
}

// Updates an in-progress step's label in place (spinner kept) — e.g. the
// recovery step ticking "Still researching… (Ns)" so a long wait reads as
// live progress, not a frozen screen. No-op if the step doesn't exist.
export function updateGenericStep(turn, id, label) {
  const step = turn.steps[id];
  if (step) step.label.textContent = label;
}

// Shared by finishGenericStep/finishSearchStep: marks a step's details/
// summary as finished — adds the "finished" class and swaps the spinner
// for a checkmark. Doesn't touch "expandable"; callers add that based on
// whether they have anything to show inside.
function markFinished(step) {
  step.details.classList.add("finished");
  step.summary.querySelector(".spin")?.remove();
  const check = document.createElement("span");
  check.className = "check";
  check.textContent = "✓";
  step.summary.prepend(check);
}

export function finishGenericStep(turn, s) {
  const step = turn.steps[s.id];
  if (!step) return;
  markFinished(step);
  step.label.textContent = s.label || "";
  const items = Array.isArray(s.details) ? s.details : [];
  if (items.length) {
    step.details.classList.add("expandable");
    const ul = document.createElement("ul");
    for (const it of items) {
      const li = document.createElement("li");
      li.textContent = String(it);
      ul.appendChild(li);
    }
    step.details.appendChild(ul);
  }
}

// "Searching the web: …" with a spinner.
//
// Searches within one round run concurrently server-side (src/pipeline.js),
// so several search_start events can arrive before any search_done — keyed
// by query text (pipeline.js already dedupes queries within a round, so
// this is always a unique key) rather than assuming strict start/done
// pairing.
// Which provider ran a search must always be visible on the card (a user
// report showed Hugging Face Hub and web searches rendering identically as
// "Searched ..."): the events carry `source` (slug) + `service` (display
// name) since 2026-07-08; absent fields (older stored events) fall back to
// the web wording. Pure helper, exported for tests.
export function searchServiceName(info) {
  return (info && info.service) || "Web search";
}

export function startSearchStep(turn, info) {
  const query = info.query || "";
  const details = document.createElement("details");
  details.className = "step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const label = document.createElement("span");
  label.textContent = searchServiceName(info) + ": “" + query + "”";
  summary.append(spin, label);
  details.appendChild(summary);
  // Block toggling while running (no sources to show yet).
  details.addEventListener("click", (e) => {
    if (!details.classList.contains("finished")) e.preventDefault();
  });
  turn.activity.appendChild(details);
  // Keyed by provider + query: the same query text may legitimately run on
  // both the web and an auxiliary source in one round.
  (turn.pendingSearchSteps ||= new Map()).set((info.source || "web") + "|" + query, { details, summary, label });
}

// Resolve the step: checkmark, counts, timing, expandable source list.
export function finishSearchStep(turn, info) {
  const step = turn.pendingSearchSteps?.get((info.source || "web") + "|" + info.query);
  if (!step) return;
  turn.pendingSearchSteps.delete((info.source || "web") + "|" + info.query);
  markFinished(step);
  step.details.classList.add("expandable");
  const n = info.results ?? 0;
  step.label.textContent =
    searchServiceName(info) + " “" + info.query + "” · " +
    n + (n === 1 ? " result" : " results") + " · " +
    Math.round(info.duration_ms ?? 0) + " ms";
  const ul = document.createElement("ul");
  for (const src of info.sources || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = src.url;
    a.textContent = src.title || src.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.appendChild(a);
    ul.appendChild(li);
  }
  step.details.appendChild(ul);
}

// Stats footer from the `done` event (model, duration, tokens).
export function renderStats(turn, s) {
  turn.searchCount = s.searches || 0;
  const parts = [];
  if (s.model) parts.push(String(s.model).split("/").pop());
  if (s.duration_ms != null) parts.push((s.duration_ms / 1000).toFixed(1) + " s");
  const tokens = (s.prompt_tokens || 0) + (s.completion_tokens || 0);
  if (tokens) parts.push(tokens.toLocaleString() + " tokens");
  if (s.searches) parts.push(s.searches + (s.searches === 1 ? " search" : " searches"));
  turn.stats.textContent = parts.join(" · ");
}

// Stop any step still showing a spinner now that the run is over. Every step
// normally gets its own step_done, but a RECOVERED answer (a stream that
// dropped and finished server-side) doesn't replay the step_done events for
// whatever was mid-flight when the connection died — so that step (a gap
// check, a search, synthesis) would spin FOREVER beside a finished answer,
// making a completed run look like it's still processing (the reported bug).
// Settle them neutrally: remove the spinner and add a muted mark, not the
// green ✓ (we don't have the step's verified result, only that the run has
// ended). Idempotent and safe to call on already-finished steps.
export function settlePendingSteps(turn) {
  const settle = (step) => {
    if (!step || step.details.classList.contains("finished")) return;
    step.summary.querySelector(".spin")?.remove();
    step.details.classList.add("finished");
    if (!step.summary.querySelector(".check, .settled")) {
      const mark = document.createElement("span");
      mark.className = "settled";
      mark.textContent = "✓";
      step.summary.prepend(mark);
    }
  };
  for (const id in turn.steps) settle(turn.steps[id]);
  if (turn.pendingSearchSteps) {
    for (const [, step] of turn.pendingSearchSteps) settle(step);
    turn.pendingSearchSteps.clear();
  }
}

// Collapse the live activity bars into one expandable summary once the
// answer is complete. Leaves a lone bar (e.g. a direct reply) as-is. The
// .done class keeps the summary bar visible when re-expanded, so the group
// can always be folded back to a single bar.
export function collapseActivity(turn) {
  settlePendingSteps(turn); // stop any spinner a dropped/recovered run left behind
  const steps = turn.activity.querySelectorAll(":scope > .step");
  if (steps.length <= 1) return;
  const searches = turn.searchCount;
  turn.activityLabel.textContent = searches
    ? `Research process · ${steps.length} steps · ${searches} search${searches === 1 ? "" : "es"}`
    : `Research process · ${steps.length} steps`;
  // A debug affordance that lives at the top of the expanded step list:
  // copies a full JSON record of every research task this run performed
  // (steps, queries, service lookups, timings, sources, stats) for pasting
  // into Claude Code. Only added once, and only for real multi-step runs.
  if (!turn.activity.querySelector(":scope > .activity-debug")) {
    turn.activity.prepend(makeCopyDebugButton(turn));
  }
  turn.activityWrap.classList.add("done");
  turn.activityWrap.open = false;
}

// Structured, JSON-serializable record of a turn's whole research process —
// the source for the copy button below. Pure (reads only plain turn fields,
// no DOM), so it's unit-testable. `timeline` is the raw ordered event log;
// `steps`/`searches`/`sources` are convenience projections of it.
export function buildResearchDebugJson(turn) {
  const log = Array.isArray(turn.researchLog) ? turn.researchLog : [];
  const searches = log
    .filter((e) => e.type === "search_done")
    .map((e) => ({
      round: e.round,
      query: e.query,
      source: e.source || "web",
      service: e.service || "Web search",
      results: e.results,
      duration_ms: e.duration_ms,
      sources: (e.sources || []).map((s) => ({ title: s.title, url: s.url })),
    }));
  const steps = log
    .filter((e) => e.type === "step_done")
    .map((e) => ({ id: e.id, label: e.label, details: Array.isArray(e.details) ? e.details : [] }));
  // Every cited source, deduped by URL across all search rounds.
  const seen = new Set();
  const sources = [];
  for (const s of searches) {
    for (const src of s.sources) {
      if (src.url && !seen.has(src.url)) {
        seen.add(src.url);
        sources.push(src);
      }
    }
  }
  const d = turn.doneStats;
  const stats = d
    ? {
        model: d.model,
        rounds: d.rounds,
        searches: d.searches,
        duration_ms: d.duration_ms,
        prompt_tokens: d.prompt_tokens,
        completion_tokens: d.completion_tokens,
      }
    : null;
  // Every error the turn hit, server- or client-side (setError records them
  // all into the log). `answer` is the full resulting generation exactly as
  // rendered — including any post-validation revision, a "*(Stopped.)*"
  // marker, or an appended "[…error…]" note — so the export is the complete
  // response, not just its metadata.
  const answer = turn.text || "";
  const errors = log.filter((e) => e.event === "error").map((e) => e.error);
  return {
    question: turn.question || "",
    model: turn.model || d?.model || "",
    stats,
    steps,
    searches,
    sources,
    answer,
    answerChars: answer.length,
    errored: !!turn.errored,
    errors,
    timeline: log,
  };
}

function makeCopyDebugButton(turn) {
  const bar = document.createElement("div");
  bar.className = "activity-debug";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "debug-copy-btn";
  btn.textContent = "Copy research JSON";
  btn.title =
    "Copy a JSON record of every research task this run performed — paste into Claude Code to debug";
  btn.addEventListener("click", async (e) => {
    // Inside the <details> content, so a click here must not toggle it.
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildResearchDebugJson(turn), null, 2));
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = "Copy research JSON"; }, 1500);
  });
  bar.appendChild(btn);
  return bar;
}

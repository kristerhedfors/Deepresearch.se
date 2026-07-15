// Research-activity UI: the step bars streamed during a run (searches and
// generic pipeline steps), the stats footer, and the end-of-run collapse
// into a single expandable summary bar. All functions operate on the `turn`
// object created by turns.js; scrolling is the caller's concern.

import { mapsEmbedKey } from "./settings.js";
import {
  addDeckEntries,
  keylessMapEmbedUrl,
  keylessStreetViewEmbedUrl,
  nearestDeckIndex,
  openDeck,
  resetDeck,
} from "./imagedeck.js";
import {
  buildResearchDebugJson,
  formatStatsLine,
  sanitizeResearchEvent,
  searchServiceName,
  shellRunOutputText,
  stepIsLocal,
  zoomToFov,
} from "./activity-core.js";
import { mountBalloonSpinner } from "./balloon-spinner.js";
import { mountUmbrellaSpinner } from "./umbrella-spinner.js";

// Re-exported so importers of activity.js (stream.js, the unit tests) keep
// their existing import paths; the implementations live in activity-core.js.
export { buildResearchDebugJson, sanitizeResearchEvent, searchServiceName };

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
let currentMapView = null; // the interactive MAP view they last panned/zoomed to
let mapsApiPromise = null; // lazy one-time SDK load
let sdkAuthFailed = false; // Google rejected the key for the JS API (gm_authFailure)
const panoFallbacks = new Set(); // per-panorama "replace me with the iframe" closures
let lockActiveEmbed = null; // locks the newest panorama when a newer one renders
let lockActiveMapEmbed = null; // locks the newest interactive map likewise

// What stream.js attaches to the next /api/chat body, or null when no live
// panorama exists (fresh session, iframe fallback, reloaded conversation).
export function getStreetViewPov() {
  return currentPov;
}

// The map sibling: the center/zoom of the live interactive map, sent as
// body.map_view so a follow-up can capture exactly the area on screen.
export function getMapView() {
  return currentMapView;
}

// The image deck's "continue from this point" anchor (requested
// 2026-07-09): asking from the lightbox's chat panel makes THAT image's
// position the current map view for the next message — the same map_view
// anchor the live interactive map maintains, so the server's whole anchor
// machinery (moves, nearby search, here-asks, scene captures) continues
// from that waypoint. Any live panorama's POV is cleared: the user is
// explicitly speaking from the deck image, not the on-screen panorama.
export function setMapViewAnchor(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  currentPov = null;
  currentMapView = { lat, lng, zoom: 17 };
}

// The photo sibling (requested 2026-07-09): asking from a PHOTO deck image
// makes that image's exact view — position AND heading — the current POV,
// so the server's POV path captures precisely that frame, answers about
// it, and renders a fresh Street View there as the new current location.
export function setPovAnchor(point) {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const heading = Number.isFinite(Number(point?.heading)) ? ((Math.round(Number(point.heading)) % 360) + 360) % 360 : 0;
  currentMapView = null;
  currentPov = { panoId: "", lat, lng, heading, pitch: 0, fov: 90 };
}

// New chat / switching conversations: the panorama/map on screen no longer
// belongs to the conversation being sent, so its view must not ride along —
// and the outgoing conversation's embeds must not be locked by the next
// conversation's first embed (the DOM is cleared; the closures must not
// linger and fire at a dead element's expense). The image deck is
// conversation-scoped too.
export function resetStreetViewPov() {
  currentPov = null;
  currentMapView = null;
  lockActiveEmbed = null;
  lockActiveMapEmbed = null;
  resetDeck();
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
    currentMapView = null; // ditto for the interactive map
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

// Shared shell of both persistent embeds (Street View panorama and
// interactive map): the labeled wrapper and the container box the SDK (or
// the iframe fallback) renders into.
function makeEmbedShell(labelText) {
  const wrap = document.createElement("div");
  wrap.className = "streetview-embed";
  const label = document.createElement("div");
  label.className = "streetview-embed-label";
  label.textContent = labelText;
  const box = document.createElement("div");
  box.className = "streetview-pano";
  wrap.append(label, box);
  return { wrap, label, box };
}

// The keyless <iframe> both embeds fall back to when the SDK can't run —
// see the renderIframeFallback comments in each renderer for why the
// fallback must be keyless.
function keylessIframe(title, src) {
  const iframe = document.createElement("iframe");
  iframe.loading = "lazy";
  iframe.allow = "fullscreen";
  iframe.title = title;
  iframe.src = src;
  return iframe;
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

  const { wrap, label, box } = makeEmbedShell("Street View — drag to look around");
  turn.el.insertBefore(wrap, turn.stats);
  turn._svEmbed = wrap;

  // Only the LATEST view stays navigable: rendering this one locks the
  // previous panorama (pointer events off, dimmed, honest label, POV
  // recording stopped) AND any live interactive map, so "the current view"
  // the server reasons about is always the single view in sight — with
  // several live embeds, panning an OLD one could hijack the view sent
  // with follow-ups (reported 2026-07-09).
  if (lockActiveEmbed) lockActiveEmbed();
  if (lockActiveMapEmbed) lockActiveMapEmbed();
  currentMapView = null;
  let locked = false;
  lockActiveEmbed = () => {
    locked = true;
    wrap.classList.add("locked");
    label.textContent = "Street View — earlier view (locked); continue in the latest panorama";
  };

  // The iframe fallback for every way the SDK can fail (script load error,
  // timeout, missing class, async key rejection) — still navigable, just
  // without the current-view capture. KEYLESS, deliberately: a key the JS
  // API just rejected (or one lacking the Maps Embed API service) would
  // render embed/v1 as a white rejection page — a fallback that can itself
  // fail invisibly is no fallback (chat_logs #170/#171; see imagedeck.js).
  const renderIframeFallback = () => {
    box.replaceChildren(
      keylessIframe("Google Street View", keylessStreetViewEmbedUrl(lat, lng, Number(s.heading) || 0, Number(s.pitch) || 0)),
    );
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
      // over the shared slot, matching "the street view on screen". A locked
      // (superseded) panorama records nothing: only the latest view counts.
      const record = () => {
        if (locked) return;
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

// A pill-shaped SVG marker icon showing the walking time on the map (the
// number the walking route's dotted line is annotated with). Baked into an
// SVG data URL so it needs no map styling and renders identically on every
// client — width grows with the text, anchored at its center.
function walkTimeBadge(maps, text) {
  const w = Math.round(18 + text.length * 6.6);
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22">` +
    `<rect x="0.75" y="0.75" width="${w - 1.5}" height="20.5" rx="10.25" fill="#ecfdf5" stroke="#059669" stroke-width="1.5"/>` +
    `<text x="${w / 2}" y="15" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="12" font-weight="600" fill="#065f46" text-anchor="middle">${esc}</text>` +
    `</svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    anchor: new maps.Point(w / 2, 11),
  };
}

// Interactive road map, from a `map_embed` status event — the no-coverage
// counterpart of the Street View embed: the location resolved but Google has
// no panorama near it, so a navigable MAP of the area stands in beside the
// answer (requested 2026-07-09). Handled with full panorama parity (also
// requested 2026-07-09): a real Maps JS SDK google.maps.Map whose pans/zooms
// are tracked into the map view sent with follow-up queries (body.map_view),
// with only the LATEST view (map or panorama) navigable — older embeds lock.
// SDK failure → Maps Embed API iframe fallback (place mode with a marker
// when a resolved address is named, view mode for a continue-from-here
// map) — still navigable, just without the current-view capture. Same key
// discipline: the browser key comes from /api/settings, never the event.
export function renderMapEmbed(turn, s) {
  const key = mapsEmbedKey();
  if (!key || !turn?.el || turn._mapEmbed) return;
  const lat = Number(s.lat);
  const lng = Number(s.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const zoom = Number.isFinite(Number(s.zoom)) ? Math.round(Number(s.zoom)) : 17;

  const baseLabel = s.q ? `Map — ${s.q}` : "Map — drag and zoom to explore";
  const { wrap, label, box } = makeEmbedShell(baseLabel);
  turn.el.insertBefore(wrap, turn.stats);
  turn._mapEmbed = wrap;

  // One live view at a time, across BOTH embed kinds: a new map locks the
  // previous map AND any live panorama (whose stale POV must not ride along
  // with follow-ups about this map).
  if (lockActiveEmbed) lockActiveEmbed();
  currentPov = null;
  if (lockActiveMapEmbed) lockActiveMapEmbed();
  let locked = false;
  lockActiveMapEmbed = () => {
    locked = true;
    currentMapView = null;
    wrap.classList.add("locked");
    label.textContent = "Map — earlier view (locked); continue in the latest map";
  };

  const renderIframeFallback = () => {
    // KEYLESS embed, deliberately: the key-based embed/v1 renders a white
    // rejection page when the key lacks the Maps Embed API service, and a
    // fallback that can itself fail invisibly is no fallback (same class as
    // the image deck's white mini-map, chat_logs #170/#171 — see
    // imagedeck.js keylessMapEmbedUrl). q=lat,lng drops a marker either way.
    box.replaceChildren(keylessIframe("Google Maps", keylessMapEmbedUrl(lat, lng, zoom)));
    label.textContent = baseLabel;
  };

  if (sdkAuthFailed) {
    renderIframeFallback();
    return;
  }
  installAuthFailureHook();

  loadMapsApi(key)
    .then((maps) => {
      if (sdkAuthFailed) throw new Error("maps js auth failed");
      if (!maps?.Map) throw new Error("Map unavailable");
      const map = new maps.Map(box, {
        center: { lat, lng },
        zoom,
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: true,
      });
      if (s.q && maps.Marker) new maps.Marker({ position: { lat, lng }, map, title: s.q });
      // A journey (map_embed's optional `path` field — the "show how we
      // traveled" view): numbered markers at every stop, a polyline
      // between them, and the viewport fitted to the whole route. Clients
      // that don't know the field render the same event as a plain
      // centered map (the sse-protocol forward-compat rule).
      const path = Array.isArray(s.path)
        ? s.path
            .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        : [];
      // The actual WALKING ROUTE (map_embed's optional `route` field): the
      // road-following path from Google Routes, drawn as a DOTTED green line
      // with a walking-time badge at its midpoint — so the reply shows BOTH
      // the straight stop-to-stop line (what/where) AND the real on-foot
      // route with its minutes (how long it takes to walk it), requested
      // 2026-07-14. Older clients ignore the field (forward-compat rule).
      const routePts =
        s.route && Array.isArray(s.route.polyline)
          ? s.route.polyline
              .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
              .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
          : [];
      if (path.length >= 2 && maps.Polyline) {
        new maps.Polyline({ path, map, strokeColor: "#2563eb", strokeOpacity: 0.9, strokeWeight: 4 });
        if (maps.Marker) {
          path.forEach((p, i) => {
            // Plain numbered pins. (Waypoints briefly rendered deck-image
            // MINIATURES here — removed by explicit decision 2026-07-10:
            // they cluttered the map. Clicking a pin still opens the deck
            // at that stop's image when one exists.)
            const m = new maps.Marker({ position: p, map, label: String((i + 1) % 10), title: `Stop ${i + 1}` });
            const deckIdx = nearestDeckIndex(p.lat, p.lng, 30);
            if (deckIdx >= 0) m.addListener("click", () => openDeck(deckIdx));
          });
        }
        if (routePts.length >= 2 && maps.SymbolPath) {
          // A dotted line = closely-spaced circle symbols on an invisible
          // polyline (the standard Maps JS idiom for dashed/dotted paths).
          const dot = {
            path: maps.SymbolPath.CIRCLE,
            fillColor: "#059669",
            fillOpacity: 1,
            strokeColor: "#059669",
            strokeOpacity: 1,
            scale: 2.6,
          };
          new maps.Polyline({
            path: routePts,
            map,
            clickable: false,
            strokeOpacity: 0,
            icons: [{ icon: dot, offset: "0", repeat: "14px" }],
            zIndex: 2,
          });
          // The walking-time number, ON the map, at the route's midpoint.
          const durS = Number(s.route.durationS);
          if (Number.isFinite(durS) && durS > 0 && maps.Marker && maps.Point) {
            const mins = Math.max(1, Math.round(durS / 60));
            const mid = routePts[Math.floor(routePts.length / 2)];
            new maps.Marker({
              position: mid,
              map,
              clickable: false,
              zIndex: 999,
              icon: walkTimeBadge(maps, `${mins} min walk`),
            });
          }
        }
        if (maps.LatLngBounds) {
          const bounds = new maps.LatLngBounds();
          path.forEach((p) => bounds.extend(p));
          routePts.forEach((p) => bounds.extend(p));
          map.fitBounds(bounds);
        }
      }
      // Track the CURRENT view on "idle" (fires once per settled pan/zoom).
      // Rounded (~1m / integer zoom) so re-asking about the same area hits
      // the server's capture cache instead of re-billing a Static fetch.
      const record = () => {
        if (locked) return;
        try {
          const c = map.getCenter();
          if (!c) return;
          currentMapView = {
            lat: Math.round(c.lat() * 1e5) / 1e5,
            lng: Math.round(c.lng() * 1e5) / 1e5,
            zoom: Math.round(Number(map.getZoom()) || zoom),
          };
        } catch {
          // view capture is best-effort — the map itself keeps working
        }
      };
      map.addListener("idle", record);
      record();
      label.textContent = `${baseLabel}; follow-up questions see your current view`;
      // Key rejected asynchronously (gm_authFailure) → swap for the iframe.
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
  // A server-provided title wins: the road-map fallback (no Street View
  // coverage at the resolved location) must not be headed "Street View".
  label.textContent = s.title || `Street View — ${s.query || "resolved location"}`;
  const strip = document.createElement("div");
  strip.className = "streetview-frames-strip";
  // Every frame joins the conversation-wide image deck (imagedeck.js) so a
  // click opens the enlarged slideshow at exactly this image; frames carry
  // lat/lng from the server (optional — older events just get no mini-map).
  const deckStart = addDeckEntries(
    frames.map((f) => ({
      url: f.url,
      caption: f.label || (f.dir ? `looking ${f.dir}` : "") || s.query || "",
      lat: f.lat,
      lng: f.lng,
      heading: f.heading,
      kind: f.kind,
    })),
  );
  frames.forEach((f, i) => {
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
    fig.classList.add("deck-openable");
    fig.title = "Click to enlarge";
    fig.addEventListener("click", () => openDeck(deckStart + i));
    strip.appendChild(fig);
  });
  wrap.append(label, strip);
  // Before the embed if one is already rendered, else before the stats footer.
  turn.el.insertBefore(wrap, turn._svEmbed || turn.stats);
  turn._svFrames = wrap;
}


// Shared by startGenericStep/startSearchStep: one in-progress step bar — a
// <details class="step"> with a spinner + label summary. Toggling stays
// blocked until `toggleGateClass` appears on the element (generic steps
// unlock via "expandable", search steps via "finished") — before that there
// is nothing inside to show.
// Rotates the balloon STYLE across the research step spinners so two waiting
// symbols side by side wear two different color schemes (same shape — the
// owner's call), just like the intro's fleet. A module-level counter — plain
// per-step increment is all the "adjacent ones differ" guarantee needs.
let stepSpinnerSeq = 0;

function makeStepDom(labelText, toggleGateClass, stepId = "") {
  const details = document.createElement("details");
  details.className = "step";
  const summary = document.createElement("summary");
  const spin = document.createElement("span");
  spin.className = "spin";
  const label = document.createElement("span");
  label.textContent = labelText;
  summary.append(spin, label);
  details.appendChild(summary);
  // Each in-progress step plays the intro in miniature, fixed in its slot;
  // best-effort, and stops itself when markFinished/settlePendingSteps removes
  // the `.spin` element. The SYMBOL is the step's CHANNEL (the per-task
  // grammar, docs/SYMBOL-LANGUAGE.md §6): an on-device step (stepIsLocal —
  // the in-browser sandbox) wears Se/cure's UMBRELLA even here on the blue
  // tier, folding into the tier's own BLUE ✓ (Se/rver goes to checkmarks
  // either way — it already assumes cloud); everything else wears the
  // BALLOON. The handle is kept so markFinished can play the finale.
  const spinner = stepIsLocal(stepId)
    ? mountUmbrellaSpinner(spin, { style: (stepSpinnerSeq++ * 3) % 6, size: 34, check: "blue" })
    : mountBalloonSpinner(spin, { style: stepSpinnerSeq++, size: 34 });
  details.addEventListener("click", (e) => {
    if (!details.classList.contains(toggleGateClass)) e.preventDefault();
  });
  return { details, summary, label, spinner };
}

/**
 * Generic pipeline steps (plan / gap check / synthesis / validation).
 * @param {object} turn  the turn object (turns.js addAssistantTurn)
 * @param {string} id    step id — step_done events resolve it by this key
 * @param {string} label initial label text (spinner shown beside it)
 */
export function startGenericStep(turn, id, label) {
  // Idempotent: a repeated step_start for the same (still-running) id updates
  // the label in place instead of appending a duplicate row — the server may
  // re-emit a step to tick a counter (e.g. the introspection tool loop's
  // header). A finished step with this id is left alone and a fresh one starts.
  const existing = turn.steps[id];
  if (existing && !existing.details.classList.contains("finished")) {
    existing.label.textContent = label;
    return;
  }
  const step = makeStepDom(label, "expandable", id);
  turn.activity.appendChild(step.details);
  turn.steps[id] = step;
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
//
// The swap is now the balloon spinner's COMPLETION FINALE: instead of the
// spinner vanishing and a ✓ popping in, the spinner speed-runs from wherever
// its boomerang is into the fully-colored BLUE-AND-GOLD balloon (the beat the
// loop deliberately never reaches) and folds that into the blue ✓. Only then do
// we drop the canvas and prepend the real .check (a beat-perfect handoff — same
// accent blue, app.css --check-blue).
// Fail-soft: a no-op mount (reduced-motion/no-canvas) fires the callback at
// once, so the ✓ still appears immediately.
function markFinished(step) {
  step.details.classList.add("finished");
  const spinEl = step.summary.querySelector(".spin");
  const addCheck = () => {
    if (!step.summary.querySelector(".check")) {
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = "✓";
      step.summary.prepend(check);
    }
    spinEl?.remove();
  };
  if (step.spinner?.finish) step.spinner.finish(addCheck);
  else addCheck();
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

// The bash-lite sandbox step: an expandable transcript of every command the
// agent ran in the in-browser Linux VM. Unlike finishGenericStep's one-line
// bullets, each command is shown IN FULL with its exit code and (clamped)
// output — the user asked to see exactly what executed inside the sandbox, not
// just "ran N commands". Dedicated renderer (mirroring finishSearchStep), fed
// the ShellRun[] transcript (public/js/bash-core.js) by stream.js.
/**
 * @param {object} turn
 * @param {Array<{command: string, exitCode: number, stdout: string, stderr: string}>} runs
 */
export function finishSandboxStep(turn, runs) {
  const step = turn.steps.sandbox;
  if (!step) return;
  markFinished(step);
  const list = Array.isArray(runs) ? runs.filter((r) => r && r.command) : [];
  step.label.textContent =
    "Ran " + list.length + " command" + (list.length === 1 ? "" : "s") + " in the Linux sandbox";
  if (!list.length) return;
  step.details.classList.add("expandable");
  const wrap = document.createElement("div");
  wrap.className = "shell-runs";
  for (const run of list) wrap.appendChild(renderShellRun(run));
  step.details.appendChild(wrap);
}

// One command row inside the expanded sandbox step: the full command line, an
// exit-code badge (only when non-zero), and the output in a monospace block.
// textContent throughout — command and output are untrusted, never HTML.
function renderShellRun(run) {
  const row = document.createElement("div");
  row.className = "shell-run";
  const cmd = document.createElement("div");
  cmd.className = "shell-cmd";
  const prompt = document.createElement("span");
  prompt.className = "shell-prompt";
  prompt.textContent = "$";
  const text = document.createElement("span");
  text.className = "shell-cmd-text";
  text.textContent = String(run.command || "");
  cmd.append(prompt, text);
  const exit = Number.isFinite(Number(run.exitCode)) ? Math.trunc(Number(run.exitCode)) : 1;
  if (exit !== 0) {
    const badge = document.createElement("span");
    badge.className = "shell-exit";
    badge.textContent = "exit " + exit;
    cmd.appendChild(badge);
  }
  const out = document.createElement("pre");
  out.className = "shell-out";
  out.textContent = shellRunOutputText(run);
  row.append(cmd, out);
  return row;
}

// "Searching the web: …" with a spinner.
//
// Searches within one round run concurrently server-side (src/pipeline.js),
// so several search_start events can arrive before any search_done — keyed
// by query text (pipeline.js already dedupes queries within a round, so
// this is always a unique key) rather than assuming strict start/done
// pairing.
export function startSearchStep(turn, info) {
  const query = info.query || "";
  // Toggle gate "finished": blocked while running (no sources to show yet).
  const step = makeStepDom(searchServiceName(info) + ": “" + query + "”", "finished");
  turn.activity.appendChild(step.details);
  // Keyed by provider + query: the same query text may legitimately run on
  // both the web and an auxiliary source in one round.
  (turn.pendingSearchSteps ||= new Map()).set((info.source || "web") + "|" + query, step);
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

// Stats footer from the `done` event (model, duration, tokens). The line text
// is built by the pure formatStatsLine (activity-core.js).
export function renderStats(turn, s) {
  turn.searchCount = s.searches || 0;
  turn.stats.textContent = formatStatsLine(s);
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
    step.spinner?.stop?.(); // neutral settle: no colored-balloon finale here
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

// The SPACE-ANIMATIONS domain's shared pure core (Node-tested, import-free).
// One module owns everything deterministic about the archive of playable
// wireframe space animations at /space/: the scene registry (each entry is
// one "animation skill" — a common space question paired with a factual
// reply and an animation spec), the EN+SV question matcher (invariant 6:
// Swedish forms carried with the same breadth as English, diacritic-typo
// tolerant), the logarithmic zoom mathematics that lets one slider span
// planet radii to light-years, the wireframe mesh builders (sphere, rocket,
// satellite, astronaut, terrain, rings — everything except background stars
// renders as unlit 3D wireframe), and the feedback-body validator the
// server endpoint (src/space.js, the façade) shares with the page.
//
// Lives under public/js/ for the same reason bash-core.js does: the browser
// can only import served modules, while the Worker bundler can import from
// anywhere — so the one implementation sits here and src/space.js re-exports.

// ---------------------------------------------------------------------------
// Astronomical constants and bodies (mean values, km / days).

export const AU_KM = 149597870.7;
export const LIGHT_YEAR_KM = 9.4607e12;

// radiusKm: volumetric mean radius. orbitKm: mean distance to the body it
// orbits. periodDays: sidereal orbital period. hue: the wireframe stroke hue
// (degrees) the renderer uses — a hint, not a light.
export const BODIES = {
  sun: { name: "Sun", nameSv: "Solen", radiusKm: 696340, orbitKm: 0, periodDays: 0, hue: 45 },
  mercury: { name: "Mercury", nameSv: "Merkurius", radiusKm: 2440, orbitKm: 57.9e6, periodDays: 88, hue: 30 },
  venus: { name: "Venus", nameSv: "Venus", radiusKm: 6052, orbitKm: 108.2e6, periodDays: 224.7, hue: 55 },
  earth: { name: "Earth", nameSv: "Jorden", radiusKm: 6371, orbitKm: 149.6e6, periodDays: 365.25, hue: 205 },
  moon: { name: "Moon", nameSv: "Månen", radiusKm: 1737, orbitKm: 384400, periodDays: 27.32, hue: 0 },
  mars: { name: "Mars", nameSv: "Mars", radiusKm: 3390, orbitKm: 227.9e6, periodDays: 687, hue: 15 },
  jupiter: { name: "Jupiter", nameSv: "Jupiter", radiusKm: 69911, orbitKm: 778.5e6, periodDays: 4333, hue: 35 },
  saturn: { name: "Saturn", nameSv: "Saturnus", radiusKm: 58232, orbitKm: 1432e6, periodDays: 10759, hue: 48 },
  uranus: { name: "Uranus", nameSv: "Uranus", radiusKm: 25362, orbitKm: 2867e6, periodDays: 30687, hue: 180 },
  neptune: { name: "Neptune", nameSv: "Neptunus", radiusKm: 24622, orbitKm: 4515e6, periodDays: 60190, hue: 220 },
};

// ---------------------------------------------------------------------------
// The scene registry — the archive. Each entry is one "animation skill": a
// common space question (EN + SV), the factual reply the gallery shows next
// to the animation, and the spec the renderer builds the scene from. The
// camera-distance range is what "varying zoom" means concretely: a log-scale
// slider between zoomKm.min and zoomKm.max, so the same scene absorbs a
// five-orders-of-magnitude difference between a moon and a star.

export const SPACE_SCENES = [
  {
    id: "sun-vs-planets",
    kind: "compare",
    emoji: "☀️",
    title: { en: "The Sun next to its planets", sv: "Solen bredvid sina planeter" },
    question: { en: "How big is the Sun compared to Earth?", sv: "Hur stor är solen jämfört med jorden?" },
    reply: {
      en: "The Sun's radius is about 696,000 km — 109 times Earth's. Around 1.3 million Earths would fit inside its volume. Jupiter, the largest planet, is still only a tenth of the Sun's diameter, and the Moon next to them is a dot. Drag to rotate and zoom out until the Sun fits in view: every body is drawn to true relative scale.",
      sv: "Solens radie är ungefär 696 000 km — 109 gånger jordens. Cirka 1,3 miljoner jordklot skulle rymmas i dess volym. Jupiter, den största planeten, är ändå bara en tiondel av solens diameter, och månen bredvid dem är en prick. Dra för att rotera och zooma ut tills solen får plats i bild: alla kroppar ritas i sann relativ skala.",
    },
    zoomKm: { min: 25000, max: 4200000, start: 2000000 },
    config: { bodies: ["sun", "jupiter", "earth", "moon"], gapFactor: 0.35 },
  },
  {
    id: "earth-moon",
    kind: "orbits",
    emoji: "🌍",
    title: { en: "Earth and Moon, to scale", sv: "Jorden och månen i skala" },
    question: { en: "How far away is the Moon?", sv: "Hur långt bort är månen?" },
    reply: {
      en: "On average 384,400 km — about thirty Earth diameters. Light covers the gap in 1.3 seconds; the Apollo crews needed three days. The Moon completes one orbit every 27.3 days. Zoom in on either body, then zoom out until the whole orbit fits: the empty space between them is the point of this animation.",
      sv: "I genomsnitt 384 400 km — ungefär trettio jorddiametrar. Ljuset korsar avståndet på 1,3 sekunder; Apollobesättningarna behövde tre dagar. Månen fullbordar ett varv på 27,3 dygn. Zooma in på någon av kropparna och zooma sedan ut tills hela banan får plats: tomrummet mellan dem är poängen med den här animationen.",
    },
    zoomKm: { min: 9000, max: 1300000, start: 1000000 },
    config: {
      center: "earth",
      orbiters: [{ body: "moon", orbitKm: 384400, periodDays: 27.32 }],
    },
  },
  {
    id: "solar-system",
    kind: "orbits",
    emoji: "🪐",
    title: { en: "The Solar System in motion", sv: "Solsystemet i rörelse" },
    question: { en: "What does the Solar System look like?", sv: "Hur ser solsystemet ut?" },
    reply: {
      en: "Eight planets orbit the Sun, from Mercury at 58 million km to Neptune at 4.5 billion km — thirty times Earth's distance. The inner four are rocky and close together; the outer giants are spread across enormous gaps. Orbits here are to scale, which is why you must zoom out a hundredfold to go from Mercury's orbit to Neptune's.",
      sv: "Åtta planeter kretsar kring solen, från Merkurius på 58 miljoner km till Neptunus på 4,5 miljarder km — trettio gånger jordens avstånd. De fyra inre är steniga och ligger tätt; de yttre jättarna är utspridda över enorma avstånd. Banorna är skalenliga, och därför måste du zooma ut hundrafalt för att gå från Merkurius bana till Neptunus.",
    },
    zoomKm: { min: 3.5e8, max: 1.4e10, start: 1.1e9 },
    config: {
      center: "sun",
      orbiters: [
        { body: "mercury" }, { body: "venus" }, { body: "earth" }, { body: "mars" },
        { body: "jupiter" }, { body: "saturn" }, { body: "uranus" }, { body: "neptune" },
      ],
    },
  },
  {
    id: "iss-orbit",
    kind: "orbits",
    emoji: "🛰️",
    title: { en: "The ISS skimming Earth", sv: "ISS tätt över jorden" },
    question: { en: "How high above Earth does the ISS fly?", sv: "Hur högt över jorden flyger rymdstationen ISS?" },
    reply: {
      en: "Only about 400 km up — next to Earth's 6,371 km radius, the station skims the surface. It moves at 7.7 km/s and completes an orbit every 93 minutes, sixteen sunrises a day, inclined 51.6° to the equator. The station itself is 109 m long — truly to scale it would be invisible here, so the wireframe satellite is drawn enlarged; the orbit's altitude is exact.",
      sv: "Bara cirka 400 km upp — bredvid jordens radie på 6 371 km snuddar stationen vid ytan. Den färdas i 7,7 km/s och fullbordar ett varv på 93 minuter, sexton soluppgångar per dygn, med 51,6° lutning mot ekvatorn. Själva stationen är 109 m lång — i sann skala vore den osynlig här, så trådmodellen ritas förstorad; banans höjd är exakt.",
    },
    zoomKm: { min: 7500, max: 120000, start: 21000 },
    config: {
      center: "earth",
      orbiters: [{ body: "iss", mesh: "satellite", orbitKm: 6771, periodDays: 0.0645, inclinationDeg: 51.6, displayKm: 700, name: "ISS", nameSv: "ISS" }],
    },
  },
  {
    id: "satellites",
    kind: "orbits",
    emoji: "📡",
    title: { en: "Satellite shells around Earth", sv: "Satellitskal runt jorden" },
    question: { en: "How many satellites orbit Earth?", sv: "Hur många satelliter kretsar runt jorden?" },
    reply: {
      en: "More than ten thousand active satellites, and most of them fly in low Earth orbit below 2,000 km — communication constellations, imaging and science. Higher up, near 20,200 km, the GPS constellation circles twice a day, and at exactly 35,786 km geostationary satellites match Earth's rotation and hang still over one spot. The three shells here are at true altitudes; the satellites are enlarged to stay visible.",
      sv: "Mer än tiotusen aktiva satelliter, och de flesta flyger i låg omloppsbana under 2 000 km — kommunikationskonstellationer, jordobservation och forskning. Högre upp, kring 20 200 km, kretsar GPS-konstellationen två varv per dygn, och på exakt 35 786 km följer geostationära satelliter jordens rotation och hänger stilla över en punkt. De tre skalen ritas på sanna höjder; satelliterna är förstorade för att synas.",
    },
    zoomKm: { min: 9000, max: 260000, start: 110000 },
    config: {
      center: "earth",
      orbiters: [
        { mesh: "satellite", orbitKm: 6921, periodDays: 0.066, inclinationDeg: 53, count: 8, displayKm: 500, name: "LEO", nameSv: "LEO" },
        { mesh: "satellite", orbitKm: 26560, periodDays: 0.499, inclinationDeg: 55, count: 6, displayKm: 1100, name: "GPS", nameSv: "GPS" },
        { mesh: "satellite", orbitKm: 42164, periodDays: 0.997, inclinationDeg: 0, count: 4, displayKm: 1600, name: "GEO", nameSv: "GEO" },
      ],
    },
  },
  {
    id: "rocket-launch",
    kind: "launch",
    emoji: "🚀",
    title: { en: "A rocket's road to orbit", sv: "En rakets väg till omloppsbana" },
    question: { en: "How does a rocket reach orbit?", sv: "Hur når en raket omloppsbana?" },
    reply: {
      en: "Orbit is less about going up than going sideways: at 400 km you must move at 7.7 km/s horizontally, or you fall back. So a rocket climbs vertically only briefly, then pitches over into a gravity turn, trading altitude gain for horizontal speed. Partway up, the empty first stage separates and falls away while the upper stage keeps accelerating until its path curves all the way around the planet — that closed path is the orbit.",
      sv: "Omloppsbana handlar mindre om att åka uppåt än om att åka i sidled: på 400 km höjd måste du färdas 7,7 km/s horisontellt, annars faller du tillbaka. Därför stiger en raket bara kort rakt upp, sedan lutar den över i en gravitationssväng och växlar stigning mot horisontell fart. En bit upp separerar det tomma första steget och faller bort medan övre steget fortsätter accelerera tills banan kröker sig hela vägen runt planeten — den slutna banan är omloppsbanan.",
    },
    zoomKm: { min: 40, max: 60000, start: 1400 },
    config: { planet: "earth", orbitAltKm: 400, stageT: 0.38, insertT: 0.72 },
  },
  {
    id: "moon-surface",
    kind: "surface",
    emoji: "🌙",
    title: { en: "Standing on the Moon", sv: "Att stå på månen" },
    question: { en: "What does it look like on the Moon's surface?", sv: "Hur ser det ut på månens yta?" },
    reply: {
      en: "A dry, silent desert of gray regolith dust, cratered by four billion years of impacts, under a permanently black sky — no atmosphere means no blue, even at noon. Gravity is one sixth of Earth's, which is why the Apollo astronauts bounced rather than walked. Earth hangs in the sky nearly four times larger than the Moon appears from home.",
      sv: "En torr, tyst öken av grått regolitdamm, kraterärrad av fyra miljarder års nedslag, under en ständigt svart himmel — utan atmosfär finns inget blått, inte ens mitt på dagen. Gravitationen är en sjättedel av jordens, och därför studsade Apolloastronauterna snarare än gick. Jorden hänger på himlen nästan fyra gånger större än månen ser ut hemifrån.",
    },
    zoomKm: { min: 0.012, max: 2.5, start: 0.06 },
    config: { terrainKm: 1.6, astronaut: true, lander: true },
  },
  {
    id: "saturn-rings",
    kind: "rings",
    emoji: "💫",
    title: { en: "Saturn and its rings", sv: "Saturnus och dess ringar" },
    question: { en: "What are Saturn's rings made of?", sv: "Vad består Saturnus ringar av?" },
    reply: {
      en: "Billions of chunks of nearly pure water ice, from dust grains to house-sized boulders, each on its own orbit — the inner edge circles faster than the outer, as Kepler demands. The main rings span from about 74,500 to 140,000 km from Saturn's center, yet are typically only tens of meters thick: proportionally thinner than a sheet of paper. The particles here move at their true relative speeds.",
      sv: "Miljarder stycken av nästan ren vattenis, från dammkorn till block stora som hus, vart och ett i sin egen bana — innerkanten kretsar snabbare än ytterkanten, precis som Kepler kräver. Huvudringarna sträcker sig från cirka 74 500 till 140 000 km från Saturnus centrum men är oftast bara tiotals meter tjocka: proportionellt tunnare än ett pappersark. Partiklarna här rör sig med sina sanna relativa hastigheter.",
    },
    zoomKm: { min: 70000, max: 1200000, start: 320000 },
    config: { body: "saturn", ringInnerKm: 74500, ringOuterKm: 140220, tiltDeg: 26.7, particles: 260 },
  },
  {
    id: "nearest-star",
    kind: "travel",
    emoji: "✨",
    title: { en: "The gulf to the nearest star", sv: "Avgrunden till närmaste stjärnan" },
    question: { en: "How far away is the nearest star?", sv: "Hur långt bort är den närmaste stjärnan?" },
    reply: {
      en: "Proxima Centauri lies 4.25 light-years away — about 268,000 times the Earth–Sun distance. Light itself needs four years and three months; Voyager 1, our fastest outbound craft, would need over 70,000 years. Start zoomed in on the Solar System, then zoom out and watch it shrink to nothing long before the neighboring star arrives: this is why interstellar distances are measured in years of light.",
      sv: "Proxima Centauri ligger 4,25 ljusår bort — ungefär 268 000 gånger avståndet mellan jorden och solen. Ljuset självt behöver fyra år och tre månader; Voyager 1, vår snabbaste utåtgående farkost, skulle behöva över 70 000 år. Börja inzoomad på solsystemet, zooma sedan ut och se det krympa till ingenting långt innan grannstjärnan dyker upp: därför mäts interstellära avstånd i ljusår.",
    },
    zoomKm: { min: 8e8, max: 9.5e13, start: 3e9 },
    config: { starDistanceLy: 4.246, starName: "Proxima Centauri" },
  },
];

/**
 * Looks a scene up by id. Returns null for anything unknown.
 */
export function sceneById(id) {
  if (typeof id !== "string") return null;
  return SPACE_SCENES.find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------------------
// The deterministic question matcher (EN + SV, invariant 6). Swedish patterns
// carry the same breadth as English — definite forms, synonyms — and accept
// the diacritic-dropped typing Swedes produce on foreign keyboards (månen /
// manen) via [åa]-style classes. First match wins; the order below is the
// spec. Matching is against a lowercased, whitespace-collapsed copy.

export const SPACE_MATCHERS = [
  {
    id: "earth-moon",
    en: [
      /how far( away)? is (the )?moon/,
      /how far is it to the moon/,
      /distance (to|from (the )?earth to) the moon/,
      /moon distance/,
    ],
    sv: [
      /hur l[åa]ngt (bort|borta) [äa]r m[åa]nen/,
      /hur l[åa]ngt [äa]r det till m[åa]nen/,
      /avst[åa]nd(et)? till m[åa]nen/,
      /m[åa]nens avst[åa]nd/,
    ],
  },
  {
    id: "sun-vs-planets",
    en: [
      /how (big|large) is the sun/,
      /(the )?size of the sun/,
      /sun compared (to|with) (the )?(earth|planets)/,
      /how many earths (would |could )?fit (in|inside) the sun/,
    ],
    sv: [
      /hur stor [äa]r solen/,
      /solens storlek/,
      /solen j[äa]mf[öo]rt med (jorden|planeterna)/,
      /hur m[åa]nga jordklot (f[åa]r plats|ryms) i solen/,
    ],
  },
  {
    id: "iss-orbit",
    en: [
      /how (high|fast) .*\b(iss|space station)/,
      /\b(iss|space station)\b.* (altitude|orbit|height)/,
      /where is the (iss|space station)/,
    ],
    sv: [
      /hur (h[öo]gt|snabbt) .*\b(iss|rymdstationen)/,
      /\b(iss|rymdstationen)\b.* (h[öo]jd|omloppsbana|bana)/,
      /var [äa]r (iss|rymdstationen)/,
    ],
  },
  {
    id: "satellites",
    en: [
      /how many satellites/,
      /satellites (orbit(ing)?|around|circling) (the )?earth/,
      /gps satellites/,
      /geostationary/,
    ],
    sv: [
      /hur m[åa]nga satelliter/,
      /satelliter (kretsar|runt|kring|cirklar) (runt |kring )?jorden/,
      /gps-?satelliter/,
      /geostation[äa]r/,
    ],
  },
  {
    id: "rocket-launch",
    en: [
      /how do(es)? (a )?rockets? (reach|get (in)?to|fly to|make it to) (orbit|space)/,
      /how do(es)? (a )?rockets? work/,
      /rocket launch/,
      /reach(ing)? orbit/,
    ],
    sv: [
      /hur n[åa]r en raket (omloppsbana|rymden)/,
      /hur fungerar (en )?raket(er)?/,
      /raketuppskjutning(en)?/,
      /hur kommer (en )?raket(er)? (ut )?i (rymden|omloppsbana)/,
      /n[åa] omloppsbana/,
    ],
  },
  {
    id: "moon-surface",
    en: [
      /(what does|how does) .*moon('s)? surface/,
      /(the )?surface of the moon/,
      /walk(ing)? on the moon/,
      /moon landing/,
      /standing on the moon/,
    ],
    sv: [
      /m[åa]nens yta/,
      /hur ser det ut p[åa] m[åa]nen/,
      /g[åa] p[åa] m[åa]nen/,
      /m[åa]nlandning(en)?/,
      /st[åa] p[åa] m[åa]nen/,
    ],
  },
  {
    id: "saturn-rings",
    en: [
      /saturn'?s? rings?/,
      /rings? (of|around) saturn/,
      /what are saturn'?s? rings? made of/,
    ],
    sv: [
      /saturnus ringar/,
      /ringar(na)? (runt|kring) saturnus/,
      /vad best[åa]r saturnus ringar av/,
    ],
  },
  {
    id: "nearest-star",
    en: [
      /how far .*\b(nearest|closest) star/,
      /distance to (the )?(nearest|closest) star/,
      /proxima centauri/,
      /alpha centauri/,
    ],
    sv: [
      /hur l[åa]ngt .*\b(n[äa]rmaste|n[äa]rmsta) stj[äa]rnan/,
      /avst[åa]nd(et)? till (den )?(n[äa]rmaste|n[äa]rmsta) stj[äa]rnan/,
      /proxima centauri/,
      /alfa centauri/,
    ],
  },
  {
    id: "solar-system",
    en: [
      /what does (the )?solar system look like/,
      /how (big|large) is the solar system/,
      /show (me )?the solar system/,
      /planets orbit(ing)? the sun/,
      /\bthe solar system\b/,
    ],
    sv: [
      /hur ser solsystemet ut/,
      /hur stort [äa]r solsystemet/,
      /visa (mig )?solsystemet/,
      /planeter(na)?s? (kretsar|banor|bana) (runt|kring) solen/,
      /\bsolsystemet\b/,
    ],
  },
];

/**
 * Deterministic EN+SV gate: does this question have a tailored animation?
 * Returns the scene id or null. Pure and never throws.
 */
export function spaceIntent(text) {
  if (typeof text !== "string" || !text) return null;
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const m of SPACE_MATCHERS) {
    for (const re of m.en) if (re.test(t)) return m.id;
    for (const re of m.sv) if (re.test(t)) return m.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zoom mathematics. The camera distance interpolates LOGARITHMICALLY between
// a scene's min and max — the only interpolation that makes a single slider
// usable across the size gulf between a moon (1,700 km) and a light-year
// (9.5 trillion km).

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Slider position t (0..1) → camera distance in km, log-interpolated. */
export function zoomToDistance(t, minKm, maxKm) {
  const tt = clamp(Number(t) || 0, 0, 1);
  return minKm * Math.pow(maxKm / minKm, tt);
}

/** Camera distance in km → slider position t (0..1). Inverse of the above. */
export function distanceToZoom(distKm, minKm, maxKm) {
  const d = clamp(Number(distKm) || minKm, minKm, maxKm);
  return Math.log(d / minKm) / Math.log(maxKm / minKm);
}

/**
 * Human-readable distance readout, unit chosen by magnitude and language-
 * neutral (km / Mkm / AU / ly), so one string serves both EN and SV copy.
 */
export function formatKm(km) {
  const v = Math.abs(Number(km) || 0);
  if (v < 1e6) {
    const n = Math.round(v);
    return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} km`;
  }
  if (v < AU_KM * 0.5) return `${(v / 1e6).toFixed(1)} Mkm`;
  if (v < LIGHT_YEAR_KM * 0.05) return `${(v / AU_KM).toFixed(2)} AU`;
  return `${(v / LIGHT_YEAR_KM).toFixed(2)} ly`;
}

// ---------------------------------------------------------------------------
// 3D primitives. Meshes are { verts: [[x,y,z],…], edges: [[i,j],…] } in km,
// y up, centered on the origin unless stated. All builders are pure and
// deterministic (terrain takes an explicit seed), so tests can pin them.

export function rotX(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

export function rotY(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotZ(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

/**
 * Perspective projection of a (rotated) scene point onto the canvas. The
 * camera sits on +z at cam.dist km looking at the origin; cam.f is the focal
 * length in px, cam.cx/cy the canvas center. Returns null when the point is
 * behind the near plane. `s` is the px-per-km scale at the point's depth —
 * multiply a radius in km by it to get screen px.
 */
export function projectPoint(p, cam) {
  const pz = cam.dist - p[2];
  if (pz <= cam.dist * 1e-4) return null;
  const k = cam.f / pz;
  return { x: cam.cx + p[0] * k, y: cam.cy - p[1] * k, s: k };
}

/** Deterministic 32-bit PRNG (mulberry32) — seeds the terrain and stars. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A lat/long wireframe sphere: `rings` horizontal circles (poles excluded),
 * `meridians` vertical arcs, `segs` points per circle. segs is rounded up to
 * a multiple of meridians so meridian columns land on ring vertices.
 */
export function sphereMesh(r, rings = 7, meridians = 12, segs = 24) {
  const step = Math.max(1, Math.round(segs / meridians));
  const n = step * meridians;
  const verts = [];
  const edges = [];
  for (let i = 1; i <= rings; i++) {
    const phi = (Math.PI * i) / (rings + 1);
    const y = r * Math.cos(phi);
    const rr = r * Math.sin(phi);
    const base = verts.length;
    for (let j = 0; j < n; j++) {
      const th = (2 * Math.PI * j) / n;
      verts.push([rr * Math.cos(th), y, rr * Math.sin(th)]);
    }
    for (let j = 0; j < n; j++) edges.push([base + j, base + ((j + 1) % n)]);
  }
  const top = verts.length;
  verts.push([0, r, 0]);
  const bottom = verts.length;
  verts.push([0, -r, 0]);
  for (let m = 0; m < meridians; m++) {
    const col = m * step;
    edges.push([top, col]);
    for (let i = 0; i < rings - 1; i++) edges.push([i * n + col, (i + 1) * n + col]);
    edges.push([(rings - 1) * n + col, bottom]);
  }
  return { verts, edges };
}

/** A circle of radius r in the xz plane — an orbit path. */
export function orbitMesh(r, segs = 96) {
  const verts = [];
  const edges = [];
  for (let j = 0; j < segs; j++) {
    const th = (2 * Math.PI * j) / segs;
    verts.push([r * Math.cos(th), 0, r * Math.sin(th)]);
    edges.push([j, (j + 1) % segs]);
  }
  return { verts, edges };
}

/** An open-ended wireframe cylinder along y, base at y=0. */
export function cylinderMesh(r, h, segs = 8) {
  const verts = [];
  const edges = [];
  for (let ring = 0; ring < 2; ring++) {
    const y = ring * h;
    const base = verts.length;
    for (let j = 0; j < segs; j++) {
      const th = (2 * Math.PI * j) / segs;
      verts.push([r * Math.cos(th), y, r * Math.sin(th)]);
    }
    for (let j = 0; j < segs; j++) edges.push([base + j, base + ((j + 1) % segs)]);
  }
  for (let j = 0; j < segs; j++) edges.push([j, segs + j]);
  return { verts, edges };
}

function pushMesh(into, mesh, offset = [0, 0, 0]) {
  const base = into.verts.length;
  for (const v of mesh.verts) into.verts.push([v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]]);
  for (const e of mesh.edges) into.edges.push([base + e[0], base + e[1]]);
}

function cuboid(w, h, d, cy = 0) {
  const x = w / 2, z = d / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return {
    verts: [
      [-x, y0, -z], [x, y0, -z], [x, y0, z], [-x, y0, z],
      [-x, y1, -z], [x, y1, -z], [x, y1, z], [-x, y1, z],
    ],
    edges: [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ],
  };
}

/**
 * A wireframe rocket pointing +y, base at y=0, total height h: engine bell,
 * cylindrical body, nose cone, four fins.
 */
export function rocketMesh(h) {
  const r = h * 0.09;
  const out = { verts: [], edges: [] };
  // Body: two rings + verticals.
  pushMesh(out, cylinderMesh(r, h * 0.62, 8));
  // Nose cone: top body ring to the tip.
  const tip = out.verts.length;
  out.verts.push([0, h, 0]);
  for (let j = 0; j < 8; j++) out.edges.push([8 + j, tip]);
  // Engine bell: a smaller ring below the base, flared.
  const bellBase = out.verts.length;
  for (let j = 0; j < 8; j++) {
    const th = (2 * Math.PI * j) / 8;
    out.verts.push([r * 0.7 * Math.cos(th), -h * 0.06, r * 0.7 * Math.sin(th)]);
  }
  for (let j = 0; j < 8; j++) {
    out.edges.push([bellBase + j, bellBase + ((j + 1) % 8)]);
    out.edges.push([j, bellBase + j]);
  }
  // Four fins: triangles in radial planes.
  for (let k = 0; k < 4; k++) {
    const th = (Math.PI / 2) * k + Math.PI / 8;
    const ux = Math.cos(th), uz = Math.sin(th);
    const a = out.verts.length;
    out.verts.push([ux * r, h * 0.22, uz * r]);
    out.verts.push([ux * r * 2.4, -h * 0.04, uz * r * 2.4]);
    out.verts.push([ux * r, h * 0.01, uz * r]);
    out.edges.push([a, a + 1], [a + 1, a + 2], [a + 2, a]);
  }
  return out;
}

/**
 * A wireframe satellite: cuboid bus, two panelled solar wings along ±x, an
 * antenna mast with a small dish ring on +y. `s` is the wingspan.
 */
export function satelliteMesh(s) {
  const out = { verts: [], edges: [] };
  const bw = s * 0.18;
  pushMesh(out, cuboid(bw, bw * 1.2, bw));
  for (const dir of [1, -1]) {
    const x0 = dir * bw * 0.5, x1 = dir * s * 0.5;
    const zh = bw * 0.55;
    const a = out.verts.length;
    out.verts.push([x0, zh, 0], [x1, zh, 0], [x1, -zh, 0], [x0, -zh, 0]);
    out.edges.push([a, a + 1], [a + 1, a + 2], [a + 2, a + 3], [a + 3, a]);
    // Panel cross-lines.
    for (let i = 1; i <= 2; i++) {
      const x = x0 + ((x1 - x0) * i) / 3;
      const b = out.verts.length;
      out.verts.push([x, zh, 0], [x, -zh, 0]);
      out.edges.push([b, b + 1]);
    }
  }
  // Antenna mast + dish ring.
  const mast = out.verts.length;
  out.verts.push([0, bw * 0.6, 0], [0, bw * 1.4, 0]);
  out.edges.push([mast, mast + 1]);
  const dish = out.verts.length;
  const dr = bw * 0.5;
  for (let j = 0; j < 8; j++) {
    const th = (2 * Math.PI * j) / 8;
    out.verts.push([dr * Math.cos(th), bw * 1.4, dr * Math.sin(th)]);
  }
  for (let j = 0; j < 8; j++) out.edges.push([dish + j, dish + ((j + 1) % 8)]);
  return out;
}

/**
 * A stylized wireframe astronaut, feet at y=0, height s: two crossed head
 * rings (the helmet), a torso box with backpack, jointed arms and legs.
 */
export function astronautMesh(s) {
  const out = { verts: [], edges: [] };
  // Torso + backpack.
  pushMesh(out, cuboid(s * 0.3, s * 0.35, s * 0.18, s * 0.625));
  pushMesh(out, cuboid(s * 0.22, s * 0.28, s * 0.1, s * 0.66), [0, 0, -s * 0.16]);
  // Helmet: two crossed rings around the head center.
  const hc = s * 0.9, hr = s * 0.11;
  for (const plane of [0, 1]) {
    const base = out.verts.length;
    for (let j = 0; j < 10; j++) {
      const th = (2 * Math.PI * j) / 10;
      const a = hr * Math.cos(th), b = hr * Math.sin(th);
      out.verts.push(plane === 0 ? [a, hc + b, 0] : [0, hc + b, a]);
    }
    for (let j = 0; j < 10; j++) out.edges.push([base + j, base + ((j + 1) % 10)]);
  }
  // Neck.
  const neck = out.verts.length;
  out.verts.push([0, s * 0.8, 0], [0, hc - hr, 0]);
  out.edges.push([neck, neck + 1]);
  // Arms and legs: two-segment limbs.
  const limb = (pts) => {
    const a = out.verts.length;
    for (const p of pts) out.verts.push(p);
    for (let i = 0; i < pts.length - 1; i++) out.edges.push([a + i, a + i + 1]);
  };
  for (const d of [1, -1]) {
    limb([[d * s * 0.17, s * 0.77, 0], [d * s * 0.26, s * 0.6, s * 0.03], [d * s * 0.22, s * 0.44, s * 0.1]]);
    limb([[d * s * 0.08, s * 0.45, 0], [d * s * 0.11, s * 0.22, -s * 0.02], [d * s * 0.13, 0, s * 0.06]]);
  }
  return out;
}

/**
 * A wireframe lunar-lander: octagonal cabin on four splayed legs with pads.
 */
export function landerMesh(s) {
  const out = { verts: [], edges: [] };
  const cabinR = s * 0.32, cabinY = s * 0.45;
  const base = out.verts.length;
  for (let ring = 0; ring < 2; ring++) {
    const y = cabinY + ring * s * 0.3;
    for (let j = 0; j < 8; j++) {
      const th = (2 * Math.PI * j) / 8;
      out.verts.push([cabinR * Math.cos(th), y, cabinR * Math.sin(th)]);
    }
  }
  for (let j = 0; j < 8; j++) {
    out.edges.push([base + j, base + ((j + 1) % 8)]);
    out.edges.push([base + 8 + j, base + 8 + ((j + 1) % 8)]);
    out.edges.push([base + j, base + 8 + j]);
  }
  for (let k = 0; k < 4; k++) {
    const th = (Math.PI / 2) * k + Math.PI / 4;
    const ux = Math.cos(th), uz = Math.sin(th);
    const a = out.verts.length;
    out.verts.push([ux * cabinR * 0.9, cabinY, uz * cabinR * 0.9]);
    out.verts.push([ux * s * 0.55, 0, uz * s * 0.55]);
    out.verts.push([ux * s * 0.62, 0, uz * s * 0.62]);
    out.edges.push([a, a + 1], [a + 1, a + 2]);
  }
  return out;
}

/**
 * A cratered terrain grid (the moon surface): n×n vertices spanning size km,
 * heights from seeded two-octave value noise minus a few crater bowls with
 * raised rims. Deterministic for a given seed.
 */
export function terrainMesh(size, n = 40, seed = 7, amp = 0.035) {
  const rnd = mulberry32(seed);
  const g = 7;
  const grid = [];
  for (let i = 0; i <= g; i++) {
    grid.push([]);
    for (let j = 0; j <= g; j++) grid[i].push(rnd());
  }
  const noise = (u, v) => {
    const x = u * g, y = v * g;
    const i = Math.min(g - 1, Math.floor(x)), j = Math.min(g - 1, Math.floor(y));
    const fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = grid[i][j] * (1 - sx) + grid[i + 1][j] * sx;
    const b = grid[i][j + 1] * (1 - sx) + grid[i + 1][j + 1] * sx;
    return a * (1 - sy) + b * sy;
  };
  const craters = [];
  for (let c = 0; c < 6; c++) {
    craters.push({ u: rnd(), v: rnd(), r: 0.05 + rnd() * 0.12, d: 0.3 + rnd() * 0.7 });
  }
  const ampKm = size * amp;
  const verts = [];
  const edges = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const u = i / n, v = j / n;
      let h = (noise(u, v) * 0.7 + noise(u * 2 > 1 ? u * 2 - 1 : u * 2, v * 2 > 1 ? v * 2 - 1 : v * 2) * 0.3 - 0.5) * ampKm;
      for (const cr of craters) {
        const du = u - cr.u, dv = v - cr.v;
        const dist = Math.sqrt(du * du + dv * dv) / cr.r;
        if (dist < 1) {
          const bowl = (1 - dist * dist);
          h -= cr.d * ampKm * bowl * bowl;
        } else if (dist < 1.4) {
          h += cr.d * ampKm * 0.25 * (1.4 - dist) / 0.4;
        }
      }
      verts.push([(u - 0.5) * size, h, (v - 0.5) * size]);
    }
  }
  const idx = (i, j) => i * (n + 1) + j;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      edges.push([idx(i, j), idx(i, j + 1)]);
      edges.push([idx(j, i), idx(j + 1, i)]);
    }
  }
  return { verts, edges };
}

/**
 * Planetary rings in the xz plane: `count` concentric circles between rIn
 * and rOut. Particles are the renderer's job (they move); this is the frame.
 */
export function ringMesh(rIn, rOut, count = 5, segs = 96) {
  const out = { verts: [], edges: [] };
  for (let k = 0; k < count; k++) {
    const r = rIn + ((rOut - rIn) * k) / (count - 1);
    pushMesh(out, orbitMesh(r, segs));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feedback validation — shared between the page (client-side pre-check) and
// the public POST /api/space/feedback endpoint (src/space.js). The row a
// feedback lands as carries scene id + verdict + a short comment ONLY: the
// page is public, no identity exists, and none is invented.

export const FEEDBACK_COMMENT_MAX = 500;

export function validateSpaceFeedback(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid feedback body." };
  }
  const scene = typeof body.scene === "string" ? body.scene : "";
  if (!sceneById(scene)) return { ok: false, error: "Unknown scene." };
  const verdict = body.verdict === "up" || body.verdict === "down" ? body.verdict : null;
  if (!verdict) return { ok: false, error: "Verdict must be 'up' or 'down'." };
  let comment = typeof body.comment === "string" ? body.comment.replace(/\s+/g, " ").trim() : "";
  if (comment.length > FEEDBACK_COMMENT_MAX) comment = comment.slice(0, FEEDBACK_COMMENT_MAX);
  return { ok: true, value: { scene, verdict, comment } };
}

/**
 * Registry integrity check the unit test drives: returns a list of problems
 * (empty = sound). Checks bilingual completeness, zoom sanity, matcher
 * coverage in BOTH languages for every scene (invariant 6 structurally).
 */
export function validateScene(scene) {
  const errs = [];
  if (!scene || typeof scene !== "object") return ["not an object"];
  if (!/^[a-z0-9-]+$/.test(scene.id || "")) errs.push("bad id");
  for (const field of ["title", "question", "reply"]) {
    const v = scene[field];
    if (!v || typeof v.en !== "string" || !v.en.trim()) errs.push(`${field}.en missing`);
    if (!v || typeof v.sv !== "string" || !v.sv.trim()) errs.push(`${field}.sv missing`);
  }
  const z = scene.zoomKm;
  if (!z || !(z.min > 0) || !(z.max > z.min) || !(z.start >= z.min && z.start <= z.max)) {
    errs.push("zoomKm unsound");
  }
  const m = SPACE_MATCHERS.find((x) => x.id === scene.id);
  if (!m) errs.push("no matcher entry");
  else {
    if (!Array.isArray(m.en) || m.en.length === 0) errs.push("no EN patterns");
    if (!Array.isArray(m.sv) || m.sv.length === 0) errs.push("no SV patterns");
  }
  return errs;
}

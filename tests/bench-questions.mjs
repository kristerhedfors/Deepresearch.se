// Fixed benchmark question set for the LLM-judged research benchmark
// (eval-bench.mjs runner, bench-score.mjs scoring). Unlike model-eval's
// QUERY_SETS — raw traces read by hand — this set exists to produce a
// NUMBER: each question carries a `rubric` (the coverage points a strong
// answer must hit) that the judge model scores against, so a pipeline
// change can be shown to have made answers measurably better or worse.
//
// DISCIPLINE (mirrors QUERY_SETS): this is a FIXED set. Treat it as
// append-only — do NOT edit or delete existing questions once a baseline
// has been recorded against them, or past scores stop being comparable.
// Add a NEW question (fresh id) if you need to cover a new case. Every
// question is SYNTHETIC — composed here, never derived from any real
// user's chat — so running the benchmark stays clear of the site's
// zero-retention promise.
//
// Entry shape:
//   { id, question, lang: "en"|"sv", kind, rubric: [string...], notes }
// `kind` is a coarse tag for slicing the summary:
//   multihop        — needs synthesis across several facts/sources
//   recency         — answer depends on recent/latest information
//   contested       — genuinely mixed/conflicting expert findings
//   unanswerable    — no legitimate sources can exist; must admit it
//   diversity_trap  — topic that tempts single-domain (often self-)citation
//   numeric         — hinges on getting specific figures right
//   comparison      — structured compare/contrast of two+ things
//
// Distribution here: ~27 questions, both languages, every kind represented,
// two unanswerable-by-design, and several diversity traps (the round-7
// self-citation case).

export const BENCH_QUESTIONS = [
  // --- multi-hop synthesis -------------------------------------------------
  {
    id: "mh_semiconductor_export",
    question:
      "How have US export controls on advanced semiconductors to China since 2022 affected the strategies of the three largest contract chip manufacturers, and what specific fab-location or product decisions have they announced in response?",
    lang: "en",
    kind: "multihop",
    rubric: [
      "Identifies the major export-control actions (2022 rules and later tightenings)",
      "Names the largest contract foundries (e.g. TSMC, Samsung, GlobalFoundries/SMIC context)",
      "Connects specific announced fab locations or product/roadmap decisions to the controls",
      "Distinguishes announced/confirmed moves from speculation",
    ],
    notes: "Requires chaining policy -> company -> concrete decision across multiple sources.",
  },
  {
    id: "mh_battery_supply_chain",
    question:
      "Trace the supply chain for lithium-ion EV batteries from raw material extraction to cell assembly, and identify at which stages a single country currently dominates global capacity.",
    lang: "en",
    kind: "multihop",
    rubric: [
      "Covers the stages: mining, refining/processing, cathode/anode materials, cell manufacture",
      "Identifies where China dominates (notably refining and cell/component manufacture)",
      "Names specific materials (lithium, cobalt, graphite, nickel) and their sourcing geography",
      "Uses figures or shares where available rather than only qualitative claims",
    ],
    notes: "Multi-stage synthesis; rewards structure and geographic specificity.",
  },
  {
    id: "mh_undersea_cables",
    question:
      "What are the main documented threats to undersea internet cables, which recent incidents have raised concern, and what protective measures have governments or operators proposed?",
    lang: "en",
    kind: "multihop",
    rubric: [
      "Categorizes threats (accidental anchor/fishing damage, sabotage, natural)",
      "Cites specific recent incidents (e.g. Baltic Sea cable damage)",
      "Describes proposed or implemented protective/monitoring measures",
      "Attributes contested attribution claims cautiously",
    ],
    notes: "Recency + multi-hop; attribution is genuinely uncertain -> calibration signal.",
  },

  // --- recency-sensitive ---------------------------------------------------
  {
    id: "rec_node_lts",
    question:
      "What is the current Long-Term Support (LTS) version of Node.js, when did it enter LTS, and what is its scheduled end-of-life date?",
    lang: "en",
    kind: "recency",
    rubric: [
      "States the current LTS major version",
      "Gives the LTS-entry date",
      "Gives the scheduled end-of-life date",
      "Answer is internally consistent with the Node.js release schedule",
    ],
    notes: "Fast-moving fact; cheap to verify; punishes stale training-data answers.",
  },
  {
    id: "rec_eu_ai_act_timeline",
    question:
      "What are the key application dates of the EU AI Act's obligations rolling out after its entry into force, and which categories of system does each milestone affect?",
    lang: "en",
    kind: "recency",
    rubric: [
      "Identifies entry-into-force and the staggered application dates",
      "Maps milestones to categories (prohibited practices, GPAI, high-risk)",
      "Gets the ordering of the phase-in right",
      "Distinguishes dates that have passed from upcoming ones",
    ],
    notes: "Recency + numeric dates; overlaps the site's own domain.",
  },
  {
    id: "rec_latest_mars_mission",
    question:
      "Which Mars missions are currently active on or around the planet, and what is the most recently announced major finding from any of them?",
    lang: "en",
    kind: "recency",
    rubric: [
      "Lists currently-operating orbiters and surface assets",
      "Identifies a genuinely recent announced finding",
      "Does not list missions that have ended as active",
      "Attributes the finding to the specific mission/instrument",
    ],
    notes: "Tests currency of 'active' status vs training data.",
  },

  // --- contested / nuanced -------------------------------------------------
  {
    id: "con_coffee_health",
    question:
      "What does recent research say about the health effects of moderate daily coffee consumption, and where do studies genuinely disagree?",
    lang: "en",
    kind: "contested",
    rubric: [
      "Summarizes areas of broad agreement (e.g. moderate intake generally not harmful for most adults)",
      "Names specific outcomes studied (cardiovascular, mortality, pregnancy, sleep)",
      "Explicitly flags where findings are mixed or confounded",
      "Avoids overstating causation from observational studies",
    ],
    notes: "Calibration is the point — must hedge, not declare a verdict.",
  },
  {
    id: "con_moderate_alcohol",
    question:
      "Do recent large studies still support the idea that moderate alcohol consumption has a protective cardiovascular effect, or has that view changed?",
    lang: "en",
    kind: "contested",
    rubric: [
      "Explains the older 'J-curve' protective hypothesis",
      "Describes how newer studies (e.g. Mendelian randomization) challenge it",
      "Notes methodological criticisms (abstainer bias, confounding)",
      "Reaches a calibrated conclusion rather than a flat yes/no",
    ],
    notes: "The literature genuinely shifted; rewards honest 'the picture changed'.",
  },
  {
    id: "con_remote_work_productivity",
    question:
      "What does the evidence say about whether remote work increases or decreases worker productivity, and why do studies reach different conclusions?",
    lang: "en",
    kind: "contested",
    rubric: [
      "Presents evidence on both sides",
      "Explains why methodologies diverge (self-report vs output, role type, hybrid vs full-remote)",
      "Avoids cherry-picking a single study as definitive",
      "Notes context-dependence of the answer",
    ],
    notes: "Contested with strong priors on both sides -> calibration test.",
  },

  // --- unanswerable by design ---------------------------------------------
  {
    id: "un_fictional_device",
    question:
      "What are the documented technical specifications, release date, and manufacturer of the 'Zylophar Quantum Router X9'? If you cannot find real sources, say so plainly rather than inventing details.",
    lang: "en",
    kind: "unanswerable",
    rubric: [
      "States plainly that no legitimate sources for this device exist",
      "Does NOT fabricate specifications, a date, or a manufacturer",
      "Optionally notes the name appears fictional",
    ],
    notes: "Fabricated product; the whole score is 'did it refuse to hallucinate'.",
  },
  {
    id: "un_future_election",
    question:
      "Who won the 2032 Swedish general election and what coalition did they form?",
    lang: "en",
    kind: "unanswerable",
    rubric: [
      "Recognizes the event is in the future and has not occurred",
      "Declines to invent a winner or coalition",
      "May explain why it cannot answer",
    ],
    notes: "Future event; must not confabulate a result.",
  },

  // --- source-diversity traps (round-7 self-citation class) ----------------
  {
    id: "div_openai_safety",
    question:
      "What safety and alignment techniques does OpenAI use for its frontier models, and how do independent researchers and other labs assess the effectiveness of those techniques?",
    lang: "en",
    kind: "diversity_trap",
    rubric: [
      "Describes OpenAI's stated techniques (e.g. RLHF, red-teaming, system cards)",
      "Includes independent/third-party assessment, not only OpenAI's own claims",
      "Notes any criticism or limitations raised externally",
      "Does not present the company's self-description as independently verified",
    ],
    notes: "Company likely over-represented in results; tests source diversity + the synthPrompt single-origin caveat.",
  },
  {
    id: "div_tesla_fsd",
    question:
      "How safe is Tesla's Full Self-Driving system compared to human drivers, and what do independent analyses say about the company's own safety statistics?",
    lang: "en",
    kind: "diversity_trap",
    rubric: [
      "Reports what Tesla itself claims about FSD/Autopilot safety",
      "Includes independent analysis and criticism of Tesla's methodology",
      "Notes the data-comparability problems (highway vs city miles, reporting definitions)",
      "Reaches a calibrated conclusion, flagging single-origin data where relevant",
    ],
    notes: "Classic self-reported-statistics trap; diversity + calibration.",
  },
  {
    id: "div_palantir_privacy",
    question:
      "What privacy and civil-liberties concerns have been raised about Palantir's data platforms, and how does the company respond to them?",
    lang: "en",
    kind: "diversity_trap",
    rubric: [
      "Summarizes externally-raised concerns (surveillance, data aggregation, government use)",
      "Includes the company's own response/position",
      "Draws on journalistic or advocacy sources, not just Palantir's site",
      "Attributes contested claims to their origin",
    ],
    notes: "Tempts citing the company's own PR; diversity backstop test.",
  },

  // --- numeric precision ---------------------------------------------------
  {
    id: "num_renewable_share",
    question:
      "What share of global electricity generation came from renewable sources in the most recent year with data, and how does that compare to five years earlier?",
    lang: "en",
    kind: "numeric",
    rubric: [
      "Gives a specific recent percentage for renewables' share",
      "Gives the comparison figure from ~five years prior",
      "States the year each figure refers to",
      "Numbers are plausible and internally consistent",
    ],
    notes: "Precise figures with a delta; punishes vague 'a lot more'.",
  },
  {
    id: "num_slr_projection",
    question:
      "What is the current central projection for global mean sea-level rise by 2100 under a moderate emissions scenario, and what is the plausible range around it?",
    lang: "en",
    kind: "numeric",
    rubric: [
      "Gives a central estimate in cm/m for 2100",
      "Gives a range (not just a point estimate)",
      "Names the scenario framework (e.g. SSP/RCP)",
      "Notes deep-uncertainty tails (ice-sheet instability) if relevant",
    ],
    notes: "Numeric + calibration (ranges, tails).",
  },
  {
    id: "num_transistor_count",
    question:
      "Roughly how many transistors are in a current flagship consumer CPU or GPU, and how does that compare to a flagship from ten years ago?",
    lang: "en",
    kind: "numeric",
    rubric: [
      "Gives an order-of-magnitude transistor count for a current flagship",
      "Gives a comparison figure from ~ten years ago",
      "Names the specific chips being compared",
      "The growth factor stated is consistent with the two figures",
    ],
    notes: "Order-of-magnitude numeric reasoning across a decade.",
  },

  // --- structured comparison ----------------------------------------------
  {
    id: "cmp_sse_websockets",
    question:
      "Compare Server-Sent Events and WebSockets for streaming LLM responses in a web app: connection model, direction, reconnection, proxy/infrastructure behavior, and when to prefer each.",
    lang: "en",
    kind: "comparison",
    rubric: [
      "Contrasts unidirectional SSE vs bidirectional WebSockets",
      "Covers reconnection/resumption differences",
      "Addresses proxy/HTTP-infrastructure behavior",
      "Gives a clear 'prefer X when' recommendation",
    ],
    notes: "Mostly stable technical knowledge; tests structured comparison quality.",
  },
  {
    id: "cmp_nis2_sec",
    question:
      "Compare mandatory cybersecurity incident-disclosure requirements under the EU's NIS2 Directive and the US SEC's 2023 cybersecurity disclosure rules: reporting timelines, which entities are covered, and enforcement.",
    lang: "en",
    kind: "comparison",
    rubric: [
      "States NIS2 reporting timelines (e.g. early-warning / detailed report windows)",
      "States the SEC's materiality-based disclosure timeline",
      "Contrasts the scope of covered entities in each regime",
      "Contrasts enforcement mechanisms and penalties",
    ],
    notes: "Two regulatory regimes side by side; numeric deadlines + structure.",
  },
  {
    id: "cmp_ztna_vpn",
    question:
      "Compare zero-trust network access (ZTNA) with traditional VPN for enterprise remote access, focusing on attack surface and common exploitation techniques against each.",
    lang: "en",
    kind: "comparison",
    rubric: [
      "Explains the architectural difference (network-level tunnel vs per-application brokered access)",
      "Contrasts the attack surface each exposes",
      "Names concrete exploitation techniques relevant to each",
      "Avoids vendor-marketing framing of ZTNA as a silver bullet",
    ],
    notes: "Security comparison; watch for over-refusal and vendor-speak.",
  },

  // --- Swedish-language questions ------------------------------------------
  {
    id: "sv_ai_act_forskning",
    question:
      "Vilka krav i EU:s AI-förordning (AI Act) gäller för forsknings- och demonstrationsprojekt som inte släpps ut på marknaden, och vilka undantag finns?",
    lang: "sv",
    kind: "recency",
    rubric: [
      "Beskriver forsknings-/utvecklingsundantaget i förordningen",
      "Nämner relevanta artiklar eller skäl (t.ex. undantag före utsläppande på marknaden)",
      "Klargör var undantaget slutar gälla (verklig användning, marknadsintroduktion)",
      "Svarar på svenska och håller sig till frågan",
    ],
    notes: "Swedish; overlaps the site's own /build/ EU AI Act discussion.",
  },
  {
    id: "sv_elpris_norden",
    question:
      "Varför skiljer sig elpriserna så mycket mellan norra och södra Sverige, och vilka faktorer driver prisskillnaden mellan elområdena?",
    lang: "sv",
    kind: "multihop",
    rubric: [
      "Förklarar elområdesindelningen (SE1–SE4)",
      "Kopplar prisskillnaden till produktion i norr vs förbrukning i söder",
      "Nämner överföringskapacitet/flaskhalsar i stamnätet",
      "Tar upp export/koppling till kontinenten där relevant",
    ],
    notes: "Swedish multi-hop energy question with real domestic nuance.",
  },
  {
    id: "sv_ranteutveckling",
    question:
      "Hur har Riksbankens styrränta utvecklats de senaste åren och vad har Riksbanken angett som huvudsakliga skäl för de senaste besluten?",
    lang: "sv",
    kind: "recency",
    rubric: [
      "Beskriver styrräntans riktning de senaste åren",
      "Anger de huvudsakliga skälen Riksbanken angett (t.ex. inflation)",
      "Skiljer på genomförda och framåtblickande beslut",
      "Undviker att hitta på exakta siffror om källor saknas",
    ],
    notes: "Swedish + recency + numeric-ish; calibration if figures are unavailable.",
  },
  {
    id: "sv_ovansbar_produkt",
    question:
      "Vilka är de tekniska specifikationerna och lanseringsdatumet för 'Nordström Kvantprocessor Z-500'? Om det inte finns några verkliga källor, säg det tydligt istället för att hitta på detaljer.",
    lang: "sv",
    kind: "unanswerable",
    rubric: [
      "Anger tydligt att inga verkliga källor för produkten finns",
      "Hittar INTE på specifikationer eller datum",
      "Kan notera att namnet verkar påhittat",
    ],
    notes: "Swedish unanswerable twin of un_fictional_device — tests refusal in Swedish.",
  },

  // --- extra multihop / contested to round out coverage --------------------
  {
    id: "mh_glp1_outcomes",
    question:
      "Beyond weight loss, what cardiovascular and other health outcomes have recent large trials of GLP-1 receptor agonists (e.g. semaglutide, tirzepatide) reported, and how strong is the evidence?",
    lang: "en",
    kind: "multihop",
    rubric: [
      "Names specific trials or programs where possible",
      "Reports cardiovascular outcome findings with figures where available",
      "Covers additional outcomes studied (renal, sleep apnea, etc.)",
      "Calibrates strength of evidence rather than overselling",
    ],
    notes: "Biomedicine multihop + numeric + calibration.",
  },
  {
    id: "con_carbon_budget",
    question:
      "What do recent major climate assessments say about the remaining carbon budget for staying under 1.5°C of warming, and how and why has that estimate changed across updates?",
    lang: "en",
    kind: "contested",
    rubric: [
      "Gives a recent remaining-budget figure with its probability framing",
      "Explains that the estimate has shrunk and why (ongoing emissions, method updates)",
      "Notes the genuine uncertainty in the number",
      "Attributes figures to specific assessments (e.g. IPCC / annual updates)",
    ],
    notes: "Numeric + contested + recency; a strong all-round test.",
  },
];

// Convenience: filter helpers the runner uses for env overrides.
export function questionsByIds(ids) {
  if (!ids || !ids.length) return BENCH_QUESTIONS;
  const set = new Set(ids);
  return BENCH_QUESTIONS.filter((q) => set.has(q.id));
}

export function questionsByKinds(kinds) {
  if (!kinds || !kinds.length) return BENCH_QUESTIONS;
  const set = new Set(kinds);
  return BENCH_QUESTIONS.filter((q) => set.has(q.kind));
}

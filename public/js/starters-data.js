// @ts-check
// Starter prompts — the DATA. One queue per agent; the logic that selects,
// rotates, ranks and validates these lives in starters-core.js.
//
// This is the authoritative registry. It is a served ES module rather than a
// JSON file plus a bundle step because both the browser and Node import it
// directly — the same reason bash-core.js and agent-spec-core.js live under
// public/js/ (CLAUDE.md, Code layout). No build artifact, so nothing to drift.
//
// ---------------------------------------------------------------------------
// HOW THESE WERE COMPOSED
//
// The ASPECT taxonomy under each agent was derived from what people actually
// send this site — 200 logged interactions read in the session that added this
// file — plus the pipeline cases in docs/test-batches/. That is where the
// weighting comes from: research draws Swedish consumer and civic questions
// far more than a synthetic set would guess, introspection is dominated by
// "walk me through the pipeline" and "draw it", and Agent Studio is almost
// entirely "build me a <thing>".
//
// The TEXT is synthetic. Every starter here was composed for this file; none
// is a logged question, paraphrased or verbatim. Two reasons, and the second
// is the load-bearing one:
//
//   1. It matches the discipline tests/bench-questions.mjs already sets for
//      the benchmark set, so the two corpora stay comparable.
//   2. A starter is shown to every visitor. Lifting a real question out of
//      chat_logs and putting it on a stranger's opening screen publishes one
//      user's chat to another user, and a full-visibility log is not consent
//      for that. Aspects generalise; sentences do not.
//
// ---------------------------------------------------------------------------
// WHAT MAKES A GOOD STARTER (the editorial rule these follow)
//
// A starter must carry enough for the agent to ACT on it with no follow-up.
// The failure this system exists to fix is the opposite: chat_logs #636
// ("update") and #637 ("vad finns på feeden?") were both sent to the
// outrospection agent, both got an honest but empty-handed reply, and the very
// next message (#638) was the user telling us both answers were inadequate. A
// one-word opener does not fail because the model is weak; it fails because it
// names no lens, no topic and no task. So every entry below names a subject
// AND a task, and reads like something a person would actually want answered.
//
// EN/SV parity (invariant 6) is enforced by validateStarters, not left to
// taste: a Swedish speaker opening any agent sees Swedish openers in the
// strip, because a monolingual strip silently tells them which language the
// product is really for.
//
// ---------------------------------------------------------------------------
// RANKS
//
// `rank` (1-5) and `evidence` appear only on starters a recorded eval run has
// scored, and they are written by hand from that run's shortlist — never by
// the harness itself (invariant 5: evidence-driven, and a number that appears
// in the product should be traceable to the run that justified it).
// `evidence` is the run id in tests/STARTER-EVAL-FINDINGS.md. Unranked entries
// are not "bad"; they are untried, and selectStarters' explore slots exist to
// get them tried. See the **starter-prompts** skill.
//
// ---------------------------------------------------------------------------
// XP NUMBERS — the #XP-<nn> tag (feedback #37, 2026-07-26)
//
// Every entry carries an `xp`: a small integer that is this starter's stable
// public identity, rendered as `#XP-07` (starters-core.js starterTag). In
// evaluation mode the chip prepends that tag to the message it sends, the same
// way the try-it list prepends `#UC-34` (testpoints-core.js tagStarterPrompt),
// so a reviewer's later "feedback …" note is tied to the exact starter by the
// first message of the conversation. The pipeline strips the tag before any
// model sees it (src/pipeline.js), so the question the agent answers is the
// starter's text and nothing else.
//
// The numbering is APPEND-ONLY: a new starter takes max+1, and a number is
// never reused or reordered, because a number that moves silently re-points
// every feedback entry that cited it. The validator enforces uniqueness and
// shape; the append-only part is discipline (there is no registry of retired
// numbers to check against — deleting an entry simply retires its number).
//
// The tag is NOT added to the ordinary visitor strip. A visitor's pick signal
// is local-only by design (starters.js), and prefixing an identifier onto a
// stranger's first message would put exactly the byte on the wire that promise
// says is not there — as well as showing them a code they never asked about.

/** Registry format version — bumped when an entry's shape changes. */
export const STARTERS_VERSION = "1.1.0";

/**
 * Aspect vocabularies, per agent. Documentation rather than enforcement — the
 * validator only requires that every starter HAS an aspect and that a queue
 * spans enough distinct ones. Listing them here is what stops a queue from
 * quietly becoming twenty rephrasings of its author's favourite question.
 */
export const ASPECTS = {
  research: [
    "recency-news", "sv-civic", "consumer-sv", "product-compare", "health-evidence",
    "policy-regulation", "tech-compare", "science-numbers", "contested", "osint-security",
    "geo-place", "ml-models", "explainer", "market-finance", "howto",
    "unanswerable", "multihop", "climate-energy", "space", "local-sv",
  ],
  secure: [
    "privacy-posture", "key-handling", "local-models", "browser-crypto", "threat-model",
    "workspace-share", "offline", "search-grant", "tier-compare", "data-exposure",
    "verify-claims", "sv-privacy", "portability", "provider-choice", "attachments",
    "regulation", "self-host", "sv-threat", "cost", "explainer",
  ],
  introspection: [
    "pipeline-walkthrough", "diagram", "server-vs-browser", "model-routing", "encryption",
    "source-location", "skills", "security-assessment", "invariants", "privacy-model",
    "extensions", "testing", "agent-definition", "sse-events", "sv-arch",
    "code-example", "mode-routing", "docs-help", "deploy", "sandbox",
  ],
  orchestrator: [
    "fan-out-compare", "market-tech-reg", "competitor-scan", "multi-jurisdiction", "pro-con-panel",
    "self-vs-others", "supply-chain", "due-diligence", "literature-sweep", "sv-multi",
    "red-blue", "option-scoring", "timeline-build", "vendor-shortlist", "risk-register",
    "cross-verify", "feasibility", "sv-market", "spec-audit", "parallel-drill",
  ],
  outrospection: [
    "deep-research", "privacy-llm", "browser-models", "edge-rag", "llm-architecture",
    "agent-standards", "one-dependency", "contrast-self", "sv-outward", "pricing-moves",
    "open-weights", "sandbox-tech", "eval-benchmarks", "local-inference", "sv-privacy",
    "feed-state", "strategy", "sv-architecture", "tooling", "gap-check",
  ],
  models: [
    "pick-a-model", "cost-compare", "vision-model", "sv-language", "context-window",
    "licence", "open-weights", "sv-cost", "benchmark-claims", "self-host",
    "provider-choice", "quantization", "sv-pick", "dataset", "fine-tune",
    "paper", "tool-support", "sv-licence", "small-models", "model-family",
  ],
  "agent-builder": [
    "single-purpose", "themed-agent", "tutor", "tool-app", "distill-secure",
    "sv-agent", "data-app", "writing-aid", "dev-tool", "visual-app",
    "quiz", "converter", "dashboard", "platform-distill", "minimal-client",
    "role-play", "summarizer", "comparison-tool", "sv-study", "game",
  ],
  palaeogenomics: [
    "geo-radius", "sv-samples", "haplogroup", "sv-population", "mammoth-megafauna",
    "coverage-quality", "dating", "contamination", "sedadna", "sv-method",
    "deextinction", "preservation", "population-history", "corpus-limits", "method-caveats",
    "proteomics", "literature-frontier", "reference-panel", "sv-dating", "isotopes",
  ],
  scholar: [
    "clinical-evidence", "sv-clinical", "replication", "venue-metrics", "effect-size",
    "disagreement", "author-profile", "retraction", "emerging", "sv-method",
    "cs-evidence", "method-critique", "systematic-review", "scholarly-system", "peer-review-itself",
  ],
  "under-construction": [
    "purpose", "tier-choice", "controls", "theme", "examples",
    "capability", "prompts", "search-policy", "gates", "bounds",
    "quota", "sv-purpose", "team", "events", "model-routing",
    "sv-controls", "derive", "publish", "validate", "naming",
  ],
};

/**
 * The queues. Keys are agent ids from sdk/AGENTS.json; order within a queue is
 * only the explore-rotation order, not a ranking.
 * @type {{ queues: Record<string, Array<{id:string,xp:number,text:string,aspect:string,lang:string,rank?:number,evidence?:string}>> }}
 */
export const STARTERS = {
  queues: {
    // =====================================================================
    // research — Deep Research on the Se/rver tier. The taxonomy here leans
    // the way the logs lean: news and Swedish practical questions are the
    // real front door, not the polished multi-hop benchmark questions.
    // =====================================================================
    research: [
      // Rewritten after run 2026-07-26T07-34-22-617Z scored the original 2.10.
      // It had asked for "the most significant developments in open-source AI
      // from the past month" — broad enough that the pipeline retrieved 24
      // sources and then cited around them, which the judge correctly read as
      // unsupported. A recency starter needs a narrow enough subject that the
      // sources it finds are the sources it needs. Unranked until re-run.
      { id: "res-news-tech", xp: 1, lang: "en", aspect: "recency-news",
        text: "Which language models released in the last few months can be self-hosted on a single GPU, and what hardware does each one actually need?" },
      { id: "res-sv-ranta", xp: 2, lang: "sv", aspect: "sv-civic", rank: 4.25, evidence: "2026-07-26T07-34-22-617Z",
        text: "Hur har Riksbankens styrränta utvecklats det senaste året, och vilka skäl har Riksbanken själv angett för de senaste besluten?" },
      { id: "res-sv-elpris", xp: 3, lang: "sv", aspect: "sv-civic", rank: 4.4, evidence: "2026-07-26T07-34-22-617Z",
        text: "Varför skiljer sig elpriserna mellan norra och södra Sverige, och vilka faktorer driver skillnaden mellan elområdena?" },
      { id: "res-compare-edge", xp: 4, lang: "en", aspect: "tech-compare", rank: 4, evidence: "2026-07-26T07-34-22-617Z",
        text: "Compare Cloudflare Workers, Deno Deploy and Fly.io for a low-latency streaming API: cold starts, CPU limits, pricing and where each one hurts." },
      { id: "res-health-glp1", xp: 5, lang: "en", aspect: "health-evidence",
        text: "Beyond weight loss, what do recent large trials show about GLP-1 receptor agonists and cardiovascular outcomes — and where do the trials disagree?" },
      { id: "res-policy-aiact", xp: 6, lang: "en", aspect: "policy-regulation",
        text: "What are the key application dates of the EU AI Act's obligations, and which ones affect a small company shipping an LLM product in Europe?" },
      { id: "res-sv-konsument", xp: 7, lang: "sv", aspect: "consumer-sv",
        text: "Jag behöver en drivrem till en åkgräsklippare men vet bara modellnamnet — hur tar jag reda på rätt reservdel och var den finns att köpa i Sverige?" },
      { id: "res-product-watch", xp: 8, lang: "en", aspect: "product-compare",
        text: "Which affordable automatic watches are the closest homages to the Rolex Explorer II, and how do the movements and finishing actually differ?" },
      { id: "res-numbers-transistor", xp: 9, lang: "en", aspect: "science-numbers",
        text: "Roughly how many transistors are in a current flagship consumer GPU, and how does that compare with a flagship chip from ten years ago?" },
      { id: "res-contested-remote", xp: 10, lang: "en", aspect: "contested",
        text: "Does the evidence say remote work raises or lowers productivity? Show me where the studies genuinely conflict and why their methods differ." },
      { id: "res-osint-surface", xp: 11, lang: "en", aspect: "osint-security",
        text: "Map the public attack surface of a domain I name: which services are exposed, what the banners reveal, and which findings actually matter." },
      { id: "res-ml-models", xp: 12, lang: "en", aspect: "ml-models",
        text: "Which openly licensed language models released recently can run on a single consumer GPU, and how do they compare on quality per gigabyte?" },
      { id: "res-explainer-demon", xp: 13, lang: "en", aspect: "explainer",
        text: "Explain the 1940s criticality accidents at Los Alamos: what physically happened, what the safety failures were, and what changed afterwards." },
      { id: "res-market-cloud", xp: 14, lang: "en", aspect: "market-finance",
        text: "Explain the financial position of a major cloud provider's AI buildout: the capital commitments, how they are being funded, and the risks analysts flag." },
      { id: "res-sv-recept", xp: 15, lang: "sv", aspect: "howto",
        text: "Jag vill baka bullar på havregrynsgröt som blivit över. Hur påverkar gröten degen, och vad behöver jag ändra i ett vanligt bullrecept?" },
      { id: "res-unanswerable", xp: 16, lang: "en", aspect: "unanswerable",
        text: "What are the confirmed specifications and release date of the Nordström Quantum Processor Z-500? If it does not exist, say so plainly." },
      { id: "res-multihop-export", xp: 17, lang: "en", aspect: "multihop",
        text: "How have export controls on advanced semiconductors reshaped where the largest contract chip manufacturers are building fabs, and which decisions are confirmed?" },
      { id: "res-climate-budget", xp: 18, lang: "en", aspect: "climate-energy",
        text: "What do the most recent major climate assessments say about the remaining carbon budget for 1.5°C, and how much do their estimates differ?" },
      { id: "res-sv-lokal", xp: 19, lang: "sv", aspect: "local-sv",
        text: "Vad har hänt i Stockholm den senaste veckan som faktiskt påverkar vardagen — trafik, bostäder, kommunala beslut? Sammanfatta med källor." },
      { id: "res-geo-place", xp: 20, lang: "en", aspect: "geo-place",
        text: "Tell me about a street address I give you: what is at that location, what the surroundings look like, and what the area is known for." },
      { id: "res-space", xp: 21, lang: "en", aspect: "space",
        text: "Which missions are currently operating on or around Mars, what is each one doing right now, and what was the most recent significant finding?" },
      { id: "res-sv-halsa", xp: 22, lang: "sv", aspect: "health-evidence",
        text: "Vad säger aktuell forskning om måttligt kaffedrickande och hälsa, och var är forskarna oense om slutsatserna?" },
    ],

    // =====================================================================
    // secure — the never-cloud tier. Its starters do double duty: they must
    // be answerable browser-direct (no server in the data path), and the
    // tier's whole pitch is a privacy claim, so a good chunk of the queue is
    // the visitor interrogating that claim. That is the point of Se/cure, not
    // a distraction from it.
    // =====================================================================
    secure: [
      { id: "sec-posture", xp: 23, lang: "en", aspect: "privacy-posture",
        text: "What exactly can this site's server observe about this conversation, and what is it structurally unable to see? Be specific about the boundary." },
      { id: "sec-keys", xp: 24, lang: "en", aspect: "key-handling",
        text: "Where does my API key live once I paste it in, what touches it, and what happens to it when I close this tab?" },
      { id: "sec-crypto", xp: 25, lang: "en", aspect: "browser-crypto",
        text: "Explain how AES-GCM sealing of local chat history works, and what an attacker with access to my browser storage would and would not get." },
      { id: "sec-sv-integritet", xp: 26, lang: "sv", aspect: "sv-privacy",
        text: "Vad innebär det konkret att den här varianten aldrig skickar mina samtal till en server? Vad händer i webbläsaren och vad händer inte?" },
      { id: "sec-threat", xp: 27, lang: "en", aspect: "threat-model",
        text: "Walk me through the threat model of a browser-only AI client: which attacks does it genuinely prevent, and which ones does it not help with at all?" },
      { id: "sec-local-models", xp: 28, lang: "en", aspect: "local-models",
        text: "What are my options for running a language model entirely on my own machine and pointing this client at it, and what quality do I give up?" },
      { id: "sec-workspace", xp: 29, lang: "en", aspect: "workspace-share",
        text: "How can I hand someone a working copy of my setup through a link alone, without a server holding a record of it — and what does the link expose?" },
      { id: "sec-offline", xp: 30, lang: "en", aspect: "offline",
        text: "Which parts of this client keep working with no network at all, and which ones stop? Explain what that means for using it on a plane." },
      { id: "sec-grant", xp: 31, lang: "en", aspect: "search-grant",
        text: "If I turn on web search here, what leaves my browser and who sees it? Explain the smallest thing that has to be shared for search to work." },
      { id: "sec-sv-jamfor", xp: 32, lang: "sv", aspect: "tier-compare",
        text: "Vad är skillnaden mellan den här webbläsarvarianten och den inloggade varianten, i termer av vad som faktiskt lagras och var?" },
      { id: "sec-verify", xp: 33, lang: "en", aspect: "verify-claims",
        text: "I do not want to take the privacy claims on trust. What can I check myself, from the browser, to verify that no conversation data is being sent?" },
      { id: "sec-exposure", xp: 34, lang: "en", aspect: "data-exposure",
        text: "List every third party that receives anything at all during one of my questions, and exactly what each one receives." },
      { id: "sec-sv-nycklar", xp: 35, lang: "sv", aspect: "key-handling",
        text: "Hur bör jag hantera min API-nyckel på en delad dator när jag använder en klient som kör helt i webbläsaren?" },
      { id: "sec-portability", xp: 36, lang: "en", aspect: "portability",
        text: "How do I export everything this client holds about me and move it to another browser, and what is lost in the move?" },
      { id: "sec-provider", xp: 37, lang: "en", aspect: "provider-choice",
        text: "Which model providers can a browser-only client call directly, and what makes some of them impossible to use from a page?" },
      { id: "sec-attach", xp: 38, lang: "en", aspect: "attachments",
        text: "If I attach a document here, where is it processed and is any of it sent anywhere beyond the model call itself?" },
      { id: "sec-sv-gdpr", xp: 39, lang: "sv", aspect: "regulation",
        text: "Om ingen personuppgift lämnar min webbläsare — vad betyder det rent praktiskt för GDPR-ansvaret när jag använder verktyget i arbetet?" },
      { id: "sec-selfhost", xp: 40, lang: "en", aspect: "self-host",
        text: "What would it take to run my own web-search service for this client instead of a third-party one, and what do I gain by doing it?" },
      { id: "sec-sv-hot", xp: 41, lang: "sv", aspect: "sv-threat",
        text: "Vilka risker finns kvar även när allt körs lokalt i webbläsaren? Var ärlig om vad den här modellen inte skyddar mot." },
      { id: "sec-cost", xp: 42, lang: "en", aspect: "cost",
        text: "If I bring my own API key, what does a typical research question actually cost me, and which settings move that number most?" },
      { id: "sec-explainer", xp: 43, lang: "en", aspect: "explainer",
        text: "Explain in plain language why running the research pipeline in my browser changes the privacy story, rather than just moving the same risk around." },
      { id: "sec-sv-lokal-modell", xp: 44, lang: "sv", aspect: "local-models",
        text: "Går det att köra en språkmodell direkt i webbläsaren utan att något lämnar datorn, och vad kostar det i svarskvalitet?" },
    ],

    // =====================================================================
    // introspection — the site read from the inside. The logs are dominated
    // by two things: "walk me through the pipeline" and "draw it". Both are
    // over-represented here on purpose, because both are what people ask.
    // =====================================================================
    introspection: [
      { id: "int-pipeline", xp: 45, lang: "en", aspect: "pipeline-walkthrough", rank: 4.65, evidence: "2026-07-26T07-34-22-617Z",
        text: "Walk me through what happens to my message from the moment I press send until the first word of the answer appears, phase by phase." },
      { id: "int-diagram", xp: 46, lang: "en", aspect: "diagram", rank: 3.7, evidence: "2026-07-26T07-34-22-617Z",
        text: "Draw the request pipeline as a diagram: every phase, what runs where, and which steps can fail without breaking the answer." },
      { id: "int-sv-visualisera", xp: 47, lang: "sv", aspect: "diagram", rank: 4.3, evidence: "2026-07-26T07-34-22-617Z",
        text: "Visualisera hur användarens text tolkas steg för steg, från inskickat meddelande till färdigt svar, med ett diagram och en kort förklaring." },
      { id: "int-split", xp: 48, lang: "en", aspect: "server-vs-browser", rank: 4.05, evidence: "2026-07-26T07-34-22-617Z",
        text: "During a research request, which work happens on the server and which happens in my browser? Be precise about where the boundary sits." },
      { id: "int-routing", xp: 49, lang: "en", aspect: "model-routing",
        text: "Why do the planning phases run on a different model from the one I picked, and what breaks if that split is removed?" },
      { id: "int-crypto", xp: 50, lang: "en", aspect: "encryption",
        text: "Show me from the source how chat history is encrypted, where the keys come from, and what the server can decrypt." },
      { id: "int-source", xp: 51, lang: "en", aspect: "source-location",
        text: "Where does your own source code live in this environment, and how do you retrieve the parts relevant to a question like this one?" },
      { id: "int-skills", xp: 52, lang: "en", aspect: "skills",
        text: "List the operational skills this project ships with, and give me a one-line brief on what each one is for." },
      { id: "int-security", xp: 53, lang: "en", aspect: "security-assessment",
        text: "Assess this project's security posture from its actual source: what is genuinely hardened, and what is the weakest link you can find?" },
      { id: "int-invariants", xp: 54, lang: "en", aspect: "invariants",
        text: "What architectural rules is this codebase not allowed to break, why does each one exist, and what would go wrong if it were violated?" },
      { id: "int-sv-integritet", xp: 55, lang: "sv", aspect: "privacy-model",
        text: "Förklara integritetsmodellen utifrån koden: vad lagras var, vad är krypterat, och vilka undantag finns det från huvudregeln?" },
      { id: "int-extensions", xp: 56, lang: "en", aspect: "extensions",
        text: "How are third-party integrations kept out of the core, and what would adding a new one actually touch?" },
      { id: "int-testing", xp: 57, lang: "en", aspect: "testing",
        text: "What does the test suite here actually cover, what is deliberately left to live verification, and why is the line drawn there?" },
      { id: "int-agent-def", xp: 58, lang: "en", aspect: "agent-definition",
        text: "What defines an agent in this system? Show me the fields that make one agent different from another, from the real registry." },
      { id: "int-sse", xp: 59, lang: "en", aspect: "sse-events",
        text: "What events does the server stream to the page during a request, and how does the UI turn them into the activity you see while waiting?" },
      { id: "int-sv-arkitektur", xp: 60, lang: "sv", aspect: "sv-arch",
        text: "Beskriv arkitekturen för den här applikationen utifrån källkoden: vilka moduler finns, vad ansvarar de för, och hur hänger de ihop?" },
      { id: "int-code", xp: 61, lang: "en", aspect: "code-example",
        text: "Show me the actual code that decides whether a question needs a web search, and explain how that decision is made." },
      { id: "int-modes", xp: 62, lang: "en", aspect: "mode-routing",
        text: "How does a request get routed to one chat mode rather than another, and what happens if several mode flags arrive at once?" },
      { id: "int-docs", xp: 63, lang: "en", aspect: "docs-help",
        text: "Which documentation does this project ship, how is it indexed for retrieval, and which document should I read first to understand the whole thing?" },
      { id: "int-sv-deploy", xp: 64, lang: "sv", aspect: "deploy",
        text: "Hur går en kodändring från commit till att den är live? Beskriv kedjan utifrån den faktiska konfigurationen i projektet." },
      { id: "int-sandbox", xp: 65, lang: "en", aspect: "sandbox",
        text: "How does the in-browser Linux environment work, what is it allowed to do, and where are its boundaries enforced?" },
      { id: "int-sv-modell", xp: 66, lang: "sv", aspect: "model-routing",
        text: "Vilka språkmodeller kan användas här, hur väljs de, och vad avgör vilken modell som får svara på min fråga?" },
      { id: "int-sv-sakerhet", xp: 67, lang: "sv", aspect: "security-assessment",
        text: "Gör en säkerhetsgenomgång utifrån den faktiska källkoden: vad är väl skyddat, och var finns den svagaste länken?" },
    ],

    // =====================================================================
    // orchestrator — the sub-agent workflow mode. The one thing a starter
    // here must do is be genuinely DECOMPOSABLE: a question with one obvious
    // answer wastes the whole mechanism and looks slow for no reason. Every
    // entry below has at least three natural parallel lanes.
    // =====================================================================
    orchestrator: [
      { id: "orc-vectordb", xp: 68, lang: "en", aspect: "fan-out-compare", rank: 4.15, evidence: "2026-07-26T07-34-22-617Z",
        text: "Compare three vector databases with one agent per product — architecture, operational cost and failure modes — then merge them into a single verdict." },
      { id: "orc-market-tech-reg", xp: 69, lang: "en", aspect: "market-tech-reg", rank: 4.4, evidence: "2026-07-26T07-34-22-617Z",
        text: "Research home battery storage in Sweden across three lanes at once: the market, the technology, and the regulation. Then reconcile them." },
      { id: "orc-competitors", xp: 70, lang: "en", aspect: "competitor-scan", rank: 4.4, evidence: "2026-07-26T07-34-22-617Z",
        text: "Scan the deep-research assistant landscape: one agent per major product, each reporting capability, pricing and privacy posture, merged into a table." },
      { id: "orc-jurisdiction", xp: 71, lang: "en", aspect: "multi-jurisdiction", rank: 4.15, evidence: "2026-07-26T07-34-22-617Z",
        text: "How is AI in hiring regulated in the EU, the UK and the US? One agent per jurisdiction, then a comparison of where they genuinely conflict." },
      { id: "orc-procon", xp: 72, lang: "en", aspect: "pro-con-panel",
        text: "Put a case for and a case against nuclear expansion in Sweden with separate agents, then have a third judge which arguments actually survive." },
      { id: "orc-self", xp: 73, lang: "en", aspect: "self-vs-others",
        text: "Assess this site's privacy claims two ways at once: one agent reading its source, another reading what comparable products promise. Then compare." },
      { id: "orc-supply", xp: 74, lang: "en", aspect: "supply-chain",
        text: "Trace the lithium-ion battery supply chain stage by stage with an agent per stage, and identify where a single country dominates capacity." },
      { id: "orc-diligence", xp: 75, lang: "en", aspect: "due-diligence",
        text: "Run diligence on a company I name: financials, product, litigation and public reputation in parallel, merged into one risk summary." },
      { id: "orc-sv-marknad", xp: 76, lang: "sv", aspect: "sv-market",
        text: "Kartlägg den svenska marknaden för laddinfrastruktur: en agent för aktörerna, en för tekniken, en för regelverket. Sammanfoga till en lägesbild." },
      { id: "orc-literature", xp: 77, lang: "en", aspect: "literature-sweep",
        text: "Sweep the recent literature on retrieval-augmented generation from several angles at once, then reconcile what the strands actually agree on." },
      { id: "orc-redblue", xp: 78, lang: "en", aspect: "red-blue",
        text: "Assess a system design I describe with an attacking agent and a defending agent working in parallel, then a third that scores which risks are real." },
      { id: "orc-scoring", xp: 79, lang: "en", aspect: "option-scoring",
        text: "I have three candidate architectures for a streaming API. Score each with its own agent against cost, latency and operational burden, then rank them." },
      { id: "orc-sv-tidslinje", xp: 80, lang: "sv", aspect: "timeline-build",
        text: "Bygg en tidslinje över EU:s AI-reglering: en agent per fas, som sedan vävs ihop till en sammanhängande kronologi med källor." },
      { id: "orc-vendor", xp: 81, lang: "en", aspect: "vendor-shortlist",
        text: "Shortlist observability vendors for a small edge-deployed service: parallel agents on pricing, integration effort and data residency, then a recommendation." },
      { id: "orc-risk", xp: 82, lang: "en", aspect: "risk-register",
        text: "Build a risk register for launching an AI product in Europe — legal, technical, reputational and operational lanes in parallel — ranked by severity." },
      { id: "orc-verify", xp: 83, lang: "en", aspect: "cross-verify",
        text: "Take a claim I give you and have several agents independently try to verify it from different source types, then report where they disagree." },
      { id: "orc-sv-genomforbarhet", xp: 84, lang: "sv", aspect: "feasibility",
        text: "Är det rimligt att driva en liten AI-tjänst helt på edge-infrastruktur? Undersök teknik, kostnad och drift parallellt och väg ihop svaret." },
      { id: "orc-spec", xp: 85, lang: "en", aspect: "spec-audit",
        text: "Audit an open specification I name from three angles at once — completeness, ambiguity and adoption — and merge them into one assessment." },
      { id: "orc-drill", xp: 86, lang: "en", aspect: "parallel-drill",
        text: "Find the projects most similar to this one, one agent per discovery channel, then merge the findings into a ranked list with what each does better." },
      { id: "orc-sv-halsa", xp: 87, lang: "sv", aspect: "literature-sweep",
        text: "Undersök forskningsläget om skärmtid och sömn hos ungdomar från flera håll samtidigt, och redovisa var studierna faktiskt går isär." },
      { id: "orc-standards", xp: 88, lang: "en", aspect: "spec-audit",
        text: "Which agent interchange standards are gaining real adoption? One agent per standard, each reporting who implements it, then a joint verdict." },
      { id: "orc-sv-upphandling", xp: 89, lang: "sv", aspect: "multi-jurisdiction",
        text: "Vad gäller vid offentlig upphandling av AI-system i Sverige? Dela upp i regelverk, praxis och praktiska fallgropar och sammanfoga till en guide." },
      { id: "orc-sv-leverantor", xp: 90, lang: "sv", aspect: "vendor-shortlist",
        text: "Ta fram en kortlista på molnleverantörer för en svensk myndighet: en agent för pris, en för datahemvist, en för driftkrav. Väg ihop och rangordna." },
    ],

    // =====================================================================
    // outrospection — the outward feed. THIS is the queue the whole system
    // was worth building for. Its two logged starters were "update" and "vad
    // finns på feeden?", and the user's next message said both answers were
    // inadequate (chat_logs #636-638). Neither question names a lens, so
    // neither could retrieve anything. Every entry below names a lens subject
    // explicitly, and the seven ids they target are the real ones from the
    // lens registry in public/js/outrospect-core.js.
    // =====================================================================
    outrospection: [
      { id: "out-deep-research", xp: 91, lang: "en", aspect: "deep-research", rank: 3.8, evidence: "2026-07-26T07-34-22-617Z",
        text: "What have the other deep-research assistants shipped recently, and what do they do that this one does not?" },
      { id: "out-privacy", xp: 92, lang: "en", aspect: "privacy-llm", rank: 3.45, evidence: "2026-07-26T07-34-22-617Z",
        text: "Who else is trying to make privacy a structural property of an AI product rather than a policy promise, and how far have they got?" },
      { id: "out-browser-models", xp: 93, lang: "en", aspect: "browser-models", rank: 2.35, evidence: "2026-07-26T07-34-22-617Z",
        text: "What is the current state of language models that run entirely in a browser tab — which ones are usable, and at what size?" },
      { id: "out-edge-rag", xp: 94, lang: "en", aspect: "edge-rag", rank: 2.35, evidence: "2026-07-26T07-34-22-617Z",
        text: "Which retrieval approaches now work without a vector database in someone else's cloud, and has anyone made edge RAG genuinely practical?" },
      { id: "out-architecture", xp: 95, lang: "en", aspect: "llm-architecture",
        text: "How are other teams structuring LLM applications now, and does any of it actually beat a deterministic pipeline with no function calling?" },
      { id: "out-standards", xp: 96, lang: "en", aspect: "agent-standards",
        text: "Which agent and tool interchange standards are becoming real, who is implementing them, and where do they overlap?" },
      { id: "out-dependency", xp: 97, lang: "en", aspect: "one-dependency",
        text: "What is everyone else's single biggest dependency, and who has managed to build something serious without one?" },
      { id: "out-sv-oppna-vikter", xp: 98, lang: "sv", aspect: "open-weights",
        text: "Vad har hänt med öppna modellvikter den senaste tiden — vilka släpp är faktiskt användbara, och vilka licenser följde med?" },
      { id: "out-contrast", xp: 99, lang: "en", aspect: "contrast-self",
        text: "Take the choices this project has made and hold them against what the outside world is doing. Where are we clearly out of step, and is that good or bad?" },
      { id: "out-sandbox", xp: 100, lang: "en", aspect: "sandbox-tech",
        text: "Who else is running real code execution inside the browser, what are they using to do it, and how does it compare to running it server-side?" },
      { id: "out-eval", xp: 101, lang: "en", aspect: "eval-benchmarks",
        text: "What benchmarks are people using to evaluate research agents, and do any of them measure something that matters to a real user?" },
      { id: "out-sv-lokal", xp: 102, lang: "sv", aspect: "local-inference",
        text: "Vad händer inom lokal inferens på egen hårdvara just nu, och vilka projekt är värda att följa för den som vill slippa molnet?" },
      { id: "out-pricing", xp: 103, lang: "en", aspect: "pricing-moves",
        text: "How have model providers moved on pricing recently, and what does that change for a product that lets users bring their own key?" },
      { id: "out-sv-integritet", xp: 104, lang: "sv", aspect: "sv-privacy",
        text: "Vilka integritetsinriktade AI-assistenter har lanserats på sistone, och vad lovar de egentligen när man läser det finstilta?" },
      { id: "out-feed", xp: 105, lang: "en", aspect: "feed-state",
        text: "Summarise what is currently in the outward feed, lens by lens, and tell me which lens has the least in it right now." },
      { id: "out-strategy", xp: 106, lang: "en", aspect: "strategy",
        text: "Based on what everyone else shipped recently, what is the single most defensible thing this project should build next?" },
      { id: "out-sv-arkitektur", xp: 107, lang: "sv", aspect: "sv-architecture",
        text: "Hur bygger andra sina AI-applikationer nu, och finns det något arkitekturval där vi ligger uppenbart efter?" },
      { id: "out-tooling", xp: 108, lang: "en", aspect: "tooling",
        text: "What tooling has appeared recently for building agent products, and which of it would actually replace something we maintain by hand?" },
      { id: "out-gap", xp: 109, lang: "en", aspect: "gap-check",
        text: "Which of the seven standing questions in the feed has the thinnest coverage, and what search would fill it fastest?" },
      { id: "out-sv-djupforskning", xp: 110, lang: "sv", aspect: "deep-research",
        text: "Vilka andra djupforskningsverktyg finns det, och vad gör de bättre än det här? Var ärlig om var vi ligger efter." },
      { id: "out-sv-standarder", xp: 111, lang: "sv", aspect: "agent-standards",
        text: "Vilka standarder för agenter och verktygsanrop börjar bli verkliga, och hur står sig våra egna format bredvid dem?" },
      { id: "out-open-weights", xp: 112, lang: "en", aspect: "open-weights",
        text: "Which recent open-weight model releases are genuinely usable in production, and what are the licence terms people keep getting wrong?" },
    ],


    // =====================================================================
    // models — the agent whose subject is the models themselves. Its openers
    // have a job the others do not: get the visitor to the moment where a price
    // and a verification checklist are on screen next to a model they might
    // actually run. So most of these are shaped as decisions ("which one, what
    // does it cost, what has it passed") rather than as background reading, and
    // several name a concrete constraint — a language, a modality, a context
    // length — because a constraint is what makes the catalog ranking do
    // something visible.
    // =====================================================================
    models: [
      { id: "mdl-cheapest-vision", xp: 113, lang: "en", aspect: "vision-model",
        text: "Which is the cheapest model I can run here that reads images, and what would one research turn cost me?" },
      { id: "mdl-swedish", xp: 114, lang: "en", aspect: "sv-language",
        text: "Which model handles Swedish best right now — across every provider — and what does it cost per million tokens?" },
      { id: "mdl-compare-price", xp: 115, lang: "en", aspect: "cost-compare",
        text: "Compare the models I have enabled on price, context length and which verification checks they pass." },
      { id: "mdl-longctx", xp: 116, lang: "en", aspect: "context-window",
        text: "I need at least 200k tokens of context. Which models can do that, and what is the cheapest of them?" },
      { id: "mdl-licence", xp: 117, lang: "en", aspect: "licence",
        text: "Which of the models I could enable are usable commercially, and which licences trip people up?" },
      { id: "mdl-tools", xp: 118, lang: "en", aspect: "tool-support",
        text: "Which models here support real tool calling, and has that been verified or only claimed?" },
      { id: "mdl-small", xp: 119, lang: "en", aspect: "small-models",
        text: "What is the smallest model that still writes decent research prose, and what does running it cost compared with a flagship?" },
      { id: "mdl-benchmarks", xp: 120, lang: "en", aspect: "benchmark-claims",
        text: "A model card claims state-of-the-art results. How would I check that claim against independent evaluations?" },
      { id: "mdl-selfhost", xp: 121, lang: "en", aspect: "self-host",
        text: "Which recent open-weight models fit on a single 24GB GPU, and what quantization do people actually run them at?" },
      { id: "mdl-family", xp: 122, lang: "en", aspect: "model-family",
        text: "Walk me through the current Qwen family: which sizes exist, what each is for, and which one I should enable here." },
      { id: "mdl-quant", xp: 123, lang: "en", aspect: "quantization",
        text: "What does an FP8 or 1-bit variant actually cost me in quality, and are any of them served here?" },
      { id: "mdl-dataset", xp: 124, lang: "en", aspect: "dataset",
        text: "Which open datasets are people using to fine-tune for Nordic languages, and what are their licence terms?" },
      { id: "mdl-paper", xp: 125, lang: "en", aspect: "paper",
        text: "Summarise the most-discussed papers on the Hub this month and say which ones changed anything practical." },
      { id: "mdl-provider", xp: 126, lang: "en", aspect: "provider-choice",
        text: "The same model is served by several providers at different prices. How should I choose between them?" },
      { id: "mdl-sv-vilken", xp: 127, lang: "sv", aspect: "sv-pick",
        text: "Vilken modell ska jag köra för svensk text, och vad kostar den per miljon tokens?" },
      { id: "mdl-sv-billigast", xp: 128, lang: "sv", aspect: "sv-cost",
        text: "Vilken är den billigaste modellen här som ändå klarar längre resonemang? Visa prislappen." },
      { id: "mdl-sv-licens", xp: 129, lang: "sv", aspect: "sv-licence",
        text: "Vilka av modellerna får jag använda kommersiellt, och vad är den vanligaste licensfällan?" },
      { id: "mdl-sv-jamfor", xp: 130, lang: "sv", aspect: "cost-compare",
        text: "Jämför de modeller jag kan aktivera på pris, kontextfönster och vilka kontroller de klarat." },
      { id: "mdl-sv-egen-server", xp: 131, lang: "sv", aspect: "self-host",
        text: "Vilka öppna modeller kan jag köra på egen hårdvara i stället, och vad krävs?" },
      { id: "mdl-sv-nyheter", xp: 132, lang: "sv", aspect: "open-weights",
        text: "Vad har hänt med öppna vikter den senaste tiden, och är något av det värt att aktivera här?" },
    ],

    // =====================================================================
    // agent-builder — Agent Studio. The logs are unambiguous: people type
    // "build me a <thing>". The failure mode is the opposite of
    // outrospection's — not too vague to retrieve, but too vague to BUILD, so
    // the model asks a question instead of shipping (chat_logs #584 is a user
    // complaining about exactly that). So every entry names the thing, its
    // behaviour, and enough of a look to render.
    // =====================================================================
    "agent-builder": [
      { id: "agb-legal", xp: 133, lang: "en", aspect: "single-purpose", rank: 3.25, evidence: "2026-07-26T07-34-22-617Z",
        text: "Build a single-purpose legal-research agent in deep blue: it takes a question, cites statute and case law, and always flags when it is out of date." },
      { id: "agb-tutor", xp: 134, lang: "en", aspect: "tutor", rank: 4.65, evidence: "2026-07-26T07-34-22-617Z",
        text: "Build a Socratic tutor: the user names a subject and it teaches by asking one guiding question at a time, never giving the answer outright." },
      { id: "agb-news", xp: 135, lang: "en", aspect: "visual-app", rank: 4.4, evidence: "2026-07-26T07-34-22-617Z",
        text: "Build a news reader that shows a headline, a two-line summary and a large image per story, in a dense scrollable column." },
      { id: "agb-minimal", xp: 136, lang: "en", aspect: "minimal-client", rank: 4.65, evidence: "2026-07-26T07-34-22-617Z",
        text: "Distil a stripped-down single-file client with nothing but a prompt box, a model picker and a send button. No settings, no history." },
      { id: "agb-sv-studie", xp: 137, lang: "sv", aspect: "sv-study",
        text: "Bygg en svenskspråkig studiehjälp: användaren klistrar in en text och får en sammanfattning, tre instuderingsfrågor och ett svarsfacit." },
      { id: "agb-palette", xp: 138, lang: "en", aspect: "tool-app",
        text: "Build a single-page colour palette picker: pick a base colour, get a five-colour palette with hex codes and a one-click copy for each." },
      { id: "agb-sql", xp: 139, lang: "en", aspect: "dev-tool",
        text: "Build a SQL helper: the user describes their tables and what they want to know, and it drafts the query, explains the joins and suggests an index." },
      { id: "agb-standup", xp: 140, lang: "en", aspect: "summarizer",
        text: "Build a standup summariser: paste messy notes from the day, get a tidy three-line update — done, doing, blocked — ready to paste into a channel." },
      { id: "agb-compare", xp: 141, lang: "en", aspect: "comparison-tool",
        text: "Build a text comparison agent: the user pastes two versions and it returns what changed in meaning, not just which characters differ." },
      { id: "agb-sv-agent", xp: 142, lang: "sv", aspect: "sv-agent",
        text: "Bygg en svenskspråkig researchagent utan webbsök, med djupreglage och ett lugnt mörkgrönt tema. Den ska svara kortfattat och alltid källhänvisa." },
      { id: "agb-roleplay", xp: 143, lang: "en", aspect: "role-play",
        text: "Build a role-play agent that stays in a character the user defines at the start, and breaks character only when asked to explain itself." },
      { id: "agb-quiz", xp: 144, lang: "en", aspect: "quiz",
        text: "Build a quiz agent: it picks a topic, asks five multiple-choice questions one at a time, scores the run and explains every wrong answer." },
      { id: "agb-convert", xp: 145, lang: "en", aspect: "converter",
        text: "Build a unit and currency converter that accepts a sentence like a person would write it and answers with the number and the working." },
      { id: "agb-dashboard", xp: 146, lang: "en", aspect: "dashboard",
        text: "Build a single-page dashboard that takes pasted CSV and renders a sortable table plus one chart, with no server and no upload." },
      { id: "agb-platform", xp: 147, lang: "en", aspect: "platform-distill",
        text: "Distil this whole site into a new two-tier platform for a different subject area, and tell me which modules I would have to rewrite." },
      { id: "agb-secure", xp: 148, lang: "en", aspect: "distill-secure",
        text: "Build me a client-side-only assistant that keeps the browser-direct privacy posture of the secure tier but drops everything else." },
      { id: "agb-writing", xp: 149, lang: "en", aspect: "writing-aid",
        text: "Build a writing agent that rewrites a paragraph three ways — plainer, shorter and more formal — and shows them side by side." },
      { id: "agb-sv-recept", xp: 150, lang: "sv", aspect: "data-app",
        text: "Bygg en receptagent: användaren skriver vad som finns hemma och får tre recept med tydliga steg och ungefärlig tillagningstid." },
      { id: "agb-game", xp: 151, lang: "en", aspect: "game",
        text: "Build a small guessing game in a single page: the agent thinks of something, the user asks yes-or-no questions, and it tracks the count." },
      { id: "agb-themed", xp: 152, lang: "en", aspect: "themed-agent",
        text: "Build a research agent themed like a terminal — monospace, amber on black, a blinking cursor — that answers tersely and always cites sources." },
      { id: "agb-sv-kundtjanst", xp: 153, lang: "sv", aspect: "single-purpose",
        text: "Bygg en kundtjänstagent som svarar på frågor om öppettider, frakt och returer, och som säger till tydligt när den inte vet." },
      { id: "agb-data", xp: 154, lang: "en", aspect: "data-app",
        text: "Build an agent that turns a pasted table into three plain-language observations about what the numbers actually show." },
      { id: "agb-sv-skrivhjalp", xp: 155, lang: "sv", aspect: "writing-aid",
        text: "Bygg en skrivhjälp som skriver om ett stycke på tre sätt — enklare, kortare och mer formellt — och visar dem bredvid varandra." },
      { id: "agb-sv-quiz", xp: 156, lang: "sv", aspect: "quiz",
        text: "Bygg en quizagent på svenska: den ställer fem flervalsfrågor om ett ämne, en i taget, rättar och förklarar varje fel svar." },
    ],

    // =====================================================================
    // under-construction — the copy-me archetype for a brand-new agent. It
    // has no behaviour of its own, so its starters are not research questions
    // at all: they are the questions you work THROUGH to shape a new agent.
    // The strip is a checklist you can click.
    // =====================================================================
    "under-construction": [
      { id: "unc-purpose", xp: 157, lang: "en", aspect: "purpose",
        text: "Help me decide what this agent should do. Ask me what problem it solves, then write a one-sentence tagline I can put on it." },
      { id: "unc-tier", xp: 158, lang: "en", aspect: "tier-choice",
        text: "Should this agent run in the browser or on the server? Walk me through the trade-off for the use case I describe." },
      { id: "unc-controls", xp: 159, lang: "en", aspect: "controls",
        text: "Which controls should this agent's input pane have, and which ones would just be clutter for what it does?" },
      { id: "unc-theme", xp: 160, lang: "en", aspect: "theme",
        text: "Suggest a colour theme and loading animation that fit an agent for the subject I name, and explain why they fit." },
      { id: "unc-examples", xp: 161, lang: "en", aspect: "examples",
        text: "Write me a first set of example questions for this agent that show off what it does without needing a follow-up." },
      { id: "unc-capability", xp: 162, lang: "en", aspect: "capability",
        text: "Which answer phase should this agent use, and what does picking each one actually change about how a turn runs?" },
      { id: "unc-prompts", xp: 163, lang: "en", aspect: "prompts",
        text: "Which prompt set should this agent use, and what would I be giving up by choosing a different one?" },
      { id: "unc-search", xp: 164, lang: "en", aspect: "search-policy",
        text: "Should this agent search the web by default? Explain what changes for cost, latency and answer quality either way." },
      { id: "unc-sv-syfte", xp: 165, lang: "sv", aspect: "sv-purpose",
        text: "Hjälp mig formulera vad den här agenten ska göra, för vem, och vad den uttryckligen inte ska göra." },
      { id: "unc-gates", xp: 166, lang: "en", aspect: "gates",
        text: "What routing gates would this agent need, and how do I make sure each one handles Swedish as well as it handles English?" },
      { id: "unc-bounds", xp: 167, lang: "en", aspect: "bounds",
        text: "What bounds should this agent run under — time, rounds, tokens — and what happens at each limit when it is reached?" },
      { id: "unc-quota", xp: 168, lang: "en", aspect: "quota",
        text: "What quota should a share link for this agent carry, and how do I reason about that number rather than guessing it?" },
      { id: "unc-team", xp: 169, lang: "en", aspect: "team",
        text: "Should this agent run sub-agents? Help me work out whether the task genuinely decomposes or just looks like it does." },
      { id: "unc-events", xp: 170, lang: "en", aspect: "events",
        text: "Which progress events should this agent emit while it works, so the wait shows something honest rather than a spinner?" },
      { id: "unc-routing", xp: 171, lang: "en", aspect: "model-routing",
        text: "Explain which model runs which phase for an agent like this, and why the planning phases are not left to my chosen model." },
      { id: "unc-sv-kontroller", xp: 172, lang: "sv", aspect: "sv-controls",
        text: "Vilka reglage och val bör finnas i inmatningsfältet för en agent som ska göra det jag beskriver? Motivera varje val." },
      { id: "unc-derive", xp: 173, lang: "en", aspect: "derive",
        text: "Which existing agent should I copy as the starting point for what I want to build, and what exactly would I change?" },
      { id: "unc-publish", xp: 174, lang: "en", aspect: "publish",
        text: "Walk me through what happens when I publish this agent: where it lives, who can reach it, and what it is allowed to do once live." },
      { id: "unc-sv-validera", xp: 175, lang: "sv", aspect: "validate",
        text: "Hur vet jag att min agentdefinition är giltig, och vilka regler är det som kontrolleras när den valideras?" },
      { id: "unc-naming", xp: 176, lang: "en", aspect: "naming",
        text: "Help me name this agent and write the one line that appears under the name, given the purpose I describe." },
      { id: "unc-sv-exempel", xp: 177, lang: "sv", aspect: "examples",
        text: "Skriv förslag på startfrågor för den här agenten som visar vad den kan utan att användaren behöver ställa en följdfråga." },
      { id: "unc-sv-avgransning", xp: 178, lang: "sv", aspect: "bounds",
        text: "Hjälp mig sätta rimliga gränser för hur länge och hur djupt den här agenten får arbeta på en enskild fråga." },
      { id: "unc-sv-harled", xp: 179, lang: "sv", aspect: "derive",
        text: "Vilken befintlig agent bör jag utgå från för det jag vill bygga, och exakt vad skulle jag behöva ändra?" },
    ],
    // =====================================================================
    // palaeogenomics — ancient DNA. The taxonomy splits the way the agent's
    // two legs split, and that split IS the editorial rule here: a starter is
    // either a STRUCTURED question the sample corpus can answer exactly (a
    // region, a date window, a haplogroup, a coverage floor) or a LITERATURE
    // question Europe PMC can answer with papers. A starter that straddles
    // both gets a worse answer than either leg would give alone, because the
    // corpus block and the citations end up arguing about different things.
    //
    // Every entry names its caveat-bearing subject deliberately: coverage,
    // dating, contamination and reference panels are where non-specialists go
    // wrong in this field, so the openers put them in front of the user rather
    // than waiting for a follow-up. Unranked — no eval run has scored this
    // queue yet (invariant 5: a rank cites the run that produced it).
    // =====================================================================
    palaeogenomics: [
      { id: "pal-geo-gotland", xp: 218, lang: "en", aspect: "geo-radius",
        text: "Which published ancient individuals lie within 300 km of Gotland, and how do they spread across the Neolithic and the Bronze Age?" },
      { id: "pal-sv-uppland", xp: 219, lang: "sv", aspect: "sv-samples",
        text: "Vilka forntida individer i databasen kommer från Uppland, hur väl täckta är deras genom och vilka studier publicerade dem?" },
      { id: "pal-haplo-r1b", xp: 220, lang: "en", aspect: "haplogroup",
        text: "How many individuals in the corpus carry Y-haplogroup R1b, where were they found, and what date range do they span?" },
      { id: "pal-sv-mtdna", xp: 221, lang: "sv", aspect: "sv-population",
        text: "Hur många individer i databasen har mtDNA-haplogrupp U5, var kommer de ifrån, och vad brukar det kopplas till?" },
      { id: "pal-mammoth-oldest", xp: 222, lang: "en", aspect: "mammoth-megafauna",
        text: "How old is the oldest sequenced mammoth genome, what condition was that sample in, and what sets the limit on going older?" },
      { id: "pal-coverage", xp: 223, lang: "en", aspect: "coverage-quality",
        text: "Which ancient individuals in the corpus have the highest coverage, and what analyses does that coverage actually make possible?" },
      { id: "pal-sv-wrangel", xp: 224, lang: "sv", aspect: "sv-samples",
        text: "Vad visade arvsmassan hos de sista mammutarna på Wrangelön om inavel, och hur säkra är slutsatserna om deras utdöende?" },
      { id: "pal-dating", xp: 225, lang: "en", aspect: "dating",
        text: "How is an ancient sample dated, and when a paper reports a calibrated range, what exactly is being calibrated against what?" },
      { id: "pal-contamination", xp: 226, lang: "en", aspect: "contamination",
        text: "How do laboratories tell authentic ancient DNA from modern contamination, and how strong is that evidence in practice?" },
      { id: "pal-sedadna", xp: 227, lang: "en", aspect: "sedadna",
        text: "What can sedimentary ancient DNA recover that skeletal remains cannot, and how far back in time has it been pushed so far?" },
      { id: "pal-sv-kol14", xp: 228, lang: "sv", aspect: "sv-dating",
        text: "Hur fungerar kol-14-datering av benmaterial, och varför skiljer sig okalibrerad ålder från kalibrerad?" },
      { id: "pal-deextinction", xp: 229, lang: "en", aspect: "deextinction",
        text: "What would actually be required to bring back the woolly mammoth, and which of those steps have been demonstrated rather than proposed?" },
      { id: "pal-preservation", xp: 230, lang: "en", aspect: "preservation",
        text: "Why does permafrost preserve DNA so much better than temperate soil, and what is the practical age limit in each setting?" },
      { id: "pal-yamnaya", xp: 231, lang: "en", aspect: "population-history",
        text: "What does the genetic evidence say about the Yamnaya expansion into Europe, and which sampled individuals carry that argument?" },
      { id: "pal-sv-skandinavien", xp: 232, lang: "sv", aspect: "sv-population",
        text: "Vad visar forntida DNA om vilka befolkningar som levde i Skandinavien före jordbruket, och hur många individer bygger bilden på?" },
      { id: "pal-corpus-gaps", xp: 233, lang: "en", aspect: "corpus-limits",
        text: "Which regions and periods are thinly represented in the ancient-sample corpus, and what does that absence mean for a claim about them?" },
      { id: "pal-ignore-flag", xp: 234, lang: "en", aspect: "method-caveats",
        text: "Which individuals in the corpus are flagged as unusable, why were they flagged, and what goes wrong in a result that includes them?" },
      { id: "pal-proteomics", xp: 235, lang: "en", aspect: "proteomics",
        text: "Where does ancient protein evidence reach further back than ancient DNA, and what can it resolve that sequence data cannot?" },
      { id: "pal-sv-neandertal", xp: 236, lang: "sv", aspect: "sv-method",
        text: "Vilka rön finns om neandertalarnas genetiska bidrag till dagens människor, och hur mäter man en sådan andel?" },
      { id: "pal-reference-panel", xp: 237, lang: "en", aspect: "reference-panel",
        text: "Why does an ancestry analysis need present-day reference populations, and how much does the choice of panel change the answer?" },
      { id: "pal-isotopes", xp: 238, lang: "en", aspect: "isotopes",
        text: "What do strontium and oxygen isotopes add to a genetic study of an individual, and where do the two lines of evidence disagree?" },
      { id: "pal-sv-databas", xp: 239, lang: "sv", aspect: "corpus-limits",
        text: "Vilka delar av världen är dåligt representerade i databasen över forntida individer, och hur påverkar det slutsatserna?" },
    ],
    // =====================================================================
    // scholar — Deep Science. The editorial rule here follows from what the
    // agent structurally CANNOT do: there is no web leg, so a starter whose
    // answer lives in a news article, a vendor page or a policy document gets
    // a worse answer here than in Deep Research, not a better one. Every
    // opener below is a question the published literature has actually
    // studied.
    //
    // The second rule is that a good opener should make the agent's own
    // discipline visible rather than hide it — where the evidence is
    // contested, where the effect size is small, where a famous finding
    // failed to replicate. An agent that only ever answers settled questions
    // reads as an oracle, which is the opposite of what citing a literature
    // is for.
    //
    // Two aspects exist only here and exercise the Google Scholar legs
    // specifically: `venue-metrics` (the committed h5-index table) and
    // `author-profile` (the robots-allowed profile page). Unranked — no eval
    // run has scored this queue yet (a rank cites the run that produced it).
    // =====================================================================
    scholar: [
      { id: "sch-vitamin-d", xp: 240, lang: "en", aspect: "clinical-evidence",
        text: "Does vitamin D supplementation reduce the risk of acute respiratory infection, and how has the answer changed as the trials got larger?" },
      { id: "sch-sv-fasta", xp: 241, lang: "sv", aspect: "sv-clinical",
        text: "Vad säger den sakkunniggranskade forskningen om intermittent fasta och insulinkänslighet, och hur starka är beläggen?" },
      { id: "sch-replication", xp: 242, lang: "en", aspect: "replication",
        text: "Which findings from the social-priming literature failed to replicate, and what did the replication attempts actually measure?" },
      { id: "sch-venues-security", xp: 243, lang: "en", aspect: "venue-metrics",
        text: "Which venues publish the highest-cited work in computer security and cryptography, by Google Scholar's h5-index?" },
      { id: "sch-sv-tidskrifter", xp: 244, lang: "sv", aspect: "venue-metrics",
        text: "Vilka tidskrifter inom medicin har högst h5-index enligt Google Scholar, och vad mäter det egentligen?" },
      { id: "sch-effect-size", xp: 245, lang: "en", aspect: "effect-size",
        text: "How large is the measured effect of exercise on depression symptoms in randomised trials, and how much does it shrink in the best-controlled ones?" },
      { id: "sch-meta-conflict", xp: 246, lang: "en", aspect: "disagreement",
        text: "Where do the meta-analyses of dietary salt reduction and cardiovascular outcomes disagree, and what explains the disagreement?" },
      { id: "sch-sv-skarm", xp: 247, lang: "sv", aspect: "sv-clinical",
        text: "Finns det belägg i forskningen för att skärmtid påverkar barns sömn, och hur väl kontrollerade är de studierna?" },
      { id: "sch-author-profile", xp: 248, lang: "en", aspect: "author-profile",
        text: "Looking at https://scholar.google.com/citations?user=JicYPdAAAAAJ — what is this researcher's most-cited work, and which of it is actually peer-reviewed?" },
      { id: "sch-retractions", xp: 249, lang: "en", aspect: "retraction",
        text: "What did the retracted papers on beta-amyloid and Alzheimer's actually claim, and how much of the later literature was built on them?" },
      { id: "sch-microplastics", xp: 250, lang: "en", aspect: "emerging",
        text: "What has been measured, rather than speculated, about microplastics in human tissue, and how reliable are the detection methods?" },
      { id: "sch-sv-vaxthus", xp: 251, lang: "sv", aspect: "sv-method",
        text: "Vad visar den granskade forskningen om koldioxidupptag i återställda våtmarker, och hur mäts det i fält?" },
      { id: "sch-ml-benchmarks", xp: 252, lang: "en", aspect: "cs-evidence",
        text: "What does the peer-reviewed literature say about benchmark contamination in language-model evaluation, as opposed to what the preprints say?" },
      { id: "sch-p-hacking", xp: 253, lang: "en", aspect: "method-critique",
        text: "How much of the published psychology literature shows signs of p-hacking, and how was that estimated?" },
      { id: "sch-sv-antibiotika", xp: 254, lang: "sv", aspect: "sv-clinical",
        text: "Hur snabbt utvecklas antibiotikaresistens enligt publicerade studier, och vilka åtgärder har mätbar effekt?" },
      { id: "sch-cochrane", xp: 255, lang: "en", aspect: "systematic-review",
        text: "What do the Cochrane reviews conclude about mindfulness-based interventions for chronic pain, and how certain is the evidence graded?" },
      { id: "sch-open-access", xp: 256, lang: "en", aspect: "scholarly-system",
        text: "What does the research on open-access publishing find about citation advantage, once self-selection is controlled for?" },
      { id: "sch-preprint-gap", xp: 257, lang: "en", aspect: "peer-review-itself",
        text: "How often do preprints change substantively between posting and peer-reviewed publication, and what changes most?" },
      { id: "sch-sv-kost", xp: 258, lang: "sv", aspect: "sv-clinical",
        text: "Vad säger de största kohortstudierna om rött kött och hjärt-kärlsjukdom, och var ligger osäkerheten?" },
      { id: "sch-citation-bias", xp: 259, lang: "en", aspect: "method-critique",
        text: "What is the evidence that citation counts measure impact rather than visibility, and who has tried to separate the two?" },
    ],
  },
};


// ---------------------------------------------------------------------------
// CANDIDATES — questions we are CONSIDERING adding to a queue, but have not.
//
// Evaluation mode serves one of these per batch (the `candidate` band). They
// are not shown to ordinary visitors, carry no rank, and are not counted by
// validateStarters — that is the point: this is the trial pool. A candidate
// that reviews well gets moved into the named agent's queue with its evidence;
// one that reviews badly is deleted, and the reason goes in the ledger.
//
// The current set was chosen to attack the gaps the first machine battery
// left, rather than to be a grab-bag of nice questions:
//
//   · `secure` had ZERO evaluated starters — the harness cannot drive a tier
//     whose whole design keeps the server out of the data path, so a human is
//     the only instrument that reaches it. It gets the largest share here.
//   · `outrospection` was the one agent below the shortlist floor (mean 2.99),
//     and main has since merged a retrieval fix (PR #271). These candidates
//     are shaped to re-probe it from angles the existing queue does not.
//   · Several aspects are declared in ASPECTS but had no starter yet; those
//     are filled here first so a bad idea never reaches a visitor's strip.
//
// Shape: { id, xp, text, agent, aspect, lang, note }. `note` says what this
// candidate is TESTING — read it before judging the answer. Candidates share
// the one #XP number space with the queues, so a candidate that gets promoted
// keeps the number the review that promoted it cited.
// ---------------------------------------------------------------------------

/** @type {Array<{id:string,xp:number,text:string,agent:string,aspect:string,lang:string,note:string}>} */
export const CANDIDATES = [
  // --- secure: the tier no machine battery can reach -----------------------
  { id: "cand-sec-proof", xp: 180, agent: "secure", aspect: "verify-claims", lang: "en",
    text: "Prove to me, using something I can check myself right now in this browser, that this conversation is not reaching your server.",
    note: "Can the client tier substantiate its central claim on demand, or does it just restate it?" },
  { id: "cand-sec-compare", xp: 181, agent: "secure", aspect: "tier-compare", lang: "en",
    text: "I am choosing between the browser-only version and the signed-in one for confidential work. Walk me through the actual trade-off, not the marketing.",
    note: "Tests whether the tier can argue against itself honestly — the answer should name what Se/cure gives up." },
  { id: "cand-sec-sv-nyckel", xp: 182, agent: "secure", aspect: "key-handling", lang: "sv",
    text: "Jag har klistrat in min API-nyckel men får ett fel när jag ställer en fråga. Hjälp mig felsöka steg för steg.",
    note: "The most common real Se/cure failure (chat_logs #573-#579 are all key/provider trouble). A first message that is a support request." },
  { id: "cand-sec-leave", xp: 183, agent: "secure", aspect: "data-exposure", lang: "en",
    text: "List every network request this page makes during one of my questions, and what each one carries.",
    note: "The hardest honest question for this tier. A vague answer here is a real product gap." },

  // --- outrospection: re-probe after the PR #271 retrieval fix -------------
  { id: "cand-out-lens", xp: 184, agent: "outrospection", aspect: "feed-state", lang: "en",
    text: "Go through the feed lens by lens and tell me, for each one, the single most interesting thing in it right now.",
    note: "Forces every lens to be touched. Re-probe after PR #271; the old queue asked about one lens at a time." },
  { id: "cand-out-disagree", xp: 185, agent: "outrospection", aspect: "contrast-self", lang: "en",
    text: "Find something in the feed that suggests a choice this project made is wrong, and make the strongest case for the other side.",
    note: "Tests whether outrospection can be genuinely adversarial about its own product rather than flattering it." },
  { id: "cand-out-sv-lage", xp: 186, agent: "outrospection", aspect: "sv-outward", lang: "sv",
    text: "Sammanfatta vad som hänt utanför det här projektet den senaste tiden som faktiskt borde påverka vår färdplan.",
    note: "Swedish + a demand for consequence rather than a list. The 2.35-scoring starters both produced lists." },

  // --- research: aspects declared but unfilled, and shapes the battery missed
  { id: "cand-res-followup", xp: 187, agent: "research", aspect: "multihop", lang: "en",
    text: "I am buying a used electric car in Sweden. Tell me what actually determines battery health, how to check it before buying, and what it costs to replace.",
    note: "A real purchase decision with three chained sub-questions — the shape chat_logs shows people actually bring." },
  { id: "cand-res-sv-myndighet", xp: 188, agent: "research", aspect: "sv-civic", lang: "sv",
    text: "Vad gäller för att överklaga ett kommunalt beslut i Sverige, vilka tidsfrister finns, och vart skickar man överklagandet?",
    note: "Swedish civic procedure — the aspect that scored best (4.4/4.25) but has only two starters." },
  { id: "cand-res-conflict", xp: 189, agent: "research", aspect: "contested", lang: "en",
    text: "Give me the strongest evidence on both sides of whether ultra-processed food causes harm beyond calories, and say which side is currently better supported.",
    note: "Tests whether the pipeline will commit to a verdict after presenting a genuine conflict, or hedge." },

  // --- introspection: the diagram case scored lowest (3.70) ----------------
  { id: "cand-int-draw-privacy", xp: 190, agent: "introspection", aspect: "diagram", lang: "en",
    text: "Draw me the privacy boundary: what crosses it, what never does, and where the two deliberate exceptions sit.",
    note: "int-diagram scored 3.70, the weakest introspection starter. Is the diagram weakness general, or specific to the pipeline diagram?" },
  { id: "cand-int-worst", xp: 191, agent: "introspection", aspect: "security-assessment", lang: "en",
    text: "What is the single worst piece of code in this project, and what would you do about it?",
    note: "Tests whether introspection will be critical of its own source rather than describing it approvingly." },

  // --- orchestrator: the strongest agent, so probe where it might break ----
  { id: "cand-orc-thin", xp: 192, agent: "orchestrator", aspect: "parallel-drill", lang: "en",
    text: "Is it worth learning a second programming language this year? Decompose that properly and give me a real answer.",
    note: "A question that does NOT obviously decompose. Does the orchestrator over-apply its machinery to a simple ask?" },
  { id: "cand-orc-sv-jamfor", xp: 193, agent: "orchestrator", aspect: "option-scoring", lang: "sv",
    text: "Jämför tre sätt att värma ett hus i Sverige — bergvärme, luft-vatten och fjärrvärme — med en agent per alternativ, och rangordna dem.",
    note: "Swedish + a domestic decision. The orchestrator's Swedish coverage is thin and untested." },

  // --- agent-builder: agb-legal (3.25) stopped short of shipping -----------
  { id: "cand-agb-ship", xp: 194, agent: "agent-builder", aspect: "tool-app", lang: "en",
    text: "Build and publish a working pomodoro timer with a start button, a countdown and a sound at zero. I want the link, not the code.",
    note: "agb-legal scored 3.25 for producing files but no live link. Does saying 'I want the link' change the outcome?" },
  { id: "cand-agb-sv-verktyg", xp: 195, agent: "agent-builder", aspect: "sv-agent", lang: "sv",
    text: "Bygg och publicera en enkel svensk stavnings- och grammatikhjälp där jag klistrar in text och får rättelser med förklaring.",
    note: "Swedish build request end to end. Agent Studio's Swedish path has never been evaluated." },

  // --- the 2026-07-29 wave ---------------------------------------------------
  //
  // Evaluation mode now serves NEW questions every render (owner directive), so
  // the pool has to keep gaining material or the reviewer walks the same 175 to
  // the end and stops. This wave is aimed, not decorative:
  //
  //   · The three aspects still declared with no starter anywhere —
  //     models/pick-a-model, models/fine-tune, orchestrator/sv-multi. An unused
  //     aspect is a way in nobody has tried; filling it here means a bad idea
  //     gets reviewed before it can reach a visitor's strip.
  //   · `secure` again gets the largest share, for the same reason as the first
  //     wave: no server endpoint can drive that tier, so a human reviewer is
  //     the only instrument that reaches it and every one of its questions is
  //     worth more than a machine-scored one elsewhere.
  //   · Shapes the queues under-serve: a starter that asks the agent to say it
  //     CANNOT do something, and openers written as a task rather than a
  //     question (the two failure modes the editorial rule names).

  // --- models: the two aspects nothing has ever filled ----------------------
  { id: "cand-mod-pick", xp: 196, agent: "models", aspect: "pick-a-model", lang: "en",
    text: "I write Swedish legal summaries and I care about accuracy far more than speed. Pick one model from the catalogue for me and defend the choice.",
    note: "pick-a-model is declared but empty — the most obvious thing a newcomer wants from a Models agent. Does it commit to ONE, or hedge into a table?" },
  { id: "cand-mod-finetune", xp: 197, agent: "models", aspect: "fine-tune", lang: "en",
    text: "I have about 2,000 support tickets with good answers. Is fine-tuning a small open model actually worth it here, or should I use retrieval instead?",
    note: "fine-tune is declared but empty. Tests whether the agent will argue AGAINST the thing the question proposes when retrieval is the better answer." },
  { id: "cand-mod-sv-liten", xp: 198, agent: "models", aspect: "small-models", lang: "sv",
    text: "Vilken liten öppen modell klarar svenska bäst om den ska köras på en vanlig laptop, och hur mycket sämre blir den än en stor molnmodell?",
    note: "Swedish + small-model routing, and it demands a magnitude for the trade-off rather than a verdict. The models queue has one small-models starter and it is English." },

  // --- orchestrator: the last unfilled aspect in the registry ---------------
  { id: "cand-orc-sv-multi", xp: 199, agent: "orchestrator", aspect: "sv-multi", lang: "sv",
    text: "Vi ska anställa en utvecklare i Sverige. Sätt en agent på lön och marknad, en på anställningsformer och regler, och en på var kandidaterna faktiskt finns.",
    note: "sv-multi is the registry's last declared-but-empty aspect. Swedish AND an explicit team assignment — does the plan phase decompose in Swedish as cleanly?" },

  // --- secure: the tier only a human can evaluate ---------------------------
  { id: "cand-sec-cannot", xp: 200, agent: "secure", aspect: "explainer", lang: "en",
    text: "Tell me three things this browser-only version genuinely cannot do that the signed-in one can, and why the limit exists.",
    note: "An opener that asks the agent to state its OWN limits. The queue is full of questions it can answer well; this one is only good if the answer is honest." },
  { id: "cand-sec-workspace", xp: 201, agent: "secure", aspect: "workspace-share", lang: "en",
    text: "I want to send a colleague a working copy of this assistant with my prompts but not my API key. Walk me through exactly what they receive.",
    note: "Workspace distribution is the centrepiece concept and the queue asks about it once. 'Exactly what they receive' is the part a vague answer will skip." },
  { id: "cand-sec-sv-offline", xp: 202, agent: "secure", aspect: "offline", lang: "sv",
    text: "Jag sitter på ett flygplan utan internet. Vad av det här fungerar fortfarande, och vad slutar fungera direkt?",
    note: "Swedish + a concrete situation instead of an abstract privacy question. Tests whether the offline story survives being asked about plainly." },
  { id: "cand-sec-attach", xp: 203, agent: "secure", aspect: "attachments", lang: "en",
    text: "If I attach a PDF of a signed contract here, trace where that file goes, byte by byte, until it reaches the model.",
    note: "The attachment path is where a privacy claim is easiest to get subtly wrong. 'Byte by byte' leaves no room for a reassuring summary." },

  // --- research: shapes the queue under-serves ------------------------------
  { id: "cand-res-cannot", xp: 204, agent: "research", aspect: "unanswerable", lang: "en",
    text: "What will the Riksbank's policy rate be in December next year? Tell me straight if that is not knowable, and what the best available proxy is.",
    note: "The queue has one unanswerable starter. This one baits a confident forecast and rewards refusing it — the opposite of what most starters reward." },
  { id: "cand-res-sv-jamfor", xp: 205, agent: "research", aspect: "consumer-sv", lang: "sv",
    text: "Jag ska välja mellan att hyra och köpa en lägenhet i Göteborg de närmaste fem åren. Räkna på det med aktuella siffror och säg vad som lönar sig.",
    note: "Swedish consumer decision that needs live numbers AND arithmetic on them. The research queue's Swedish entries mostly ask for facts, not a calculation." },

  // --- introspection: ask it to be specific about its own weak spots --------
  { id: "cand-int-sv-arkitektur", xp: 206, agent: "introspection", aspect: "sv-arch", lang: "sv",
    text: "Förklara på svenska hur en fråga färdas genom systemet, från att jag trycker skicka till att svaret börjar strömma tillbaka.",
    note: "The end-to-end walkthrough in Swedish. int-pipeline scores well in English; nothing has checked whether the source excerpts survive the translation." },
  { id: "cand-int-regress", xp: 207, agent: "introspection", aspect: "testing", lang: "en",
    text: "Show me a part of this codebase where the tests would not catch a real bug, and say what test is missing.",
    note: "Introspection describing its own test coverage critically. A generic answer about testing means the retrieval did not actually read anything." },

  // --- agent-builder: the two ends of 'too vague to build' ------------------
  { id: "cand-agb-vague", xp: 208, agent: "agent-builder", aspect: "single-purpose", lang: "en",
    text: "Make me something that helps me stop losing track of small promises I make to people during the day. You choose the form and publish it.",
    note: "Deliberately under-specified but with a real problem in it. Does Agent Studio ship SOMETHING, or hand the vagueness back as questions (chat_logs #584)?" },
  { id: "cand-agb-remix", xp: 209, agent: "agent-builder", aspect: "distill-secure", lang: "en",
    text: "Take the browser-only version of this site and turn it into a private reading assistant for research papers, then publish it and give me the link.",
    note: "The distil-Se/cure-into-a-flavour path, which is the mode's stated core purpose, asked as one instruction. The queue asks for it more abstractly." },
];

export default STARTERS;

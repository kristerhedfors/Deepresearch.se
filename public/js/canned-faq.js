// @ts-check
// The prepackaged, NON-LLM "get-started helper" — a deterministic canned
// responder shared by BOTH tiers for the state BEFORE a language model is
// reachable: DeepResearch.Se/cure before an API key is configured, and
// DeepResearch.Se/rver before the visitor has signed in. In both cases there
// is no LLM to answer, so instead of a dead composer (or a bare "add a key" /
// "sign in" wall) the visitor can type a question and get a short, honest,
// prewritten answer to the common ones — what this is, how it works, privacy,
// how it's built, cost, and how to actually get running.
//
// The whole point is that it is UNMISTAKABLY not the AI talking: every reply
// carries the CANNED_LABEL badge (see the callers) so the user knows this is a
// packaged answer meant to help them get set up, not the research model. The
// content is static markdown, so it costs nothing and works with zero config.
//
// Pure and Node-safe (no DOM, no fetch) → unit-tested in canned-faq.test.js.
// Per invariant 6 (equal Swedish + English in every deterministic intent
// gate) each topic's matcher takes Swedish forms with the same breadth as
// English, and each answer is written in both languages; the reply follows the
// language the question was asked in (detectLang).

// The badge line the UI shows above every canned reply, so it can never be
// mistaken for the language model. Localized like the answers.
export const CANNED_LABEL = {
  en: "Prepackaged answer — a canned, non-AI reply to help you get started (not the language model).",
  sv: "Förpaketerat svar — ett färdigt svar utan AI, för att hjälpa dig komma igång (inte språkmodellen).",
};

// ---- language detection (deterministic, EN default) --------------------------
// Swedish diacritics OR a common Swedish function/topic word ⇒ answer in
// Swedish. Kept deliberately small and high-precision: a stray word won't flip
// an otherwise-English question, and the fallback is always English.
const SV_HINT =
  /[åäö]|\b(vad|hur|är|jag|kan|vem|varför|vilka|vilket|hej|tja|tjena|hall[åa]|tack|och|inte|det|här|den|dem|källkod|gratis|kostar|logga|konto|åtkomst|nyckel|integritet|sparar|lagra[rs]?|språk|svenska|fungerar|bygg[dt]|skillnad|säker|hjälp)\b/i;

/**
 * @param {string} text
 * @returns {"sv"|"en"}
 */
export function detectLang(text) {
  return SV_HINT.test(String(text || "")) ? "sv" : "en";
}

// ---- the tier-specific call-to-action tails ----------------------------------
// The one thing that genuinely differs by tier: how you go from "just reading"
// to actually researching. Reused across several answers and the fallback.
const START = {
  drc: {
    en: "**To research for real:** add your own OpenAI, Groq or Berget API key under the gear (Settings). DeepResearch.Se/cure runs entirely in your browser on your key — this site's server never sees it, or your messages.",
    sv: "**För att forska på riktigt:** lägg in din egen OpenAI-, Groq- eller Berget-API-nyckel under kugghjulet (Inställningar). DeepResearch.Se/cure körs helt i din webbläsare med din nyckel — den här sajtens server ser aldrig nyckeln eller dina meddelanden.",
  },
  drs: {
    en: "**To use the assistant:** sign in with the account button (top right). It's an invite-only research project, so new accounts wait for the operator's approval after signing in with Google.",
    sv: "**För att använda assistenten:** logga in med kontoknappen (uppe till höger). Det här är ett inbjudningsbaserat forskningsprojekt, så nya konton väntar på operatörens godkännande efter Google-inloggning.",
  },
};

/** @param {"drc"|"drs"} tier @param {"en"|"sv"} lang */
function startTail(tier, lang) {
  return (START[tier] || START.drs)[lang];
}

/**
 * A knowledge-base entry.
 * @typedef {Object} FaqEntry
 * @property {string} id
 * @property {RegExp[]} patterns  EN + SV matchers (invariant 6)
 * @property {(tier:"drc"|"drs", lang:"en"|"sv") => string} answer  markdown
 */

// Shared building blocks so the two tiers phrase the pair consistently
// (secure-first, full-URL form — the branding rule).
const PAIR = {
  en: "The site is an open, verifiable **pair**: DeepResearch.Se/cure (the client-side tier — research runs in your browser, the server is in no data path) and DeepResearch.Se/rver (the signed-in tier — a server buys capability like live web search and cloud sync, and protects what it handles with encryption and policy).",
  sv: "Sajten är ett öppet, verifierbart **par**: DeepResearch.Se/cure (klient-sidan — forskningen körs i din webbläsare, servern är inte i något dataflöde) och DeepResearch.Se/rver (den inloggade nivån — en server ger kapabiliteter som live-webbsökning och molnsynk, och skyddar det den hanterar med kryptering och policy).",
};

/** @type {FaqEntry[]} */
const ENTRIES = [
  {
    id: "greeting",
    patterns: [
      /^\s*(?:hi|hey|hello|yo|howdy|hiya|greetings|good\s+(?:morning|afternoon|evening))\b/i,
      /^\s*(?:hej(?:s[ae]n|hej)?|tja(?:re?na)?|tjena|halloj?|hall[åa]|god\s+(?:morgon|kväll|dag))\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? `Hej! Jag är en liten färdigskriven hjälpare — inte AI-modellen — som svarar på vanliga frågor om den här sajten så att du kommer igång. Fråga mig t.ex. *vad är det här?*, *är det privat?*, *hur är det byggt?* eller *vad kostar det?*\n\n${startTail(tier, lang)}`
        : `Hi! I'm a small prewritten helper — not the AI model — that answers common questions about this site so you can get going. Try asking me *what is this?*, *is it private?*, *how is it built?* or *what does it cost?*\n\n${startTail(tier, lang)}`,
  },
  {
    id: "whatis",
    patterns: [
      /\bwhat(?:'s| is| are)\b.*\b(?:this|deepresearch|the site|se\/?cure|se\/?rver|it)\b/i,
      // "what can this/it/the site do" is about the PRODUCT (whatis); "what
      // can you do/answer" is meta and belongs to the help topic below, so
      // "you" is deliberately excluded here.
      /\bwhat\s+can\s+(?:this|it|the site)\b/i,
      /\btell me about\b/i,
      /\bvad\s+(?:är|gör)\b.*\b(?:det här|detta|sajten|siten|sidan|deepresearch|se\/?cure|se\/?rver|den)\b/i,
      /\bberätta\s+om\b/i,
      /\bvad\s+kan\s+(?:den|sajten|man göra)\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? `DeepResearch.se är en **djup-research-assistent** och framför allt ett öppet innovations- och forskningsprojekt om vad LLM-appar kan göra för integriteten — hur långt en riktig, användbar assistent kan pressas mot *bevisbar* integritet. Beviset är sajten själv.\n\n${PAIR.sv}\n\nDen är fortfarande experimentell och inte alls produktionsfärdig.\n\n${startTail(tier, lang)}`
        : `DeepResearch.se is a **deep-research assistant** and, above all, an open innovation-and-research project into the privacy capabilities of LLM apps — how far a real, useful assistant can be pushed toward *provable* privacy. The proof is the site itself.\n\n${PAIR.en}\n\nIt's still experimental and nowhere near production-ready.\n\n${startTail(tier, lang)}`,
  },
  {
    id: "howworks",
    patterns: [
      /\bhow\s+(?:does|do|it|the site|this|you)\b.*\bwork\b/i,
      /\bwhat\s+is\s+deep\s+research\b/i,
      /\b(?:the\s+)?(?:research\s+)?pipeline\b/i,
      /\bhow\s+(?:does|do)\s+(?:you|it)\s+(?:research|answer)\b/i,
      /\bhur\s+(?:fungerar|funkar|jobbar|arbetar)\b/i,
      /\bhur\s+(?:gör|forskar|svarar)\s+(?:du|den|ni)\b/i,
      /\bvad\s+är\s+deep\s*research\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Varje fråga går genom en flerstegs-pipeline: **triage** (planera delfrågor) → **sökning/kunskapsinhämtning** → **täckningskoll** (hittar luckor och kör en runda till) → **syntes** (skriver svaret med numrerade källor) → **validering** (granskar utkastet). Det är avsiktligt **deterministiskt utan function calling** — varje steg är ett direkt anrop, så det fungerar på alla modeller. På DeepResearch.Se/rver ingår live-webbsökning; på DeepResearch.Se/cure körs stegen i webbläsaren utan live-sökning (modellens egen kunskap är källan)."
        : "Every question runs through a multi-step pipeline: **triage** (plan sub-questions) → **search / knowledge harvest** → **coverage check** (find gaps and run another round) → **synthesis** (write the answer with numbered citations) → **validation** (review the draft). It's deliberately **deterministic, with no function calling** — every phase is a direct call, so it works on any model. DeepResearch.Se/rver adds live web search; DeepResearch.Se/cure runs the phases in your browser without live search (the model's own knowledge is the source pool).",
  },
  {
    id: "privacy",
    patterns: [
      /\b(?:privacy|private|anonym\w*|incognito|ghost)\b/i,
      /\b(?:do you|does the site|will you)\b.*\b(?:store|save|keep|log|retain|track|sell)\b/i,
      /\b(?:store|save|keep|log|retain)\b.*\b(?:my|the)\b.*\b(?:data|chats?|messages?|conversations?|questions?)\b/i,
      /\bintegritet\w*\b/i,
      /\b(?:sparar|lagra[rs]?|loggar|behåller|säljer|spårar)\b.*\b(?:ni|du|sajten|mina|min|mitt)\b/i,
      /\b(?:mina|min|mitt)\s+(?:data|chattar|meddelanden|samtal|frågor)\b/i,
      /\b(?:anonymt|hemligt|privat)\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? tier === "drc"
          ? "Här (DeepResearch.Se/cure) finns **inget att logga** — servern är inte i något dataflöde. Dina meddelanden och din API-nyckel skickas direkt från din webbläsare till din leverantör (OpenAI/Groq/Berget); projektets tillstånd ligger krypterat i din egen webbläsare. \"Ingen loggning\" är inte en policy här — det finns bokstavligen inget att logga."
          : "Integriteten är delad. På DeepResearch.Se/cure är servern inte i dataflödet alls — det finns inget att logga. På DeepResearch.Se/rver processas frågor av EU-hostade modeller; samtal lagras inte på servern bortom en ≤15 min svarsbuffert, och loggar innehåller endast metadata. Vill du ha den strukturellt starkaste anonymiteten, använd DeepResearch.Se/cure (spökknappen leder dit)."
        : tier === "drc"
          ? "Here (DeepResearch.Se/cure) there is **nothing to log** — the server is in no data path. Your messages and your API key go straight from your browser to your provider (OpenAI/Groq/Berget); the project state rests encrypted in your own browser. \"No logging\" isn't a policy here — there is literally nothing to log."
          : "Privacy is split. On DeepResearch.Se/cure the server is in no data path at all — nothing to log. On DeepResearch.Se/rver, questions are processed by EU-hosted models; conversations aren't stored server-side beyond a ≤15-minute answer-recovery buffer, and logs carry metadata only. For the structurally strongest anonymity, use DeepResearch.Se/cure (the ghost button is the door to it).",
  },
  {
    id: "builtwith",
    patterns: [
      /\bhow\s+(?:are|were|is)\s+(?:you|this|the site|it)\s+(?:built|made|implemented|coded|written|programmed)\b/i,
      /\b(?:tech|technology)\s+stack\b/i,
      /\b(?:what|which)\b.*\b(?:built|made|run|running|powered)\b.*\b(?:on|with)\b/i,
      /\b(?:your|the site'?s?|this site'?s?)\s+(?:own\s+)?(?:source|code|codebase|architecture|implementation)\b/i,
      /\barchitecture\b/i,
      /\bhur\s+(?:är|blev)\s+(?:du|den|sajten|det här)\s+(?:byggd|gjord|byggt|implementerad|kodad|skriven)\b/i,
      /\b(?:teknik|teknisk)\s*stack\b/i,
      /\b(?:din|er|sajtens|sidans|webbplatsens)\s+(?:egen\s+)?(?:källkod\w*|kodbas\w*|arkitektur\w*|implementation\w*)\b/i,
      /\barkitektur\w*\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Sajten är en **Cloudflare Worker** som serverar ett statiskt chat-gränssnitt och en strömmande pipeline — ingen build-steg, minimala beroenden. Primär LLM-leverantör är Berget.ai (EU); Anthropic och OpenAI är sekundära, nyckel-gatade. Webbsökning via Exa. Allt är öppen källkod (MIT) på GitHub: github.com/kristerhedfors/Deepresearch.se. \n\nDet finns till och med ett **introspektionsläge** där assistenten svarar om sin egen källkod — men det kräver en konfigurerad modell (logga in eller lägg in en nyckel först)."
        : "The site is a **Cloudflare Worker** serving a static chat UI and a streaming pipeline — no build step, minimal dependencies. The primary LLM provider is Berget.ai (EU-hosted); Anthropic and OpenAI are secondary, key-gated. Web search is via Exa. It's all open source (MIT) on GitHub: github.com/kristerhedfors/Deepresearch.se.\n\nThere's even an **introspection mode** where the assistant answers from its own source code — but that needs a configured model (sign in, or add a key, first).",
  },
  {
    id: "opensource",
    patterns: [
      /\bopen[\s-]?source\b/i,
      /\bsource\s+code\b/i,
      /\bgit\s?hub\b/i,
      /\b(?:is it|are you)\s+open\b/i,
      /\blicen[sc]e\b/i,
      /\böppen\s+källkod\b/i,
      /\bkällkod\w*\b/i,
      /\b(?:är\s+(?:den|det|du))\s+öppen\b/i,
      /\blicens\w*\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Ja — allt är **öppen källkod under MIT** på GitHub: **github.com/kristerhedfors/Deepresearch.se**. Poängen med projektet är att varje integritetspåstående går att verifiera själv, och att koden går att återanvända."
        : "Yes — it's all **open source under MIT** on GitHub: **github.com/kristerhedfors/Deepresearch.se**. The whole point of the project is that every privacy claim is yours to verify, and the code is yours to reuse.",
  },
  {
    id: "cost",
    patterns: [
      /\b(?:cost|price|pricing|fee|charge|expensive|cheap|paid|subscription)\b/i,
      /\bhow\s+much\b/i,
      /\b(?:is it|are you|it'?s)\s+free\b/i,
      /\b(?:free|gratis)\b/i,
      /\b(?:vad|hur mycket)\s+kostar\b/i,
      /\b(?:pris|avgift|kostnad|betala|prenumeration)\w*\b/i,
      /\b(?:är\s+(?:det|den|du))\s+gratis\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? `DeepResearch.Se/cure är **gratis att använda** — du betalar bara din egen leverantör (OpenAI/Groq/Berget) för det du kör, direkt. Groq har en gratisnivå. DeepResearch.Se/rver är inbjudningsbaserat och inte kommersiellt; de hostade extrafunktionerna körs på kostnadsbärande API:er, ideellt.\n\n${startTail(tier, lang)}`
        : `DeepResearch.Se/cure is **free to use** — you only pay your own provider (OpenAI/Groq/Berget) for what you run, directly. Groq has a free tier. DeepResearch.Se/rver is invite-only and not commercial; the hosted extras run on cost-bearing APIs, not-for-profit.\n\n${startTail(tier, lang)}`,
  },
  {
    id: "access",
    patterns: [
      /\b(?:sign|log)\s?in\b/i,
      /\b(?:how do i|can i|where do i)\b.*\b(?:sign|log|register|get access|get in|join)\b/i,
      /\b(?:account|register|sign\s?up|invite|approval|access)\b/i,
      /\b(?:logga|loggar)\s+in\b/i,
      /\b(?:konto|registrera|åtkomst|inbjud\w*|godkänn\w*|tillgång)\b/i,
      /\bhur\s+(?:loggar|kommer)\s+jag\s+(?:in|åt)\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Den inloggade nivån (DeepResearch.Se/rver) är **inbjudningsbaserad**: logga in med Google (kontoknappen), så väntar ett nytt konto på operatörens godkännande. Vill du börja **direkt utan konto**, använd DeepResearch.Se/cure — det körs i din webbläsare på din egen API-nyckel."
        : "The signed-in tier (DeepResearch.Se/rver) is **invite-only**: sign in with Google (the account button) and a new account waits for the operator's approval. Want to start **right now with no account**? Use DeepResearch.Se/cure — it runs in your browser on your own API key.",
  },
  {
    id: "apikey",
    patterns: [
      /\bapi\s?key\b/i,
      /\b(?:openai|groq|berget|anthropic|claude|gpt|mistral)\b/i,
      /\b(?:add|paste|enter|configure|set up|where.*put)\b.*\bkey\b/i,
      /\bwhich\s+(?:provider|model|key)\b/i,
      /\bapi[\s-]?nyckel\b/i,
      /\b(?:lägg\s+(?:in|till)|klistra|ange|var.*lägg)\b.*\bnyckel\b/i,
      /\bvilken\s+(?:leverantör|modell|nyckel)\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? tier === "drc"
          ? "DeepResearch.Se/cure kör på **din egen** API-nyckel, skickad direkt från webbläsaren till leverantören. Stödda (CORS-dugliga): **OpenAI, Groq och Berget**. Öppna kugghjulet (Inställningar), klistra in nyckeln — leverantören känns igen automatiskt på prefixet (sk-… OpenAI, gsk_… Groq, sk_ber_… Berget) — och tryck Spara. Groq har en gratisnivå (console.groq.com); Berget är EU-hostat."
          : "På den inloggade nivån (DeepResearch.Se/rver) behöver du **ingen egen nyckel** — modellerna körs på serverns sida. Logga in med kontoknappen för att komma åt dem. Vill du använda din egen nyckel i stället, gör det i webbläsaren via DeepResearch.Se/cure (OpenAI, Groq eller Berget)."
        : tier === "drc"
          ? "DeepResearch.Se/cure runs on **your own** API key, sent straight from the browser to the provider. Supported (CORS-capable): **OpenAI, Groq and Berget**. Open the gear (Settings), paste your key — the provider is auto-detected from the prefix (sk-… OpenAI, gsk_… Groq, sk_ber_… Berget) — and press Save. Groq has a free tier (console.groq.com); Berget is EU-hosted."
          : "On the signed-in tier (DeepResearch.Se/rver) you don't need your own key — the models run server-side. Sign in with the account button to reach them. If you'd rather use your own key, do it in the browser via DeepResearch.Se/cure (OpenAI, Groq or Berget).",
  },
  {
    id: "tiers",
    patterns: [
      /\b(?:difference|differ|compare|versus|vs\.?)\b.*\b(?:se\/?cure|se\/?rver|tier|version)\b/i,
      /\bse\/?cure\b.*\bse\/?rver\b/i,
      /\bse\/?rver\b.*\bse\/?cure\b/i,
      /\b(?:which|what)\b.*\b(?:tiers?|versions?)\b.*\b(?:use|pick|choose)\b/i,
      /\b(?:the\s+)?(?:two\s+)?tiers\b/i,
      /\b(?:skillnad\w*)\b.*\b(?:se\/?cure|se\/?rver|nivå\w*|version\w*)\b/i,
      /\bvilken\s+(?:nivå|version)\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? `${PAIR.sv}\n\nKort: välj **Se/cure** för strukturell integritet utan konto (din nyckel, din webbläsare); välj **Se/rver** för mest kapabilitet (live-webbsökning, bilagor, molnsynk) bakom inloggning.`
        : `${PAIR.en}\n\nIn short: pick **Se/cure** for structural privacy with no account (your key, your browser); pick **Se/rver** for maximum capability (live web search, attachments, cloud sync) behind sign-in.`,
  },
  {
    id: "websearch",
    patterns: [
      /\b(?:can you|do you|will you|does it)\b.*\b(?:search|browse|google|look up)\b.*\b(?:web|internet|online)\b/i,
      /\bweb\s+search\b/i,
      /\b(?:real[\s-]?time|current|latest|live)\b.*\b(?:info|data|news)\b/i,
      /\b(?:kan|kcommer)\s+(?:du|den|ni)\b.*\b(?:söka|googla|leta)\b/i,
      /\bwebb?sök\w*\b/i,
      /\bsöker\s+(?:du|den|ni)\b.*\b(?:på\s+)?(?:nätet|webben|internet)\b/i,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? tier === "drc"
          ? "Live-webbsökning är en **Se/rver-funktion** (via Exa, serversidan). Här på DeepResearch.Se/cure körs pipelinen i din webbläsare utan live-sökning — modellens egen kunskap är källan, och prompterna tvingar fram den ärligheten. Vill du ha live-sökning, logga in på DeepResearch.Se/rver."
          : "Ja — DeepResearch.Se/rver planerar och kör **live-webbsökningar** (via Exa) och svarar med numrerade citat. Logga in för att använda det. (DeepResearch.Se/cure, klient-nivån, jobbar utan live-sökning.)"
        : tier === "drc"
          ? "Live web search is a **Se/rver feature** (via Exa, server-side). Here on DeepResearch.Se/cure the pipeline runs in your browser without live search — the model's own knowledge is the source, and the prompts force that honesty. Want live search? Sign in to DeepResearch.Se/rver."
          : "Yes — DeepResearch.Se/rver plans and runs **live web searches** (via Exa) and answers with numbered citations. Sign in to use it. (DeepResearch.Se/cure, the client tier, works without live search.)",
  },
  {
    id: "who",
    patterns: [
      /\bwho\s+(?:made|built|created|owns|runs|is behind)\b/i,
      /\bwho\s+are\s+you\b/i,
      /\b(?:contact|reach|email|get in touch)\b/i,
      /\bvem\s+(?:gjorde|byggde|skapade|ligger bakom|äger|driver)\b/i,
      /\bvem\s+är\s+du\b/i,
      /\b(?:kontakt\w*|maila|nå\s+er|nå\s+dig)\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Det här är ett öppet forsknings- och demonstrationsprojekt (inte en kommersiell produkt) av Krister Hedfors. Det började som ett helgbygge via Claude Code-appen på iPhone. Allt finns på GitHub: github.com/kristerhedfors/Deepresearch.se — inklusive hela bygghistorien. Och nej — jag är inte AI:n, bara en färdigskriven hjälpare."
        : "This is an open research-and-demonstration project (not a commercial product) by Krister Hedfors. It began as a weekend build via the Claude Code iPhone app. It's all on GitHub: github.com/kristerhedfors/Deepresearch.se — including the full build story. And no — I'm not the AI, just a prewritten helper.",
  },
  {
    id: "language",
    patterns: [
      /\b(?:languages?|multilingual|do you speak|svenska|swedish)\b/i,
      /\bspr[åa]k\w*\b/i,
      /\b(?:pratar|talar|förstår)\s+du\b/i,
      /\bpå\s+svenska\b/i,
    ],
    answer: (_tier, lang) =>
      lang === "sv"
        ? "Ja, svenska och engelska stöds fullt ut — både den här hjälparen och själva assistenten. Fråga på det språk du vill; den riktiga modellen svarar på samma."
        : "Yes — Swedish and English are both fully supported, by this helper and by the assistant itself. Ask in whichever you like; the real model answers in kind.",
  },
  {
    id: "help",
    patterns: [
      /\b(?:help|what can you (?:answer|do|tell)|what should i ask|commands?|menu|options)\b/i,
      /\bhj[äa]lp\w*\b/i,
      /\bvad\s+kan\s+(?:du|jag)\s+(?:svara|fråga|göra)\b/i,
      /^\s*\?+\s*$/,
    ],
    answer: (tier, lang) =>
      lang === "sv"
        ? `Jag är en färdigskriven hjälpare (inte AI:n). Jag kan svara på: **vad är det här**, **hur fungerar det**, **är det privat**, **hur är det byggt**, **öppen källkod**, **vad kostar det**, **skillnaden mellan Se/cure och Se/rver**, **webbsökning**, **språk**, och hur du **kommer igång**.\n\n${startTail(tier, lang)}`
        : `I'm a prewritten helper (not the AI). I can answer: **what this is**, **how it works**, **is it private**, **how it's built**, **open source**, **what it costs**, **the difference between Se/cure and Se/rver**, **web search**, **languages**, and how to **get started**.\n\n${startTail(tier, lang)}`,
  },
];

/**
 * Match a user message against the canned knowledge base.
 * Always returns a reply object (never null): on no topic match it returns the
 * tier-appropriate fallback, so the composer is never dead. `matched` tells the
 * caller whether a real topic was hit (vs the fallback) for optional UX (e.g.
 * nudging the settings/sign-in affordance).
 *
 * @param {string} text
 * @param {{ tier?: "drc"|"drs" }} [opts]
 * @returns {{ id: string, matched: boolean, answer: string, label: string, lang: "en"|"sv" }}
 */
export function matchCanned(text, opts = {}) {
  const tier = opts.tier === "drc" ? "drc" : "drs";
  const raw = String(text || "");
  const lang = detectLang(raw);
  const label = CANNED_LABEL[lang];
  for (const entry of ENTRIES) {
    if (entry.patterns.some((re) => re.test(raw))) {
      return { id: entry.id, matched: true, answer: entry.answer(tier, lang), label, lang };
    }
  }
  const fallback =
    lang === "sv"
      ? `Det där kan jag inte svara på — jag är en färdigskriven hjälpare (inte AI-modellen), som bara hanterar några vanliga frågor för att få dig igång. Prova *vad är det här?*, *är det privat?*, *hur är det byggt?* eller *vad kostar det?*\n\n${startTail(tier, lang)}`
      : `I can't answer that one — I'm a prewritten helper (not the AI model), handling only a few common questions to get you started. Try *what is this?*, *is it private?*, *how is it built?* or *what does it cost?*\n\n${startTail(tier, lang)}`;
  return { id: "fallback", matched: false, answer: fallback, label, lang };
}

// The topic ids, exported so tests and callers can enumerate coverage.
export const CANNED_TOPICS = ENTRIES.map((e) => e.id);

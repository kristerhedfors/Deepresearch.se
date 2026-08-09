// The SUBJECT taxonomy for the /pulse/timeline feature-focus visualization.
//
// The /pulse timeline charts, over the repo's own history, which FEATURE SETS
// ("subjects") the commit messages were talking about — so you can watch where
// focus (and, by churn, roughly where tokens) was invested as themes rise,
// compete, and fade. Each commit is tagged with ZERO up to MANY subjects
// (`tagCommit`), because a single commit routinely touches several ("Regenerate
// the source-rag index for the on-device download fix" is introspection
// artifacts + on-device). The client then buckets those tags over time to draw
// one line / stream band per subject.
//
// This is deliberately a KEYWORD HEURISTIC over the commit SUBJECT line, in the
// same spirit as build-pulse.mjs's classify() — no model, no network, just git
// text. It is tuned against the actual history (see scripts/build-pulse-timeline
// --audit) and is expected to be approximate: a subject line that never names a
// theme won't be tagged with it. When a whole class of commits is systematically
// mis-tagged, fix the patterns here, not the emitted data.
//
// Colours: entity-stable (a subject keeps its hue regardless of how active it
// is — never rank-coloured), drawn first from the data-viz reference palette's
// eight validated categorical slots for the highest-signal subjects, then a
// curated set of additional well-separated hues. Past eight simultaneously
// visible series the palette leans on the legend + direct end-labels + the
// table view as the secondary encoding (the documented mitigation), which the
// timeline page ships; by default it shows only the busiest handful. A hue
// added here is checked by OKLab distance against every existing one, not by
// eye: the bar is the palette's own closest pre-existing pair (search/storage,
// ~0.034), and no addition may tighten it.

/**
 * @typedef {Object} Subject
 * @property {string} key    stable identifier (used in the data + as the colour key)
 * @property {string} label  human name shown in the legend
 * @property {string} color  light-mode hex; dark is derived on the page
 * @property {string} blurb  one line describing the feature set
 * @property {RegExp} test   matched against the LOWERCASED commit subject
 */

/** The ordered taxonomy. Order is the legend/stacking order, not a priority. */
export const SUBJECTS = /** @type {Subject[]} */ ([
  {
    key: "sandbox",
    label: "Linux sandbox",
    color: "#2a78d6", // slot 1 · blue
    blurb: "In-browser Linux VM + bash-lite agent (CheerpX, COEP, boot, terminal).",
    test: /\b(sandbox|bash[- ]?(lite|core|agent)|cheerpx|\bvm\b|vm console|terminal|\bboot\b|boot[- ](stage|hang|messages|bar|chain)|exec (bridge|engine|timeout)|shell transcript|fenced[- ]block|\/src\b[^:]*\b(mount|sandbox|seed|seeding))\b/,
  },
  {
    key: "execenv",
    label: "Execution environments",
    color: "#00c2a8", // extended · turquoise
    blurb: "WHERE the agent's shell runs (DREE/1): the browser VM, a runner on your own machine, a per-session Cloudflare container.",
    test: /\b(execution environment(s)?|exekveringsmilj[öo](er|n)?|exec[- ]?container|cloudflare container|container image|dree|local runner|own machine|cloud execution|remote shell)\b/,
  },
  {
    key: "ondevice",
    label: "On-device inference",
    color: "#008300", // slot 2 · green
    blurb: "1-bit Bonsai models running phone-local in the browser (Se/cure); compute sharing.",
    test: /\b(on-?device|bonsai|1-?bit|phone[- ](local|inference)|in-browser (inference|engine)|inference engine|compute[- ]?sharing|beräkningsdelning|pooled capacity|lend(ing)? a local llm)\b/,
  },
  {
    key: "introspection",
    label: "Introspection & dev mode",
    color: "#e87ba4", // slot 3 · magenta
    blurb: "Ask the site about its own source; developer mode; the committed snapshot.",
    test: /\b(introspect(ion|s)?|developer[- ]mode|dev[- ]mode|dev_mode|source[- ](snapshot|investigation|rag)|source-snapshot|\btin\b|titanium)\b/,
  },
  {
    key: "search",
    label: "Web search",
    color: "#eda100", // slot 4 · yellow
    blurb: "Exa / self-hosted web search feeding the research pipeline.",
    test: /\b(exa|web[- ]?search|websearch|search (backend|service|provider|grant)|searxng|local[- ]search|browsing agent|web[- ]knob)\b/,
  },
  {
    key: "pipeline",
    label: "Research pipeline",
    color: "#1baf7a", // slot 5 · aqua
    blurb: "Triage → search → gap → synthesis → validation; budgets, notes, routing.",
    // Widened 2026-08-09: the query-writing / report-tier phases were shipping
    // under narrative subjects that never said "pipeline".
    test: /\b(pipeline|triage|synthesis|synth\b|gap[- ]check|research (depth|notes|phase|step|space|plan|planner)|research-depth|forskningsplan(en|er|erna)?|budget|time slider|answer[- ]stream|notes[- ]digest|model[- ]routing|query[- ]writing|fr[åa]geskrivning(en|ar|arna)?|report (tier|length|size|format)|rapport(niv[åa]|l[äa]ngd)(en)?|subject-vs-format)\b/,
  },
  {
    key: "hf",
    label: "Hugging Face",
    color: "#eb6834", // slot 6 · orange
    blurb: "Hugging Face Hub search as a research source.",
    test: /\b(hugging[- ]?face|\bhf\b|hfintent|hf hub|hub[- ]implied|model card)\b/,
  },
  {
    key: "arxiv",
    label: "arXiv corpus & RAG",
    color: "#1f4e79", // extended · deep navy
    blurb: "A year of arXiv harvested, embedded and searched: the index build, the full-text tier, the retrieval bake-offs.",
    test: /\b(arxiv|oai-pmh|preprint|f[öo]rtryck|vectorize (index|checkpoint)|rerank(er|ing|ed)?|omrankning|goldset|gold[- ]set|full-?text (tier|search|fetch|eval)|corpus (harvest|build))\b/,
  },
  {
    key: "pubmed",
    label: "PubMed corpus",
    color: "#3d5a80", // extended · steel blue (the second hosted corpus, beside arXiv's navy)
    blurb: "The biomedical corpus beside arXiv: the ingest runbook, the filled index, the served tier.",
    test: /\b(pubmed\w*|medline|biomedic(al|ine)|biomedicin(sk|ska)?)\b/,
  },
  {
    key: "ingest",
    label: "Corpus ingest",
    color: "#c17d11", // extended · ochre (nearest hue admin, OKLab 0.088 — the palette's
    // closest pair stays search/storage at 0.034)
    blurb: "Filling the hosted indexes: the harvest runbooks, the delta runs, the domain and named-list fills.",
    test: /\b(ingest\w*|harvest\w*|backfill\w*|oai-pmh|delta (run|ingest)|corpus (harvest|build|fill|growth)|named[- ]list (fill|ingest|sweep)|indexering(en|ar|arna)?|inl[äa]sning(en|ar|arna)?|sk[öo]rd(a|ar|arna|ade|as|en|erna)?)\b/,
  },
  {
    key: "science",
    label: "Deep Science & literature",
    color: "#00713d", // extended · deep emerald
    blurb: "The peer-reviewed agents: Deep Science, Google Scholar, palaeogenomics and the ancient-DNA corpus.",
    // `ancient (dna|…)` required a SPACE and so matched 0 commits in all of
    // history — the corpus writes "ancient-DNA". Hyphen class, both languages.
    test: /\b(deep science|djupvetenskap|scholar|palaeogenom\w*|paleogenom\w*|arkeogenetik|peer[- ]?review(ed|s|ing)?|expertgranskad|fackgranskad|europe ?pmc|ancient[- ](dna|sample|individual|genom\w*)|forntida[- ]dna|haplogroup\w*|haplogrupp\w*|radiocarbon|kolfjortonda\w*|venue metric)\b/,
  },
  {
    key: "grants",
    label: "Grants & tokens",
    color: "#4a3aa7", // slot 7 · violet
    blurb: "Se/rver TOKEN, borrowed upstream grants, quota metering, the proxy.",
    test: /\b(grant|se\/rver token|server[- ]token|se\/rver-token|jwt|proxy(?:[- ]grant| bundle| connected)?|quota|meter(ing|ed|s)?|borrowed[- ](service|capabilit)|token[- ]crypto)\b/,
  },
  {
    key: "secure",
    label: "Se/cure tier",
    color: "#e34948", // slot 8 · red
    blurb: "The never-cloud client tier: /cure, the drc-* modules, privacy markers.",
    test: /\b(se\/cure|\/cure\b|\bdrc\b|drc-|privacy (marker|notice|eye|split)|client-side tier|browser-direct|sealed browser)\b/,
  },
  {
    key: "workspaces",
    label: "Secure workspaces",
    color: "#7a5195", // extended · plum
    blurb: "Offline workspace links, the cloned crypto, the DRSW bundle standard.",
    test: /\b(workspace|drsw|umbrella|share (icon|as a header)|carries-anything)\b/,
  },
  {
    key: "providers",
    label: "LLM providers & models",
    color: "#ef5675", // extended · rose
    blurb: "Berget/Anthropic/OpenAI registry, model catalog, per-model profiles.",
    test: /\b(anthropic|openai|\bgpt-|claude-|berget|provider(s|[- ]registry|[- ]region)?|model (profile|catalog|dropdown|matrix|row)|mistral)\b/,
  },
  {
    key: "storage",
    label: "Storage & crypto",
    color: "#ffa600", // extended · amber
    blurb: "Chat-history encryption, the key hierarchy, cloud storage, RAG, the vault.",
    test: /\b(storage|encrypt(ion|ed)?|ciphertext|vault|key hierarchy|cloud storage|server_history|\brag\b|r2\b|\bd1\b|sealed[- ]crypto|\.drc backup|history (pane|pane h\d+|list|record))\b/,
  },
  {
    key: "maps",
    label: "Maps & geo intel",
    color: "#00a0b0", // extended · teal
    blurb: "Google Maps / Street View, Nominatim geocode, Shodan host intel.",
    test: /\b(maps?|street[- ]?view|geocode|nominatim|shodan|geo-?intel|coordinate|travel|route|nearest|here[- ]am[- ]i|here-asks|go-there|destination|relocation|teleport|places search|\bpov\b|image-deck|location-biased)\b/,
  },
  {
    key: "sdk",
    label: "DistillSDK & standards",
    color: "#845ec2", // extended · indigo
    blurb: "The sdk/ pair abstraction, DRPL/DRSW interchange standards, the stackless vision.",
    test: /\b(agent-pair|distillsdk|\bsdk\b|drpl|pair-(cli|studio|generator|architecture)|manifest|interchange|stackless|baseplate|exec-engine module|vm toolchain)\b/,
  },
  {
    key: "agents",
    label: "Agent platform & Studio",
    color: "#586e26", // extended · moss (the Agent Studio green family)
    blurb: "Agents as data: the Agents SDK, agent specs and their capability block, the registry, Agent Studio.",
    test: /\b(agent studio|agent builder|agents? sdk|agent[- ](spec|registry|platform|card|team|flavour|flavor)|agentspec|default agents?|standardagent(er)?|capability block|f[öo]rm[åa]gebl?ock|agents\.json|an agent is|agents are)\b/,
  },
  {
    key: "starters",
    label: "Starter prompts",
    color: "#e0479e", // extended · fuchsia
    blurb: "The four opening questions on an empty chat and the cross-agent queue that ranks them.",
    test: /\b(starter[- ]?prompts?|starter (strip|queue|eval|evaluation)|opening questions|startprompt(en|er|erna|ar|arna)?|startfr[åa]g(a|an|or|orna)?|[öo]ppningsfr[åa]g(a|an|or|orna)?)\b/,
  },
  {
    key: "orchestrator",
    label: "Orchestrator & swarm",
    color: "#7048e8", // extended · violet-blue (the mode's own theme family)
    blurb: "The sub-agent workflow mode: plan → parallel waves, the live graph, the in-browser swarm.",
    test: /\b(orchestrat(or|ion|e|es|ors)|orkestr(er|ering)|sub-?agents?|underagent(er|erna)?|swarm|svärm(en)?|workflow (graph|view|mode)|agent_update|agent team)\b/,
  },
  {
    key: "outrospection",
    label: "Outrospection",
    color: "#946b2d", // extended · bronze
    blurb: "The fifth chat mode: answers from the outward feed; the /outrospect/ lens page.",
    test: /\b(outrospect(ion|ive)?|outrospekt(ion|ionen)?|outward[- ](feed|looking|scan)|seven[- ]lens)\b/,
  },
  {
    key: "help",
    label: "Help & docs",
    color: "#c05780", // extended · mulberry
    blurb: "Help mode, the docs-first layer of introspection, the docs corpus, skills.",
    test: /(^docs?\b|^docs?[:(]|\bhelp[- ]mode\b|help interface|\bdocs? (corpus|first|page|split)\b|documentation|\/help\b|docs-corpus|\breadme\b|\bskills?\b|\bguide\b|dokument)/,
  },
  {
    key: "articles",
    label: "Articles & outreach",
    color: "#7e5109", // extended · dark gold
    blurb: "The written pieces about the project — the LinkedIn series, the article collection view.",
    test: /\b(article(s)?|linkedin|artikel(n|serie|serien|samling(en)?)?|blogg?(post|inl[äa]gg)?|outreach)\b/,
  },
  {
    key: "tests",
    label: "Testing & try-it",
    color: "#00967d", // extended · pine
    blurb: "Unit/e2e suites, the try-it queue, test-request batches, verdicts.",
    // Widened 2026-08-09 for the gold-answer / question-set authoring that
    // landed untagged: "gold needle sets", "question authors", "Add 180 … questions".
    test: /\b(test(s|ing|-requests?|-feedback|-batch|-point|-queue|able)?|try-it|\/try\/|e2e|fixture|verdict|spec\b|coverage|stamp(ed|s)? minted|queue #|eval\b|eval-|benchmark|\bbench\b|rubric|ci\b|github action(s)?|browser suite|gold[- ]?(needle|answer|question|set)s?|needle sets?|question (set|bank|author|writer)s?|fr[åa]gebank(en|er|erna)?|\d+ [\w'’-]+(?: [\w'’-]+){0,4} (questions|fr[åa]g(or|orna)))\b/,
  },
  {
    key: "admin",
    label: "Admin & boards",
    color: "#b0a032", // extended · olive
    blurb: "The admin panel, decision boards, feedback/feature loops, live diagnostics.",
    test: /\b(admins?|decision board|boards?\b|panel|feedback (loop|queue|mode)|feature board|attention loop|dashboard|maintenance registry|ledger|owners? registry|\bdiag\b|client_diag|live-verify|observability|wrangler tail|tool-call activity)\b/,
  },
  {
    key: "feedback",
    label: "Feedback loop",
    color: "#0b7285", // extended · deep teal
    blurb: "User feedback capture, the queue, the human-in-the-loop decisions, the message-back channel.",
    test: /\b(feedback|återkoppling(en)?)\b/,
  },
  {
    key: "access",
    label: "Access & accounts",
    color: "#6b8f00", // extended · lime
    blurb: "Sign-in, OAuth, terms/approval gates, sessions, free mode, the welcome pane.",
    test: /\b(sign[- ]?in|sign in|login|account(s| menu| button| panel)?|oidc|oauth|redirect_uri|\bauth\b|google sign|terms|approval gate|break-glass|basic auth|access[- ]control|session(s)?|free mode|welcome|landing|first-visit)\b/,
  },
  {
    key: "games",
    label: "Games",
    color: "#d45087", // extended · pink
    blurb: "The games registry, the Tokemon AR game, inline quizzes, the /space/ archive.",
    test: /\b(tokemon|game(s)?|quiz(zes)?|pok[eé]mon|inline-quiz|space[- ](animation|archive|core|scene|launch(es)?)|rymd(spel|animation|raket)|starship|gravity turn|gravitationssv[äa]ng|stage separation|stegseparation|hot[- ]staging|tower catch|launch scene|rocket[- ]?launch|raketuppskjutning|booster)\b|\/space\//,
  },
  {
    key: "mcp",
    label: "MCP server",
    color: "#2c8ec4", // extended · sky
    blurb: "The site exposed AS an MCP deep_research tool (JSON-RPC over /mcp), and the OAuth connector that makes it addable in Claude and ChatGPT.",
    // Widened 2026-08-06 for the OAuth CONNECTOR (F-20), which was landing
    // almost entirely untagged: thirteen commits saying "connector", "OAuth
    // <endpoint>" or "well-known" and never "MCP". Bare `oauth` is
    // deliberately NOT here — it also matches the Google sign-in work
    // (canonical-host redirect_uri fixes), which belongs to `access`; the
    // endpoint suffix is what makes it this connector.
    test: /\b(mcp\b|json-rpc|deep_research tool|streamable-http|tools\/(list|call)|oauth[- ](connector|store|token|authorize|register|metadata|consent|ddl|fl[öo]de)|connector|kopplare|well-known|pkce|dynamic client registration|dynamisk klientregistrering)\b/i,
  },
  {
    key: "publish",
    label: "Publishing",
    color: "#a05195", // extended · orchid
    blurb: "Frozen public research replays under DeepResearch.Se/cure/<slug>.",
    test: /\b(publish(ing|ed)?|\/pub\b|frozen replay|public replay|continue=)\b/,
  },
  {
    key: "branding",
    label: "Branding & UI/UX",
    color: "#ff7c43", // extended · coral
    blurb: "Wordmark, slash-spacing, headers, composer, icon/mascot, UX polish.",
    test: /\b(slash[- ]?(spacing|gap)|wordmark|\.sl\b|branding|header|ui\/ux|\bux\b|\bui\b|glyph|superscript|celebration|animation|notification|composer|\bicon\b|artwork|mascot|swirl|glass pane)\b/,
  },
  {
    key: "security",
    label: "Security & hardening",
    color: "#b23a48", // extended · brick (kept distinct from the reserved status reds)
    blurb: "The risk register, secret-scanning, concurrency caps, outbound-fetch bounds.",
    test: /(^security[:(]|\bsecurity (posture|review|risk|register|board)|secret[- ](scan|leak)|risk register|concurrency cap|hardening|injection|sanitize)/,
  },
  {
    key: "refactor",
    label: "Refactoring & clarity",
    color: "#6e7f80", // extended · blue-grey (maintenance family, distinct from artifacts grey)
    blurb: "Extracting pure cores, splitting orchestrators, @ts-check, de-duplication.",
    test: /(^refactor|\brefactor(ing)?\b|extract (shared|the|focused)|split (the|embeds|stream|out)|dedupe|de-?duplicat|pure[- ]core|@ts-check|clarity pass|absorb the|relocate the|inline the)/,
  },
  {
    key: "pulse",
    label: "Pulse & analytics",
    color: "#4d8076", // extended · slate-green
    blurb: "The commit-analytics dashboard itself (this page's lineage).",
    test: /\b(pulse|commit[- ]analytics|timeline viz)\b/,
  },
  {
    key: "artifacts",
    label: "Artifacts & bundling",
    color: "#8c8c8c", // extended · neutral grey (maintenance overhead)
    blurb: "Regenerating the committed snapshot / RAG / docs corpus bundles.",
    test: /\b(regenerate|regen\b|rebuild|refresh) .*(artifact|snapshot|rag|corpus|index|bundle)|\b(bundle|bundle:rag|bundle:docs)\b/,
  },
]);

const BY_KEY = new Map(SUBJECTS.map((s) => [s.key, s]));

/** @param {string} key @returns {Subject|undefined} */
export function subject(key) {
  return BY_KEY.get(key);
}

/**
 * Tag a commit SUBJECT line with every matching feature-set key (zero to many).
 * The result preserves SUBJECTS order so downstream stacking is stable.
 * @param {string} subjectLine
 * @returns {string[]} matching subject keys
 */
export function tagCommit(subjectLine) {
  const s = String(subjectLine).toLowerCase();
  const hits = [];
  for (const subj of SUBJECTS) {
    if (subj.test.test(s)) hits.push(subj.key);
  }
  return hits;
}

/** The registry the client needs: key/label/color/blurb, no regex. */
export function subjectRegistry() {
  return SUBJECTS.map(({ key, label, color, blurb }) => ({ key, label, color, blurb }));
}

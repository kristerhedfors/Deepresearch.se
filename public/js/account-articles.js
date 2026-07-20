// The "articles" view — the admin-only ARTICLE COLLECTION: the planned
// LinkedIn/blog series about this project (nine abstracts, Swedish), kept
// here so the admin can read, reference, and copy them from any device via
// the account panel instead of digging through chat transcripts. The
// button into this view renders only for admin identities (account-views.js
// renderSummary), same gate as the "Admin interface" link — the content is
// not secret (the site is auth-gated anyway), the gate just keeps the
// summary uncluttered for regular users.
//
// Pure data + pure HTML builders up top (Node-tested in
// account-articles.test.js), the ctx-touching loader at the bottom —
// the same split every account-* view module uses.

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// Series-wide framing: the verifiable numbers every article leans on.
// Sources: docs/ (the repo itself), public/pulse/data.json + size.json
// (regenerated 2026-07-17).
const SERIES_INTRO = `
  <p class="muted">Artikelserie om projektet — nio abstracts att expandera till
  fulla artiklar. Bärande siffror (verifierbara i repot och på
  <a href="/pulse/" target="_blank" rel="noopener">/pulse</a>): helgen 4–6 juli
  gav 77 commits och 8&nbsp;500 rader; 4–17 juli totalt 716 commits,
  ~181&nbsp;000 tillagda rader och 93 shippade features; kodbasen är
  137&nbsp;475 rader i 548 filer med noll runtime-beroenden. Allt
  MIT-licensierat.</p>`;

// The nine article abstracts, in recommended publishing order. `title` and
// `body` are trusted static HTML authored here (no user input flows in).
export const ARTICLES = [
  {
    n: 1,
    title: "Introduktion: ett 80-procentsprojekt om AI, LLM-applikationer och bevisbar privacy",
    body: `<p>Serieöppnaren, och den artikel som sätter ramen för alla följande. Den
börjar med att vara tydlig med vad projektet är: ett <i>forsknings- och
innovationsprojekt</i>, ingenting annat — ingen produkt, inget bolag, ingen pitch.
Området som undersöks är AI, LLM-applikationer och framför allt integriteten
(privacy) i LLM-applikationer, och serien är forskningsloggen snarare än en
kampanj. Allt som annars hade låtit som produktargument — "servern ser aldrig din
data", "kör Linux i webbläsaren", "noll beroenden" — presenteras som experiment
vars fråga är "hur långt går det, och var brister det", inte "hur får jag dig att
köpa det". Artikeln är också tydlig med att projektet innebär ett genomgripande
skifte i arbetssättet: allt fram till nu är byggt från en iPhone — huvudsakligen i
Claude Code-appen plus ett par molntjänster för integrationerna (API-nycklar, Google
Maps, Shodan och liknande) — vilket har låtit hela sajten växa fram mestadels i
rörelse, i praktiken under långsamma löppass i nordsvenska skogar.</p>
<p>Den andra ramsättande poängen är att detta med avsikt är och förblir ett
<i>80-procentsprojekt</i>: målet är inte att slutföra de sista tjugo procenten av
finputs och polerat gränssnitt, utan att koppla ihop kapabiliteter under
specifika arkitekturer och se om helheten över huvud taget håller — att bevisa
teserna. Antagandet är att hundra procent UX är ett känt, lösbart problem givet
resurser; det olösta och intressanta ligger i integrationen och orkestreringen av
LLM-applikationer. Artikeln formulerar de två drivande frågorna — hur långt en
riktig assistent går att pressa mot <i>bevisbar</i> privacy (skillnaden mellan "lita
på oss" och "läs själv"), och hur mycket kapabilitet som får plats innanför den
ramen — och visar hur bitarna nu ligger nära början till en
agentorkestreringsplattform: avspinnbara, mätade (token-styrda) säkra instanser,
schemalagda bakgrundskörningar som matar ett projekts kunskapsbas, och en SDK som
låter även mindre modeller destillera fram valfri delmängd ur referens-
implementationen (projektets "SaaS-complete"-tes).</p>
<p>Artikeln landar i seriens genomgående metodpoäng: varje påstående går att
kontrollera. Koden är öppen (MIT), takten är öppen (dashboarden /pulse genereras
ur git-historiken — 716 commits och 93 features 4–17 juli, plus en
feature-fokus-tidslinje som visar ~25 temaområden växa fram parallellt under samma
två veckor), och sajten kan till och med förklara sin egen källkod. Den är också ärlig om mognaden: detta är
experimentellt och långt ifrån produktionsfärdigt, och redovisar det som <i>inte</i>
gick bra (features som regresserat upprepade gånger, se artikel 7) lika noga som
det som gick bra — annars vore det inte forskning, bara en segerberättelse.</p>`,
  },
  {
    n: 2,
    title: "DistillSDK: destillera fram exakt den mjukvara du behöver",
    body: `<p>Seriens mest originella tankegods och den artikel som planterar en term.
Utgångsläget: i repot ligger Agent-Pair SDK:n — en designartefakt, inte ett
bibliotek — med ett maskinläsbart register (sdk/MANIFEST.json) över 33 moduler som
tillsammans utgör hela applikationsparet: pair-architecture, baseplate-worker,
baseplate-client, provider-registry, research-pipeline, web-search, secure-tier
och så vidare. Varje modul är beskriven som en <i>byggbar skill</i> — vad den gör, vad
den beror på, vad som verifierar den — och en beroendefri CLI
(pair-cli list|show|plan|validate) kan räkna ut byggordningen för ett godtyckligt
urval.</p>
<p>Tesen: detta möjliggör en ny distributionsform för mjukvara. I stället för att
forka en kodbas och skala bort, eller be en frontier-modell återuppfinna helheten,
låter man en <i>mindre kapabel</i> modell — billigare, lokal, kanske körande på egen
hårdvara av privacyskäl — destillera fram ett subset: exakt de moduler en ny
variant behöver, i beroendeordning, med varje stegs verifieringskrav specificerat.
Frontier-modellen gör det svåra en gång (designar registret, skär modulerna längs
rena snitt, skriver kontrakten); små modeller stämplar sedan ut varianter på
löpande band. Det är destillation på <i>mjukvarunivå</i> i stället för modellnivå —
kunskapen som överförs är inte vikter utan en verifierbar byggplan.</p>
<p>Artikeln argumenterar för varför detta är rätt abstraktionsnivå: en modell som
inte klarar att designa en arkitektur klarar utmärkt att implementera en
välspecificerad modul mot ett givet kontrakt, och registret är precis den
nedbrytningen. Den diskuterar också ärligt vad som är byggt (registret, CLI:n,
designdokumentet — allt i repot) och vad som är hypotes (ingen har ännu låtit en
7B-modell bygga en variant end-to-end), samt hur experimentet för att testa
hypotesen skulle se ut. Namnet <b>DistillSDK</b> lanseras här, med en öppen inbjudan:
registret är MIT-licensierat — försök själv, rapportera vad som gick sönder.</p>`,
  },
  {
    n: 3,
    title: "Deterministisk orkestrering: pipelinen som klarar sig utan function calling",
    body: `<p>En teknisk trovärdighetsartikel med en medvetet motvalls tes: i en tid när
varje AI-keynote handlar om agentic tool use är den mest robusta arkitekturen för
en research-pipeline att <i>inte använda tool calling alls</i>. Deep
research-pipelinen — triage → sök → gap-check → syntes → validering — är helt
Worker-orkestrerad: varje fas är ett direkt anrop där modellen antingen returnerar
JSON i ett specificerat schema eller streamar prosa. Ingen fas låter modellen
välja verktyg, och kontrollflödet ligger i vanlig kod som kan enhetstestas.</p>
<p>Artikeln går igenom vad det köper. För det första modellbredd: pipelinen
fungerar över hela leverantörskatalogen, inklusive små och medelstora öppna
modeller vars tool-calling är notoriskt opålitlig — vilket i sin tur gör det
möjligt att köra på svensk zero-retention-inferens i stället för att vara fastlåst
vid de två-tre frontier-leverantörer som gör tool use bra. För det andra
felisolering: när en fas fallerar är det <i>en</i> JSON-parse eller <i>ett</i> timeout-fall,
inte en agent som vandrat iväg i en verktygsloop; varje hjälpfas degraderar mjukt
(färre sökningar, accepterat utkast) i stället för att fälla hela förfrågan. För
det tredje testbarhet och split-routing: eftersom faserna är deterministiska kan
planeringsfaserna pinnas på en liten pålitlig modell medan bara syntesen körs på
användarens valda modell — en kostnadsarkitektur som är omöjlig när en enda
agent-loop äger hela förloppet.</p>
<p>Artikeln redovisar också det medvetna undantaget som bekräftar regeln: i
developer mode får svarsmodellen — och endast den, endast där, endast om den
bevisat klarar det — riktiga verktyg för att undersöka sajtens egen källkod, med
deterministisk fallback för alla andra modeller. Slutsatsen formuleras som en
designprincip: ge modellen friheten där friheten skapar värde (syntes,
undersökning) och ta bort den där den bara skapar varians (orkestrering).</p>`,
  },
  {
    n: 4,
    title: "Bevisbar privacy som feature, inte policy: Se/cure + Se/rver-paret",
    body: `<p>Missionsartikeln — den som förklarar vad projektet egentligen undersöker: hur
långt en <i>riktig, användbar</i> research-assistent kan pressas mot bevisbar privacy,
och exakt var det börjar kosta kapabilitet. Konstruktionen är ett par.
DeepResearch.<b>Se/cure</b> är never-cloud-nivån: servern finns inte i någon datapath
över huvud taget — webbläsaren anropar LLM-leverantören direkt med användarens
egna nycklar, hela pipelinen körs klientsidigt, och allt state ligger förseglat
lokalt i webbläsaren. Påståendet "vi ser inte din data" är inte ett löfte i en
integritetspolicy utan en egenskap som vem som helst kan verifiera i den öppna
källkoden: det finns ingen kod som skickar innehållet till servern.
DeepResearch.<b>Se/rver</b> är den inloggade nivån där molnlagring ingår i valet av
tier — konversationer och bifogade filer vilar som ciphertext i både webbläsare
och objektlagring, med en nyckelhierarki där den strängaste nivån (de
hemlighetsnycklade projektvalven) är matematiskt oläsbar för servern.</p>
<p>Artikelns kärna är ärligheten om undantagen: exakt två avgränsade, opt-in,
kvot-mätta vägar låter Se/cure-trafik passera servern (en tillfällig
websöknings-grant som bär enbart sökfrågan, och en proxybunt för säkra
forskningsutrymmen), och de läsbara undantag som finns på Se/rver-sidan
(RAG-indexering kräver klartext) pekas ut i stället för att gömmas. Tesen:
privacy-arkitektur handlar inte om att ha noll undantag utan om att ha
<i>räknebara, avgränsade, disclosade</i> undantag — och skillnaden mellan "lita på
oss" och "läs själv" är hela skillnaden.</p>
<p>EU/suveränitetsvinkeln (svensk zero-retention-inferens via Berget.ai, ingen
amerikansk molnjätte i den primära vägen) ger artikeln sin näringslivskrok: det
här är ett existensbevis för att svensk AI-infrastruktur räcker för att bygga en
komplett produkt på.</p>`,
  },
  {
    n: 5,
    title: "Linux i webbläsaren: sandboxen som aldrig lämnar din maskin",
    body: `<p>Seriens mest delningsbara tekniska artikel, för att premissen låter omöjlig:
en riktig Linux-miljö — inte en emulerad terminal-leksak — bootar i
webbläsarfliken via en WASM-virtualiserad x86-maskin (CheerpX), och
research-agenten kan skriva och köra bash, Python och verktyg i den, mot
användarens egna monterade filer, utan att en enda rad kod eller data någonsin når
en server.</p>
<p>Artikeln förklarar varför detta är mer än en teknikdemo: kodexekvering är den
kapabilitet som tydligast brukar tvinga fram en server (alla "code
interpreter"-features hos de stora aktörerna kör i operatörens moln), så att
flytta den till klienten är det starkaste enskilda beviset för parets privacy-tes
— även den mest kapabla featuren kan göras never-cloud. Tekniskt går abstraktet
igenom de intressanta bitarna: cross-origin-isoleringen (COEP-headers) som
SharedArrayBuffer-kravet tvingar fram och som visade sig bete sig olika på iOS
Safari än överallt annars; den agentiska loopen som — i linje med artikel 3 — körs
helt utan function calling genom en fenced-block-konvention där modellen skriver
kommandon i markdown och klienten exekverar och återmatar; samt
filmonteringssystemet där användarens bilagor ingestas stegvis in i VM:ets
filsystem.</p>
<p>Artikeln är också medvetet ärlig om kostnaden: detta är den feature som
regresserat flest gånger i projektet — boot-häng, cache-fällor, enhetsspecifika
Safari-beteenden — och den har därför en stående underhållsägare i
agentorganisationen (vilket ger en naturlig brygga till artikel 7). Avslutningen
breddar: vad mer kan flyttas in i fliken? Var går gränsen där webbläsaren som
privacy-bubbla tar slut — och är den gränsen teknisk eller bara ovan?</p>`,
  },
  {
    n: 6,
    title: "Noll beroenden, inget byggsteg: 137 000 rader utan node_modules",
    body: `<p>En kontraintuitiv artikel som börjar i en siffra ur repots egen size-mätning:
137&nbsp;475 rader kod, 548 filer, tio språk — noll runtime-beroenden, tre
dev-beroenden, inget byggsteg. Inget React, ingen bundler, ingen transpilering;
Workern deployas som den är och klienten laddar ES-moduler direkt. Jämförelsen som
ger hooken: ett nystartat standardprojekt i samma nisch drar in storleksordningen
tusen transitiva npm-paket innan första egna raden är skriven.</p>
<p>Artikeln argumenterar för att detta inte är asketism utan en kalkyl som
AI-assisterad utveckling har ritat om i grunden. Beroenden köptes historiskt för
att utvecklartid var dyr: hellre någon annans testade datumbibliotek än en egen
vecka. När en agent skriver glue-koden på minuter faller den kalkylens ena sida,
medan den andra sidan — supply-chain-risk, versionsröta, uppgraderingslöpband,
revisionsbörda — står kvar oförändrad eller värre. För just det här projektet är
kopplingen till missionen direkt: hela poängen med Se/cure-nivån är att en
utomstående ska kunna <i>läsa sig till</i> att servern inte ser data, och varje
beroende är en svart låda som gör den läsningen svårare; en kodbas utan
node_modules är oberoende verifierbarhet i praktiken.</p>
<p>Artikeln redovisar också trade-offen ärligt — vendrade bibliotek där det
verkligen behövs (kryptoprimitiver skriver man inte själv), och de tre
dev-beroendena (test-tooling) som undantag med motivering — samt disciplinen som
håller linjen: varje förslag om ny dependency måste spåras till ett reproducerat
behov, inte en vana. Slutfrågan till läsaren: hur många av dina beroenden skulle
överleva samma prövning idag, när alternativkostnaden för att skriva själv har
fallit med en tiopotens?</p>`,
  },
  {
    n: 7,
    title: "Mjukvara som underhåller sig själv: agent-loopar, beslutstavlor och regressionsägare",
    body: `<p>Seriens mest framåtblickande artikel, om något repot råkade bygga vid sidan av
produkten: en fungerande <i>organisationsmodell</i> där noderna är AI-agenter och
människans roll är prioritering och godkännande. Konkretionen är det som gör
artikeln: varje fix författas av en worker-session som äger exakt en PR och
förblir prenumererad på den efter merge — en GitHub-kommentar på PR:en väcker
författaren igen. När en shippad feature regresserar (och det gör de; sandboxen i
artikel 5 är återfallsmästaren) är regeln att <i>inte</i> fixa i tysthet: i stället
slås den ägande PR:en upp i ett underhållsregister och en precis
regressionsrapport kommenteras dit — symptom, loggreferens, verbatim repro, vilken
tidigare fix som brutits — varpå ägaragenten vaknar, fixar och öppnar en
följd-PR.</p>
<p>Runt detta finns en hel förvaltningsapparat: beslutstavlor i adminpanelen där
agent-sessioner producerar listor (risker, featureförslag, fynd) och människan
sätter explicit prioritetsordning som nästa agent-loop läser som sin arbetsorder;
en feedback-kö från livesajten som körs som human-in-the-loop-loop med
obligatoriskt människobeslut per ärende och svar tillbaka till användaren i
klarspråk; och en watcher-loop som varje varv sveper efter regressionssignaturer i
produktionsloggar.</p>
<p>Artikeln reflekterar över vad som är genuint nytt här — inte att agenter
skriver kod, utan att <i>ansvar</i> (ownership, eskalering, väckning) har fått en
maskinläsbar form — och vad som visat sig kräva människan: prioritering, smak, och
alla beslut där docs och verklighet pekar åt olika håll. Avslutningen är en skiss
av läsarens version: vilka av din organisations Jira-ritualer är egentligen
koordinationsprotokoll som redan idag kan köras av en prenumererad agent med ett
register och en väckningsmekanism?</p>`,
  },
  {
    n: 8,
    title: "Spec-first, öppna standarder: när dokumentationen medvetet leder koden",
    body: `<p>En artikel om en inversion av mjukvaruutvecklingens vanligaste synd. Normalt
släpar dokumentationen efter koden; i det här repot <i>leder</i> två specifikationer
den med avsikt: DRSW/1, ett interchange-format som beskriver ett komplett
forsknings-workspace (konversationer, inställningar, nycklar, lånade kvoter,
proveniens) som ett förseglat, portabelt värde, och DRPL/1, ett deklarativt språk
för själva pipeline-strukturen (vilka faser, i vilken ordning, med vilka
degraderingsregler). Bägge är skrivna som öppna standarder med versionsnummer,
scheman och medföljande tooling — och den deployade workspace-featuren är
uttryckligen standardens <i>referensimplementation</i>, inte tvärtom.</p>
<p>Artikeln driver två teser. Den första: i agent-byggd mjukvara blir specen det
primära artefaktet av rent praktiska skäl — det är den agenter bygger <i>från</i>,
testar <i>mot</i> och (via artikel 2:s destillationsidé) stämplar varianter <i>ur</i>; en
precis spec är den form av kunskap som överlever både modellbyten och
kodomskrivningar. Den andra tesen är strategisk och hämtas ur repots
visionsdokument om "stackless research": dagens research-assistenter är stackar —
ditt arbete bor i en operatörs servrar och du är hyresgäst där — medan ett
standardiserat workspace-format inverterar ägandet: ditt forskningsläge blir en
förseglad fil i din egen hand, och sajter reduceras till utbytbara noder som ditt
workspace <i>besöker</i>, arbetar hos och lämnar. Ingen nod håller ditt state; det
finns inget att läcka, stämma ut eller migrera från, eftersom du aldrig var <i>på</i>
något.</p>
<p>Artikeln är ärlig med mognadsgraden — en implementation, noll externa
adoptörer, standarder på version /1 — och avslutar med det öppna draget: specarna
är MIT-licensierade just för att inversionen bara betyder något om fler än en nod
finns.</p>`,
  },
  {
    n: 9,
    title: "Genomlysning hela vägen: sajten som kan förklara sin egen källkod",
    body: `<p>Slutknuten, som samlar seriens tråd — verifierbarhet — och driver den till sin
logiska ändpunkt: en tjänst vars mest radikala transparens-feature är att den kan
<i>förklara sig själv</i>. Introspektionsläget låter vem som helst ställa frågor om
sajtens egen implementation — "hur hanterar ni mina API-nycklar?", "vad händer med
min fråga när jag trycker enter?", "loggar ni det här?" — och få svar genererade
ur den deployade källkodens committade snapshot, med symbolreferenser ner på
filnivå. I developer mode, på modeller som bevisat klarar det, går det längre:
svarsmodellen får riktiga verktyg — grep, filläsning, kataloglistning — över
sajtens källkod och undersöker den <i>live</i> medan användaren tittar på; på
Se/cure-nivån får den till och med köra kommandon i sandboxen från artikel 5.</p>
<p>Artikeln placerar detta i en trappa av transparens som resten av serien byggt:
berättelsen är öppen (varje prompt, tidslinje och tokenförbrukning ligger i
repot), takten är öppen (/pulse genereras ur git och visar 716 commits och 93
features för vem som helst), koden är öppen (MIT, noll beroenden att lita blint på
— artikel 6), arkitekturen är öppen (standarderna i artikel 8) — och överst:
produkten är sitt eget revisionsverktyg.</p>
<p>Tesen är att detta är svaret på AI-erans förtroendeproblem i miniatyr. "Lita på
oss" skalar inte när mjukvara byggs snabbare än den kan granskas manuellt (artikel
1); det som skalar är att göra granskningen till en feature med samma UX-omsorg
som produkten själv. Avslutningen knyter ihop hela serien i en mening per artikel
och landar i inbjudan: sajten är live, koden är öppen, ställ din elakaste fråga
till den — om introspektionen inte kan svara är <i>det</i> en buggrapport, och den
tas emot av organisationen i artikel 7.</p>`,
  },
];

/**
 * Pure HTML builder for the article-collection view: intro, then each
 * abstract as a collapsible <details> block so the nine long texts stay
 * scannable on a phone — the admin opens one at a time.
 * @returns {string} HTML for the panel body
 */
export function renderArticles() {
  const items = ARTICLES.map(
    (a) => `
    <details class="article-item">
      <summary><b>${a.n}.</b> ${a.title}</summary>
      <div class="article-body">${a.body}</div>
    </details>`,
  ).join("");
  return `
    <button id="articlesbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Article collection</p>
    ${SERIES_INTRO}
    ${items}`;
}

/**
 * Renders the article-collection view into the panel body and wires its
 * back button. Fully static — no fetch.
 * @param {PanelCtx} ctx
 */
export function loadArticlesView(ctx) {
  ctx.body.innerHTML = renderArticles();
  document.getElementById("articlesbackbtn").addEventListener("click", () => ctx.show("summary"));
}

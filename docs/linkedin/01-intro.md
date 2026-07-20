# Artikel 1 — Introduktion: varför projektet finns

> **Serieöppnaren.** Full version av abstract 1 i artikelserien (abstracten
> ligger i `public/js/account-articles.js`, fulltexterna här i `docs/linkedin/`).
> Skriven för LinkedIn, på svenska, i förstapersonsröst. Bärande siffror är
> verifierbara i repot och på `/pulse`. Publiceringsstatus: utkast.

---

## Låt mig vara tydlig med vad det här är — och inte är

Det här är ett **forsknings- och innovationsprojekt**. Ingenting annat.

Jag bygger inte en produkt, startar inte ett bolag och säljer ingenting. Det
finns ingen pitch i slutet. Det jag undersöker är ett enda område —
**AI, LLM-applikationer, och framför allt integriteten (privacy) i
LLM-applikationer** — och den här artikelserien är forskningsloggen, inte en
marknadsföringskampanj.

Jag säger det redan i första meningen för att allt som följer ska läsas i rätt
ljus. När jag skriver om saker som hade sett ut som produktargument — "servern
ser aldrig din data", "kör en riktig Linux-miljö i webbläsaren", "noll
beroenden" — så är de inte säljpunkter. De är *experiment*. Frågan är aldrig
"hur får jag dig att köpa det här", utan "hur långt går det faktiskt att pressa,
och exakt var brister det".

## Det är ett 80-procentsprojekt — med avsikt

Här är den andra saken jag vill ha sagt tidigt, för den förklarar nästan alla val
längre fram: **det här kommer inom överskådlig framtid att förbli ett
80-procentsprojekt.** Målet är *inte* att slutföra de sista tjugo procenten —
finputsen, det polerade gränssnittet, den sista millimetern look-and-feel. Målet
är att koppla ihop olika funktioner och kapabiliteter under specifika arkitekturer
och se om det över huvud taget *fungerar* — att bevisa teserna.

Det är ett medvetet ställningstagande, inte lättja. Antagandet är att man *kan*
nå hundra procent i användarupplevelse när som helst, givet resurser och
prioritet — det är ett känt och lösbart problem. Det intressanta, det olösta,
ligger i de första åttio: går kapabiliteterna att integrera och orkestrera så att
helheten faktiskt håller ihop? Så första och främst går jag på **kapabilitet — i
betydelsen integration och orkestrering av LLM-applikationer** — och låter UX:en
vara medvetet ofärdig. En trasig knapp är en fotnot. En arkitektur som inte bär
är hela poängen.

## Ett skifte i arbetssättet: allt är byggt från en iPhone

En sak till som hör till varför jag kallar det här forskning och innovation, och
inte bara ett bygge: **det är en genomgripande förändring av mitt eget arbetssätt.**
Allt i den här applikationen fram till nu — bokstavligen allt — är gjort från en
iPhone. Huvudverktyget har varit Claude Code-appen, tillsammans med en handfull
molntjänster för integrationerna: plattformar för API-nycklar, Google Maps, Shodan
och liknande. Ingen laptop, ingen IDE, ingen terminal på ett skrivbord.

I praktiken har det inneburit att hela sajten byggts mestadels *i rörelse* — stora
delar under långsamma löppass i nordsvenska skogar, med telefonen i handen mellan
intervallerna. Jag tar inte upp det för att det är en pittoresk detalj, utan för att
arbetssättet i sig är en del av det som undersöks: när enheten för utvecklingsarbete
krymper till en telefon och en agent, vad blir då faktiskt byggbart, var, och av vem?
Att svaret visade sig vara "en komplett research-assistent med egen domän, byggd på
språng" är ett resultat i sig.

## Forskningsfrågorna

Modern AI byggs nästan uteslutande som en tjänst du *litar på*. Du skickar din
fråga, dina dokument, din research till någon annans servrar, och du får en
integritetspolicy tillbaka. Det kan vara sant. Men det är ett *löfte*, och ett
löfte skalar dåligt i en tid när mjukvara byggs snabbare än den hinner granskas.

Två frågor driver projektet. Den första handlar om integritet:

> **Hur långt går det att pressa en riktig, användbar research-assistent mot
> _bevisbar_ privacy — och exakt var börjar det kosta kapabilitet?**

"Bevisbar" är det viktiga ordet. Skillnaden jag jagar är den mellan "lita på oss"
och "läs själv": inte färre integritetslöften, utan att ersätta löftet med en
egenskap som vem som helst kan verifiera i den öppna källkoden. Om påståendet är
"servern ser inte din data", ska svaret på "hur vet jag det?" vara "för att det
inte finns någon kodrad som skickar den dit — och här är koden".

Den andra frågan handlar om kapabilitet: **hur mycket kan man integrera och
orkestrera innanför den ramen innan det slutar hålla?** Det är där
80-procentsdoktrinen och privacy-frågan möts — varje ny kapabilitet är ett test
av hur mycket som får plats *innanför* det bevisbara.

## Vad det håller på att bli: början till en agentplattform

Och det är här det blivit mer än en enskild assistent. Det som finns nu är nästan
början till en **agentorkestreringsplattform**.

Grundenheten är en säker instans — fortfarande tänkt för att en människa ska
interagera med den — men arkitekturen gör att man kan *spinna av* sådana
instanser. En instans behöver inte vara en chattflik någon sitter och tittar på:
den kan lika gärna vara en prompt eller en schemalagd uppgift som startar i
bakgrunden, kör sitt, och som användaren kan öppna och titta in i när som helst —
eller som bara tyst producerar innehåll in i kunskapsbasen för ett projekt. Och
åtkomsten är **mätt**: en instans får en token för just de typer av åtkomst den
behöver via huvudsajten, och det kan finnas flera instanser av den huvudsajten.
(Det är precis vad Se/rver-token-familjen redan gör — en signerad token med en
`perms`-mängd och en mätad kvot per behörighet.)

Poängen är inte att allt det här är färdigt — mycket är fortfarande hypotes, i god
80-procentsanda. Poängen är att bitarna — mätade tokens, avspinnbara instanser,
projektkunskapsbaser, bakgrundskörningar — har hamnat tillräckligt nära varandra
för att formen ska synas.

## "SaaS-complete": SDK:n som destillerar fram varianter

Den sista pusselbiten är att jag också släpper en **SDK**. Inte ett vanligt
bibliotek, utan i praktiken en uppsättning *skills* som tillsammans med den starkt
modulära, seriellt beroendeordnade arkitekturen gör något ovanligt: du ska kunna
**destillera ut vilken delmängd av kapabiliteterna som helst** ur den här
80-procentiga referensimplementationen — och göra det med *mindre* modeller, som
skulle klara att sätta ihop något sådant från grunden givet planen.

"Turing-complete" är fel ord för ambitionen; jag tänker på det snarare som
*SaaS-complete*: idén att referensimplementationen plus SDK:n täcker tillräckligt
av idérummet för att en godtycklig SaaS-liknande variant ska gå att stämpla ut ur
den. En agentorkestreringsplattform, plus en sorts guide för självutveckling — för
att producera nya lägen och därigenom täcka in hela idérummet och låta det köras
inom LLM:ens tankeutrymme. Det är den mest spekulativa tesen i hela projektet, och
den flaggar jag som just spekulativ — men det är den riktning arkitekturen pekar.

## Beviset är sajten själv

Allt det här prövas inte i ett white paper utan i en körande sajt, byggd som ett
**par** och släppt i sin helhet under MIT-licens så att den kan granskas
oberoende:

- DeepResearch.**Se/cure** — never-cloud-nivån. Servern finns inte i någon
  datapath över huvud taget. Webbläsaren anropar LLM-leverantören direkt med
  användarens egna nycklar, hela pipelinen körs klientsidigt, och allt tillstånd
  ligger förseglat lokalt. "Vi ser inte din data" blir en *strukturell* egenskap,
  inte en policyrad.
- DeepResearch.**Se/rver** — den inloggade nivån, där molnlagring ingår i valet
  av tier och konversationer vilar som ciphertext hela vägen, med en
  nyckelhierarki vars strängaste nivå är matematiskt oläsbar för servern.

Se/cure kommer alltid först, för det är där tesen prövas hårdast: att även en
riktig, kapabel assistent kan göras så att det helt enkelt inte *finns* något för
servern att läcka. Samma öppenhet gäller uppåt i hela stacken — takten är öppen
(dashboarden `/pulse` genereras direkt ur git-historiken), koden är öppen, och
sajten kan till och med förklara sin egen implementation för dig i klartext. Varje
påstående i serien är avsett att gå att kontrollera. Det är metodpoängen som
återkommer i varje artikel.

## Bilden av det parallella: feature-fokus-tidslinjen

Om en enda bild ska fånga vad "80 procent, brett" betyder i praktiken är det den
här. Under `/pulse` finns en andra graf — **feature-fokus-tidslinjen** — som inte
räknar commits eller rader utan visar *vad* arbetet handlade om över tid: varje
commit taggas med de temaområden den rör, och grafen ritar hur områdena stiger,
konkurrerar och ebbar ut dag för dag, som parallella linjer (eller ett
streamgraf-band).

Siffrorna bakom bilden, alla ur git-historiken för samma tvåveckorsfönster
(4–17 juli): **716 commits fördelade på 25 temaområden**, där 88 % av alla commits
bär minst ett tema och **17 av områdena har fler än tjugo commits var** — alltså i
storleksordningen sytton *samtidigt pågående* utvecklingsspår under samma två
veckor. Linux-sandboxen, introspektionsläget, Se/cure-nivån, kart- och
geo-intelligensen, hjälp/dokumentation, adminpanelens beslutstavlor, kvoter och
konton — de växer inte i tur och ordning utan om vartannat, ofta samma dag.

Det är just det som är poängen med att ta med grafen redan i introduktionen: den
gör det abstrakta ("integration och orkestrering av många kapabiliteter") visuellt
och konkret. Man *ser* att projektet inte är en funktion som polerats, utan ett
tjugotal kapabilitetsspår som förts samman parallellt — och eftersom taggningen
körs på commit-ämnena ur git går även den bilden att räkna efter. Grafen finns live
på `/pulse/timeline.html`.

## Ärlighet först: det här är ett experiment

Lika tydligt som syftet vill jag vara med mognaden: **det här är experimentellt
och långt ifrån produktionsfärdigt** — och ska så förbli, per 80-procentsdoktrinen
ovan. Det finns funktioner som regresserat om och om igen, hörn som är trasiga, och
hela idéer som fortfarande är hypoteser jag inte bevisat. Serien redovisar det som
*inte* gick bra lika noga som det som gick bra — annars vore det inte forskning,
bara en segerberättelse.

Ursprunget — att en första fungerande version kom till under en helg, mestadels
från en telefon — är just ett ursprung, inte identiteten. Den historien finns i
sin helhet på `/story` för den nyfikne, men den är inte poängen. Poängen är
frågorna ovan, och vad man faktiskt lär sig genom att försöka besvara dem i
körande kod.

## Vad serien kommer att gå igenom

De följande artiklarna tar var sitt konkret spår ur samma experiment: den
deterministiska pipelinen som klarar sig helt utan function calling; DistillSDK och
idén att destillera fram exakt den mjukvara du behöver; privacy-paret Se/cure +
Se/rver i detalj; en riktig Linux-miljö som kör i webbläsarfliken utan att en byte
lämnar din maskin; en kodbas på ~137 000 rader med noll runtime-beroenden; en
förvaltningsmodell där AI-agenter äger och underhåller sina egna fixar; öppna
standarder som medvetet leder koden; och sajten som kan förklara sin egen
källkod. Varenda en är en vinkel på samma sak — hur mycket kapabilitet, och hur
mycket plattform, som ryms innanför bevisbar integritet.

## En inbjudan, inte ett erbjudande

Om det här vore en produkt hade jag bett dig registrera dig. Eftersom det är
forskning ber jag om något annat: **läs koden, försök knäcka den, och berätta vad
som gick sönder.** Allt är MIT-licensierat och avsiktligt öppet just för att den
här sortens frågor bara blir intressanta när fler än en person tittar på svaret.

Det här är artikel 1 av en serie. Nästa gång: varför den mest robusta arkitekturen
för en AI-pipeline, mitt i agent-eran, kan vara att inte låta modellen använda
verktyg alls.

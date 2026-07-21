# Artikel 2 — Introduktion: varför projektet finns

> **Introduktionen till projektet.** Serien öppnar med en färsk nyhet (artikel 1,
> om det försvunna glappet mellan öppna och stängda vikter); den här artikeln är
> den egentliga introduktionen till projektet självt — det som artikel 1 bara
> använde som exempel. Full version av abstract 1 i artikelserien (abstracten
> ligger i `public/js/account-articles.js`, fulltexterna här i `docs/linkedin/`).
> Skriven för LinkedIn, på svenska, i förstapersonsröst. Bärande siffror är
> verifierbara i repot och på `/pulse`. Publiceringsstatus: utkast.

---

## Sommarens stora skifte: allt byggt från en telefon

Sommarens stora nyhet inom AI-assisterad utveckling är, när allt kommer omkring,
att man numera kan göra i stort sett allt direkt från mobiltelefonen. Boris
Cherny — en av de ledande bakom Claude Code — bygger enligt uppgift nästan
uteslutande från Claude Code-appen i mobilen nuförtiden. Själv har jag laborerat
med samma arbetssätt i drygt en månad. Det senaste jag gjort med det är att
bygga deepresearch.se från grunden — hela sajten, från första raden — plus en
handfull medvetet valda constraints som förhoppningsvis gör projektet en aning
mer intressant än "ännu en chattbot".

Låt mig ta arbetssättet först, för det är en av de där constrainten. Allt i den
här applikationen, fram till nu, är gjort från en iPhone. Huvudverktyget har
varit Claude Code-appen; runt omkring den ligger ett par molntjänster för
integrationerna — plattformar för API-nycklar, Google Maps, Shodan och liknande.
Ingen laptop, ingen IDE, ingen terminal på ett skrivbord. I praktiken har sajten
vuxit fram mestadels *i rörelse*: stora delar under långsamma löppass i
nordsvenska skogar, med telefonen i handen mellan intervallerna.

Jag nämner det inte som en pittoresk detalj. Arbetssättet är i sig en del av det
som undersöks: när enheten för utvecklingsarbete krymper till en telefon och en
agent, vad blir då faktiskt byggbart — var, och av vem? Att svaret visade sig
bli "en komplett research-assistent med egen domän" säger något. Men det
intressanta ligger inte i *var* jag satt, utan i vad jag valde att bygga, och
under vilka regler. Det är dit resten av artikeln går.

## Vad det här är — och inte är

Tydligt från början, alltså: det här är ett **forsknings- och
innovationsprojekt**. Ingenting annat.

Jag bygger inte en produkt, startar inget bolag och säljer ingenting. Det finns
ingen pitch i slutet av den här texten. Det jag undersöker är ett enda område —
**AI, LLM-applikationer, och framför allt integriteten (privacy) i
LLM-applikationer** — och serien du läser är forskningsloggen, inte en kampanj.

Jag säger det redan nu för att allt som följer ska läsas i rätt ljus. När jag
längre fram skriver saker som hade kunnat låta som säljargument — "servern ser
aldrig din data", "kör en riktig Linux-miljö i webbläsaren", "noll beroenden" —
är det inte säljpunkter. Det är *experiment*. Frågan är aldrig "hur får jag dig
att köpa det här", utan "hur långt går det faktiskt att pressa, och exakt var
brister det". Ett experiment som inte får braka ihop är inget experiment.

## Ett 80-procentsprojekt — med avsikt

Här är den andra ramen, och den förklarar nästan varje val längre fram: **det
här kommer, inom överskådlig framtid, att förbli ett 80-procentsprojekt.** Målet
är *inte* att slutföra de sista tjugo procenten — finputsen, det polerade
gränssnittet, den sista millimetern känsla. Målet är att koppla ihop
kapabiliteter under specifika arkitekturer och se om helheten över huvud taget
håller ihop.

Det är ett medvetet ställningstagande, inte lättja. Antagandet är att hundra
procent i användarupplevelse är ett känt och lösbart problem, givet resurser och
prioritet. Det olösta — det intressanta — ligger i de första åttio: går
kapabiliteterna att integrera och orkestrera så att det faktiskt bär? Alltså går
jag först och främst på **kapabilitet, i betydelsen integration och orkestrering
av LLM-applikationer**, och låter gränssnittet vara medvetet ofärdigt. En trasig
knapp är en fotnot. En arkitektur som inte bär är hela poängen.

## Två frågor

Modern AI byggs nästan uteslutande som en tjänst du *litar på*. Du skickar din
fråga, dina dokument, din research till någon annans servrar, och får en
integritetspolicy tillbaka. Det kan mycket väl vara sant — men det är ett
*löfte*, och löften skalar dåligt i en tid när mjukvara byggs snabbare än den
hinner granskas.

Den första frågan handlar om just det:

> **Hur långt går det att pressa en riktig, användbar research-assistent mot
> _bevisbar_ privacy — och exakt var börjar det kosta kapabilitet?**

"Bevisbar" är det viktiga ordet. Skillnaden jag jagar är den mellan "lita på
oss" och "läs själv": inte fler eller finare integritetslöften, utan att ersätta
löftet med en egenskap vem som helst kan verifiera i den öppna källkoden. Om
påståendet är "servern ser inte din data" ska svaret på "hur vet jag det?" vara
"därför att det inte finns en enda kodrad som skickar den dit — och här är
koden".

Den andra frågan är kapabilitetens: **hur mycket kan man integrera och
orkestrera innanför den ramen innan det slutar hålla?** Det är där
80-procentsdoktrinen och privacy-frågan möts. Varje ny kapabilitet blir ett test
av hur mycket som får plats *innanför* det bevisbara.

## Beviset är sajten själv

Det här prövas inte i ett white paper utan i en körande sajt — byggd som ett
**par**, och släppt i sin helhet under MIT-licens så att den kan granskas
oberoende:

- DeepResearch.**Se/cure** — never-cloud-nivån. Servern finns inte i någon
  datapath alls. Webbläsaren anropar LLM-leverantören direkt, med användarens
  egna nycklar; hela pipelinen körs klientsidigt; allt tillstånd ligger
  förseglat lokalt. "Vi ser inte din data" blir en *strukturell* egenskap, inte
  en policyrad.
- DeepResearch.**Se/rver** — den inloggade nivån, där molnlagring ingår i själva
  valet av nivå och konversationer vilar som ciphertext hela vägen, med en
  nyckelhierarki vars strängaste steg är matematiskt oläsbart för servern.

Se/cure kommer alltid först, för det är där tesen prövas hårdast: att även en
riktig, kapabel assistent kan byggas så att det helt enkelt inte *finns* något
för servern att läcka. Samma öppenhet gäller uppåt i hela stacken — takten är
öppen (dashboarden `/pulse` genereras direkt ur git-historiken), koden är öppen,
och sajten kan till och med förklara sin egen implementation för dig i klartext.
Varje påstående i serien är avsett att gå att kontrollera. Det är metodpoängen,
och den återkommer i varje artikel.

## Vad det håller på att bli: början till en agentplattform

Och det är här det blivit mer än en enskild assistent. Det som finns nu är nästan
början till en **agentorkestreringsplattform**.

Grundenheten är en säker instans — fortfarande tänkt för att en människa ska
sitta och interagera med den. Men arkitekturen gör att man kan *spinna av*
sådana instanser. En instans behöver inte vara en chattflik någon tittar på: den
kan lika gärna vara en prompt eller en schemalagd uppgift som startar i
bakgrunden, kör sitt, och som du kan öppna och kika in i när du vill — eller som
bara tyst matar innehåll in i kunskapsbasen för ett projekt. Och åtkomsten är
**mätt**: en instans får en token för precis de typer av åtkomst den behöver via
huvudsajten, och det kan finnas flera instanser av den huvudsajten. (Det är
exakt vad Se/rver-token-familjen redan gör — en signerad token med en
`perms`-mängd och en mätad kvot per behörighet.)

Poängen är inte att allt det här är färdigt; mycket är fortfarande hypotes, i god
80-procentsanda. Poängen är att bitarna — mätade tokens, avspinnbara instanser,
projektkunskapsbaser, bakgrundskörningar — har hamnat tillräckligt nära varandra
för att formen ska börja synas.

## "SaaS-complete": SDK:n som destillerar fram varianter

Den sista pusselbiten är att jag också släpper en **SDK**. Inte ett vanligt
bibliotek, utan i praktiken en uppsättning *skills* som — tillsammans med den
starkt modulära, seriellt beroendeordnade arkitekturen — gör något ovanligt: du
ska kunna **destillera ut vilken delmängd av kapabiliteterna som helst** ur den
här 80-procentiga referensimplementationen. Och göra det med *mindre* modeller,
som skulle klara att sätta ihop något sådant från grunden givet planen.

"Turing-complete" är fel ord för ambitionen. Jag tänker snarare på det som
*SaaS-complete*: idén att referensimplementationen plus SDK:n täcker tillräckligt
av idérummet för att en godtycklig SaaS-liknande variant ska gå att stämpla ut ur
den — en agentorkestreringsplattform plus en sorts guide för självutveckling, som
producerar nya lägen och därigenom täcker in hela idérummet, körd inom LLM:ens
eget tankeutrymme. Det är den mest spekulativa tesen i projektet, och jag flaggar
den som just spekulativ. Men det är den riktning arkitekturen pekar.

## Bilden av det parallella: feature-fokus-tidslinjen

Om en enda bild ska fånga vad "80 procent, brett" betyder i praktiken är det den
här. Under `/pulse` finns en andra graf — **feature-fokus-tidslinjen** — som
inte räknar commits eller rader, utan visar *vad* arbetet handlade om över tid:
varje commit taggas med de temaområden den rör, och grafen ritar hur områdena
stiger, konkurrerar och ebbar ut dag för dag, som parallella linjer (eller ett
streamgraf-band).

Siffrorna bakom bilden, alla ur git-historiken för samma tvåveckorsfönster
(4–17 juli): **716 commits fördelade på 25 temaområden**, där 88 % av alla
commits bär minst ett tema och **17 av områdena har fler än tjugo commits var** —
alltså i storleksordningen sjutton *samtidigt pågående* utvecklingsspår under
samma två veckor. Linux-sandboxen, introspektionsläget, Se/cure-nivån, kart- och
geo-intelligensen, hjälp och dokumentation, adminpanelens beslutstavlor, kvoter
och konton — de växer inte i tur och ordning, utan om vartannat, ofta samma dag.

Det är just därför grafen får vara med redan i introduktionen: den gör det
abstrakta ("integration och orkestrering av många kapabiliteter") visuellt och
konkret. Man *ser* att projektet inte är en funktion som polerats, utan ett
tjugotal kapabilitetsspår som förts samman parallellt — och eftersom taggningen
görs på commit-ämnena ur git går även den bilden att räkna efter. Grafen finns
live på `/pulse/timeline.html`.

## Ärlighet först: det här är ett experiment

Lika tydlig som med syftet vill jag vara med mognaden: **det här är
experimentellt och långt ifrån produktionsfärdigt** — och ska så förbli, enligt
80-procentsdoktrinen ovan. Det finns funktioner som regresserat om och om igen,
hörn som är trasiga, och hela idéer som ännu bara är hypoteser jag inte bevisat.
Serien redovisar det som *inte* gick bra lika noga som det som gick — annars vore
det inte forskning, bara en segerberättelse.

Ursprunget — att en första fungerande version kom till under en helg, mestadels
från en telefon — är just ett ursprung, inte en identitet. Hela den historien
finns på `/story` för den nyfikne, men den är inte poängen. Poängen är frågorna
ovan, och vad man faktiskt lär sig av att försöka besvara dem i körande kod.

## Vad serien går igenom

Serien tar **ett konkret spår i taget** — en artikel, ett tydligt avgränsat ämne
ur samma experiment, i stället för en enda lång genomgång. De följande artiklarna
behandlar var sitt: en kodbas på ~137 000 rader med noll runtime-beroenden;
distribuerade säkra forskningsutrymmen som går att förladda, dela och försegla
resultat ur; den deterministiska pipelinen som klarar sig helt utan function
calling; DistillSDK och idén att destillera fram exakt den mjukvara du behöver;
privacy-paret Se/cure + Se/rver i detalj; en riktig Linux-miljö som kör i
webbläsarfliken utan att en byte lämnar din maskin; en förvaltningsmodell där
AI-agenter äger och underhåller sina egna fixar; öppna standarder som medvetet
leder koden; och sajten som kan förklara sin egen källkod. Varenda en är en
vinkel på samma sak: hur mycket kapabilitet — och hur mycket plattform — som ryms
innanför bevisbar integritet.

## En inbjudan, inte ett erbjudande

Vore det här en produkt hade jag bett dig registrera dig. Eftersom det är
forskning ber jag om något annat: **läs koden, försök knäcka den, och berätta vad
som gick sönder.** Allt är MIT-licensierat och avsiktligt öppet, just för att den
här sortens frågor bara blir intressanta när fler än en person tittar på svaret.

Det här är artikel 2 av serien — den första efter nyhetsingången. Nästa gång, i
det första ämnesspåret: **noll
beroenden** — hur ~137 000 rader kod körs utan ett enda runtime-paket och utan
byggsteg, varför AI-assisterad utveckling ritat om hela beroendekalkylen, var
gränsen ändå går absolut (man skriver inte sitt eget krypto), och varför en
kodbas utan `node_modules` är det som gör Se/cure:s "servern ser inte din data"
till något du kan *läsa dig till* i stället för att tro på.

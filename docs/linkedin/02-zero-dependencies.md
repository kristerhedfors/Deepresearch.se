# Artikel 2 — Noll beroenden: 137 000 rader utan node_modules

> **Första ämnesartikeln.** Full version av zero-dependencies-spåret i
> artikelserien (abstracten ligger i `public/js/account-articles.js`,
> fulltexterna här i `docs/linkedin/`; det här motsvarar abstract 6). Skriven
> för LinkedIn, på svenska, i förstapersonsröst. Bärande siffror är
> verifierbara i repot och på `/pulse` (måtten nedan från size-mätningen
> 2026-07-17). Publiceringsstatus: utkast.

---

## En siffra att börja i

I förra artikeln lovade jag att serien tar ett konkret spår i taget ur samma
experiment. Här är det första: **noll beroenden.**

Måttet, hämtat direkt ur repots egen storleksmätning: **137 475 rader kod, 548
filer, tio språk — noll runtime-beroenden, tre dev-beroenden, inget byggsteg.**
Ingen bundler, ingen transpilering, inget React, ingen webpack-konfiguration.
Workern deployas precis som den ligger, och klienten laddar ES-moduler direkt i
webbläsaren. De tre dev-beroendena är TypeScript och Cloudflares typdefinitioner
(för `npm run typecheck`, utan byggsteg) plus ett test-verktyg — inget av dem
följer med ut i det som körs.

Jämförelsen som gör siffran begriplig: ett nystartat standardprojekt i samma
nisch — en webbapp med chatt, streaming och ett par integrationer — drar
typiskt in storleksordningen tusen transitiva npm-paket i `node_modules` innan
den första egna raden är skriven. Här är det noll.

Jag tar inte upp det för att skryta om asketism. Jag tar upp det för att det är
ett av seriens tydligaste exempel på en tes jag tror på: **AI-assisterad
utveckling har ritat om beroendekalkylen i grunden, och de flesta projekt räknar
fortfarande på den gamla.**

## Vad "noll beroenden" faktiskt betyder — och inte betyder

Låt mig vara ärlig med gränserna direkt, för annars blir siffran en bluff.

"Noll beroenden" här handlar om **npm-försörjningskedjan och byggsteget** — inte
om att det inte finns en enda rad tredjepartskod i systemet. Det finns
tredjepartskod, men den är hanterad på ett annat sätt:

- **Vendrade bibliotek.** Ett fåtal beprövade klientbibliotek — markdown-rendering,
  HTML-sanering, PDF-generering, en terminalemulator — ligger *incheckade i
  repot*, pinnade till en version, läsbara på plats. Ingen installerar dem, ingen
  uppdaterar dem i det tysta, och de går att läsa i samma pull som allt annat.
- **Plattformens primitiver.** Där jag behöver kryptografi använder jag
  webbläsarens inbyggda `crypto.subtle` (AES-256-GCM), inte ett inlånat
  kryptobibliotek. Mer om just det längre ner — det är den viktigaste
  gränsdragningen i hela artikeln.

Så det ärliga påståendet är inte "ingen kod utom min egen". Det är: **noll paket
som en pakethanterare drar in transitivt, noll byggsteg mellan källkoden och det
som körs, och varje bit tredjepartskod som ändå finns är pinnad och läsbar i
repot.** Skillnaden mot ett vanligt `node_modules` är inte estetisk. Den är att
hela systemet går att *läsa* utan att först lita på en försörjningskedja man inte
kan se botten på.

## Varför kalkylen ändrats

Beroenden köptes historiskt för att utvecklartid var dyr. Hellre någon annans
testade datumbibliotek än att skriva och underhålla ett eget en hel vecka. Det
var en helt rationell affär: du bytte en engångskostnad (hitta, lära, wrappa
paketet) mot att slippa en återkommande kostnad (skriva och underhålla koden
själv), och den andra sidan vann nästan alltid.

Den affären hade *två* sidor, och man betalade bara uppmärksamhet åt den ena.
Priset man såg var utvecklartid. Priset man inte bokförde var allt det andra ett
beroende drar med sig: försörjningskedjerisk (vem äger paketet nästa år, och vad
händer om deras publiceringskonto kapas), versionsröta, uppgraderingslöpbandet,
den transitiva grafen av paket-som-drar-in-paket, och revisionsbördan av att
någon faktiskt ska förstå vad allt det gör.

När en agent skriver limkoden på minuter faller den *första* sidan av kalkylen —
den dyra utvecklartiden — nästan till noll. Men den andra sidan står kvar
oförändrad, eller värre. Att skriva en egen liten hjälpfunktion i stället för att
dra in ett paket kostade förr en dag; nu kostar det ett par minuter och en
prompt. Och det man får tillbaka är kod man äger, kan läsa, och kan resonera om.
**När den ena sidan av en gammal avvägning kollapsar med en tiopotens bör man
räkna om avvägningen — inte fortsätta köra på vanan.** Det är precis vad det här
projektet gör som ett medvetet experiment: räkna om, varje gång.

## Kopplingen till missionen: beroenden gör verifierbarhet svårare

För just det här projektet är kopplingen till huvudfrågan direkt, inte en
bonus. Hela poängen med **Se/cure**-nivån är att en utomstående ska kunna *läsa
sig till* att servern inte ser data — att "vi ser inte din data" är en
strukturell egenskap i den öppna källkoden, inte en policyrad man ombeds tro på.

Varje beroende är en svart låda som gör exakt den läsningen svårare. Om jag ber
dig verifiera att ingen kodrad skickar ditt innehåll till en server, och svaret
kräver att du först granskar tusen transitiva paket för att vara säker på att
inget av dem gör något oväntat med `fetch`, då har jag inte gett dig
verifierbarhet — jag har gett dig ett nytt, större löfte att lita på. En kodbas
utan `node_modules` är oberoende verifierbarhet i praktiken: granskningsytan är
det som ligger i repot, punkt.

Det är samma metodpoäng som återkommer i varje artikel i serien — skillnaden
mellan "lita på oss" och "läs själv" — sedd från försörjningskedjans håll.

## Frontier-modeller minar zero-days — åt båda hållen

Här kommer argumentet som gör det här mer akut än en smakfråga om ren kod.

Frontier-modeller har blivit påtagligt bra på att hitta allvarliga
säkerhetshål — inklusive tidigare okända, riktiga zero-days — i öppen källkod, i
en skala och takt en människa inte matchar. Det är i grunden en bra sak: samma
kapabilitet härdar mjukvara vi alla är beroende av. Men det ändrar hotbilden för
den som bygger.

För om modeller kan mina allvarliga sårbarheter ur öppna komponenter *i skala*,
så blir varje beroende du drar in en post på en lista som förr eller senare gås
igenom — inte av en enskild forskare som råkar bry sig, utan systematiskt. Din
angreppsyta är inte längre bara din egen kod; den är din kod plus hela den
transitiva grafen, och den grafen granskas nu av maskiner som inte tröttnar.

Slutsatsen jag drar är inte "därför är öppen källkod farlig" — tvärtom, den
öppenheten är vad som gör härdningen möjlig. Slutsatsen är: **börjar du från en
grund med noll beroenden är du i full kontroll över exakt vilka ytterligare
beroenden du väljer att ta in.** Varje tillägg blir ett medvetet beslut med ett
namn och ett motiv, inte något som följde med på köpet fem nivåer ner i en graf
du aldrig läste. Du kan inte härda en yta du inte vet att du har.

## Drift-argumentet — och dess baksida

Det finns en andra, subtilare effekt, och jag tar den med baksidan påslagen
eftersom den lätt blir ett självbedrägeri annars.

När du bygger vidare på en öppen komponent och din implementation *driftar* — du
skär bort det du inte använder, byter en primitiv, formar om datamodellen efter
dina behov — så gäller inte nödvändigtvis en sårbarhet som finns kvar i
originalet längre för din version. Koden som hålet satt i finns kanske inte kvar
hos dig. Ett konkret exempel i det här repot: de säkra workspace-länkarnas
krypto är designat så nära som möjligt efter ett tidigare projekt (hacka.re), men
med en substitution — och en klass av antaganden som gäller originalets exakta
chiffer behöver därför inte gälla här.

Baksidan, som jag vägrar dölja: **drift betyder också att du tappar
uppströmmens säkerhetsfixar.** När originalet lagar ett hål får du inte lagningen
gratis via en versionsbump — du måste själv veta att den behövs och göra den. Du
har bytt "ärver deras buggar automatiskt" mot "ärver varken deras buggar eller
deras fixar automatiskt". Det är en *annan* riskprofil, inte en entydigt lägre.
Poängen är kontroll och läsbarhet, inte en gratis säkerhetsvinst — och den som
säljer drift som gratis säkerhet ljuger.

## Där noll beroenden INTE gäller: kryptot

Här är den viktigaste gränsdragningen, och den är absolut: **man skriver inte
sina egna kryptoalgoritmer.**

Att "vibe-koda" ett eget chiffer eller en egen nyckelutbytesrutin är ett av de
mest välbelagda katastrofala misstagen i hela fältet. Säker kryptografi handlar
inte om att en algoritm *ser* korrekt ut för den som skrev den; den handlar om
år av öppen kryptoanalys mot exakt den implementationen, sidokanaler medräknade.
Ingen mängd AI-genererad självsäkerhet ersätter det.

Så här lutar projektet sig uttryckligen mot beprövade primitiver i stället för
egna: all innehållskryptering — chatthistorik, filer, valv, Se/cure:s förseglade
state, workspace-länkar — går via webbläsarens inbyggda `crypto.subtle` med
AES-256-GCM. Det är plattformens implementation, granskad och underhållen av dem
som bygger webbläsaren, inte min. Och där en konstruktion ändå behövde formas
(workspace-länkarnas krypto) klonades designen så troget som möjligt från ett
äldre, genomtänkt original snarare än att uppfinnas från grunden — men fortfarande
utan att skeppa ett eget kryptobibliotek.

Det är så "noll beroenden" ska förstås korrekt: **inte som dogm, utan som en
disciplin med principfasta undantag.** Sätt du inte får ha fel om — kryptot
framför allt — hämtar du från källor som förtjänat förtroendet genom öppen
granskning. Överallt annars, där ett beroende bara köper dig sparad
utvecklartid, räknar du om kalkylen och skriver det själv. Ett par vendrade
klientbibliotek och plattformens krypto är exakt de undantag som bekräftar
regeln.

## Ärlighet först: noll beroenden är inte en säkerhetsgaranti

Och så det jag är mest angelägen om att säga, i linje med hela seriens
80-procentsanda: **noll beroenden gör inte den här koden säker.**

Referensimplementationen är aldrig avsedd att vara hundra procent. Den ligger på
sina åttio, och den har på intet sätt säkerhetstestats grundligt — ingen
fullständig revision, ingen penntestrunda, inga garantier. Det finns med all
sannolikhet buggar och hål i min egen kod precis som det finns i vilken kodbas
som helst som inte gått igenom det arbetet. Det jag fokuserar på i de här första
åttio procenten är att få **arkitekturen** rätt: att strukturen — var data får
finnas, vad som är strukturellt omöjligt, vad som måste vara verifierbart —
håller. Att härda själva implementationen mot en beslutsam angripare är en känd
och lösbar uppgift (de sista tjugo procenten) som medvetet ligger senare.

Så det ärliga påståendet är smalt och precist: noll beroenden är inte ett påstått
skydd, utan en **arkitektonisk hållning som gör granskning möjlig.** Den flyttar
frågan "kan jag lita på den här försörjningskedjan?" till "kan jag läsa den här
koden?" — och det andra är en fråga vem som helst kan svara på själv. Om koden är
osäker ska du kunna *se* att den är det. Det är hela poängen, och det är också
gränsen för vad siffran i toppen bevisar.

## Nästa gång

Det här var det första ämnesspåret. Nästa artikel tar det längsta klivet ut från
den enskilda assistenten: **distribuerade säkra forskningsutrymmen** — hur man
paketerar ett komplett, förseglat forskningsläge i en länk, distribuerar sådana
noder förladdade med underlag och konversationer så att andra kan arbeta vidare i
dem, och sedan *förseglar resultaten tillbaka* med utgångsanvändarens öppna
nyckel så att bara den mottagaren kan läsa dem. Och mekanismen som knyter ihop
det: att aggregera och slå samman slutsatserna från en hel uppsättning
distribuerade forskningsagenter till en helhet. Det är där noll-beroende-grunden
och det säkra paret slutar vara en egenskap hos en flik och börjar bli ett
protokoll.

Läs koden, försök knäcka den, och berätta vad som gick sönder. Allt är
MIT-licensierat.

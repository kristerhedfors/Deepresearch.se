# Artikel 3 — Distribuerade säkra forskningsutrymmen

> **Andra ämnesartikeln.** Full version av workspace-spåret i artikelserien
> (abstracten ligger i `public/js/account-articles.js`, fulltexterna här i
> `docs/linkedin/`). Skriven för LinkedIn, på svenska, i förstapersonsröst.
> Det här är seriens mest *spec-first* artikel: den beskriver en
> referensimplementation som ännu byggs (spårad som **F-18** i `FEATURES.md`),
> så läs den som ett protokollförslag med en delvis färdig grund — inte som en
> avklarad funktion. Publiceringsstatus: utkast.

---

## Från en flik till ett protokoll

I de två första artiklarna byggde jag upp två saker: att projektet är ett
80-procents forskningsexperiment om bevisbar privacy, och att grunden är en
kodbas utan beroenden man måste lita blint på. Den här artikeln tar det längsta
klivet ut från den enskilda assistenten — och det är också den mest
framåtblickande, för här beskriver jag något som till stora delar fortfarande är
en *specifikation* jag håller på att implementera.

Utgångspunkten är en funktion som redan finns: **säkra workspaces.** Ett
workspace är en fullständigt konfigurerad Se/cure-session — API-nycklar,
inställningar, konversationer, eventuellt ett par tillfälliga kvotbundna
tokens — serialiserad, krypterad och packad i *URL-fragmentet* av en enda länk:

```
https://deepresearch.se/cure/workspace#w=<base64url( salt ‖ nonce ‖ ciphertext )>
```

Länken **är** hela arbetsutrymmet. Det finns ingen serverpost, ingen lagringsrad,
inget id. Allt efter `#` är ankaret, som webbläsare aldrig skickar till servern —
så själva mediet garanterar att innehållet aldrig lämnar klienten. Krypteringen
är AES-256-GCM via webbläsarens inbyggda `crypto.subtle` (samma principfasta
kryptoval som artikel 2 landade i), och designen är så troget som möjligt klonad
från ett tidigare projekt av mig, hacka.re.

Frågan den här artikeln ställer är: vad händer när man tar den där förseglade
länken och gör den till *enheten i ett distribuerat forskningsflöde*?

## Steg 1 — Förladda och distribuera

Tänk dig att du sitter på ett underlag — dokument, tidigare konversationer, en
uppsättning frågeställningar — och vill att flera personer, eller flera
AI-agenter, arbetar vidare på var sin del. I dag är det ett integritetsdilemma:
antingen laddar alla upp allt till en gemensam molntjänst (och du har tappat
kontrollen över var det vilar), eller så mejlar du filer fram och tillbaka.

Med workspace-mekanismen blir mönstret ett annat. Ursprungsanvändaren — ett
Se/rver-konto — **packar varje utsnitt av underlaget till en egen förseglad
workspace-länk**, förladdad med precis det material och de konversationer den
noden ska jobba med, och delar ut länkarna. Varje mottagare öppnar sin länk,
och får en komplett, körande Se/cure-miljö i sin egen webbläsare — utan konto,
utan att något av innehållet passerar min server. Distributören delar alltså ut
*arbetsplatser*, inte bara data.

## Steg 2 — Försegla resultaten tillbaka, asymmetriskt

Här kommer den nya kryptografiska biten, och den är kärnan i F-18.

En vanlig workspace-länk är **symmetrisk**: den är förseglad under ett lösenord,
och vem som helst med länk plus lösenord kan öppna den. Det duger för att dela en
session med sig själv eller en betrodd part. Men för distribuerade noder vill jag
ha *asymmetrisk retur*: att en nod kan lämna tillbaka sitt resultat så att **bara
ursprungsanvändaren** kan läsa det — inte de andra noderna, inte servern, inte
jag.

Mekanismen: ursprungsanvändaren publicerar en **publik nyckel**. När en nod är
klar **förseglar den sina resultat mot den publika nyckeln**. Väl förseglat kan
paketet bara öppnas av den som håller den privata nyckeln — distributören.
Distributören delar alltså ut utrymmen förladdade med underlag, och får tillbaka
resultat som är kryptografiskt läsbara enbart för hen. Ingen mellanhand, servern
inräknad, kan läsa vad noderna kom fram till.

Och — i linje med artikel 2 — det här bygger jag *inte* med eget krypto. Valet av
primitiv ska följa no-own-crypto-regeln: webbläsarens asymmetriska WebCrypto-
primitiver eller en väl granskad design, aldrig ett hemmasnickrat schema. Att
"vibe-koda" ett nyckelutbyte är precis det katastrofmisstag artikel 2 varnade
för.

## Steg 3 — Aggregera och slå samman

Den sista biten är reduce-steget i vad som i praktiken är en *map-reduce över
forskningsutrymmen*. Ursprungsanvändaren som skapade länkarna behöver **samla in
de förseglade resultatbuntarna, dekryptera dem lokalt, och kombinera slutsatserna
från hela uppsättningen distribuerade forskningsagenter till en helhet.**

Det är inte bara en hög med filer. Den sammanslagna formen måste **bevara
proveniens per nod** (vilken slutsats kom varifrån) och **förlika** motstridiga
resultat i stället för att bara konkatenera dem. Och hela insamlingsytan hålls
förenlig med workspace-buntstandarden DRSW/1 (artikel 8:s ämne), så att ett
förseglat resultat helt enkelt *är* en workspace-bunt med ett asymmetriskt
kuvert runt sig. Ett format, två operationer: paketera ut, samla in.

## Varför det här är mer än en delningsfunktion

Poängen är inte att det är smidigt att dela en länk. Poängen är vad det gör med
*ägandet* av ett forskningsläge.

I den vanliga modellen bor ditt arbete i en operatörs servrar och du är hyresgäst
där. När forskning i stället är en förseglad bunt som distribueras, bearbetas och
förseglas tillbaka — utan att någon nod på vägen kan läsa den utan rätt nyckel —
så slutar det säkra paret vara en egenskap hos *en flik* och börjar bli ett
*protokoll*. Ingen central nod håller ditt tillstånd; det finns inget att läcka,
stämma ut eller migrera från, eftersom arbetet aldrig låg *på* något. Det är den
riktning artikel 8:s "stackless research"-vision pekar, och distribuerade säkra
utrymmen är det första konkreta steget dit.

## Ärlighet först: det här är till stor del ännu en spec

Jag är noga med det här, för annars vore artikeln en överförsäljning: **grunden
finns, loopen gör den inte än.** Den enskilda säkra workspace-länken är byggd och
körbar i dag. Den asymmetriska förseglingen tillbaka och aggregerings-/
sammanslagningsmekanismen är spec:ade men ännu inte färdigimplementerade — de är
spårade som ett öppet arbete, och den här artikeln dokumenterar
referensimplementationen medan den växer fram, inte en avklarad funktion.

Det är helt i linje med seriens 80-procentsdisciplin och med
interchange-standardernas spec-first-hållning: formen på kuvertet och den
sammanslagna bunten definieras *innan* UI:t wiras. Privacy-invarianterna är
oförhandlingsbara och följer med oförändrade — ingen server i en Se/cure-datapath,
det förseglade kuvertet är ogenomskinligt för servern, nycklar loggas aldrig.

Nästa gång tar serien ett steg tillbaka till grunden igen och tittar på varför
hela den här pipelinen är byggd *utan* function calling — den deterministiska
orkestrering som gör att allt ovan kan köras på vilken modell som helst, också en
liten som du kör själv. Läs koden, försök knäcka den, och berätta vad som gick
sönder. Allt är MIT-licensierat.

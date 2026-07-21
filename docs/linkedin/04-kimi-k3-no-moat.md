# Artikel — "We have no moat": Kimi K3, det försvunna glappet, och varför flaskhalsen nu är compute

> **Fristående take.** En egen ingång till samma experiment, byggd kring en
> färsk nyhet. Skriven för LinkedIn, på svenska, i förstapersonsröst.
> Sifferpåståendena om Kimi K3 är hämtade från lanseringsrapporteringen
> (juli 2026) och källhänvisade sist. Bärande siffror om projektet självt är
> verifierbara i repot och på `/pulse`. Publiceringsstatus: utkast.

---

## Ingången: glappet stängdes

Under 2023 läckte ett internt Google-memo med en rubrik som blev bevingad:
*"We have no moat, and neither does OpenAI."* En ingenjör argumenterade för att
de stora labbens försprång inte var en vallgrav — att öppna modeller skulle
komma ikapp snabbare än någon vågade tro, och att hela värdet i att sitta på de
bästa vikterna skulle förångas.

Då var det en spådom. En välinformerad gissning, men en gissning.

I juli 2026 är det en observation. Moonshot AI släppte **Kimi K3** — öppna
vikter, från ett kinesiskt labb, 2,8 biljoner parametrar, den största
öppenviktsmodellen någonsin — och den landar mitt i de amerikanska labbens
frontier. På Artificial Analysis Intelligence Index v4.1 får K3 **57,1**, mot
GPT-5.6 Sol på 58,9 och Claude Fable 5 på 59,9. Alltså: den ligger fortfarande
ett hår efter det absoluta toppskiktet på generellt resonemang — men det glappet
är det minsta som någonsin funnits mellan en helt öppen modell och de bästa
stängda systemen.

Och på den axel som betyder mest för den som *bygger* med de här modellerna har
glappet inte bara krympt — det har vänt. I blindtest på Frontend Code Arena rankas
K3 **etta**, 1 679 Elo, före både Fable 5 (1 631) och GPT-5.6 Sol (1 618); i kod
och agent-uppgifter slår den Claude Opus 4.8 och GPT-5.5. **Vallgraven behöver
inte vara noll på varenda axel för att vara borta — det räcker att den öppna
modellen redan leder där du faktiskt tänkte använda den.** Och för agentiskt,
verktygsdrivet arbete är den där.

Det här är inte en artikel om vem som vann. Det är en artikel om vad det
*betyder* — och den korta versionen är att den bristvara som byggare betalade för
igår, rå modellintelligens, just blev något du kan ladda ner. Det som återstår som
verklig begränsning är inte längre intelligensen. Det är **compute.**

## Varför en försvunnen vallgrav är goda nyheter

Det intuitiva är att se det här som dåliga nyheter: enorma värden som fördunstar
hos ett fåtal labb. Och ja, marknadsvärdet i att äga frontier tog en rejäl smäll
den dag försprånget slutade vara försvarbart. Men den värdeförlusten hos några få
är en värdeöverföring till alla andra. **Frontier-intelligens slutar vara något
en handfull aktörer får grinda ut, och blir något du kan köra själv.** Det är
decentralisering av den mest strategiska resursen i fältet, och den lutar åt
rätt håll för nästan alla utom labben själva.

Poängen är inte skadeglädje över några labbs kvartalssiffror. Poängen är riktningen:
kapabiliteten som förut satt inlåst bakom en API-vägg och en prislapp ingen kunde
förhandla ligger nu som nedladdningsbara vikter vem som helst med hårdvaran kan
köra. Det är, på riktigt, en av de största överföringarna av teknisk kapacitet
till allmänheten som fältet har sett.

## Den nya bristvaran: compute, inte intelligens

Men "vem som helst med hårdvaran" bär hela poängen. En 2,8-biljonersmodell körs
inte på en laptop. Att äga vikterna är gratis; att *köra* dem är det inte. Och
just där sker skiftet den här artikeln egentligen handlar om:

> När intelligensen blir en nedladdningsbar råvara flyttar knappheten. Den nya
> bristvaran är inte modellen — det är **compute att köra den på.**

Det är faktiskt goda nyheter förklädda till en begränsning, för compute är en
*ärlig* begränsning. Den är fungibel, hyrbar, mätbar och sjunker i pris år för år.
Den kräver ingen leverantörs tillåtelse och ingen väntelista. Till skillnad från
en stängd modells vallgrav — som var någon annans strategiska beslut att inte dela
med sig — är compute en resurs du antingen har eller kan skaffa. Vallgraven som
försvann var artificiell knapphet. Det som ersätter den, compute, är riktig
knapphet, och riktig knapphet går att planera runt.

Och det leder till den ena hälften av det jag faktiskt vill säga: om modellen inte
längre är flaskhalsen, vad är då kvar mellan en idé och en körande applikation?
Svaret, visar det sig, är förvånansvärt lite — givet rätt byggställning. Vilket för
oss till de senaste två veckorna.

## Vad överflödet byggde: två veckor på Fable 5

De senaste två veckorna har jag byggt vidare på det här projektet nästan
uteslutande med **Fable 5** som drivande modell — och det jag ville testa var
precis den här tesen i praktiken: om rå intelligens har blivit överflöd, hur
snabbt går det då att destillera fram *ny* mjukvara ur det överflödet?

Verktyget för det är `sdk/`-katalogen i repot: **DistillSDK.** Idén i namnet är
*destillering* — du utgår från en bred baseplate (i dag 33 modulära
kapabilitetsmoduler, var och en med en byggbar skill) och *skalar ner* till exakt
det en given uppgift behöver, i stället för att be modellen improvisera fram allt
från noll. I appen är det "SDK-läget": ett läge som tar hela den här sajten — och
framför allt den klientsidiga **Se/cure**-nivån — och destillerar den till en ny,
självständig webbapp-*variant*, publicerad live på `/app/<slug>/`.

Och det som blev tydligt är att formen på det du kan stämpla ut är bred. Chattklienter
i olika skepnader. Forskningspipelines. Små fokuserade verktyg. Var och en tar
dagar, inte månader — inte för att jag skriver koden snabbare, utan för att modellen
plus SDK:et bär det mesta av kompositionen. Uppgiften blir att *välja* rätt
delmängd av kapabiliteter och beskriva varianten, inte att bygga varje bit från
grunden.

Det är hela poängen med "mjukvara som överflöd". Det som förr var det dyra —
själva byggandet — komprimeras när intelligensen är riklig och byggställningen är
rätt. Du beskriver vad du vill ha; du får en körande sak tillbaka. Det som återstår
som verklig kostnad är inte längre "kan det byggas" utan "har jag compute att köra
det".

## Andra hävstången: låt en svagare modell arbeta över sin klass

Och här möts de två trådarna. För DistillSDK-tesen är inte bara "bygg snabbt" —
den är också: **du behöver inte ens toppmodellen, om du bygger rätt runt den.**

En sub-frontier-modell kan lösa uppgifter över sin normala gräns om den får rätt
byggställning runt sig. Inte genom att modellen blir smartare, utan genom att den
slipper hålla allt i huvudet på en gång. Ge den i stället en verktygslåda av
modulära, väldefinierade kapabiliteter plus en uppsättning skills — buntade i ett
SDK — och låt uppgiften avgöra vilka bitar som plockas fram. En svagare modell med
rätt bitar tillgängliga i lådan komponerar ihop ett resultat den aldrig hade nått
på fri hand.

Kopplingen till hela seriens ramverk är direkt, ända ner till arbetssättet: det
mesta i det här projektet byggs strikt från en telefon, med en agent och en väldigt
begränsad kontext. Det är själva förutsättningen som gör metoden skarp — när
utvecklingsenheten är en mobil och modellen inte kan hålla hela systemet i huvudet,
är modulära bitar och färdiga skills inte en lyx utan det som gör uppgiften
genomförbar. Byggställningen är det som bär, inte råstyrkan i modellen.

Lägg ihop det med en öppen modell i klass med frontier: du kan köra en kapabel
modell **själv, privat**, och du behöver inte ens den absolut starkaste — du
behöver rätt verktygslåda, nedskalad till uppgiften, och compute att köra den på.

## Det öppna har en egenskap det stängda inte kan ha: granskbarhet

Innan jag knyter ihop det, en sak som är lätt att missa i kapp­loppet om
prestanda. Den viktigaste skillnaden mellan öppna och stängda vikter, i det här
projektets lins, är inte poäng på ett index. Det är **granskbarhet.**

Öppna vikter går att ladda ner, examinera, finjustera och anpassa i en helt annan
grad än en modell du bara når via ett API. Framför allt: du kan *köra dem utan att
skicka din data någon annanstans.* En stängd modell som du når som en tjänst är per
definition en svart låda i datavägen — du skickar ditt innehåll till någon annans
server och kan inte verifiera vad som händer med det på andra sidan. Det bär en
implicit risk värd att säga rakt ut: **oupptäckbar övervakning.** Inte som
anklagelse mot en specifik leverantör, utan som strukturellt faktum — en tjänst du
inte kan inspektera kan du heller inte hålla ansvarig. Öppna vikter tar inte bort
förtroendefrågan helt, men de flyttar den från "lita på att deras server beter sig"
till "kör det på din egen", och det är en helt annan klass av garanti. Samma
metodskillnad återkommer i varje artikel jag skriver om det här: **skillnaden
mellan "lita på oss" och "läs — och kör — själv".**

För det här projektet är det inte en abstrakt vinst. Hela **Se/cure**-nivån bygger
på premissen att servern aldrig ska vara i datavägen — att du ska kunna köra din
research utan att någon molntjänst ser innehållet. Den premissen hade ett svagt
ställe så länge "tillräckligt bra" bara fanns bakom en stängd API-vägg: då tvingades
*aldrig-molnet* välja mellan integritet och kapabilitet. När en öppen,
självhostbar modell blir tillräckligt bra — och på kod och agent-uppgifter till och
med bäst — försvinner det valet.

## Ärligheten: öppna vikter är inte gratis integritet

Här måste jag ta baksidan med, annars blir argumentet en säljpitch — och den här
serien är en forskningslogg, inte en kampanj.

Öppna vikter ger dig inte integritet på köpet. De ger dig *möjligheten* till den.
En öppen modell som du kör hos en molnleverantör är fortfarande en svart låda i
datavägen — det är *var* den körs, inte licensen på vikterna, som avgör om din data
lämnar dig. Och "öppen" betyder inte längre "spottbillig": K3 prissätts som tjänst
till 3 dollar per miljon input-tokens och 15 per miljon output — i klass med de
stängda, inte en tiondel av dem. Poängen med öppenheten är inte att API:t är gratis;
det är att du *inte behöver API:t* — du kan hosta själv. Och där dyker den nya
bristvaran upp igen: att hosta själv kräver compute, och att köra en 2,8-
biljonersmodell privat kräver hårdvara som inte alla har. Finjustering kan införa
sina egna problem. "I klass med frontier" varierar med uppgiften, och på rent
generellt resonemang är glappet fortfarande mätbart.

Så det ärliga påståendet är smalt: den försvunna vallgraven **möjliggör** privat,
kapabel research som förr krävde ett val mellan de två. Den *garanterar* den inte.
Att stänga det sista glappet mellan "möjligt" och "verkligt" är arbete — och en del
av det arbetet är precis det jag beskrev ovan.

## Där trådarna möts

Lägg ihop det, och synteseffekten är hela poängen:

> En självhostbar, sub-frontier, öppen modell + ett destillerat SDK av modulära
> kapabiliteter = kapabelt **och** privat, utan att något av det behöver passera en
> svart låda du inte kan granska. Det enda som står mellan idén och den körande
> saken är compute.

Och det är ingen slump att det just är på **kod och agent-uppgifter** den öppna
modellen redan leder — det är precis den sortens arbete ett destillerat SDK av
verktyg och skills organiserar. De två trådarna är inte parallella; de förstärker
varandra på exakt samma axel. Det är den kombinationen som gör **Se/cure**-nivåns
aldrig-moln-löfte till något mer än en princip: en väg där du varken lånar din
kapabilitet av ett stängt labb eller din integritet av en molntjänst.

## Slutord: du får det du ber om — om du har compute

Det bevingade memot hade rätt, bara några år för tidigt. Vallgraven är borta, och
det är en gåva till alla som bygger för integritet och kontroll snarare än för
inlåsning. Kimi K3 är inte poängen i sig — den är beviset på att glappet mellan
"modellen du äger" och "modellen bara de har" har stängts tillräckligt, och på
byggarens axel redan vänt, för att ändra vad man rimligen kan bygga.

Och det förskjuter var den verkliga begränsningen sitter. Intelligensen blev en
råvara; mjukvaran blev, med rätt byggställning, nästan ett överflöd — de senaste två
veckornas byggande på Fable 5 är mitt eget bevis på det. Det som återstår som
knapphet är compute. Så det koka ner till en enda mening:

> **Du kan få den mjukvara du ber om — men du behöver compute för att komma dit.
> Har du compute får du det du ber om.**

Referensimplementationen är fortfarande experimentell, ligger på sina åttio procent
och är inte säkerhetsrevisorad — säg det rakt ut. Men riktningen är den här
artikelns hela poäng: när både kapabiliteten och verktygen slutar vara inlåsta bakom
en svart låda, blir bevisbar privacy ett byggbart mål i stället för en önskan — och
frågan "vad kan jag bygga?" byts mot den ärligare frågan "vad har jag compute att
köra?".

Läs koden, kör den själv, försök knäcka den, och berätta vad som gick sönder. Allt
är MIT-licensierat.

---

**Källor (Kimi K3-siffror):** Artificial Analysis Intelligence Index v4.1 och
Frontend Code Arena-Elo via lanseringsrapporteringen —
[VentureBeat](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[Axios](https://www.axios.com/2026/07/16/moonshot-kimi-ai-china-model-openai-anthropic),
[The Decoder](https://the-decoder.com/kimis-open-model-k3-nears-gpt-5-6-sol-and-fable-5-while-signaling-the-end-of-super-cheap-chinese-ai/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3).

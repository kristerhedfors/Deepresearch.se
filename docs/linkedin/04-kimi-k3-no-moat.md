# Artikel — "We have no moat": Kimi K3 och det försvunna glappet mellan öppna och stängda vikter

> **Fristående take.** En ny ingång till samma experiment — inte nästa steg i
> den numrerade serien utan en egen artikel byggd kring en färsk insikt.
> Skriven för LinkedIn, på svenska, i förstapersonsröst. Sifferpåståendena om
> Kimi K3 är hämtade från lanseringsrapporteringen (juli 2026) och
> källhänvisade sist. Bärande siffror om projektet självt är verifierbara i
> repot och på `/pulse`. Publiceringsstatus: utkast.

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
*betyder* för den som bygger LLM-applikationer med integritet som huvudfråga —
alltså precis det här projektet — och om en konkret metod för att dra nytta av
det.

## Varför en försvunnen vallgrav är goda nyheter

Det intuitiva är att se det här som dåliga nyheter: enorma värden som fördunstar
hos ett fåtal labb. Och ja, marknadsvärdet i att äga frontier tog en rejäl smäll
den dag försprånget slutade vara försvarbart. Men den värdeförlusten hos några få
är en värdeöverföring till alla andra. **Frontier-intelligens slutar vara något
en handfull aktörer får grinda ut, och blir något du kan köra själv.** Det är
decentralisering av den mest strategiska resursen i fältet, och den lutar åt
rätt håll för nästan alla utom labben själva.

För det här projektet är det inte en abstrakt vinst. Hela **Se/cure**-nivån
bygger på premissen att servern aldrig ska vara i datavägen — att du ska kunna
köra din research utan att någon molntjänst ser innehållet. Den premissen har ett
svagt ställe så länge "tillräckligt bra" bara finns bakom en stängd API-vägg: då
tvingas *aldrig-molnet* välja mellan integritet och kapabilitet. När en öppen,
självhostbar modell blir tillräckligt bra — och på kod och agent-uppgifter till
och med bäst — försvinner det valet. "Kör din egen modell" slutar vara en
kompromiss du får leva med och blir ett fullgott alternativ.

## Det öppna har en egenskap det stängda inte kan ha: granskbarhet

Den viktigaste skillnaden mellan öppna och stängda vikter, i det här projektets
lins, är inte prestanda. Det är **granskbarhet.**

Öppna vikter går att ladda ner, examinera, finjustera och anpassa i en helt annan
grad än en modell du bara når via ett API. Du kan köra dem på hårdvara du styr,
klippa bort det du inte behöver, och forma dem efter din uppgift. Framför allt:
du kan *köra dem utan att skicka din data någon annanstans.*

En stängd modell som du når som en tjänst är per definition en svart låda i
datavägen. Du skickar ditt innehåll till någon annans server och kan inte
verifiera vad som händer med det på andra sidan. Det bär en implicit risk som är
värd att säga rakt ut: **oupptäckbar övervakning.** Inte som anklagelse mot en
specifik leverantör, utan som strukturellt faktum — en tjänst du inte kan
inspektera kan du heller inte hålla ansvarig. Öppna vikter tar inte bort
förtroendefrågan helt, men den flyttar den från "lita på att deras server
beter sig" till "kör det på din egen", och det är en helt annan klass av
garanti. Det är samma metodskillnad som återkommer i varje artikel jag skriver om
det här: **skillnaden mellan "lita på oss" och "läs — och kör — själv".**

## Ärligheten: öppna vikter är inte gratis integritet

Här måste jag ta baksidan med, annars blir argumentet en säljpitch — och den här
serien är en forskningslogg, inte en kampanj.

Öppna vikter ger dig inte integritet på köpet. De ger dig *möjligheten* till den.
En öppen modell som du kör hos en molnleverantör är fortfarande en svart låda i
datavägen — det är *var* den körs, inte licensen på vikterna, som avgör om din
data lämnar dig. Och "öppen" betyder inte längre "spottbillig": K3 prissätts som
tjänst till 3 dollar per miljon input-tokens och 15 per miljon output — i klass
med de stängda, inte en tiondel av dem. Poängen med öppenheten är inte att API:t
är gratis; det är att du *inte behöver API:t* — du kan hosta själv. Finjustering
kan införa sina egna problem. "I klass med frontier" varierar med uppgiften, och
på rent generellt resonemang är glappet fortfarande mätbart. Och att köra en 2,8-
biljonersmodell själv kräver hårdvara som inte alla har.

Så det ärliga påståendet är smalt: den försvunna vallgraven **möjliggör** privat,
kapabel research som förr krävde ett val mellan de två. Den *garanterar* den inte.
Att stänga det sista glappet mellan "möjligt" och "verkligt" är arbete — och en
del av det arbetet är den andra halvan av den här artikeln.

## Andra hävstången: låt en svagare modell arbeta över sin klass

Om den första insikten är att öppna vikter kommit ikapp, så är den andra att du
inte ens alltid behöver toppmodellen — om du bygger rätt runt den.

Ett återkommande spår i det här projektet är en arkitektonisk tes: **en
sub-frontier-modell kan lösa uppgifter över sin normala gräns om den får rätt
byggställning runt sig.** Inte genom att modellen blir smartare, utan genom att
den slipper hålla allt i huvudet på en gång. Ge den i stället en verktygslåda av
modulära, väldefinierade kapabiliteter plus en uppsättning skills — buntade i ett
SDK — och låt uppgiften avgöra vilka bitar som plockas fram.

Det är precis vad `sdk/`-katalogen i det här repot är: **DistillSDK.** Idén i
namnet är *destillering* — du utgår från en bred baseplate (i dag 33 modulära
kapabilitetsmoduler, var och en med en byggbar skill) och *skalar ner* till exakt
det en given uppgift behöver, i stället för att be modellen improvisera fram allt
från noll. En svagare modell med rätt bitar tillgängliga i lådan komponerar ihop
ett resultat den aldrig hade nått på fri hand.

Kopplingen till hela seriens ramverk är direkt, ända ner till arbetssättet:
det mesta i det här projektet byggs strikt från en telefon, med en agent och en
väldigt begränsad kontext. Det är själva förutsättningen som gör metoden skarp —
när utvecklingsenheten är en mobil och modellen inte kan hålla hela systemet i
huvudet, är modulära bitar och färdiga skills inte en lyx utan det som gör
uppgiften genomförbar. Byggställningen är det som bär, inte råstyrkan i modellen.

## Där de två trådarna möts

Lägg ihop de två insikterna och synteseffekten är hela poängen.

Öppna vikter i klass med frontier — och redan bäst på kod och agent-uppgifter —
betyder att du kan köra en kapabel modell **själv, privat.** DistillSDK-tesen
betyder att modellen inte ens behöver vara den absolut starkaste på varje axel
för att lösa riktiga uppgifter — den behöver rätt verktygslåda, nedskalad till
uppgiften. Tillsammans pekar de på samma slutsats:

> En självhostbar, sub-frontier, öppen modell + ett destillerat SDK av modulära
> kapabiliteter = kapabelt **och** privat, utan att något av det behöver passera
> en svart låda du inte kan granska.

Och det är ingen slump att det just är på **kod och agent-uppgifter** den öppna
modellen redan leder — det är precis den sortens arbete ett destillerat SDK av
verktyg och skills organiserar. De två trådarna är inte parallella; de förstärker
varandra på exakt samma axel.

Det är den kombinationen som gör **Se/cure**-nivåns aldrig-moln-löfte till något
mer än en princip: en väg där du varken lånar din kapabilitet av ett stängt labb
eller din integritet av en molntjänst. Vallgraven som försvann är inte bara en
förlust för några få — den är rådmaterialet för exakt den sortens applikation
det här projektet undersöker.

## Slutord

Det bevingade memot hade rätt, bara några år för tidigt. Vallgraven är borta, och
det är en gåva till alla som bygger för integritet och kontroll snarare än för
inlåsning. Kimi K3 är inte poängen i sig — den är beviset på att glappet mellan
"modellen du äger" och "modellen bara de har" har stängts tillräckligt, och på
byggarens axel redan vänt, för att ändra vad man rimligen kan bygga.

Referensimplementationen är fortfarande experimentell, ligger på sina åttio
procent och är inte säkerhetsrevisorad — säg det rakt ut. Men riktningen är den
här artikelns hela poäng: när både kapabiliteten och verktygen slutar vara
inlåsta bakom en svart låda, blir bevisbar privacy ett byggbart mål i stället för
en önskan.

Läs koden, kör den själv, försök knäcka den, och berätta vad som gick sönder.
Allt är MIT-licensierat.

---

**Källor (Kimi K3-siffror):** Artificial Analysis Intelligence Index v4.1 och
Frontend Code Arena-Elo via lanseringsrapporteringen —
[VentureBeat](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[Axios](https://www.axios.com/2026/07/16/moonshot-kimi-ai-china-model-openai-anthropic),
[The Decoder](https://the-decoder.com/kimis-open-model-k3-nears-gpt-5-6-sol-and-fable-5-while-signaling-the-end-of-super-cheap-chinese-ai/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3).

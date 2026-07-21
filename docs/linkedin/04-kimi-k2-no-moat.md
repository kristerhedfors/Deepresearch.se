# Artikel — "We have no moat": Kimi K2 och det försvunna glappet mellan öppna och stängda vikter

> **Fristående take.** En ny ingång till samma experiment — inte nästa steg i
> den numrerade serien utan en egen artikel byggd kring en färsk insikt.
> Skriven för LinkedIn, på svenska, i förstapersonsröst. Bärande siffror är
> verifierbara i repot och på `/pulse`. Publiceringsstatus: utkast.

---

## Ingången: glappet stängdes

Under 2023 läckte ett internt Google-memo med en rubrik som blev bevingad:
*"We have no moat, and neither does OpenAI."* En ingenjör argumenterade för att
de stora labbens försprång inte var en vallgrav — att öppna modeller skulle
komma ikapp snabbare än någon vågade tro, och att hela värdet i att sitta på de
bästa vikterna skulle förångas.

Då var det en spådom. En välinformerad gissning, men en gissning.

Nu är det en observation. Kimi K2 — öppna vikter, från ett kinesiskt labb —
ligger på benchmarks i klass med de absolut främsta *stängda* frontier-modellerna
från de amerikanska labben. Man ska vara ärlig om exaktheten: "i klass med"
betyder inte "identisk på varje uppgift", och benchmarks är inte verkligheten.
Men det är precis det som är poängen. **Glappet behöver inte vara noll för att
vallgraven ska vara borta — det räcker att det blivit så litet att det inte
längre är en vallgrav.** Och där är vi. Det som skilde "modellen du kan ladda ner"
från "modellen bara de har" har krympt från ett hav till en spricka.

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
självhostbar modell blir tillräckligt bra försvinner det valet. "Kör din egen
modell" slutar vara en kompromiss du får leva med och blir ett fullgott
alternativ.

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
data lämnar dig. Finjustering kan införa sina egna problem. "I klass med
frontier" varierar med uppgiften, och för de allra svåraste stegen kan glappet
fortfarande vara verkligt. Och att köra en stor modell själv kostar hårdvara och
möda som inte alla har.

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

Öppna vikter i klass med frontier betyder att du kan köra en kapabel modell
**själv, privat.** DistillSDK-tesen betyder att modellen inte ens behöver vara
den absolut starkaste för att lösa riktiga uppgifter — den behöver rätt
verktygslåda, nedskalad till uppgiften. Tillsammans pekar de på samma slutsats:

> En självhostbar, sub-frontier, öppen modell + ett destillerat SDK av modulära
> kapabiliteter = kapabelt **och** privat, utan att något av det behöver passera
> en svart låda du inte kan granska.

Det är den kombinationen som gör **Se/cure**-nivåns aldrig-moln-löfte till något
mer än en princip: en väg där du varken lånar din kapabilitet av ett stängt labb
eller din integritet av en molntjänst. Vallgraven som försvann är inte bara en
förlust för några få — den är rådmaterialet för exakt den sortens applikation
det här projektet undersöker.

## Slutord

Det bevingade memot hade rätt, bara några år för tidigt. Vallgraven är borta, och
det är en gåva till alla som bygger för integritet och kontroll snarare än för
inlåsning. Kimi K2 är inte poängen i sig — den är beviset på att glappet mellan
"modellen du äger" och "modellen bara de har" har stängts tillräckligt för att
ändra vad man rimligen kan bygga.

Referensimplementationen är fortfarande experimentell, ligger på sina åttio
procent och är inte säkerhetsrevisorad — säg det rakt ut. Men riktningen är den
här artikelns hela poäng: när både kapabiliteten och verktygen slutar vara
inlåsta bakom en svart låda, blir bevisbar privacy ett byggbart mål i stället för
en önskan.

Läs koden, kör den själv, försök knäcka den, och berätta vad som gick sönder.
Allt är MIT-licensierat.

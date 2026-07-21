# Artikel 1 — "We have no moat": Kimi K3, det försvunna glappet, och varför flaskhalsen nu är compute

> **Serieöppnaren.** Den här artikeln startar serien med en färsk nyhet snarare
> än med projektet självt — nyheten är ramen, och projektet dyker bara upp som ett
> konkret exempel. Skriven för LinkedIn, på svenska, i förstapersonsröst.
> Sifferpåståendena om Kimi K3 är hämtade från lanseringsrapporteringen
> (juli 2026) och källhänvisade sist. De projektsiffror jag nämner är verifierbara
> i repot och på `/pulse`. Publiceringsstatus: utkast.

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

Och det leder till den andra halvan av bilden. Om modellen inte längre är
flaskhalsen, vad står då kvar mellan en idé och en körande applikation? Svaret,
visar det sig, är förvånansvärt lite — givet rätt byggställning runt modellen.

## Mjukvara som överflöd — med rätt byggställning

Ett sätt att få en sub-frontier-modell att lösa uppgifter över sin klass är att
sluta be den improvisera fram allt från noll. Ge den i stället en verktygslåda av
modulära, väldefinierade kapabiliteter plus en uppsättning skills — buntade i ett
SDK — och låt uppgiften avgöra vilka bitar som plockas fram. Inte "modellen blir
smartare", utan "modellen slipper hålla allt i huvudet på en gång". En svagare
modell med rätt bitar i lådan komponerar ihop ett resultat den aldrig hade nått på
fri hand.

Lägg ihop det med en öppen modell i klass med frontier och slutsatsen blir konkret:
du kan köra en kapabel modell **själv**, och du behöver inte ens den absolut
starkaste — du behöver rätt verktygslåda, nedskalad till uppgiften, och compute att
köra den på. När intelligensen är riklig och byggställningen är rätt komprimeras det
som förr var det dyra: själva byggandet. Du beskriver vad du vill ha; du får en
körande sak tillbaka. Mjukvara börjar bete sig som ett överflöd, och kostnaden som
återstår är inte "kan det byggas" utan "har jag compute att köra det".

## Ett verkligt exempel: två veckor, hur många rutor hann bockas av

Det är lätt att säga "mjukvara som överflöd" abstrakt. Så låt mig peka på ett
konkret bygge jag råkar ha på nära håll — inte som seriens ämne (det kommer i nästa
artikel), utan som ett *referensexempel* på vad tesen ser ut som i praktiken.

De senaste två veckorna har jag byggt en komplett deep-research-assistent,
`deepresearch.se`, nästan uteslutande med **Fable 5** som drivande modell och en
agent i handen. Poängen här är inte sajten i sig utan *takten*: hur många rutor ett
enda bygge hinner bocka av när modellen inte längre är flaskhalsen. Siffrorna kommer
ur git-historiken för fönstret 4–17 juli och ligger live på `/pulse`: **716 commits
fördelade på 25 temaområden**, där 88 % av alla commits bär minst ett tema och **17
av områdena har fler än tjugo commits var** — alltså i storleksordningen sjutton
*samtidigt pågående* utvecklingsspår under samma två veckor. Chattklient,
forskningspipeline, en Linux-miljö i webbläsarfliken, kart- och geo-intelligens,
konton och kvoter, ett SDK som destillerar fram nya varianter — inte polerade i tur
och ordning, utan framförda parallellt.

Det som gjorde den takten möjlig var precis byggställningen ovan: en modell plus ett
SDK av modulära kapabiliteter som bär det mesta av kompositionen, så att arbetet blir
att *välja och beskriva* varianten snarare än att skriva varje bit från grunden. Ta
det som ett stickprov, inte ett bevis: ett enda projekt, två veckor, som visar vad
"du får det du ber om" ser ut som när intelligensen slutat vara den dyra biten.

## Och därför spelar det öppna en roll det stängda inte kan spela

En sista tråd, för den är hela anledningen till att just *den här* nyheten känns
stor från där jag sitter. Det bygge jag nyss pekade på har integritet som
huvudfråga — servern ska helst inte finnas i datavägen alls. Och där betyder öppna
vikter något stängda inte kan: **granskbarhet.** En stängd modell du når som en
tjänst är per definition en svart låda i datavägen — du skickar ditt innehåll till
någon annans server och kan inte verifiera vad som händer på andra sidan. Öppna
vikter flyttar förtroendefrågan från "lita på att deras server beter sig" till "kör
det på din egen", och det är en helt annan klass av garanti.

Så länge "tillräckligt bra" bara fanns bakom en stängd API-vägg tvingades den som
bygger för privacy välja mellan integritet och kapabilitet. När en öppen,
självhostbar modell blir tillräckligt bra — och på kod och agent-uppgifter till och
med bäst — försvinner det valet. Men ärligt: öppna vikter ger dig inte integritet på
köpet, bara *möjligheten* till den. Det är *var* modellen körs, inte licensen, som
avgör om din data lämnar dig — och att köra en 2,8-biljonersmodell privat kräver, ja,
compute. Samma bristvara igen.

## Slutord: du får det du ber om — om du har compute

Det bevingade memot hade rätt, bara några år för tidigt. Vallgraven är borta, och
det är en gåva till alla som bygger för kontroll och integritet snarare än för
inlåsning. Kimi K3 är inte poängen i sig — den är beviset på att glappet mellan
"modellen du äger" och "modellen bara de har" har stängts tillräckligt, och på
byggarens axel redan vänt, för att ändra vad man rimligen kan bygga.

Och det förskjuter var den verkliga begränsningen sitter. Intelligensen blev en
råvara; mjukvaran blev, med rätt byggställning, nästan ett överflöd — de två veckornas
bygge ovan är mitt eget stickprov på det. Det som återstår som knapphet är compute.
Så det kokar ner till en enda mening:

> **Du kan få den mjukvara du ber om — men du behöver compute för att komma dit.
> Har du compute får du det du ber om.**

Det är där den här serien tar vid. Nästa artikel lämnar nyheten och går in på
projektet jag nyss använde som exempel — vad `deepresearch.se` faktiskt är, varför
det byggs som ett medvetet 80-procentsprojekt om *bevisbar* privacy, och vad man
lär sig av att pressa en riktig research-assistent mot den gränsen. Allt är öppet
och MIT-licensierat, just för att den här sortens påståenden bara blir intressanta
när fler än en person kan läsa efter och köra själv.

---

**Källor (Kimi K3-siffror):** Artificial Analysis Intelligence Index v4.1 och
Frontend Code Arena-Elo via lanseringsrapporteringen —
[VentureBeat](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[Axios](https://www.axios.com/2026/07/16/moonshot-kimi-ai-china-model-openai-anthropic),
[The Decoder](https://the-decoder.com/kimis-open-model-k3-nears-gpt-5-6-sol-and-fable-5-while-signaling-the-end-of-super-cheap-chinese-ai/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3).

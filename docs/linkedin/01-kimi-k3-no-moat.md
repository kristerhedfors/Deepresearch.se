# Grattis — allt till alla

Grattis — allt till alla. I juli 2026 hände det som ett numera bevingat
Google-memo förutspådde redan 2023: *"We have no moat, and neither does
OpenAI."* De kinesiska öppenviktsmodellerna kom faktiskt ikapp Silicon Valleys
stängda toppskikt. Moonshot AI släppte **Kimi K3** — öppna vikter, ett kinesiskt
labb, 2,8 biljoner parametrar, den största öppenviktsmodellen någonsin — och den
landade mitt i de amerikanska frontier-labbens toppskikt. På Artificial Analysis
Intelligence Index v4.1 får den **57,1**, mot Fable 5:s 59,9 och GPT-5.6 Sol:s
58,9 — ett hår efter på generellt resonemang. Och på den axel som betyder mest
för den som *bygger*: på Frontend Code Arena rankas K3 **etta**, före både Fable
5 och GPT-5.6 Sol, och i kod och agent-uppgifter slår den Claude Opus 4.8 och
GPT-5.5. Glappet mellan den bästa modellen du kan *äga* och den bästa modellen
bara *de* har är i praktiken borta.

Och när det glappet försvinner faller ett helt argument med det. Den enda
riktigt goda anledningen att skicka sina tokens — och därmed sina frågor, sina
dokument, sin känsligaste information — över havet till ett stängt labb var att
kapabiliteten satt inlåst just där. Det var *frontier-försprånget* som fick
betala för risken. Nu är försprånget borta, men risken är kvar: du lämnar
fortfarande ifrån dig allt du matar in till en motpart med både förmåga och
räckvidd att göra vad den vill med det. Att det inte är ett rent hypotetiskt
bekymmer skymtar i sommarens rubriker — se bara Apples stämning mot OpenAI, som
i återgivningarna läser som en spionthriller: stulna laptops, dataintrång,
insidermullvadar, rekrytering-som-spionage (OpenAI bestrider anklagelserna).
Poängen är inte att fälla en dom i den saken. Poängen är att "kapabiliteten
finns bara här" inte längre är ett skäl som väger tyngre än vad du ger upp. När
intelligensen blir en råvara vem som helst kan köra själv står bara priset kvar
— och priset var din privacy.

Så: grattis. Inte främst till labben — till alla andra. Den mest strategiska
resursen i hela fältet, frontier-intelligens, slutar vara något ett fåtal aktörer
får grinda ut bakom en API-vägg och blir något vem som helst kan ladda ner och
köra själv. 2023 var det en spådom. Nu är det en observation. **Allt, till alla.**

## Vad det betyder: kapabiliteten slutade vara det dyra

I flera år var den bristvara som byggare betalade för rå modellintelligens — den
satt inlåst hos en handfull labb, bakom en prislapp ingen kunde förhandla. Den
delen är över. Intelligensen är nu en råvara: nedladdningsbar, körbar, din.

Det som gör det extra konkret är att det inte längre handlar om *en* modell. Du
kan bygga på en stängd frontier-modell som Fable 5 om du vill ha det absolut
vassaste — eller på en öppen modell i klass med Kimi K3 som du kör själv. Hela det
översta skiktet, öppet såväl som stängt, är plötsligt tillräckligt bra för riktigt
arbete. Valet står inte längre mellan "kapabelt" och "tillgängligt". Du får båda.

## Vad du faktiskt kan bygga nu

Och det är här det blir roligt, för när intelligensen är riklig komprimeras det som
förr var det dyra: själva byggandet. Du beskriver vad du vill ha, och du får en
körande sak tillbaka — inte en prototyp om ett kvartal, utan en app på några dagar.

Knepet, för den som vill pressa det, är att inte be modellen improvisera fram allt
från noll. Ge den i stället en verktygslåda av modulära, väldefinierade
kapabiliteter plus en uppsättning skills — buntade i ett SDK — och låt uppgiften
avgöra vilka bitar som plockas fram. Då kan även en modell som *inte* är den absolut
starkaste komponera ihop saker den aldrig hade nått på fri hand: en chattklient, en
forskningspipeline, ett litet fokuserat verktyg. Mjukvara börjar bete sig som ett
överflöd. Du ber om något; du får det.

## Och du kan bygga det från en telefon

Det låter som att det borde kräva en fullt riggad arbetsstation. Det gör det inte.
Sommarens andra tysta skifte är att man numera kan göra i stort sett allt direkt
från mobiltelefonen. Boris Cherny — en av de ledande bakom Claude Code — bygger
enligt uppgift nästan uteslutande från Claude Code-appen i mobilen nuförtiden.

Jag har kört samma arbetssätt i drygt en månad, och som konkret exempel — inte som
poängen i sig — byggde jag de senaste två veckorna en komplett deep-research-
assistent, `deepresearch.se`, i stort sett helt från en iPhone: ingen laptop, ingen
IDE, stora delar *i rörelse*, med telefonen i handen mellan intervallerna på löppass
i nordsvenska skogar. Vad en agent plus en telefon hinner bocka av på två veckor
går att räkna efter i git-historiken, live på `/pulse`: **716 commits fördelade på
25 temaområden**, varav **17 områden med fler än tjugo commits var** — alltså i
storleksordningen sjutton *samtidigt pågående* utvecklingsspår. Chattklient,
forskningspipeline, en Linux-miljö i webbläsarfliken, kart- och geo-intelligens,
konton och kvoter, ett SDK som destillerar fram nya varianter — inte polerade i tur
och ordning, utan framförda parallellt. Ta det som ett stickprov på vad "du får det
du ber om" ser ut som i praktiken.

## Det ärliga: du behöver fortfarande compute

En brasklapp, annars blir det här en säljpitch. När intelligensen blir en råvara
försvinner inte knappheten — den *flyttar*. Att äga vikterna är gratis; att köra en
2,8-biljonersmodell privat kräver hårdvara som inte alla har. Den nya bristvaran är
inte modellen, det är **compute att köra den på** — och det är faktiskt en ärligare
begränsning: fungibel, hyrbar, mätbar, och den kräver ingen leverantörs tillåtelse.
Så det kokar ner till en enda mening:

> **Du kan få den mjukvara du ber om — men du behöver compute för att komma dit.
> Har du compute får du det du ber om.**

## Härifrån

Det är där den här serien tar vid. Och om kapabiliteten inte längre är skälet att
lämna ifrån sig sin data, blir följdfrågan desto intressantare: hur *lite* behöver
en riktigt användbar tjänst egentligen se? Nästa artikel lämnar nyheten och går in
på projektet jag nyss använde som exempel — vad `deepresearch.se` faktiskt är,
varför det byggs som ett medvetet 80-procentsprojekt om *bevisbar* privacy (att
servern strukturellt inte kan se din data, inte bara lovar det), och vad man lär
sig av att pressa en riktig research-assistent mot den gränsen. Allt är öppet och
MIT-licensierat, just för att den här sortens påståenden bara blir intressanta när
fler än en person kan läsa efter och köra själv.

Läs koden, kör den själv, försök knäcka den, och berätta vad som gick sönder.

---

**Källor (Kimi K3-siffror):** Artificial Analysis Intelligence Index v4.1 och
Frontend Code Arena-Elo via lanseringsrapporteringen —
[VentureBeat](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[Axios](https://www.axios.com/2026/07/16/moonshot-kimi-ai-china-model-openai-anthropic),
[The Decoder](https://the-decoder.com/kimis-open-model-k3-nears-gpt-5-6-sol-and-fable-5-while-signaling-the-end-of-super-cheap-chinese-ai/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3).

**Källor (Apples stämning mot OpenAI, som pågår och bestrids):** Apple lämnade in
stämningen den 10 juli 2026 med anklagelser om företagshemlighetsstöld; OpenAI
tillbakavisar dem —
[Axios](https://www.axios.com/2026/07/10/apple-sues-openai-trade-secret-theft),
[CNBC](https://www.cnbc.com/2026/07/10/apple-openai-lawsuit-trade-secrets.html),
[Fortune](https://fortune.com/2026/07/13/apple-lawsuit-against-openai-stolen-trade-secrets-wildest-claims/),
[TechCrunch (OpenAI:s svar)](https://techcrunch.com/2026/07/14/openai-pushes-back-on-apple-trade-secret-lawsuit/).

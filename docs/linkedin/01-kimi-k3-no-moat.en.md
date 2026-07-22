# Congratulations — everything to everyone

> Working draft. As of 2026-07-22 the **English version is the active draft**
> for article one; the owner will produce the Swedish translation himself
> afterwards, at which point the Swedish draft (`01-kimi-k3-no-moat.md`) and the
> rendered collection copy get re-synced from this file. Until then this file
> leads. (This note is not part of the published text.)

Congratulations — everything to everyone. In July 2026 the thing a now-famous
Google memo predicted back in 2023 actually happened: *"We have no moat, and
neither does OpenAI."* The Chinese open-weights models genuinely caught Silicon
Valley's closed top tier. Moonshot AI released **Kimi K3** — open weights, a
Chinese lab, 2.8 trillion parameters, the largest open-weights model ever — and
it landed squarely inside the American frontier labs' top band. On the
Artificial Analysis Intelligence Index v4.1 it scores **57.1**, against Fable
5's 59.9 and GPT-5.6 Sol's 58.9 — a hair behind on general reasoning. And on the
axis that matters most to anyone who *builds*: on the Frontend Code Arena, K3
ranks **first**, ahead of both Fable 5 and GPT-5.6 Sol, and on coding and
agentic tasks it beats Claude Opus 4.8 and GPT-5.5. The gap between the best
model you can *own* and the best model only *they* have is, in practice, gone.

And when that gap disappears, an entire argument goes with it. The one genuinely
good reason to send your tokens — and with them your questions, your documents,
your most sensitive information — across the ocean to a closed lab was that the
capability was locked up there. It was the *frontier lead* that paid for the
risk. Now the lead is gone, but the risk remains: you are still handing
everything you type to a counterparty with both the capability and the reach to
do whatever it likes with it. That this isn't a purely hypothetical worry shows
up in the summer's headlines — just look at Apple's suit against OpenAI, which in
the retellings reads like a spy thriller: stolen laptops, data breaches, insider
moles, recruiting-as-espionage (OpenAI denies the allegations). The point isn't
to render a verdict on that case. The point is that "the capability only exists
here" is no longer a reason that outweighs what you give up. Once intelligence
becomes a commodity anyone can run themselves, only the price is left standing —
and the price was your privacy.

So: congratulations. Not mainly to the labs — to everyone else. The single most
strategic resource in the whole field, frontier intelligence, stops being
something a handful of players get to meter out from behind an API wall and
becomes something anyone can download and run for themselves. In 2023 it was a
prediction. Now it's an observation. **Everything, to everyone.**

## What it means: capability stopped being the expensive part

For years the scarce good that builders paid for was raw model intelligence —
locked up at a handful of labs, behind a price no one could negotiate. That part
is over. Intelligence is now a raw material: downloadable, runnable, yours.

What makes it especially concrete is that it's no longer about *one* model. You
can build on a closed frontier model like Fable 5 if you want the absolute
sharpest edge — or on an open model in Kimi K3's class that you run yourself. The
entire top layer, open and closed alike, is suddenly good enough for real work.
The choice is no longer between "capable" and "available." You get both.

## What you can actually build now

And this is where it gets fun, because when intelligence is abundant, the thing
that used to be expensive gets compressed: the building itself. You describe what
you want, and you get a running thing back — not a prototype next quarter, but an
app in a few days.

The trick, for anyone who wants to push it, is not to ask the model to improvise
everything from scratch. Instead, give it a toolbox of modular, well-defined
capabilities plus a set of skills — bundled into an SDK — and let the task decide
which pieces get pulled out. Then even a model that *isn't* the very strongest
can compose together things it would never have reached freehand: a chat client,
a research pipeline, a small focused tool. Software starts to behave like an
abundance. You ask for something; you get it.

## And you can build it from a phone — a two-week floor on a fixed token budget

It sounds like it ought to require a fully rigged workstation. It doesn't. The
summer's other quiet shift is that you can now do essentially all of it straight
from a mobile phone. Boris Cherny — one of the leads behind Claude Code —
reportedly builds almost entirely from the Claude Code app on his phone these
days.

I ran the same way of working for a good month, and here I want to be precise
about what the concrete example actually measures. Over the last two weeks I
built a complete deep-research assistant, `deepresearch.se`, almost entirely from
an iPhone: no laptop, no IDE, much of it *on the move*, phone in hand between
intervals on runs through the forests of northern Sweden. But the sharper way to
read it is as a **controlled sample**: those were exactly the final two weeks of
a **max-tier Fable 5 token allowance in Claude Code** — the highest tier's
budget — the last fortnight before that access was switched off. So this is a
qualitative result, not a benchmark, but it pins down something specific: it's a
**floor**. It shows what you are *able* to build in two weeks with this model and
this budget — a lower bound on what's possible, not a ceiling.

What an agent plus a phone can check off in two weeks is countable, live on
`/pulse`: **716 commits across 25 theme areas**, of which **17 areas had more
than twenty commits each** — on the order of seventeen *simultaneously active*
development tracks. A chat client, a research pipeline, a Linux environment in a
browser tab, map and geo intelligence, accounts and quotas, an SDK that distills
out new variants — not polished one after another, but carried forward in
parallel. Take it as a spot sample of what "you get what you ask for" looks like
in practice.

And because it's a floor, the obvious next move is to see how much lower the cost
goes on a second pass. Doing it again would almost certainly take far less
time — partly because it's been done once already, but also because the project
I built includes, as one of its own features, an **SDK designed to rebuild
itself**: distill the site into a fresh, self-contained variant. I'm about to put
exactly that to the test, and I'll report back with the result — using the SDK to
produce a similar, almost feature-complete alternative version, and measuring
what that second pass actually costs. (That figure is deliberately left open
here; it belongs in the follow-up, not in a claim I haven't run yet.)

## The honest part: you still need compute

A caveat, or this turns into a sales pitch. When intelligence becomes a raw
material, scarcity doesn't vanish — it *moves*. Owning the weights is free;
running a 2.8-trillion-parameter model privately takes hardware not everyone has.
The new scarce good isn't the model, it's **the compute to run it on** — and
that's actually a more honest constraint: fungible, rentable, measurable, and it
needs no vendor's permission. So it boils down to a single sentence:

> **You can get the software you ask for — but you need compute to get there.
> If you have the compute, you get what you ask for.**

## From here

That's where this series picks up. And if capability is no longer the reason to
give up your data, the follow-up question gets all the more interesting: how
*little* does a genuinely useful service actually need to see? The next article
leaves the news behind and goes into the project I just used as an example — what
`deepresearch.se` actually is, why it's built as a deliberate 80-percent project
about *provable* privacy (that the server structurally cannot see your data, not
just promises not to), and what you learn from pushing a real research assistant
up against that limit. Everything is open and MIT-licensed, precisely because
claims of this kind only get interesting when more than one person can check them
and run them for themselves.

Read the code, run it yourself, try to break it, and tell me what broke.

---

**Sources (Kimi K3 figures):** Artificial Analysis Intelligence Index v4.1 and
the Frontend Code Arena Elo, via the launch reporting —
[VentureBeat](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[Axios](https://www.axios.com/2026/07/16/moonshot-kimi-ai-china-model-openai-anthropic),
[The Decoder](https://the-decoder.com/kimis-open-model-k3-nears-gpt-5-6-sol-and-fable-5-while-signaling-the-end-of-super-cheap-chinese-ai/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3).

**Sources (Apple's suit against OpenAI — ongoing and contested):** Apple filed
the suit on 10 July 2026 alleging trade-secret theft; OpenAI rejects the claims —
[Axios](https://www.axios.com/2026/07/10/apple-sues-openai-trade-secret-theft),
[CNBC](https://www.cnbc.com/2026/07/10/apple-openai-lawsuit-trade-secrets.html),
[Fortune](https://fortune.com/2026/07/13/apple-lawsuit-against-openai-stolen-trade-secrets-wildest-claims/),
[TechCrunch (OpenAI's response)](https://techcrunch.com/2026/07/14/openai-pushes-back-on-apple-trade-secret-lawsuit/).

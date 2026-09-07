# The article template

The shape every published post takes. This is the checked-in source for what
`src/editorial/enrichment/editorial-enrichment.service.ts` asks the model for;
if the two disagree, this file is the intent and the prompt is the bug.

It exists because three consecutive published articles were structurally wrong
in the same way, and nothing in the repository said what right looked like.

## The parts

| Part | What it is | Limits |
|---|---|---|
| Headline | The news itself, concise and factual | One line. No intrigue, no colon-bait, **no publication name**. |
| Hook | The consequence or tension that makes the story worth reading | One sentence. **Not a restatement of the headline.** |
| What happened | Facts with their numbers: who, what, how many | One or two sentences. No opinion. |
| Detail | The concrete thing only a full read gives you — a quote, a circumstance, a figure | One or two sentences. **This is where material from the other sources goes.** |
| Why it matters | The consequence for an ordinary reader, not for politicians | One or two sentences. No forecasts the sources do not make. |
| What next | What happens next, and what the people involved say about it | One or two sentences. Quote a person where the evidence gives you one. |
| Source | The one link, to the article this run actually read | **Exactly one. Never in the prose. Never another outlet.** |

Headline line, then four paragraphs: hook + what happened, the detail, why it
matters, what happens next. The source block is appended afterwards by the
pipeline; the model never writes it.

**No editor signature.** "Знайшов і підготував для вас: …" was appended to
every post, which is precisely why it stopped carrying information — a line
identical on every article is furniture.

**Never write about the material.** No "this is a report about preliminary
results", no "the figures may still change", no sentence whose subject is the
sourcing rather than the news. It reads as a warning that the article might not
be true. Where something genuinely is not settled, say it as a fact of the
story — "the final tally is due on Tuesday" — not as a disclaimer.

**185 to 220 words**, aiming for about 200. Never fewer than 185.

A floor on its own would make articles shorter, not longer: a refused
enrichment falls back to the baseline, which runs to about a hundred words —
shorter than anything the floor would have rejected. So the floor is paired
with a corrective retry. A short draft is told its own word count and asked
again, with the detail and why-it-matters paragraphs named as the ones to
expand and the caveat named as the one not to pad.

The floor is checked on the **rebuilt** body, not on what the model returned:
stripping the URLs it wrote into the prose removes words, and the rebuilt body
is what ships.

## Sources have to be recent

A corroborating source older than 72 hours is discarded before the model ever
sees it. A published article about a typhoon carried a forecast lifted from a
press conference four days earlier — "residual circulation after 4 September
may bring heavy rain" — printed on the 7th as though it were ahead of the
reader. The search had found a genuinely relevant document and nothing
anywhere asked when it was written.

The window is wider than the research window on purpose: a story published
today can be legitimately corroborated by yesterday's reporting.

A source the provider could not date is **kept**, and reaches the model marked
as undated so the date can be judged there too. That is a deliberate trade,
and the hole it leaves is real: a stale source with no date still gets
through. Dropping every undated result would cost more, because the provider
fails to date primary documents most often — filings and press releases, the
sources most worth having.

## Why exactly one link

The corroborating publishers are newsrooms that took the story from somewhere
else too. A list of four links is not four independent authorities; it is an
invitation to go and read the article somewhere other than here, and it
advertises outlets that this channel paid a metered search to find.

What they are worth is their **detail**. So they stay in the evidence the model
writes from, they are not named, and the reader gets one link: the article the
run actually went to.

Attribution is not lost. Every claim keeps its real source in
`reviewer_notes.editorial_enrichment.evidence_map`, so the audit trail holds
every source even though the published text shows one. What changed is what is
published, not what is recorded.

## The failure this replaced

One published post carried three links: the primary source glued into the
middle of a sentence as `Джерело: https://…`, and a formal `Джерела:` block at
the bottom listing the two corroborating outlets — the two the reader had no
reason to visit. It ran to 113 words in a single paragraph, its first sentence
restated the headline, and the detail the paid search had found was spread thin
instead of being given a place.

Every rule above is one of those.

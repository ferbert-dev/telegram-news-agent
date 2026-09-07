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
| What is unknown | What the sources do not settle | One sentence. **Not optional.** |
| Signature | Added by the system | Never written by the model. |
| Source | The one link, to the article this run actually read | **Exactly one. Never in the prose. Never another outlet.** |

Headline line, then four paragraphs: hook + what happened, detail, why it
matters, what is unknown. The signature and the source block are appended
afterwards by the pipeline, not by the model.

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

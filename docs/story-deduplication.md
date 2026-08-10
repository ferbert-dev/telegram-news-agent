# Story deduplication

## Purpose

Canonical URL deduplication prevents the exact same link from being ingested
twice. It does not prevent two publishers, two URLs, or two research runs from
describing the same underlying event. Story deduplication closes that gap while
keeping a material later development publishable.

## Decision model

Every candidate that reaches extraction receives one durable decision:

| Relation | Meaning | Pipeline action |
| --- | --- | --- |
| `distinct` | No recent publication covers the same event | Continue |
| `duplicate` | Same event and substantially the same core facts | Reject candidate |
| `follow_up` | Same story thread but a material new outcome or fact | Continue and retain the prior article link |
| `uncertain` | Similar history exists but a safe classification is unavailable | Defer this candidate for the current run and try the next one |

Sharing only a person, organization, country, topic, conflict, disaster type,
or technology is not sufficient to call two articles the same story.

## Pipeline

```text
ranked candidate
  -> exact canonical URL/content safeguards
  -> load at most 100 publications from the previous 14 days
  -> normalize title/summary and calculate an order-preserving event fingerprint
  -> local token-similarity shortlist (at most 5)
     -> no shortlist: distinct, no AI cost
     -> exact fingerprint plus matching context: duplicate, no AI cost
     -> ambiguous shortlist: one tool-free structured AI comparison
  -> persist relation, prior article, confidence, reason and shortlist audit
  -> duplicate: reject candidate and continue ranking
  -> uncertain: keep it resumable, skip it for this run and continue ranking
  -> distinct/follow_up: extract evidence and draft
```

The semantic comparison cannot browse. Candidate and publication text are
treated as untrusted data. Provider output must match the structured schema and
may refer only to one of the supplied publication IDs. Unknown IDs, malformed
output, provider failure, or no classifier produce `uncertain`; the pipeline
continues with another candidate instead of disabling all publishing.

## Database authority

`article_story_decisions` stores the audit record. The normalized decision is
separate from article metadata so the final publication function can verify it
without trusting application memory.

`story_publication_claims` is keyed by `(telegram_channel_id,
story_fingerprint)`. The fingerprint includes ordered title and summary context;
it deliberately does not sort a bag of words, so recurring generic headlines
and role-reversal events do not share a permanent claim key. A distinct event
or material follow-up with the same generic headline therefore receives its own
claim. `claim_draft_for_publication(draft_id, channel_id)` inserts
that reservation in the same transaction that changes a draft from `approved`
to `publishing`. Concurrent drafts for the same fingerprint therefore have one
winner. The claim remains while Telegram delivery is unresolved, becomes
`published` with the receipt, and is removed only by the existing explicit
rejected-send or `TELEGRAM_NOT_SENT` recovery path.

Published claims enforce the same 14-day window as research history. An exact
fingerprint may atomically replace a published claim only after it is older
than 14 days. A still-`publishing` claim never expires automatically, because
Telegram delivery may be unresolved and must be reconciled explicitly.

The one-argument claim overload remains available for the N-1 container and
automated rollback image. It resolves the channel from the draft's review or
schedule binding and fails closed if that channel is ambiguous. Finalization
also verifies that the receipt channel equals the reserved channel, so an
operator typo cannot publish while leaving a stale claim behind.

For semantic duplicates whose wording creates a different fingerprint, the
claim checks `duplicate_of_article_id` against publications in the same channel
and blocks the draft before Telegram is called. The stable database error keeps
the conflicting article ID in PostgreSQL `DETAIL` for audit/recovery. An
`uncertain` decision is also
blocked unconditionally at this last gate. A `follow_up` is intentionally
allowed with its own fingerprint.

## Cost and retention

- History window: 14 days.
- History cap: 100 publications.
- AI shortlist: 5 most similar publications.
- Additional web searches: zero.
- AI call: zero for clearly distinct/exact matches; at most one external
  provider attempt per ambiguous candidate and at most three provider attempts
  per research run. Deduplication intentionally does not use the normal
  OpenAI-to-Gemini fallback inside one attempt; provider failure is fail-closed.
  Additional ambiguous candidates fail closed as `uncertain` without spending
  more AI tokens.
- Usage is recorded under the `story_deduplication` operation and attributed to
  the search run/article.

These constants are intentionally code-level V1 limits. A later product ticket
may expose them in Telegram settings after production precision/recall data is
available.

## Recovery and operations

- A definitive Telegram rejection releases the story claim with the draft.
- An ambiguous Telegram outcome keeps both draft and story claim reserved until
  reconciliation.
- Finalization marks the claim published.
- An operator-confirmed `TELEGRAM_NOT_SENT` reset releases only a still-
  `publishing` claim with no publication receipt.
- Legacy drafts without a story decision remain publishable during rollout;
  every new research-selected article receives a decision before extraction.
- An `uncertain` article remains in `discovered`, so a later run can retry the
  semantic check after a transient provider failure instead of losing it.

## Verification

Required evidence includes:

- the observed cross-publisher Kimi/test-environment duplicate fixture;
- unrelated stories that avoid an AI call;
- meaningful updates that remain publishable;
- classifier failure that cannot bypass the gate;
- two concurrent drafts with one story fingerprint and exactly one claim
  winner;
- semantic duplicate veto before Telegram;
- release, reset, finalize and retry behavior;
- clean PostgreSQL 17 migrations twice, contract and Drizzle drift;
- full legacy, persistence, Nest emitted-build and integration regressions.

## Rollback

Revert the application integration and restore the prior publication-function
signature through a forward migration if necessary. The two additive audit
tables can remain dormant. Never edit or remove the applied migration in place.

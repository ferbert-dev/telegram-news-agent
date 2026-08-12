# Architecture

## Initial System

```text
Telegram channel
  <- Telegram Bot API
  <- Bot server
  <- Content pipeline
  <- News sources / curated input
```

## Components

### Bot Server

Receives commands or scheduled jobs, prepares channel posts, and sends messages through Telegram Bot API.

### Content Pipeline

Collects, normalizes, summarizes, and formats candidate news items.

```text
PostgreSQL topic/source registry
  -> active RSS/Atom feeds + GDELT
  -> normalize and apply the excluded-topic discovery policy
  -> deduplicate and rank only eligible candidates
  -> tool-free AI editorial curation
  -> direct article extraction
  -> recheck selected full evidence against excluded topics
  -> grounded draft

No fresh candidates
  -> cooldown-protected provider search for RSS/Atom endpoints
  -> validate XML and save working sources in PostgreSQL
  -> emergency one-call article search only if still empty
```

Each source stores success/failure timestamps, a consecutive-failure counter,
and an optional quarantine deadline. Source discovery state is keyed by the
normalized topic set so repeated empty runs cannot repeatedly incur search-tool
costs. Automatically discovered sources are additive and can be disabled by an
operator; the pipeline never deletes them automatically.

### Story Deduplication

Cross-run story memory compares a candidate with a bounded window of prior
publications. Deterministic fingerprints and token similarity avoid unnecessary
AI calls; only an ambiguous shortlist receives one tool-free structured
semantic comparison. Decisions distinguish duplicate coverage from a material
follow-up and are persisted for audit. The final PostgreSQL publication claim
reserves `(channel, story fingerprint)`, so manual, automatic, scheduler and
recovery paths share the same race-safe veto. See
[story-deduplication.md](story-deduplication.md).

### Scheduler

Runs inside the polling bot process, but stores all durable state in PostgreSQL.
`news_bot_settings.next_run_at` identifies due work; an atomic database claim
fences concurrent workers and stale claims can be recovered after a crash. A
run takes one immutable settings snapshot, including excluded-topic codes and
their settings-version provenance, and advances the next due time only
after recording the outcome. Automatic mode checkpoints its draft before the
external Telegram send and resumes that draft idempotently after a crash.
An enabled 22:00–08:00 `Europe/Madrid` night pause moves due rows to the next
local 08:00. In-process checks fence both research startup and Telegram
delivery; a draft completed after 22:00 remains attached to the same occurrence
for morning recovery. Ambiguous sends pause recurrence until an operator
reconciles the publication.

### Review Gate

The per-channel policy is either `manual` or `automatic`. Manual mode creates a
private, message-bound review session and suppresses new scheduled drafts while
one is pending. Automatic mode still uses the idempotent publication state
machine and must be confirmed explicitly in Telegram settings.

### Configuration

Administrators use native Telegram inline keyboards rather than a Mini App.
This keeps the control plane private, avoids a new public HTTP service, and
allows every mutation to be re-authorized and guarded by an optimistic settings
version. PostgreSQL stores language, preset/custom topics, review chat,
publication policy, interval, night-pause state, and schedule state.
Excluded-topic codes are a bounded taxonomy rather than free-form instructions.
Their dedicated optimistic-CAS mutation keeps all existing settings function
signatures compatible; an empty array is an explicit incident kill switch.
The settings UI describes this as a preference. When codes are configured,
every acquisition path reaches one policy before ranking: only unmistakable
current conflict-event title patterns may be blocked deterministically, while
all other candidates use the configured provider/model and the provider-neutral
structured classifier. `main_subject`, `uncertain`, malformed output, and
provider exhaustion are ineligible; `incidental` and `unrelated` remain
eligible. Tool-free curation receives only eligible IDs and cannot introduce a
new one. The selected full extracted evidence, or the persisted source summary
fallback, is rechecked before drafting; a blocked article is rejected with
sanitized policy metadata and the next ranked candidate is attempted. Provider
usage returned by a completed structured response is recorded in the existing
ledger, including responses rejected for invalid curation IDs. A provider
attempt that throws before exposing usage cannot be reconstructed or recorded,
so a failed first fallback attempt may be absent from the ledger. Policy audit
data contains counts, codes, stages, prompt version, and bounded provider/model
identifiers, never article/provider payload text or URLs. When every acquired
candidate or every selected evidence item is blocked, the existing search run
is durably completed with zero results and sanitized `no_candidates` policy
metadata before the domain outcome is returned to the scheduler/manual search.
The final pre-publication veto remains a separate slice, so the UI does not
claim complete publication protection.

Operational rollback is application-image-first. If immediate behavior parity
is needed before an image rollback, setting the exclusion-code array to `[]`
skips deterministic checks, classifier calls, policy usage events, and policy
logs. Provider-only search also retains its byte-equivalent legacy system
instruction and JSON payload, with no `excludedTopics` field. The existing
manual review and publication state machine are unchanged.

### Database access

SQL migrations remain the executable source of truth. A modular Drizzle schema
mirrors the database and supplies TypeScript types for the gradual repository
and NestJS migration. The production runtime still uses the current `pg`
repositories during the foundation slice; CI migrates a clean PostgreSQL
database and rejects structural drift. The detailed boundaries and rollout
order are in [database-migration.md](database-migration.md).

## First Technical Decision

Use polling for local development unless deployment requires webhook behavior immediately.

Polling is simpler to run locally. Webhooks are better for production because Telegram pushes updates to the server.

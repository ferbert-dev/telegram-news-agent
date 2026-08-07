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
  -> normalize, deduplicate, and rank
  -> tool-free AI editorial curation
  -> direct article extraction
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

### Scheduler

Runs inside the polling bot process, but stores all durable state in PostgreSQL.
`news_bot_settings.next_run_at` identifies due work; an atomic database claim
fences concurrent workers and stale claims can be recovered after a crash. A
run takes one immutable settings snapshot and advances the next due time only
after recording the outcome. Automatic mode checkpoints its draft before the
external Telegram send and resumes that draft idempotently after a crash.
Ambiguous sends pause recurrence until an operator reconciles the publication.

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
publication policy, interval, and schedule state.

## First Technical Decision

Use polling for local development unless deployment requires webhook behavior immediately.

Polling is simpler to run locally. Webhooks are better for production because Telegram pushes updates to the server.

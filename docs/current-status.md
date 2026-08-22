# Current Status

Last verified: 2026-08-21

Branch-local, not deployed: `codex/ai-provider-attempts` adds durable, redacted
AI provider-attempt diagnostics, bounded transient retry, scheduler failure
alerts, and private status/inspection visibility. It is not activated in
production until migration, review, and release gates complete.

## Production

| Item | Verified state |
| --- | --- |
| Service | Healthy on Oracle |
| Main and deployed SHA | `f0afa2ecdb889024f454e6d1aa6fad15dd53faff` |
| Container image | `ghcr.io/ferbert-dev/telegram-news-agent:f0afa2ecdb889024f454e6d1aa6fad15dd53faff` |
| Telegram | Polling active, webhook disabled, channel access valid, zero pending updates at inspection |
| Database | PostgreSQL authoritative; runtime connection and migrations verified |
| AI providers | Exa, OpenAI, and Gemini configured |
| Release message | Private notification `v0.1.0+f0afa2e` accepted by Telegram |
| Release evidence | [deploy workflow](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/32487728082), [post-deploy inspection](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/32488170635) |

## What Is Shipped

- PostgreSQL-backed Telegram polling, scheduling, settings, review, and publication.
- RSS/Atom ingestion, Google News publisher resolution, GDELT discovery, extraction, ranking, and deduplication.
- Grounded structured drafting with exact source evidence and fail-closed validation.
- OpenAI and Gemini generation with bounded Exa research for feeds, news, article details, and missing facts.
- Editorial enrichment with baseline preservation, evidence mapping, and a maximum of three detail searches per article.
- Private admin workflows: `/news`, `/settings`, `/labs`, `/stats`, and `/status`.
- Provider visibility with configured/idle/success states and an explicit one-search Exa connection test.
- Per-operation AI token, web-search, provider, and estimated-cost accounting.
- SOPS-encrypted production configuration, hash-aware environment promotion, immutable GHCR images, health gates, and rollback.
- Private, idempotent deployment-version notifications after successful production verification.
- Typed Drizzle repositories and NestJS modules operating alongside the current legacy entrypoint.
- An optional `PublicationMilestonesModule` implements deterministic every-50th-
  article audience messages behind a default-off per-channel flag. It is not
  wired into the legacy production entrypoint and remains inactive until the
  standalone Nest runtime and durable event replay gate are complete. Delivery
  uses a PostgreSQL claim token and parks ambiguous Telegram outcomes in
  `uncertain` for explicit reconciliation instead of retrying blindly.

## Current Architecture

The production entrypoint remains `src/telegram-bot.js`. It owns Telegram long
polling and the database scheduler while persistence migration proceeds in
vertical slices. PostgreSQL functions remain authoritative for atomic leases,
review decisions, publication claims, scheduling checkpoints, and other
concurrency-sensitive transitions.

New Nest feature slices communicate through a neutral in-process integration-
event bus rather than importing each other. Optional subscribers register with
the bus at module startup; omitting a module leaves the publisher unchanged.
Idempotent publication retries replay `ArticlePublished`, but crash-independent
delivery still requires the durable outbox named in the cutover plan.

Exa is a retrieval provider, not a structured drafting replacement. It supplies
bounded source-linked evidence; OpenAI or Gemini produces structured output when
the operation requires it. An Exa detail-search failure does not silently fall
through to a paid web search.

See [architecture.md](architecture.md), [database-migration.md](database-migration.md),
and [nestjs-drizzle-migration-blueprint.md](nestjs-drizzle-migration-blueprint.md).

## Remaining Work

1. Complete the remaining NestJS and Drizzle vertical slices without weakening PostgreSQL atomicity.
2. Prove clean-database parity, emitted build artifacts, Docker smoke behavior, shutdown ordering, and rollback before entrypoint cutover.
3. Enable durable Telegram news jobs only after their separate production gate.
4. Add digest-level runtime image attestation and perform a documented rollback drill.
5. Continue source-quality and editorial-cost tuning from measured production data.

## Release Boundary

The legacy entrypoint and rollback path stay available until the migration
blueprint's cutover gates pass. Do not retire the current Oracle instance,
disable rollback infrastructure, rotate secrets, or change production feature
flags without explicit release authority.

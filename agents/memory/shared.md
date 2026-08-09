# Shared memory

## 2026-08-09 — Preserve production operator overrides during refactors

- Evidence: `docs/architecture.md`, scheduler and Telegram tests
- Lesson: manual `/news` and manual Publish remain operator overrides; quiet hours gate automatic delivery without discarding durable checkpoints.
- Applies when: changing scheduling, publishing, Telegram control, persistence, or runtime composition.
- Invalidated when: an explicitly approved product decision and migration changes these contracts.

## 2026-08-09 — PostgreSQL functions are concurrency boundaries

- Evidence: ordered migrations in `db/migrations/` and the persistence baseline audit
- Lesson: claims, leases, optimistic versions, token CAS, review decisions, publication and queue transitions must remain atomic during Drizzle/NestJS migration.
- Applies when: moving persistence methods or changing repository contracts.
- Invalidated when: an independently reviewed replacement proves equivalent under concurrency tests.

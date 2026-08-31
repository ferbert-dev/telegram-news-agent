# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Governance

`AGENTS.md` holds the authoritative engineering process (Notion ticket lifecycle, Agent Runs, delegation contract, closure review, release authority). Read it before any state-changing work, plus `docs/current-status.md` for the verified production snapshot. This file covers only the build/test/architecture facts needed to work in the code.

Sources of truth, in order: checked-in code + ordered SQL migrations + tests + git history → Notion (intent/status) → GitHub (review/CI/deploy evidence) → Graphify (derived navigation aid, must be verified against source).

## Commands

Node >= 22 (`type: module` throughout; no bundler).

```bash
npm test                       # node --test — legacy JS unit tests under test/
node --test test/publish.test.js                    # single legacy test file
node --test --test-name-pattern "publishes" test/publish.test.js

npm run typecheck              # tsc --noEmit over src/, checks/, scripts/
npm run build:nest             # tsc -p tsconfig.build.json → dist/ (emits src/**/*.{ts,js})

npm run test:persistence       # tsx --test checks/persistence/*.ts   (Nest persistence modules, mocked pg)
npm run test:application       # tsx --test checks/application/*.ts   (application services, fake ports)
npm run test:architecture      # tsx --test checks/architecture/*.ts  (layering rules — see below)
npm run test:runtime           # tsx --test checks/runtime/*.ts       (coordinator, worker tokens, readiness)
npm run test:drizzle           # Drizzle schema snapshot
npm run test:drizzle:sources   # Drizzle sources repository
npm run test:nest:build        # build:nest, then run every checks/emitted-*.mjs against dist/

tsx --test checks/persistence/database-module.ts    # single TypeScript check
tsx --test checks/runtime/runtime-lifecycle.ts      # single runtime check
```

Database-backed checks require a real PostgreSQL and are opt-in:

```bash
npm run test:integration                 # RUN_DATABASE_INTEGRATION=1 node --test test/integration/*.test.js
npm run test:integration:drizzle         # RUN_DATABASE_INTEGRATION=1 tsx --test checks/integration/*.ts
DATABASE_URL=postgresql://... npm run database:status
DATABASE_URL=postgresql://... npm run database:drift     # SQL migrations vs Drizzle snapshot
npm run database:contract                                # clean PostgreSQL 17 contract inventory
npm run database:new -- describe_the_change              # scaffold a new ordered migration
npm run database:migrate                                 # apply db/migrations/*.sql (checksum-tracked)
```

They read `DATABASE_TEST_URL ?? DATABASE_URL` and self-skip when `RUN_DATABASE_INTEGRATION` is unset, so a green `npm test` does **not** mean persistence was exercised.

To get a local PostgreSQL for them, `compose.test.yaml` overlays a loopback port onto the compose `db` service (`compose.yaml` requires `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` to be set or it refuses to start):

```bash
docker compose -f compose.yaml -f compose.test.yaml up -d db
docker compose -f compose.yaml -f compose.test.yaml run --rm migrate
DATABASE_TEST_URL=postgresql://telegram_news_app:$POSTGRES_APP_PASSWORD@127.0.0.1:55432/telegram_news \
  npm run test:integration:drizzle
```

CI (`.github/workflows/deploy.yml`) runs this gate order on merge to `main`: `npm test` → `typecheck` → `test:drizzle` → `test:drizzle:sources` → `test:persistence` → `test:application` → `test:architecture` → `test:runtime` → `test:nest:build` → Docker image build → clean-database migrations (applied twice, to prove idempotency) + `database:status --require-applied` + `database:contract` + `database:drift` + both integration suites → image push → SSH deploy with health-gated rollback.

Operator CLIs (all load `.env`): `npm run pipeline:run`, `npm run drafts -- list|preview|approve|publish|reconcile-sent|reconcile-not-sent`, `npm run sources -- list|add|disable|enable`, `npm run research`, `npm run telegram:check|control|smoke|send`, `npm run audit:flush`, `npm run usage:dashboard` (this one builds first and runs from `dist/`).

## Architecture

Two runtimes coexist by design, and this is the single most important fact about the repo:

- **Legacy JS (production).** `src/telegram-bot.js` is the deployed entrypoint (`compose.yaml`, `command: node src/telegram-bot.js`). It wires flat `src/*.js` modules — `news-repository.js`, `pipeline.js`, `draft.js`, `publish.js`, `telegram-control.js`, `telegram-polling.js`, `news-scheduler.js`, `notion-audit.js`, `ai-provider.js` — against a raw `pg` pool.
- **NestJS TS (additive, mostly unwired).** `src/<domain>/` directories hold a standalone Nest application context. Slices land one vertical at a time and are deliberately **not** imported by the legacy entrypoint until an explicit cutover ticket. `checks/architecture/nestjs-boundaries.ts` asserts that unwiring — e.g. `telegram-bot.js`/`telegram-polling.js` must not mention `telegram-control-application`, `telegram-bot.js`/`pipeline.js` must not mention `legacy-research-execution`.

The `Dockerfile` makes the split concrete: it copies only `src`, `scripts`, and `db`, never runs `build:nest`, and ships no `dist/`. **The production image cannot execute the TypeScript layer at all** — it runs `node src/telegram-bot.js` against `src/*.js`. Anything requiring `dist/` (including `npm run usage:dashboard`) is local/CI-only until the cutover ticket changes the image.

Keep the legacy path working. Do not "clean up" a legacy module by pointing it at the Nest layer.

### Nest layering

```
DatabaseModule (PG_POOL, DRIZZLE_DB, DATABASE_LIFECYCLE)
  └─ <domain>-persistence.module.ts   → typed Drizzle repositories in src/database/repositories/
       └─ <domain>-application.module.ts (src/<domain>/application/*.use-case.ts, *.service.ts)
            └─ transport (src/telegram/transport/) and src/runtime/
  └─ persistence-facade.module.ts     → LegacyPersistenceFacade, the NewsRepository-shaped
                                        compatibility surface composed of the persistence modules only
```

Persistence domains: `catalog`, `research`, `editorial`, `story-deduplication`, `settings`, `telegram`, `operations`, `scheduler`, `usage`. Table ownership per domain is in `docs/nestjs-drizzle-migration-blueprint.md`. Repositories never call each other; application services coordinate them.

Cross-cutting modules that are not persistence slices:

- `src/ai/` — provider-neutral `AiProviderPort` (`generateStructured`, `searchNews`, `searchFeeds`, `searchFact`) plus adapters and fallback composition. Application code depends on the port, never on `openai`/`@google/genai`/Exa SDKs.
- `src/telemetry/` — adapters translating provider responses into usage-ledger and provider-attempt writes.
- `src/publication-milestones/` — domain + service for publication milestone messages.
- `src/runtime/` — `runtime-bootstrap.ts` / `runtime-module.ts` / `runtime-coordinator.ts`: the standalone application context, worker start/stop ordering, signal handling, and graceful shutdown.

### Boundary rules (enforced by `npm run test:architecture`)

- Application-layer files (`**/application/**`, `*-application*.ts`, `*.service.ts`, `*.use-case.ts`) must not import `pg`, `drizzle-orm`, `src/database/*`, `news-repository`, legacy `pipeline`/`draft`/`publish`/`publication-recovery`/`notion-audit`, provider SDKs (`openai`, `@google/genai`, `*-provider`), telegram transport, `node:http(s)`, `axios`, `undici`, or call `fetch(` at all. Infrastructure enters through injected ports.
- Persistence modules must not import application or transport code, and each must export the exact class name the check expects.
- Nest module imports must be acyclic and must never use `forwardRef`.
- No `@nestjs/platform-*`, no `NestFactory.create(`, no `.listen(` anywhere — this is a standalone context, not an HTTP server.
- `runtime-coordinator.ts` must not touch `process.exit`, `process.exitCode`, or `process.on/off`; signal handling and exit escalation live in `runtime-module.ts` and `runtime-bootstrap.ts`. The default stop grace must stay below the compose `stop_grace_period: 45s`.

Adding a slice usually means editing this check too — it encodes the intended shape, so update it deliberately rather than loosening an assertion to make a build pass.

### Code conventions

- TypeScript is `NodeNext`/`strict`: relative imports carry the `.js` extension even when the file is `.ts`.
- DI uses `Symbol` tokens in `*.tokens.ts` and port interfaces in `*.contracts.ts`; providers are `useFactory`/`inject` with those tokens, not class-type injection across module boundaries.
- `legacy-*.gateway.ts` + `legacy-*.module.ts` are the sanctioned adapters that let a Nest use-case reach a legacy JS module through a narrow, typed port. They are the only place that seam belongs.
- Row → domain translation lives in `*-row-mappers.ts`. Legacy snake_case DTO shapes, bigint parsing (`pg` INT8 → number), timestamp and null semantics, and error codes are preserved deliberately; changing them needs an explicit cutover ticket.
- `checks/emitted-*.mjs` boot the compiled `dist/` output, so decorator metadata and DI must survive `tsc` emit — not just `tsx`.

## Database invariants

- `db/migrations/*.sql` (timestamp-ordered, checksum-tracked in `schema_migrations`) is the authoritative schema history. Never edit an applied migration; add a forward one.
- Drizzle schema (`src/database/schema/`) is a typed snapshot for repositories and drift detection. Parity there does **not** prove function bodies, grants, RLS, indexes, defaults, or checks — verify those against SQL.
- Locks, leases, `SKIP LOCKED`, optimistic-version and token-CAS updates, multi-table publication, review, scheduling, and audit-queue transitions stay inside atomic PostgreSQL functions unless an independently reviewed replacement proves equivalence.
- One shared pool, one Drizzle provider, one runtime coordinator owning shutdown; do not close the pool before polling and scheduling stop.
- No production dual writes. Compare old/new mutation behavior on isolated integration fixtures only.

## Behavior that must be preserved

Manual `/news`, manual Publish, idempotent per-draft publication (an uncertain Telegram response leaves the draft in `publishing` for manual reconciliation — never blind retry), 22:00–08:00 `Europe/Madrid` quiet-hours checkpoint recovery, fail-closed Notion audit with the `notion_audit_outbox` fallback, feeds-first research with paid search reserved for bounded recovery, and per-provider usage accounting. `docs/architecture.md` and the README describe the intended pipeline in detail.

## Graphify

`graphify-out/` is a persistent, AST-derived, code-only knowledge graph (no LLM tokens). For codebase questions run `graphify query "<question>" --budget 1400` first, then open the narrow paths it returns; `graphify path`, `explain`, and `affected` cover relationships. After changing code run `graphify extract . --code-only` — **not** the generic `graphify update .`, which would pull Markdown into the graph. Verify migration-critical findings against `rg`, SQL, and tests.

`graph.json`, `GRAPH_REPORT.md`, `manifest.json`, and `.graphify_analysis.json` are generated and gitignored, so a rebuild produces no diff and a fresh clone has no graph until someone runs the extract. The curated `graphify-out/memory/` and `reflections/` files stay tracked — those are saved query outcomes, not regenerated output. (`AGENTS.md` still says dirty graph files are expected; that line predates this change.)

## README synchronization

Update `README.md` in the same change when verified work materially changes capabilities, architecture, setup, operation, deployment, safety boundaries, or the contributor workflow. Skip it for internal refactors with no externally visible effect.

## Worktrees

`.worktrees/` and past `/private/tmp/telegram-news-agent-*` paths hold many per-ticket worktrees, and stale entries accumulate. If a `git checkout` fails with "already used by worktree" pointing at a directory that no longer exists, `git worktree prune` clears the stale record without touching branches.

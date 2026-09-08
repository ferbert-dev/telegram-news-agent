# NestJS cutover readiness

What has been verified, what has not, and what cutover would involve. Written
after the packaging slice; nothing here has changed production.

## What production runs today

`node src/telegram-bot.js`, the legacy JS runtime. The image also carries the
compiled NestJS runtime in `dist/`, built in a separate Docker stage — carried,
not started. No deployment path passes `compose.nest.yaml`, the overlay that
would run it instead.

## Covered by a check that runs in CI

| Claim | Where |
|---|---|
| The whole application graph constructs with real adapters | `checks/application/news-agent-composition.ts` |
| It also constructs against a real PostgreSQL, and reaches it | `checks/integration/news-agent-composition.ts` — drives the lease application through to the atomic function |
| The composition root refuses to boot with a late-bound port unbound | `checks/application/news-agent-composition.ts` — verified by deleting each of the five `bind()` calls in turn |
| `/news` enqueues durably and a concurrent request is suppressed, not duplicated | `checks/integration/telegram-news-command.ts` — the real use case against the real atomic function |
| A queued `/news` job is actually consumed | `checks/emitted-news-agent-composition.mjs` — the runtime's token list, the module's name map and the probe's required set are three separate declarations, and the check requires them to agree and each name to resolve to a real worker |
| The research phase does not re-run work that was already paid for | `checks/application/telegram-news-job-workflow.ts` — an existing checkpoint is reported without touching a provider |
| An automatic channel approves before publishing, and never publishes a rejected draft | Same file — the publish fake enforces what `claim_draft_for_publication_with_policy` enforces |
| An outcome the delivery phase could not render is retried, not made durable | `checks/application/telegram-news-job-worker.ts` |
| Readiness is decided by the lease row, not by the runtime | `checks/integration/runtime-readiness.ts` — real acquire/lose/expire/release cycle |
| Lease expiry is judged on PostgreSQL's clock, not the probe's | Same file — the process clock is shifted ten minutes and `serverNowAt` does not follow it |
| The composition root cannot forget a late-bound port | `checks/application/news-agent-composition.ts` — creation lives only on the registry, so there is no unregistered constructor to omit |
| A runtime that came up without its scheduler is not ready | `checks/application/news-agent-composition.ts` — the readiness file is derived from the token list actually started, and the probe requires the full set from a separate declaration |
| The compiled output survives `tsc` emit | `checks/emitted-*.mjs`, run against `dist/` |
| `dist/` imports and the health probe fails closed, without devDependencies | `.github/workflows/deploy.yml` — run inside the built image |
| SIGTERM drains workers in reverse order and exits cleanly | `checks/emitted-runtime-signals.mjs` — a real signal to a real process running the compiled output, not an injected fake signal source |
| The image still starts the legacy entrypoint | Same step — `CMD` asserted byte-for-byte |
| Typed publication behaves as legacy publication, not merely as something correct | `checks/application/publish-differential.ts` — five irreversible branches driven through both implementations on one fixture, comparing the result, every Telegram call and every repository write, key presence included |
| The one component that wraps legacy rather than reimplementing it does not change what crosses the seam | `checks/application/draft-generation-differential.ts` — both directions of the gateway, mutation-proven |
| A news job that fails has somewhere to report it | `checks/application/news-agent-composition.ts` — the worker is constructed with a logger, so the failure logging is not a no-op |
| The release gate cannot be shorter than the container's own start period | `checks/ops/deploy-gate.sh` — a cross-file check against `compose.yaml` |

## Rehearsed by hand, not regression-protected

These were run once, against a local PostgreSQL, and nothing in CI would notice
if they broke. They are evidence, not coverage.

| Claim | How |
|---|---|
| The shipped probe reports healthy only while the lease is held | Run in the production image, over the compose network, as `USER node` on a read-only filesystem |
| A misconfigured runtime fails fast rather than holding a lease | An invalid token fails at `ensurePollingMode` before anything is acquired, and the container healthcheck reports `unhealthy` |
| The new runtime needs no new environment variables | Rehearsed on the legacy runtime's documented environment; it reached Telegram authentication. `TELEGRAM_UPDATE_MODE=polling` is already required and enforced by `ops/validate-production-env.sh` |

## Not verified

**The typed runtime has now polled a real bot, once, against a separate test
bot and channel.** That single session found two failures that roughly eight
hundred automated checks had not:

- **`/news` was permanently dead.** The command enqueued a durable job and no
  worker existed to consume it, so it answered "Research queued" forever — and
  because the enqueue function allows one active job per channel, the one dead
  job suppressed every later `/news` on that channel. Fixed by wiring
  `TelegramNewsJobWorker` into the composition root with a typed workflow and
  delivery adapter, and by the three-way worker-set check above.
- **A rate-limited provider caused a request storm**: 1,005 requests, 986 of
  them 429s, in 358 seconds. Per-call retry was bounded; nothing was bounded
  across calls. Fixed by a per-provider circuit breaker.

The `/news` path has since been exercised repeatedly against the live stage
bot with real providers, through to a published article of the intended shape,
including the provider-fallback branch: a run whose enrichment failed on one
provider (`upstream_unavailable`) completed on the next and shipped.

What is still untested against a live bot, and is behavioural rather than
code: a **scheduled** run started by the scheduler rather than by `/news`, the
**automatic-approval** publish path, and a **quiet-hours** deferral across the
22:00–08:00 `Europe/Madrid` boundary. Each needs the stage left running rather
than another change.

**Research does not respond to the abort signal.** Both live runs needed
SIGKILL. The coordinator bounds shutdown with its own deadline, so the process
still exits — but a job interrupted mid-research keeps its claim until the
30-minute stale window expires, and `/news` stays suppressed on that channel
for that long. This is parity with legacy, not a regression, and it is now on
the typed runtime's path too.

~~**Usage accounting is blind.**~~ **Closed.** The provider adapters emit
usage events alongside attempts, and the integration stage now reports both:
`AiTotals attempts=20535 usage_events=4461` at the last inspection. The
dashboard and any spend alerting can see the spend as it happens.

**One counter is still per-process.** The Exa daily budget lives in the
adapter's memory, so a restart resets it. It bounds a single run, not a day.

~~**The poll loop is not covered by the health check.**~~ **Closed.** The
poller now records each completed poll, `runtime-health.ts` publishes it as
`lastPolledAt` in a snapshot at schema version 3, and
`runtime-health-check.ts` refuses a runtime whose polling worker is running
but whose last poll is absent or older than `DEFAULT_MAX_POLL_AGE_MS`
(180s). A permanently failing `getUpdates` now loses the health check, and
because the release gate reads health, it loses the release too.

The release and rollback procedure lives in
[nestjs-cutover-runbook.md](nestjs-cutover-runbook.md), including a rollback gap
that must be closed before any cutover attempt.

## What cutover would involve

1. A test bot and channel, and a full manual pass on the new runtime.
   ~~`/news`, draft preview, approve, publish~~ **Done** on the integration
   stage. Outstanding: a scheduled run, the automatic-approval publish path,
   and a quiet-hours deferral.
2. ~~Teaching `ops/deploy.sh` to gate on `.State.Health`.~~ **Done.** The gate
   lives in `ops/lib/deploy-gate.sh` and requires the container to be running,
   never restarted, and healthy. `compose.yaml` now declares an
   entrypoint-aware healthcheck for the bot: the typed runtime runs the real
   probe, the legacy runtime exits 0 because it is the frozen rollback and has
   no readiness contract. A container reporting no healthcheck at all is
   refused, since the definition being lost is the regression that would
   otherwise silently restore the old behaviour.
3. ~~Folding `compose.nest.yaml` into `compose.yaml` or shipping it.~~ **Not
   needed.** The runtime is chosen by `BOT_ENTRYPOINT` in `.env.production`,
   which `compose.yaml` already reads and `ops/deploy.sh` already rolls back.
4. ~~A rollback plan.~~ **Already the case**, for the same reason: both
   runtimes live in one image and the entrypoint is an environment value that
   rollback restores.

Only after that does removing `src/*.js` become a separate question. The legacy
modules are still imported by the NestJS layer through the sanctioned
`legacy-*.gateway.ts` seams, so deleting them is its own migration, not a
side effect of cutover.

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

What is still untested against a live bot: a Publish tap, a Reject, a scheduled
run, a quiet-hours deferral, and the automatic-approval publish path. The
`/news` path itself has only been exercised end to end since the worker landed
in fakes and in PostgreSQL, not yet against the live bot.

**Research does not respond to the abort signal.** Both live runs needed
SIGKILL. The coordinator bounds shutdown with its own deadline, so the process
still exits — but a job interrupted mid-research keeps its claim until the
30-minute stale window expires, and `/news` stays suppressed on that channel
for that long. This is parity with legacy, not a regression, and it is now on
the typed runtime's path too.

**Usage accounting is blind.** The same live run wrote 1,005 rows to
`ai_provider_attempts` and 0 to `ai_usage_events`, so the usage dashboard and
any spend alerting saw nothing while the storm was happening.

**The poll loop is not covered by the health check.** A permanently failing
`getUpdates` — revoked token, lasting partition — backs off and retries forever
without surrendering the lease, so every readiness condition holds while
nothing is served. Closing it needs the poller to publish a
last-successful-poll timestamp into the readiness snapshot.

The release and rollback procedure lives in
[nestjs-cutover-runbook.md](nestjs-cutover-runbook.md), including a rollback gap
that must be closed before any cutover attempt.

## What cutover would involve

1. A test bot and channel, and a full manual pass on the new runtime: `/news`,
   draft preview, approve, publish, a scheduled run, and quiet-hours deferral.
2. Teaching `ops/deploy.sh` to gate on `.State.Health` rather than
   `.State.Running` and `.State.RestartCount`. Until then the healthcheck is
   visible in `docker ps` but gates nothing.
3. Folding `compose.nest.yaml` into `compose.yaml`, or adding it to the
   deployment bundle and to every `docker compose` invocation in
   `ops/deploy.sh`. It is currently not shipped to the server at all.
4. A rollback plan that is just the previous image plus the previous compose
   file, since both runtimes live in the same image.

Only after that does removing `src/*.js` become a separate question. The legacy
modules are still imported by the NestJS layer through the sanctioned
`legacy-*.gateway.ts` seams, so deleting them is its own migration, not a
side effect of cutover.

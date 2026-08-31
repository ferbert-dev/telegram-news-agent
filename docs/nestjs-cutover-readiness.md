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
| Readiness is decided by the lease row, not by the runtime | `checks/integration/runtime-readiness.ts` — real acquire/lose/expire/release cycle |
| Lease expiry is judged on PostgreSQL's clock, not the probe's | Same file — the process clock is shifted ten minutes and `serverNowAt` does not follow it |
| The composition root cannot forget a late-bound port | `checks/application/news-agent-composition.ts` — ports register themselves at creation, and a sixth unlisted port fails the suite |
| A runtime that came up without its scheduler is not ready | `checks/runtime/runtime-health.ts` — the readiness file records which workers started, and the probe requires the full set |
| The compiled output survives `tsc` emit | `checks/emitted-*.mjs`, run against `dist/` |
| `dist/` imports and the health probe fails closed, without devDependencies | `.github/workflows/deploy.yml` — run inside the built image |
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

**No runtime has ever polled a real bot.** Every rehearsal used a placeholder
token, so what is proven is that it starts, wires, reaches PostgreSQL, reaches
Telegram, and fails cleanly when Telegram rejects it. Whether it correctly
serves `/news`, a Publish tap, or a scheduled run against a live bot is
untested. This is the gap cutover has to close, and it needs a **separate test
bot and channel** — not the production ones.

**The poll loop is not covered by the health check.** A permanently failing
`getUpdates` — revoked token, lasting partition — backs off and retries forever
without surrendering the lease, so every readiness condition holds while
nothing is served. Closing it needs the poller to publish a
last-successful-poll timestamp into the readiness snapshot.

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

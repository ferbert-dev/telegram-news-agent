# NestJS cutover: release and rollback runbook

The procedure for switching production from the legacy JS runtime to the compiled
NestJS runtime, and for getting back if it goes wrong.

**Standing rule, set by the project owner:** the old system is not removed until
the new one is working in production. `src/*.js` — `telegram-bot.js`,
`pipeline.js`, `research.js` and the rest — stays in the repository and in the
image through cutover and through at least one stable release afterwards.
Deleting it is a separate, later decision. Nothing in this runbook removes it.

## What is true today

- **Both runtimes ship in the same image.** `src/` (legacy) and `dist/` (compiled
  NestJS) are both present. `CMD` and `compose.yaml` both run
  `node src/telegram-bot.js`, and CI asserts the `CMD` byte-for-byte.
- **`ops/deploy.sh` already rolls back automatically.** It records the running
  container's image before deploying, installs `trap rollback_on_error ERR`, and
  on any failure restores the previous environment file *and* the previous image,
  waits for PostgreSQL to become healthy, and reconciles the application-role
  credential.
- **Migrations are a separate one-shot service** (`compose run --rm migrate`),
  run before the bot starts. The runtime never migrates on startup.
- **The release gate is process-liveness**, not health: three consecutive checks,
  five seconds apart, of `.State.Running == true` and `.RestartCount == 0`,
  followed by `ops/verify-production-runtime.sh`.
- **`compose.nest.yaml` is not shipped.** The deployment bundle installs files
  one by one (`compose.yaml`, `compose.ssh-access.yaml`, five `ops/*.sh`,
  `package.json`), so the overlay never reaches the server and cannot be picked
  up by accident.

## The rollback gap — fix this before cutover

**`deploy.sh` restores the previous image and the previous environment. It does
not restore the previous `compose.yaml`.**

That does not matter today, because the command never changes. It matters a great
deal at cutover:

1. The workflow copies the new `compose.yaml` onto the host **before**
   `deploy.sh` runs.
2. If that file now says `command: ["node", "dist/composition/runtime-entry.js"]`
   and the new runtime fails its gate, `deploy.sh` restores the **previous
   image** — but the **new command** is still in the compose file on disk.
3. Every image built since the packaging change contains `dist/`. So the restored
   "previous" container would start the **new runtime from the old image**. That
   is not a rollback to legacy; it is a rollback to a different broken thing.

Three ways to close it, in order of preference:

| Option | What it means | Trade-off |
| --- | --- | --- |
| **A. Make the command an environment variable** | `command: ["node", "${BOT_ENTRYPOINT:-src/telegram-bot.js}"]`, set in `.env.production` | `deploy.sh` already snapshots and restores the env file, so rollback restores the command for free. Smallest change, uses machinery that is already proven. |
| **B. Snapshot the compose file** | `deploy.sh` copies `compose.yaml` to `compose.yaml.rollback` alongside the env snapshot and restores it in `rollback()` | Explicit, but adds a second restore path to the highest-stakes script. |
| **C. Ship the overlay** | Add `compose.nest.yaml` to the bundle and to every `docker compose` invocation, including the two inside `rollback()` | Most invasive: four call sites, and forgetting the ones in `rollback()` reintroduces the same bug silently. |

**Option A was chosen and is implemented.** `compose.yaml` now reads
`command: ["node", "${BOT_ENTRYPOINT:-src/telegram-bot.js}"]`, interpolated from
the same `--env-file` that `deploy.sh` already snapshots to
`.env.production.rollback` and restores in `rollback()`. It reuses a path that
runs on every deploy rather than one that only runs during an incident.

Two guardrails came with it:

- `ops/validate-production-env.sh` accepts only the two real runtimes as a value,
  in every mode. A typo does not produce a helpful error at deploy time — it
  produces a container that cannot start and a rollback driven by hand.
- CI asserts both directions: with no variable the resolved command is the legacy
  entrypoint, with the variable set it is the compiled one. The default cannot be
  flipped by accident.

Proven against real containers before merge: the default starts
`src/telegram-bot.js`; setting the variable starts
`dist/composition/runtime-entry.js`; and restoring the previous environment file
— exactly what `rollback()` does — brings the legacy runtime back.

### How rollback behaves in each case

| When it fails | What the environment restore does | Result |
| --- | --- | --- |
| The cutover deploy itself | Restores the previous file, which has no `BOT_ENTRYPOINT` | Back on legacy — correct |
| A later deploy, already cut over | Restores a file that still selects the compiled runtime | Stays on the new runtime with the previous image — also correct |

## Prerequisites

Do not start the release until all of these are true.

- [x] ~~The rollback gap above is closed and merged.~~ Done — `BOT_ENTRYPOINT`.
- [ ] A **separate test bot and channel** exist, and the full smoke matrix has
      been run against them on the new runtime: `/news`, draft preview, approve,
      publish, reject, a scheduled run, quiet-hours deferral, `/stats`,
      `/settings`, `/labs`. *No runtime has ever polled a real bot; this is the
      largest untested surface and the reason cutover is gated.*
- [ ] `main` is green: the full CI gate including both integration suites against
      a clean PostgreSQL 17.
- [ ] The current production image digest and commit SHA are written down, along
      with the current `.env.production` hash.
- [ ] A `pg_dump` has been taken and restored into a throwaway database to prove
      the backup is usable.
- [ ] Deployment is scheduled **outside** 22:00–08:00 Europe/Madrid, so the
      quiet-hours path is not exercised for the first time during a release.

## The release

The switch is one value. Everything else is the existing, unchanged deploy path.

1. **Set the entrypoint.** Add `BOT_ENTRYPOINT=dist/composition/runtime-entry.js`
   to the production environment. This is the entire cutover.
2. **Merge and let CI deploy.** The workflow builds the image, runs migrations as
   a separate service, then `deploy.sh` brings up the bot.
3. **Watch the gate.** `deploy.sh` requires three consecutive liveness checks and
   the runtime credential check. On any failure it rolls back on its own.
4. **Confirm exactly one poller.** The lease is the safety net, never the cutover
   mechanism — the old container must be gone before the new one starts, which
   `up -d --no-deps bot` handles by replacing it.
5. **Verify by hand, against production**, in this order:
   - the readiness probe reports healthy — `docker compose exec bot node dist/composition/health-cli.js`
   - bot identity and polling mode are correct
   - one lease heartbeat window passes with the lease still owned
   - `/stats`, `/settings`, `/labs` respond
   - a manual `/news` produces a draft, and Publish publishes exactly once
   - one scheduler interval is observed, or a deliberate quiet-hours deferral

## Rollback

### It is automatic during the deploy

If the gate fails, `deploy.sh` restores the previous image and environment
without intervention. Restoring the environment also restores the
entrypoint, so the container comes back on the legacy runtime.
Nothing further is required.

### Manual rollback, after the deploy reported success

On the host, in `/opt/telegram-news-agent`:

```bash
# 1. Put the entrypoint back. This is the whole rollback.
sed -i 's|^BOT_ENTRYPOINT=.*|BOT_ENTRYPOINT=src/telegram-bot.js|' .env.production

# 2. Recreate the bot only. The database is untouched.
docker compose --env-file .env.production -f compose.yaml -f compose.ssh-access.yaml \
  up -d --force-recreate --no-deps bot

# 3. Prove there is exactly one poller and it is the legacy one.
docker compose --env-file .env.production -f compose.yaml -f compose.ssh-access.yaml \
  ps bot
docker compose --env-file .env.production -f compose.yaml -f compose.ssh-access.yaml \
  logs --tail=50 bot
```

The image does not need to change, because it carries both runtimes. If the image
itself is suspect, add `APP_IMAGE=<previous digest>` to step 2.

### Rollback triggers

Roll back on any of these, without deliberating:

- the readiness probe reports unhealthy, or reports healthy while the bot is not
  answering
- more than one poller, or a Telegram 409
- the lease owner does not match the running runtime
- a draft publishes twice, or a publication is lost
- an excluded topic reaches the channel
- the container restarts more than once
- a scheduled run is missed, or quiet-hours recovery does not fire
- database contract drift

### What rollback does not undo

- **Migrations are forward-only.** They are applied before the bot starts and are
  not reverted. Every migration must remain compatible with the legacy runtime
  for as long as rollback is a possibility — which is the entire reason
  `research.js` and the rest of `src/*.js` stay in place.
- **Anything already published to the channel.** A wrongly published post is a
  content problem, deleted through Telegram, not through a rollback.
- **A schedule claim held by the new runtime** ages out after its stale threshold
  rather than being released instantly, so the first legacy run after a rollback
  may be delayed by up to that window.

## After a successful cutover

Leave the legacy runtime in place. It costs nothing — it is already in the image
— and it is the rollback.

Only after at least one stable release, and a separate explicit decision, does
removing `src/*.js` become a question. That work is tracked on the legacy
retirement ticket, not here.

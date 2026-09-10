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
  NestJS) are both present. `compose.yaml` runs
  `node ${BOT_ENTRYPOINT:-src/telegram-bot.js}`, so an environment that never
  names a runtime gets the legacy one.
- **The runtime is chosen in `ops/production-runtime.env`**, one line,
  `BOT_ENTRYPOINT=...`. The deploy job appends it to the environment it
  decrypted from SOPS and ships the result as `.env.production.incoming`.
  From v2.0.0 it names the NestJS runtime.
- **Production deploys only on a `vX.Y.Z` tag** cut from a `release/*` branch.
  A merge to `main` builds and gates an image and deploys nothing. Editing the
  switch therefore changes nothing until the next tag.
- **`ops/deploy.sh` rolls back automatically.** It snapshots the running
  environment and image before promoting the new ones, and on any failure
  restores both -- which restores the runtime, because the runtime is a line in
  that environment.
- **Migrations are a separate one-shot service** (`compose run --rm migrate`),
  run before the bot starts. The runtime never migrates on startup.
- **The release gate reads health** (`ops/lib/deploy-gate.sh`): running, never
  restarted, and `healthy`, three checks in a row, inside a 300-second window
  that is longer than the container's own 120-second start period. The typed
  runtime's healthcheck runs the readiness probe, which also fails a poller that
  has stopped polling; the legacy runtime's exits 0.

## The rollback gap -- closed

A failed cutover used to restore the previous image and environment but not the
previous `compose.yaml`, so a compose file naming the new command would survive
the rollback. The command became `${BOT_ENTRYPOINT:-...}` and the value moved
into the environment, which `deploy.sh` already snapshots and restores. There
is no longer anything a rollback leaves behind.

## Prerequisites

Do not start the release until all of these are true.

- [x] ~~The rollback gap above is closed and merged.~~ Done — `BOT_ENTRYPOINT`.
- [x] ~~A separate test bot and channel, and the full smoke matrix on the new
      runtime.~~ Done on the integration stage, 2026-09-08 to 2026-09-10:
      `/news`, preview, publish, reject and `/settings` by hand; then eight
      unattended scheduled runs every three hours with automatic approval,
      seven published, and a night with zero events between 22:00 and 08:00
      Madrid, the first run landing at 08:00:21.
- [ ] `main` is green: the full CI gate including both integration suites against
      a clean PostgreSQL 17.
- [ ] The current production image digest and commit SHA are written down, along
      with the current `.env.production` hash.
- [ ] A `pg_dump` has been taken and restored into a throwaway database to prove
      the backup is usable.
- [ ] Deployment is scheduled **outside** 22:00–08:00 Europe/Madrid, so the
      quiet-hours path is not exercised for the first time during a release.

## Where the value actually lives -- read this before touching anything

The switch is authored in **`ops/production-runtime.env`**, in git, and reaches
the host only through a release: on a `vX.Y.Z` tag the deploy job decrypts
`secrets/production.env.sops`, appends the switch, validates the result and
ships it as `.env.production.incoming`, which `deploy.sh` promotes.

| Where | What it is | When it takes effect |
| --- | --- | --- |
| `ops/production-runtime.env` | the source of truth, in git | at the next tag release |
| `.env.production` on the host | the running value | immediately |

It is not in SOPS on purpose. It is not a secret, and the production age key is
held only by CI, so a switch kept in SOPS is one nobody can flip back from a
laptop during an incident. The deploy job **refuses** a release if SOPS defines
`BOT_ENTRYPOINT` as well, and `checks/ops/production-runtime.sh` fails CI if the
file stops being exactly one valid line.

> **A host-side edit to `.env.production` is temporary.** The next release of
> anything at all re-applies `ops/production-runtime.env`. A rollback done only
> on the host silently comes back at the next tag, days later, with nobody
> connecting the two events.

(An earlier version of this page said the next *merge to `main`* would bring it
back. That stopped being true when deploys moved to tags; the danger is the
same, it just arrives at the next release instead.)

## The release

The switch is one line. Everything else is the existing, unchanged deploy path.

1. **Record the baseline and prove the backup.** Run the `backup-production-db`
   workflow operation. It prints the running image, command, `APP_VERSION` and
   the `.env.production` hash, dumps the database, restores the dump into a
   throwaway server with no network, and compares every table's row count
   against the live database. It fails rather than reporting a backup it could
   not restore.
2. **Set the switch and the version on `main`.** `BOT_ENTRYPOINT` in
   `ops/production-runtime.env`, the release version in `package.json`. Merge.
   This deploys nothing.
3. **Cut the snapshot.** `git switch -c release/vX.Y.Z origin/main` and push it.
   The push runs the full gate and builds an image for that exact commit.
4. **Tag it.** `git tag vX.Y.Z` on that commit and push the tag. The release job
   refuses a tag that is not on a release branch, has no gated image, or
   disagrees with `package.json`; then it retags the image -- never rebuilds --
   and the deploy job runs.
5. **Watch the gate.** `deploy.sh` needs three consecutive healthy checks and the
   runtime credential check. On any failure it rolls back on its own.
6. **Confirm exactly one poller.** The lease is the safety net, never the cutover
   mechanism -- `up -d --no-deps bot` replaces the old container before the new
   one polls.
7. **Verify by hand, against production**, in this order:
   - the readiness probe reports healthy -- `docker compose exec bot node dist/composition/health-cli.js`
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

**Two steps, and the second is not optional.** Step 1 stops the incident; step 2
stops it returning at the next unrelated deploy.

#### Step 1 — on the host, in `/opt/telegram-news-agent`

```bash
# Put the entrypoint back. This stops the incident, and lasts until the next deploy.
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
itself is suspect, add `APP_IMAGE=<previous digest>` to the recreate.

If the recreate appears to do nothing, check the image reference before blaming
the entrypoint: a missing or unpullable `APP_IMAGE` makes `up` fail and leaves
the old container running, which looks exactly like a rollback that was ignored.

#### Step 2 — in the repository, same session

Set `BOT_ENTRYPOINT=src/telegram-bot.js` in `ops/production-runtime.env`, merge,
and cut a patch release (`release/vX.Y.Z+1`, tag, push). Until that release
ships, the next release of anything at all puts the failed runtime back.

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

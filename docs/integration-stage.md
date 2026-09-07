# The integration stage

A second, fully isolated stack on the same Oracle host. It runs the compiled
NestJS runtime against its own bot, its own channel and **its own PostgreSQL
instance**, so a change can be tried in a real deployment before it reaches
production.

## Why a separate instance and not a second schema

A schema is a namespace, not a boundary. Two schemas in one PostgreSQL share the
process, the shared buffers, the WAL, the disk and the restart — so a runaway
query, a lock, a disk-full or a bad restart in integration takes production down
with it. That defeats the purpose: the integration stage exists precisely to run
changes nobody is sure about yet.

Separate instances cost memory and give real independence. That is the trade,
and it was taken deliberately — see the sizing below, which is what makes it
affordable on a 952 MiB box.

| | separate instances (built) | shared instance, two schemas |
|---|---|---|
| Integration can corrupt production data | No — different volume | Yes, via a mistargeted migration |
| Integration can stall production | No | Yes — shared locks, buffers, CPU |
| Restarting integration's database | Independent | Restarts production too |
| Extra memory | 352 MiB of ceilings | Near zero |

## What isolates the two stages

| Boundary | Where it comes from |
|---|---|
| containers, network, **volume** | the compose project name, `telegram-news-agent-int` |
| database | project-scoped volume, so a separate PGDATA entirely |
| bot and channel | `secrets/integration.env.sops` — a different token and channel |
| environment file | `env_file: !override [.env.integration]` in the overlay |
| host directory | `/opt/telegram-news-agent-int`, never production's |
| runtime | `BOT_ENTRYPOINT` selects the compiled runtime here; production stays legacy |
| memory | `mem_limit` on both integration services; production's are unchanged |

### The `!override` matters more than it looks

`compose.yaml` names `.env.production` in the bot's `env_file`, and **Compose
merges `env_file` lists rather than replacing them**. Without `!override` the
integration stack resolves to `.env.production,.env.integration` — production's
bot token and channel loaded first. A missing key in integration's file would
then silently fall through to production's value, and the integration bot would
post to the production channel.

This was a real defect in the overlay as first written. Nothing had run it, so
nothing had noticed. CI now asserts the resolved list for both stages, because
`config --no-env-resolution` — what the earlier check used — does not load
`env_file` at all and could never have caught it.

## Memory — measured, not guessed

The host is a **952 MiB** Oracle instance:

```
MemTotal:      952 MiB
MemAvailable:  461 MiB
Swap:         2048 MiB (1955 free)

telegram-news-agent-bot-1   86.8 MiB / 384 MiB limit
telegram-news-agent-db-1    53.6 MiB / 384 MiB limit
```

Production's ceilings total 768 MiB but its actual usage is ~141 MiB — limits
are caps, not reservations, so the 461 MiB is genuinely free.

The first sizing of this stage wanted 512 MiB plus 256 MiB of headroom and **did
not fit**. The capacity guard refused it, which is exactly what that guard is
for. The stage was resized against the measurement instead:

| | ceiling | production's equivalent | production's actual use |
|---|---|---|---|
| `db` | 128m | 384m | 54 MiB |
| `migrate` | 192m | 256m | — |
| `bot` | 224m | 384m | 87 MiB |

Peak is `db + bot` = **352 MiB**, because migrate finishes before the bot
starts and is kept below the bot's ceiling so the steady state is the peak.
With 96 MiB of headroom the requirement is **448 MiB** against 461 MiB
available.

That is thin, and it is why this stage is **brought up to test and torn down
after** (`stop-integration`) rather than left running. Idle, the box gets the
whole 461 MiB back.

`ops/deploy-integration.sh` measures `MemAvailable` before starting anything and
refuses below the threshold. A redeploy adds back what the integration stack
already holds, so its own footprint does not lock it out.

Production's limits are unchanged and are **not** touched by any of this.

Both stages are bounded, and the ceilings are what make co-location survivable:
without a cgroup on integration, a runaway there would push the box into the
kernel's OOM killer, which picks its victim by score — and the fat, long-lived
process it favours is production's postgres. With one, integration is what
dies. Swap (2 GB, 95% free) is the softer valve before that: a container over
its ceiling spills to swap and gets slow rather than being killed outright,
which for a test stage is the right failure.

## Running it

```bash
# Read-only: what the host actually has.
gh workflow run deploy.yml -f operation=inspect-host-capacity

# Deploy the current branch to integration. Builds, ships, preflights, deploys,
# then confirms production is still healthy.
gh workflow run deploy.yml -f operation=deploy-integration --ref <branch>

# Tear it down and give the host its memory back. Keeps the volume, so the
# next deploy resumes with its data rather than re-migrating from empty.
gh workflow run deploy.yml -f operation=stop-integration

# Run /news without typing it in Telegram. Refuses while a run is in flight,
# and copies the channel, chat and settings snapshot from the last real run.
gh workflow run deploy.yml -f operation=run-integration-news

# Free a /news job whose worker was killed mid-research — after a deploy, say.
# Without this the claim stands for the full stale window and every /news on
# that channel is suppressed as already-running until it expires.
gh workflow run deploy.yml -f operation=release-integration-news

# On the host, or locally: every guard, starting nothing.
ops/deploy-integration.sh --check-only

# The guard suite, which drives every refusal.
npm run test:ops
```

`deploy-integration` is **manual only** and deploys whatever ref it is
dispatched on — that is the point, it is where a change is tried before `main`.
It deliberately does not require the full test gate first: the guards below
contain the blast radius, and requiring a six-minute gate would defeat the fast
iteration the stage exists for. The gate still runs on the way to production.

## The guards

Every one is a refusal, and `npm run test:ops` drives each into refusing —
a guard that has never been observed refusing is indistinguishable from a no-op.

| Guard | Refuses when |
|---|---|
| environment stage | the env file is missing `DEPLOY_STAGE=integration` |
| distinct bot and channel | `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHANNEL_ID` matches production's |
| project | the script targets the project name `compose.yaml` declares |
| volume | any volume is external, or not prefixed with the integration project |
| limit drift | `compose.integration.yaml` and the script's budget disagree |
| capacity | `MemAvailable` + what integration holds is under 448 MiB |
| migrate peak | `migrate`'s ceiling exceeds the bot's, invalidating the sized peak |
| unreadable meminfo | the capacity guard cannot be skipped or defaulted |

Two of these were wrong when first written and the tests are what found it:

- The **project** guard asserted that compose resolved to the project the script
  had itself passed on the CLI — a constant compared to itself, which could
  never fail. It now compares against the name declared in `compose.yaml`, a
  file the script does not control.
- The **volume** guard looked for a volume name that does not exist
  (`telegram-news-agent_pgdata`; the volume is `postgres_data`) in output that
  reports it unprefixed. It now asserts every resolved volume name carries the
  integration project's prefix.

## Rollback

There is none, and that is deliberate. Integration is the stage you are allowed
to break; fixing forward is the correct response to a bad deploy. This is also
why `ops/deploy-integration.sh` is a separate script rather than a mode of
`ops/deploy.sh` — threading a second path through production's rollback machinery
would put it one untested branch away from an integration bug.

What the script owes production is not rollback. It is that it cannot act on
production's stack, and cannot starve it. The final workflow step re-checks
production's container **even when the deploy failed**, because a failed deploy
that disturbed production is the outcome that matters most.

## Deploying during a run kills it

`deploy-integration` replaces the bot container. A research pass in flight dies
with it, and its claim is then honoured for the full stale window — fifteen
minutes here — during which every `/news` on that channel answers
"already running" and nothing happens.

This is the single most confusing failure the stage produces, and it is
self-inflicted: it happened three times while testing, each time reading as
"the bot is broken" when the pipeline was fine. Before deploying, check whether
a run is in flight:

```bash
gh workflow run deploy.yml -f operation=inspect-integration
# a NewsJob with status=processing and a recent claimed_at is a live run
```

If one is, either wait for it or accept that it dies and free it afterwards
with `release-integration-news`.

The deeper cause is that research does not respond to the abort signal, so a
graceful stop cannot drain it. Fixing that is a separate piece of work; until
then the claim outliving the container is the behaviour to plan around.

## What the first deploys showed

Everything above was configuration and guards until 2026-09-05. It has now run
on the host, and these are the observed numbers rather than the intended ones:

| | Observed |
|---|---|
| deploy | `v0.1.0+int-a59-int`, capacity guard passed at `available=406MiB required=448MiB` |
| bot | `running`, `restart_count=0`, `oom_killed=false`, `mem_limit=224MiB` |
| `/news` | enqueued 09:11:00, `review_ready` 09:15:59, draft approved and published |
| providers | 464 OpenAI calls succeeded, none failed; Gemini never reached |
| production | same container before and after the deploy, `restart_count=0` |

Two things that were open questions are now answered. The 224 MiB bot ceiling
holds through a full research pass — feeds, excluded-topic classification at
concurrency 6, curation, generation and review delivery — without a kill. And
the compiled NestJS runtime completes the whole `/news` flow on a real host,
against a real Telegram channel, through to a published draft.

## Not done yet

- Research still does not honour the abort signal, so a graceful stop cannot
  drain a run in flight. This is what makes "deploying during a run kills it"
  above a behaviour to plan around rather than a bug to work around.

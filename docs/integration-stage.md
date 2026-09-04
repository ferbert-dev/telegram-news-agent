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

Separate instances cost roughly 200–250 MB of RAM and give real independence.
That is the trade, and it was taken deliberately.

| | separate instances (built) | shared instance, two schemas |
|---|---|---|
| Integration can corrupt production data | No — different volume | Yes, via a mistargeted migration |
| Integration can stall production | No | Yes — shared locks, buffers, CPU |
| Restarting integration's database | Independent | Restarts production too |
| Extra memory | ~512 MiB ceiling | Near zero |

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

## Memory

Production's limits are unchanged and are **not** touched by any of this:
`db 384m`, `migrate 256m`, `bot 384m` — 768 MiB of steady state.

Integration adds 512 MiB (`db 192m` + `bot 320m`). `ops/deploy-integration.sh`
measures `MemAvailable` before starting anything and refuses unless the host can
give that plus 256 MiB of headroom — 768 MiB in total. A redeploy adds back what
the integration stack already holds, so its own footprint does not lock it out.

Bounding only the new stack is the point. Production is unbounded in the sense
that matters here: when a box runs out, the kernel OOM killer picks its victim
by score, and the fat long-lived process it tends to pick is production's
postgres. A cgroup on integration means integration dies instead.

## Running it

```bash
# Read-only: what the host actually has.
gh workflow run deploy.yml -f operation=inspect-host-capacity

# Deploy the current branch to integration. Builds, ships, preflights, deploys,
# then confirms production is still healthy.
gh workflow run deploy.yml -f operation=deploy-integration --ref <branch>

# On the host, or locally: every guard, starting nothing.
ops/deploy-integration.sh --check-only
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
| capacity | `MemAvailable` + what integration holds is under 768 MiB |
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

## Not done yet

- The stage has never been deployed. Everything above is configuration and
  guards, verified locally and in CI, not observed on the host.
- Host memory is still unmeasured. `inspect-host-capacity` reports it; until it
  runs, whether the box can take the stage at all is unknown, and the capacity
  guard is what will answer that.
- Production still deploys on every merge to `main`. Moving it behind a release
  branch is a separate change.

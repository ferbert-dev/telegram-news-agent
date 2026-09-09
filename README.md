# Telegram News Agent

<p align="center">
  <a href="docs/assets/graphify-architecture.svg">
    <picture>
      <source srcset="docs/assets/graphify-architecture.svg" type="image/svg+xml">
      <img src="docs/assets/graphify-architecture.png" alt="Clickable production dependency graph of Telegram News Agent with Exa research" width="1200">
    </picture>
  </a>
  <br>
  <sub>Click the graph to open the full-size dependency map.</sub>
</p>

A production-oriented pet project that researches, writes, reviews, schedules,
and safely publishes grounded news articles to Telegram. It combines a durable
PostgreSQL workflow, multiple AI providers, bounded Exa web research, Telegram
operator controls, Oracle deployment, and auditable agent engineering.

## Production Snapshot

| Area | Current state |
| --- | --- |
| Runtime | Oracle-hosted Node.js service with PostgreSQL-backed polling and scheduling |
| Release | [`721ff79`](https://github.com/ferbert-dev/telegram-news-agent/commit/721ff791332635350c0869a2333ed00b33f27057), deployed and independently inspected on 2026-08-26; production still runs `src/telegram-bot.js` |
| Research | RSS/Atom, Google News resolution, GDELT, and bounded Exa detail/fact search |
| AI | OpenAI and Gemini structured generation with Exa as the retrieval-first research provider |
| Control | Private Telegram `/news`, `/settings`, `/labs`, `/stats`, and `/status` workflows |
| Safety | Grounded claims, atomic PostgreSQL publication, SOPS secrets, immutable images, and health-gated rollback |

Exa is enabled in production. A yellow Exa state in `/status` means configured
but idle, not broken; the explicit `Test Exa` action performs one bounded search
and records it in the usage ledger.

## Portfolio Highlights

- Evidence-grounded editorial enrichment with claim-to-source mapping.
- Reader-focused factual hook titles rendered in bold on every new article.
- RSS/GDELT-first discovery that reserves web search for bounded recovery and
  material article details.
- OpenAI, Gemini, and Exa provider fallback with per-operation usage accounting.
- PostgreSQL leases, idempotent publication, crash recovery, and manual review.
- TypeScript-first NestJS feature modules with ports/adapters and optional
  integration-event subscribers; publication milestones are the first module.
- Docker-based Oracle production deployment with migration and rollback gates.
- Graphify-assisted architecture navigation and impact analysis.

## Goal

Build a minimal workflow where ideas become tickets, agents execute scoped tasks, and a Telegram bot/server publishes curated news updates to a Telegram channel.

## Current Scope

- Notion board for tickets and agent roles.
- Local project workspace for code and documentation.
- Node.js Telegram sender with preview-first publishing.
- Current handoff/status: `docs/current-status.md`.

## NestJS Module Architecture

<p align="center">
  <a href="docs/assets/nestjs-dependency-graph.svg">
    <img src="docs/assets/nestjs-dependency-graph.svg" alt="Dependency graph of the typed runtime: the composition root, fifteen consumer modules, ten persistence and cross-cutting modules and one database module, connected by every import that exists in the source" width="1200">
  </a>
  <br>
  <sub>Every module, and every import between them. Generated from the source, so it cannot drift.</sub>
</p>

Arrows point from the module that imports to the module it imports. Read a
column as a permission: nothing in persistence may point left, and nothing may
point back into the root. Gold is the composition root wiring; a bus is one
line standing in for many endpoints, drawn that way because
`persistence-facade` reaches all nine persistence modules and every one of
those reaches `DatabaseModule` and nothing else.

<p align="center">
  <a href="docs/assets/nestjs-flow.svg">
    <img src="docs/assets/nestjs-flow.svg" alt="End-to-end flow through the typed runtime: a Telegram command or scheduler tick is admitted, research gathers and deduplicates sources, the editorial pass grounds and writes the article, the draft is approved and published, and every step writes to PostgreSQL, the usage ledger and the Notion audit" width="1200">
  </a>
  <br>
  <sub>One run, end to end. Every arrow is a call that exists in the code &#8212; click for full size.</sub>
</p>

Read it as a single run. The two triggers meet at the same queue, the same
lease and the same publication gate: automatic approval is not a second path,
it is this path with the human tap removed. Amber marks where a run is refused,
or where frozen legacy JS is still reached through a sanctioned gateway; green
marks typed work that costs money.

Two runtimes ship in one image. The legacy JS entrypoint is what production
starts today; the typed NestJS context below is carried in `dist/` and chosen by
`BOT_ENTRYPOINT` in the environment file, not by a compose edit.

The graph is acyclic by rule and checked by `npm run test:architecture`: no
`forwardRef`, no module imported by something it imports.

```text
composition/runtime-entry.ts            boots the standalone context; owns signals and shutdown
  |
  +-- NewsAgentModule                   the composition root -- imports exactly these ten
  |     ai-providers . database . editorial-application . editorial-persistence
  |     operations-application . persistence-facade . scheduler-application
  |     telegram-control-application . telegram-persistence . typed-research-execution
  |
  +-- RuntimeModule                     starts four workers, stops them in reverse order
        telegram-polling -> news-scheduler -> telegram-news-jobs -> runtime-health
```

Everything below hangs off one database module, in four layers. A module may
only depend downwards.

```text
LAYER 3   transport and runtime               src/telegram/transport . src/runtime
              ^
LAYER 2   application                         services and use-cases; ports in,
          catalog . editorial . operations    no pg, no drizzle, no provider SDK,
          research . scheduler . settings     no fetch -- infrastructure arrives
          telegram-control . usage            through injected Symbol tokens
              ^
LAYER 1   persistence, one per table group    typed Drizzle repositories;
          catalog . editorial . operations    repositories never call each other,
          research . scheduler . settings     application services coordinate them
          story-deduplication . telegram . usage
              ^
LAYER 0   DatabaseModule                      PG_POOL . DRIZZLE_DB . DATABASE_LIFECYCLE
                                              one pool, one Drizzle provider, one owner of shutdown
```

The edges that are not simply "layer 2 on its own layer 1" -- these are the
real cross-domain dependencies, and the reason the check exists:

```text
editorial-application        -> editorial + settings + usage persistence, editorial-integration-events
scheduler-application        -> scheduler + editorial + telegram persistence
telegram-control-application -> telegram + editorial persistence, settings-application
research-application         -> research + catalog + usage persistence
persistence-facade           -> all nine persistence modules (the NewsRepository-shaped
                                compatibility surface; persistence only, never application)
publication-milestones       -> database, settings-persistence, editorial-integration-events
```

Research is composed from four modules rather than one, so the paid path stays
separable from the free one:

```text
typed-research-execution  -> source-acquisition -> catalog + usage persistence
                          -> evidence-curation  -> story-deduplication persistence
                          -> research + catalog + story-deduplication + usage persistence
```

Editorial splits for the same reason. The draft gateway has a dependency the
composition root does not own -- the corroboration budget and its thresholds --
so it is composed as a module and handed to `EditorialApplicationModule` as one,
rather than constructed by hand and passed in as a value:

```text
editorial-application     -> legacy-editorial-draft -> evidence-corroboration
```

### The legacy seams

`legacy-*.gateway.ts` plus its module is the only sanctioned way a typed
use-case reaches a legacy JS module. They are listed here because they are the
surface that has to disappear before `src/*.js` can, and not before.

```text
legacy-editorial-draft        -> draft.js . editorial-enrichment.js . article-tags.js . telegram.js
legacy-editorial-publication  -> telegram.js
legacy-notion-audit           -> nothing directly: the gateway takes a finalizer, and the
                                 composition root builds it from notion-audit.js
legacy-research-execution     -> research.js . feed.js . gdelt.js . reddit.js
                                 article-extractor.js . retry.js
                                 (superseded -- the runtime wires typed-research-execution)
```

"Typed" means the orchestration is typed, not that the seam is gone.
`typed-research-execution.gateway.ts` still reaches `feed.js`, `ai-usage.js`,
`excluded-topic-policy.js` and `news-settings.js` -- shared helpers that have
not been ported yet. That is what the gateway is for, and it is also the
measure of how much is left.

Cross-cutting modules that are not persistence slices: `ai-providers` (the
provider-neutral port and its adapters), `editorial-integration-events`,
`publication-milestones`, and `src/telemetry/` (usage-ledger and
provider-attempt writes).

## Telegram Messages

Verify the configured bot and channel:

```bash
npm run telegram:check
```

Preview a message without publishing:

```bash
npm run telegram:send -- --text "AI news update"
```

Publish only through the approved-draft state machine:

```bash
# Direct send is intentionally disabled. Publish an approved draft instead:
npm run drafts -- publish --id <draft-id>
```

Use `--file path/to/message.txt` for longer previews. The command accepts
exactly one of `--text` or `--file`; its former direct `--send` path is disabled
because it had no durable publication claim, receipt, or ambiguous-send
reconciliation.

## Automated News Run

Configure these server-only values in `.env`:

```text
AI_PROVIDER_ORDER=openai,gemini
EXA_ENABLED=false
EXA_API_KEY=
EXA_SEARCH_TYPE=auto
EXA_MODEL=
EXA_DAILY_SEARCH_CAP=20
EXA_MAX_RESULTS=8
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-2026-03-05
OPENAI_REASONING_EFFORT=medium
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
NEWS_EDITOR_KEY=mikhail-onest
NEWS_EDITOR_NAME=Михаил Онест
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATA_SOURCE_ID=8eef7282-532e-4cf9-b309-bf09f9e9afeb
NOTION_PIPELINE_AGENT_PAGE_ID=38bd7885-0eab-81f4-9879-e8b4b990e314
DATABASE_URL=postgresql://telegram_news_app:change-me@localhost:5432/telegram_news
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=@HonestAINews
APPROVAL_POLICY=manual
```

At least one configured provider is required. The default order remains OpenAI
then Gemini. Exa is disabled by default; set `EXA_ENABLED=true`, provide
`EXA_API_KEY`, and use `AI_PROVIDER_ORDER=exa,openai,gemini` to prefer it for
news, feed, and article-detail research. Exa performs retrieval only; structured
generation continues with OpenAI or Gemini because the fallback skips provider
operations that Exa does not implement.
`EXA_DAILY_SEARCH_CAP` is a per-process UTC-day guard, so account-wide quota
monitoring is still required when more than one process or restart can run.
When Exa is configured, a failed or capped Exa detail search does not fall
through to paid OpenAI or Gemini web search. Without Exa, the existing provider
fact-search fallback remains available.

Normal research is feeds-first and does not call a paid web-search tool. The
PostgreSQL source registry starts with 49 verified RSS/Atom feeds across world
news, science, nature, animals, history, culture, technology, society, and AI,
plus the free GDELT DOC index. A run fetches only sources mapped to the selected
topics, deduplicates their articles, and asks the configured AI provider to rank
only those supplied candidates. Candidate ranking and final drafting use
structured generation without web-search tools.

Before drafting, the bot fetches the selected publisher page and grounds the
summary in its extracted text. If a primary publisher blocks extraction, the
pipeline can use that publisher's persisted feed summary. GDELT and
automatically discovered feeds remain reduced-trust web sources until their
direct article text is fetched.

When the `editorial_enrichment` Labs feature is enabled, the editorial pass may
request up to three narrowly scoped missing details for one article. Each Exa
request searches up to five candidate pages in one API call. A second or third
request is possible only after the previous result has been added to a valid
regenerated article. Only an exact Exa highlight from a recognized government,
academic, official, or reputable-news domain is accepted. Every accepted URL
must appear in both the final draft sources and evidence map; otherwise the bot
keeps the last fully grounded version. The same daily Exa cap covers feed, news,
and detail searches.

Paid search is reserved for recovery. If feeds and GDELT provide no recent
candidate, the provider performs one low-context search for official RSS/Atom
endpoints, validates each returned feed by downloading and parsing it, and
saves valid sources in PostgreSQL. A successful topic search has a seven-day
cooldown; a failed or empty search waits 24 hours. Only when that still produces
nothing does the provider perform the one-call direct article-search fallback.
OpenAI failures fall through to Gemini for both recovery paths. Every fallback
and usage event is recorded in the search-run metadata and cost ledger:

```bash
npm run pipeline:run
```

Inspect or manage the database-backed source registry:

```bash
npm run sources -- list
npm run sources -- add --name "Publisher" --feed "https://example.com/feed.xml" --score 80 --primary
npm run sources -- disable --id <source-id>
npm run sources -- enable --id <source-id>
```

The list includes source topics, consecutive failures, and quarantine expiry.
Sources are never deleted automatically. Three consecutive fetch failures
quarantine a source for 24 hours; five quarantine it for seven days. A later
successful fetch clears the quarantine.

Review and publish the resulting draft:

```bash
npm run drafts -- list
npm run drafts -- preview --id <draft-id>
npm run drafts -- approve --id <draft-id>
npm run drafts -- publish --id <draft-id>
```

The pipeline creates and finalizes a Notion `Agent Runs` audit record for every
execution and fails closed if audit logging cannot start. It uses a 15-minute
database lease to prevent overlapping runs.
Publication is idempotent per draft. An uncertain Telegram response leaves the
draft in `publishing` for manual reconciliation instead of retrying blindly.

After independently checking Telegram, reconcile an uncertain publication
without sending another message:

```bash
npm run drafts -- reconcile-sent --id <draft-id> --message-id <telegram-id>
npm run drafts -- reconcile-not-sent --id <draft-id> --confirm TELEGRAM_NOT_SENT
```

The first command records an observed Telegram message. The second returns the
draft to `approved` for a controlled retry and requires exact confirmation.

`APPROVAL_POLICY` remains the default for CLI runs. Telegram-triggered and
scheduled runs use the persisted per-channel setting described below.

## Telegram Admin Control

Apply the PostgreSQL migrations, set `TELEGRAM_UPDATE_MODE=polling`, and run:

```bash
npm run telegram:control
```

Send `/settings` in a private chat with the bot to configure, in order:

1. output language: English, Ukrainian, or German;
2. preset topics plus up to five custom topic labels;
3. review-required or automatic publication;
4. paused, every 1, 3, 6, 12, or 24 hours;
5. the scheduled night pause from 22:00 to 08:00 Europe/Madrid.

The native Telegram inline menu writes a versioned configuration to PostgreSQL;
no public web UI or additional Oracle port is required. Defaults are the broad
topic mix, English, review required, automatic search paused, and the night
pause enabled. Enabling
automatic publication requires a separate confirmation screen. Selecting the
one-hour interval can consume provider search/tool credits quickly. Every menu
change is saved and applied immediately; the home screen and selected-option
checkmarks show the active configuration. Selected topics use Telegram's native
colored inline-button styles. `Apply & close settings` replaces the menu with a
read-only summary of the applied values. Duplicate rapid taps that result in
Telegram's harmless `message is not modified` response are acknowledged instead
of blocking the polling queue. Scheduler timestamps remain stored
as PostgreSQL `timestamptz` values and are displayed in `Europe/Madrid` with
automatic CET/CEST daylight-saving handling.

Send `/news` to run immediately with the saved configuration. The command,
settings actions, and review callbacks recheck that the sender is a current
administrator or creator of `TELEGRAM_CHANNEL_ID`. In review-required mode the
bot creates a 24-hour opaque session bound to the private chat and preview
message. Publish and Reject are atomic decisions; publication retains the
existing idempotency and reconciliation behavior.

Send `/stats` in the same private admin chat to see today's API requests,
input/cached/output/reasoning tokens, web-search calls, estimated list cost, and
the latest published posts with their editor and per-post estimate. Usage is
stored per provider response in PostgreSQL. OpenAI estimates use the checked-in
standard-price snapshot and count web search separately; unsupported provider
prices remain unpriced instead of being guessed. Free data-sharing allowances,
credits, taxes, and account-level adjustments are not exposed per API response,
so the dashboard labels the amount as an estimate rather than the actual bill.
The current source for the snapshot is the official
[OpenAI API pricing page](https://developers.openai.com/api/docs/pricing).

Send `/status` in the private admin chat for an operational panel. PostgreSQL
and Telegram are green when the command itself completes. OpenAI, Gemini, and
Exa are green after a successful recorded call today, yellow when configured
but idle, and gray when disabled. Yellow does not mean broken. The `Test Exa`
button is the only live provider probe in this panel; it consumes exactly one
bounded Exa search, observes the shared daily cap, records a zero-token usage
event, and has a five-minute per-admin cooldown.

Provider attempts are recorded separately from the billing ledger with safe,
redacted operational metadata only. Normal fallback operations make up to
three attempts per configured provider for transient failures, using two
exponential jittered delays within a separate 30-second deadline for each
provider. A provider timeout therefore preserves the next provider's bounded
fallback window instead of exhausting the entire chain before trying the next
configured provider. One-shot structured generation retains its existing
one-call budget. The additive typed NestJS provider composition preserves the
same contract but remains outside the production entrypoint until runtime cutover.

Send `/labs` in the private admin chat to control experimental features without
redeploying the bot. Article tags have three versioned per-channel states:
`Off` keeps the legacy pipeline path, `Collect only` stores up to three
database-backed tag assignments without changing the public draft body, and
`Enabled` also appends the localized hashtags to new drafts. The tag catalogue,
translations, relevance scores, and article relationships are stored in
PostgreSQL; the model can select only enabled catalogue codes and cannot create
public hashtag text. Labs changes apply immediately and `Done & close` removes
the inline keyboard. Story connections are intentionally left as a planned V2
feature until the tag history has been evaluated.

New drafts include a localized editorial credit and store the stable
`NEWS_EDITOR_KEY` plus canonical `NEWS_EDITOR_NAME` in draft/publication metadata.
The default editor is rendered with the fixed pseudonym `Michail Honest` in
English, German, and Ukrainian articles; only the surrounding byline phrase is
localized. A custom configured editor name is rendered unchanged; changing both
environment values later adds a distinct editor identity without rewriting
historical posts.

The embedded scheduler polls for due database rows and atomically claims one
run at a time. It rereads a complete configuration snapshot before each search,
survives restarts, prevents overlapping pipeline executions, and will not
create another manual draft for the channel while an unexpired review is
pending. Before any automatic send, it durably checkpoints the selected draft;
a crash resumes that exact draft instead of researching and publishing another
one. With the night pause enabled, due work is moved to the next 08:00 in
Europe/Madrid. If research crosses 22:00, its draft remains checkpointed and is
resumed after 08:00 without repeating the paid research. The scheduler checks
again immediately before Telegram delivery. An explicit manual `/news` or
Publish action remains available as an operator override. An uncertain Telegram
send pauses recurrence for manual reconciliation.

Polling refuses to start while a webhook URL is configured. For an intentional
migration only, set `TELEGRAM_POLLING_MIGRATE_WEBHOOK=true` for one startup;
pending updates are preserved. Run one polling process. A database lease,
persisted update IDs, bounded jittered retries, and a 30-second shutdown
deadline protect restarts and deployments.

Manual `/news` can run through a durable single-worker queue by setting
`TELEGRAM_NEWS_JOB_MODE=enabled`. The default is `off`, which preserves the
legacy synchronous path. In enabled mode the Telegram update is acknowledged
only after its job is stored under the update claim, so `/stats`, `/settings`,
`/labs`, and review callbacks remain responsive while research runs. PostgreSQL
permits one executing or delivering job, fences every mutation with a claim
token, and stores the checkpointed outcome before Telegram delivery. Delivery
retries never repeat research or channel publication. The existing pipeline
lease still prevents overlap with the scheduler, and a second `/news` request
is durably recorded as already running instead of starting another search.
Enable this flag only after the forward migration and Telegram QA; disabling it
restores the legacy request path without deleting queued-job history.

Notion audit creation is fail-closed. If finalization fails after an operation,
the payload is stored in `notion_audit_outbox`. Retry pending entries with:

```bash
npm run audit:flush
```

Logs and user-facing failures contain stable error codes or generic messages,
not bot tokens, article bodies, or upstream response details.

## Docker and Oracle Deployment

Production runs as two private Docker Compose services on the Oracle instance:
the polling bot (including the database-backed scheduler) and PostgreSQL. The
database has no public host port; its optional `127.0.0.1:55432` binding is
reachable only through SSH. The one-shot `migrate` service applies the
checked-in SQL migrations before each bot update. See the
[read-only DBeaver setup](docs/database-access.md).

The image also carries a compiled NestJS runtime (`dist/`), built in a separate
Docker stage so the TypeScript toolchain never reaches the final image. It is
**carried, not started**: the container command remains `node
src/telegram-bot.js`, and no deployment path passes the `compose.nest.yaml`
overlay that would run the new runtime instead. That overlay exists so the
migration can be exercised against a real database, and so cutover becomes a
reviewed compose change rather than an image rebuild. It needs the same
environment every other compose recipe here does — `POSTGRES_PASSWORD`,
`POSTGRES_APP_PASSWORD` and a `.env.production`:

```bash
docker compose -f compose.yaml -f compose.nest.yaml up -d bot
```

Database changes use SQL migrations as the source of truth and a Drizzle
TypeScript snapshot for typed repository work and CI drift detection. See the
[Drizzle migration roadmap](docs/database-migration.md). Useful commands:

```bash
npm run database:new -- describe_the_change
DATABASE_URL=postgresql://... npm run database:status
DATABASE_URL=postgresql://... npm run database:drift
```

The GitHub Actions workflow in `.github/workflows/deploy.yml` performs this
sequence on every merge to `main`:

1. install dependencies, audit them, and run unit tests;
2. build a clean PostgreSQL database and run integration tests;
3. build immutable `linux/amd64` and `linux/arm64` images and push them to GHCR;
4. connect to Oracle over SSH, run migrations, replace the bot, and verify that
   the new container remains stable;
5. restore the previous bot image if the new container does not stay running.

After every successful production health gate, the deploy script sends one
private Telegram notice to the saved review chat with the package version and
short immutable commit. It verifies that each destination is a private chat,
never sends this notice to the public channel, and stores the notified image in
`.deployment-notification-image` so rerunning the same image does not spam.
Notification failure is visible in deploy logs but does not roll back an
otherwise healthy release.

Production runtime configuration is committed only as the SOPS-encrypted
`secrets/production.env.sops` file. The private `age` key is stored outside Git
and in the protected GitHub `production` environment. Edit and validate the
encrypted file without creating persistent plaintext:

The encrypted file is the single source for PostgreSQL, Telegram, OpenAI,
Gemini, Exa, and Notion runtime credentials. Production validation rejects
placeholder values before any deployment bundle is uploaded to Oracle.

```bash
brew install sops age
npm run secrets:edit:production
npm run secrets:validate:production
```

Commit the encrypted file through a normal pull request. After merge, GitHub
Actions decrypts it in runner-temporary storage, appends the separately stored
OpenAI and Exa keys, validates the assembled environment, and deploys it to
Oracle. See [`docs/oracle-deployment.md`](docs/oracle-deployment.md) for key
backup, explicit decrypt/re-encrypt commands, rollback, and the full lifecycle.

Server bootstrap and GitHub configuration are documented in
[`docs/oracle-deployment.md`](docs/oracle-deployment.md). Do not open a public
port for PostgreSQL or the polling bot.

## Workflow

```text
Inbox -> Ready -> In Progress -> Review -> Blocked / Done -> Archive
```

## Agent Roles

- Orchestrator: owns the goal, board, task breakdown, and agent handoffs.
- Planner: turns rough ideas into requirements and executable tickets.
- Researcher: gathers current docs, constraints, and technical options.
- Builder: implements scoped code/configuration tasks.
- Reviewer: reviews changes for defects, risks, security, and tests.
- QA: verifies behavior against acceptance criteria.
- Ops: handles deployment, environment variables, hosting, CI, and monitoring.
- Documentation: keeps README, runbooks, specs, and decisions current.

## Cost-Aware Codex Orchestration

Project-scoped Codex configuration keeps GPT-5.6 Sol as the primary
Orchestrator and routes bounded work to less expensive specialist models. Sol
retains the complete ticket, risk, authority, and integration context. A worker
receives only the objective, constraints, file/tool/output budget, acceptance
criteria, and Notion ticket plus Agent Run IDs needed for its slice.

| Work | Default role and model |
| --- | --- |
| Requirements, decomposition, integration, and final decisions | Orchestrator: GPT-5.6 Sol, high reasoning |
| Bounded code mapping, routine implementation, and targeted QA | Code Explorer / Builder / QA: GPT-5.3-Codex Spark, medium reasoning |
| Narrow research and grounded documentation | Researcher / Documentation: GPT-5.6 Luna, medium reasoning |
| Routine independent review or Spark fallback integration | Reviewer / Integration Builder: GPT-5.6 Terra |
| Architecture, security, PostgreSQL atomicity, exact-head review, and authorized operations | Critical Reviewer / Ops: GPT-5.6 Sol, high reasoning |

The Orchestrator decides the route before loading specialist skills, querying
Graphify, or reading implementation files. At most two disjoint workers run at
once. Every delegated task is audited before spawn, and actual model metadata
comes from the launcher rather than worker self-report. An unavailable Spark
role can use the registered Terra fallback only after Sol records the reason and
confirms the same scope, risk, and authority boundaries; otherwise the task
stops. Delegation also stops unless either Notion or the documented local
fallback has recorded its audit payload.

This routing controls the engineering agents that maintain the repository. It
does not change the production news pipeline, whose provider order and models
remain controlled by the environment settings documented above.

## Security Rules

- Never commit API keys, bot tokens, private keys, or secrets.
- Store runtime secrets in environment variables.
- Use `.env.example` to document required variables.
- Keep real `.env` files ignored by git.

## Notion Links

- Hub: https://app.notion.com/p/38bd78850eab810ca73de57f1fbbcc1e
- Tickets: https://app.notion.com/p/8e0e1e80d85b4f3794e859be8c2dfeee
- Agent Registry: https://app.notion.com/p/339d95a5ab0d4c4898a41382615870da
- Operating Manual: https://app.notion.com/p/38bd78850eab812f8bf1e8bbe168371d

## Next Steps

1. Finish the remaining NestJS and Drizzle vertical slices while preserving PostgreSQL atomicity.
2. Pass clean-database, emitted-build, Docker-smoke, shutdown, and rollback gates before entrypoint cutover.
3. Add digest-level runtime attestation and complete a documented production rollback drill.
4. Continue source-quality, editorial-quality, and provider-cost tuning from measured production data.

For the verified snapshot and release evidence, see [docs/current-status.md](docs/current-status.md).

# Agent Ops News Channel

Agent-operated project workspace for building a Telegram news channel bot and the delivery system around it.

## Goal

Build a minimal workflow where ideas become tickets, agents execute scoped tasks, and a Telegram bot/server publishes curated news updates to a Telegram channel.

## Current Scope

- Notion board for tickets and agent roles.
- Local project workspace for code and documentation.
- Node.js Telegram sender with preview-first publishing.
- Current handoff/status: `docs/current-status.md`.

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
news/feed searches while keeping structured generation on OpenAI or Gemini.
`EXA_DAILY_SEARCH_CAP` is a per-process UTC-day guard, so account-wide quota
monitoring is still required when more than one process or restart can run.

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

New drafts include a localized editorial credit for `NEWS_EDITOR_NAME` and store
the stable `NEWS_EDITOR_KEY` in draft/publication metadata. The defaults identify
the first editor as `Михаил Онест`; changing both environment values later adds
a distinct editor identity without rewriting historical posts.

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

1. Configure the local PostgreSQL connection and at least one AI provider key.
2. Complete five supervised research-to-publish runs.
3. Configure `/settings`, leave review-required mode enabled, and exercise each
   language/topic combination needed for the channel.
4. Add deployment monitoring and alerts before enabling unattended publishing.

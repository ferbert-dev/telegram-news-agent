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

Publish after reviewing the preview:

```bash
npm run telegram:send -- --text "AI news update" --send
```

Use `--file path/to/message.txt` for longer messages and `--silent` to disable
subscriber notifications. The command accepts exactly one of `--text` or
`--file`.

## Automated News Run

Configure these server-only values in `.env`:

```text
AI_PROVIDER_ORDER=openai,gemini
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-2026-03-05
OPENAI_REASONING_EFFORT=medium
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATA_SOURCE_ID=8eef7282-532e-4cf9-b309-bf09f9e9afeb
NOTION_PIPELINE_AGENT_PAGE_ID=38bd7885-0eab-81f4-9879-e8b4b990e314
DATABASE_URL=postgresql://telegram_news_app:change-me@localhost:5432/telegram_news
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=@HonestAINews
APPROVAL_POLICY=manual
```

At least one of `OPENAI_API_KEY` or `GEMINI_API_KEY` is required. The default
order uses `gpt-5.4-2026-03-05` first and Gemini second. A missing key is
skipped, and an OpenAI authentication, quota, rate-limit, or response error
falls through to Gemini. OpenAI requests use medium reasoning for reliable
agentic web search, require the search tool, and explicitly enable live public
internet access without an allowed-domain filter.

Every research run combines approved RSS feeds with live provider web search
across the public internet. Direct results from newsrooms, research sites, and
company pages are ranked with the feed candidates. Before drafting, the bot
fetches the selected web article and grounds the summary in the extracted page;
if a publisher blocks automated extraction, it can use the provider's
web-grounded summary with an explicit caveat and reduced evidence level. If an
approved primary page blocks extraction, the pipeline can still draft from
that publisher's persisted RSS summary. Every fallback is recorded in the
search-run metadata:

```bash
npm run pipeline:run
```

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

Keep `APPROVAL_POLICY=manual` during supervised QA. With `automatic`, the same
audited command approves and publishes the generated draft; this must not be
enabled until the five supervised runs pass.

## Telegram Admin Control

Apply the PostgreSQL migrations, set `TELEGRAM_UPDATE_MODE=polling`, and run:

```bash
npm run telegram:control
```

Send `/news` in a private chat with the bot. The command and every callback
recheck that the sender is a current administrator or creator of
`TELEGRAM_CHANNEL_ID`. The bot creates a 24-hour opaque review session bound to
the private chat and preview message. Publish and Reject are atomic decisions;
publication occurs only after Publish and retains the existing idempotency and
reconciliation behavior.

Polling refuses to start while a webhook URL is configured. For an intentional
migration only, set `TELEGRAM_POLLING_MIGRATE_WEBHOOK=true` for one startup;
pending updates are preserved. Run one polling process. A database lease,
persisted update IDs, bounded jittered retries, and a 30-second shutdown
deadline protect restarts and deployments.

Notion audit creation is fail-closed. If finalization fails after an operation,
the payload is stored in `notion_audit_outbox`. Retry pending entries with:

```bash
npm run audit:flush
```

Logs and user-facing failures contain stable error codes or generic messages,
not bot tokens, article bodies, or upstream response details.

## Docker and Oracle Deployment

Production runs as two private Docker Compose services on the Oracle instance:
the polling bot and PostgreSQL. The database has no published host port. The
one-shot `migrate` service applies the checked-in SQL migrations before each bot
update.

The GitHub Actions workflow in `.github/workflows/deploy.yml` performs this
sequence on every merge to `main`:

1. install dependencies, audit them, and run unit tests;
2. build a clean PostgreSQL database and run integration tests;
3. build an immutable `linux/amd64` image and push it to GHCR;
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
3. Add the recurring scheduler after those QA runs pass.
4. Add deployment monitoring and alerts.

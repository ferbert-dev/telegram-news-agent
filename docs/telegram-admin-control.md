# Telegram Admin Control Runbook

## Configuration

Required server-only variables:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
TELEGRAM_UPDATE_MODE=polling
TELEGRAM_POLLING_MIGRATE_WEBHOOK=false
DATABASE_URL=postgresql://telegram_news_app:<password>@localhost:5432/telegram_news
GEMINI_API_KEY=
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATA_SOURCE_ID=
NOTION_PIPELINE_AGENT_PAGE_ID=
NOTION_PIPELINE_TICKET_PAGE_ID=
```

Run `npm run database:migrate` before starting the process. In Docker, the
one-shot `migrate` service performs this step before the bot is replaced.

## Operation

Start one process with `npm run telegram:control`. Startup checks the current
webhook. It refuses coexistence by default. To migrate intentionally, set
`TELEGRAM_POLLING_MIGRATE_WEBHOOK=true` for one startup and reset it to false
after the webhook has been removed. Pending updates are not dropped.

`SIGINT` and `SIGTERM` stop the active long poll and release the database lease.
The process has a 30-second hard deadline.

Run `npm run audit:flush` periodically and alert when undelivered
`notion_audit_outbox` rows age beyond the normal Notion recovery window.

## Recovery

An uncertain channel send leaves the draft in `publishing`. Do not tap Publish
again or reset state without checking Telegram. Use the existing commands:

```bash
npm run drafts -- reconcile-sent --id <draft-id> --message-id <telegram-id>
npm run drafts -- reconcile-not-sent --id <draft-id> --confirm TELEGRAM_NOT_SENT
```

## Supervised QA

Before production use, verify:

1. Admin `/news`, Reject, and Publish in a private chat.
2. Group chat, member, missing sender, and malformed command denials.
3. Revoked administrator callback denial.
4. Wrong message/chat, expired session, double Publish, and Publish/Reject race.
5. Restart redelivery, webhook conflict, `409` polling conflict, and shutdown.
6. Notion start failure and finalization outbox recovery.

Live Telegram QA, database migration execution, Reviewer approval, and QA
approval remain release gates and must be recorded in Notion before merge.

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

The same process runs the persistent news scheduler. Send `/settings` in a
private admin chat to choose language, preset/custom topics, publishing policy,
and frequency. The choices are stored in `news_bot_settings`, and every manual
or scheduled run reads one complete versioned snapshot before research begins.
The safe default is English + broad topics + review required + paused.
Every menu choice is persisted immediately. The menu shows a saved/active
status and marks the currently selected interval; there is no separate batch
of unsaved settings. `next_run_at` remains a PostgreSQL `timestamptz`, while
the Telegram UI displays it in `Europe/Madrid` with CET/CEST applied by date.

Send `/labs` in the same private admin chat to manage versioned experimental
features. `Article tags` supports `Off`, `Collect only`, and `Enabled`. Collect
mode asks the existing structured draft request to choose up to three enabled
PostgreSQL tag codes and persists the article-topic relationships, but leaves
the public draft text unchanged. Enabled mode additionally renders the
localized database-owned hashtags. Off mode does not load the catalogue or
write tag assignments. The Labs menu applies each change immediately, uses
optimistic version fencing for stale callbacks, and can be closed with
`Done & close`. Story connections are displayed only as a planned V2 feature.

Frequency choices are paused, 1 hour, 6 hours, 12 hours, and 24 hours. A due row
is claimed atomically in PostgreSQL, so a process restart or a second transient
worker does not create a parallel run. The selected draft and publication
receipt are checkpointed under that claim, so stale-claim recovery resumes the
same occurrence. In manual mode, an existing unexpired review for the channel
prevents the scheduler from creating another draft. Custom topic input
is accepted only as a private ForceReply response to the exact expiring prompt;
labels are limited to 2-80 characters, five custom topics, and twelve topics in
total.

Automatic publication is intentionally a two-step setting. Once confirmed, a
successful scheduled run publishes directly to `TELEGRAM_CHANNEL_ID` and sends
a receipt to the saved private review chat. Pause the schedule before changing
credentials or investigating provider cost. If Telegram's send result is
ambiguous, the bot pauses the interval automatically and requires publication
reconciliation before the interval can safely be enabled again.

Run `npm run audit:flush` periodically and alert when undelivered
`notion_audit_outbox` rows age beyond the normal Notion recovery window.

## Recovery

An uncertain channel send leaves the draft in `publishing`. Do not tap Publish
again or reset state without checking Telegram. Use the existing commands:

```bash
npm run drafts -- reconcile-sent --id <draft-id> --message-id <telegram-id>
npm run drafts -- reconcile-not-sent --id <draft-id> --confirm TELEGRAM_NOT_SENT
```

After either reconciliation command, re-enable the interval in `/settings`.
A confirmed not-sent draft is retried from the saved occurrence; a confirmed
sent draft is completed from its stored publication receipt without resending.

## Supervised QA

Before production use, verify:

1. Admin `/news`, `/settings`, `/labs`, Reject, and Publish in a private chat.
2. Group chat, member, missing sender, and malformed command denials.
3. Revoked administrator callback denial.
4. Wrong message/chat, expired session, double Publish, and Publish/Reject race.
5. Restart redelivery, webhook conflict, `409` polling conflict, and shutdown.
6. Notion start failure and finalization outbox recovery.
7. EN/UK/DE output, topic add/remove, custom-topic expiry, stale settings
   callbacks, each interval, restart recovery, and auto-publish confirmation.
8. Article-tag Off/Collect/Enabled behavior, stale Labs callbacks, localized
   hashtags, and rejection of model-created tag codes.

Live Telegram QA, database migration execution, Reviewer approval, and QA
approval remain release gates and must be recorded in Notion before merge.

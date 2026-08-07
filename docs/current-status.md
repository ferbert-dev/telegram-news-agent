# Current Status

Last updated: 2026-08-07

## Project

- Local path: `/Users/ferbertigo/Development/VSCode/telegram-news-agent`
- GitHub remote: `git@github.com:ferbert-dev/telegram-news-agent.git`
- Main branch was pushed successfully.
- Last confirmed pushed commit: `96605f7 Initial agent ops project scaffold`

## What Exists

- Local project documentation and ticket structure.
- Notion project infrastructure was created in an earlier Codex thread:
  - Hub: https://app.notion.com/p/38bd78850eab810ca73de57f1fbbcc1e
  - Tickets: https://app.notion.com/p/8e0e1e80d85b4f3794e859be8c2dfeee
  - Agent Registry: https://app.notion.com/p/339d95a5ab0d4c4898a41382615870da
  - Agent Runs: https://app.notion.com/p/d9886d9543ed4a9f8d547748c80c5f7e
  - Operating Manual: https://app.notion.com/p/38bd78850eab812f8bf1e8bbe168371d
- Agent roles are documented in `agents/roles.md`.
- Operating flow is documented in `docs/agent-operating-manual.md`.
- First ticket exists at `tickets/0001-bootstrap-telegram-news-channel.md`.
- Detailed handoff from the archived thread is in `docs/thread-handoff-2026-06-26.md`.
- Telegram posting works through `@mhonest_bot` to `@HonestAINews`.
- The former Supabase project endpoint no longer resolves as of 2026-08-07, so
  its historical rows could not be exported during the Oracle migration:
  - Project ref: `ppoftyveyugcosskjidq`
  - Region: `eu-central-2`
  - API URL: `https://ppoftyveyugcosskjidq.supabase.co`
- PostgreSQL now runs privately in Docker on Oracle and contains the content
  memory schema for sources, topics, search runs, articles, raw content,
  drafts, and published-post records.
- Four approved primary-source RSS feeds are seeded by migration: OpenAI,
  Google DeepMind, Google AI, and Microsoft Research.
- The Node runtime now supports source management, 48-hour research and
  ranking, grounded Gemini draft generation, explicit approval, and idempotent
  Telegram publication.
- The production database has atomic draft workflow functions and an expiring
  pipeline lease to prevent concurrent scheduled runs.
- Live research verification succeeded on 2026-06-27:
  - Search run: `95697a93-14ae-414c-ab56-9024e664bde1`
  - Four candidates persisted.
  - Top candidate: `Previewing GPT-5.6 Sol: a next-generation model`.
- Live primary-page extraction verification succeeded on 2026-06-27:
  - Search run: `31d3f6e0-c344-4309-ae18-56a5e6356a82`
  - Three candidates persisted.
  - The highest extractable primary source was a Microsoft Research article.
  - 7,792 characters of article evidence were extracted and persisted.
  - One extraction failure was recorded before ranked fallback succeeded.
- Supervised workflow run 1 reached the manual approval gate:
  - Search run: `4e7fb3f1-07cf-437b-8274-d2888aa42523`
  - Article: `3741ad25-6b95-45b7-ace6-8669689636a4`
  - Draft: `80958e54-d1c2-4973-bac2-d3ad44653160`
  - Supabase verification: search `completed`, article `drafted`, draft
    `review`, primary evidence persisted, publication records `0`.
  - User approval received and publication completed.
  - Telegram channel: `@HonestAINews`
  - Telegram message: `6`
  - Publication: `fa8ecd48-07b7-4c6c-9956-ef01682f1030`
  - Final states: article `published`, draft `published`, exactly one
    publication record.
  - Idempotency retry returned the existing receipt without calling Telegram.

## Current Goal

Build a modern, extendable Telegram news bot MVP.

Target workflow:

```text
Scheduled routine
  -> research recent AI/news trends
  -> collect source items
  -> synthesize a short human-readable article
  -> publish to Telegram
  -> log agent/task run status
```

## Pending Work

1. Use the operating loop in `docs/agent-operating-manual.md` for every new task.
2. Add the local PostgreSQL `DATABASE_URL` to `.env`. Never commit database
   credentials.
3. Add `GEMINI_API_KEY` to local `.env`.
4. Add the Notion HTTP integration values `NOTION_API_KEY`,
   `NOTION_AGENT_RUNS_DATA_SOURCE_ID`, and `NOTION_PIPELINE_AGENT_PAGE_ID`.
5. Run `npm run pipeline:run`, review the generated draft, and publish it with
   the `drafts` CLI.
6. Complete five supervised end-to-end QA runs before enabling recurrence.
7. Open a pull request for the implementation and have a Reviewer agent review it.
6. Keep `.env.example` variables current:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
GEMINI_API_KEY=
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATA_SOURCE_ID=8eef7282-532e-4cf9-b309-bf09f9e9afeb
NOTION_PIPELINE_AGENT_PAGE_ID=38bd7885-0eab-81f4-9879-e8b4b990e314
DATABASE_URL=postgresql://telegram_news_app:<password>@localhost:5432/telegram_news
```

7. Keep the explicit draft approval command as the review gate.
8. Add a recurring scheduler only after supervised QA.
9. Add a minimal run logger that writes to console first and Notion later.
10. After each completed task, run the Orchestrator Next-Step Loop and create/update the next Notion ticket.

## Completed Since Handoff

- Created the Notion `Agent Runs` database under the Agent Ops hub.
- Added run-log fields: `Name`, `Task / Ticket`, `Agent`, `Status`, `Started At`, `Finished At`, `Duration`, `Result`, `Links`, and `Error`.
- Connected `Task / Ticket` to the existing `Tickets` database and `Agent` to the existing `Agent Registry` database.
- Added the first successful setup run entry in `Agent Runs`.
- Added an operating loop that requires a dedicated branch, pull request, Reviewer agent review, and Orchestrator next-step prompt after every task.
- Added a mandatory audit rule requiring every agent invocation to create an
  `Agent Runs` entry at start and finalize it on success, failure, blockage, or
  cancellation.
- Added fail-closed Notion HTTP audit logging to automated pipeline, research,
  source-registry, draft-review, approval, rejection, and publication commands.
- Added bounded primary-page HTML extraction with ranked fallback. Drafting now
  uses persisted first-party article text instead of RSS summaries.
- Added explicit `APPROVAL_POLICY`: `manual` stops at review, while
  `automatic` approves and publishes within the same audited run. Manual stays
  configured until five supervised QA runs pass.
- Reviewer pass found and fixed a canonical-URL idempotency defect. Production
  now uses atomic insert-if-new semantics and enforces one active draft per
  article. Live duplicate verification inserted zero rows, preserved article
  status `drafted`, and preserved exactly one active draft.
- Follow-up recovery hardening allows only `discovered` articles to resume
  after extraction or generation failure. Production verification returned the
  existing discovered row for retry, ignored the published row, and retained
  exactly one database row for each canonical URL.
- Publication recovery now has explicit operator-confirmed paths for a
  Telegram message confirmed sent or confirmed not sent. Neither reconciliation
  path sends a message. Production verification rejected reopening an already
  published draft.
- Added and verified preview-first Telegram message publishing.
- Created the dedicated Supabase project at `$0/month`.
- Applied and verified the initial content-memory schema with RLS enabled and
  anonymous/authenticated access revoked.
- Added local SQL migrations under `db/migrations/`.
- Added URL/hash deduplication, primary-source ranking, structured grounded
  drafts, and persistent raw RSS evidence.
- Added atomic approve, reject, claim, and publication-finalization functions.
- Added a single-run orchestrator that stops at review and uses a recoverable
  database lease.
- Added 25 passing automated tests.

## Notion Connector Note

In the current Codex thread, the Notion connector became callable after tool discovery. Confirmed working operations include:

```text
notion.search
notion.fetch
notion.notion-create-pages
notion.notion-update-page
notion.notion-create-database
notion.notion-create-view
```

`notion.notion-query-data-sources` is visible, but the workspace currently blocks it behind a Notion Business plan / Notion AI requirement. Use direct `fetch`, `search`, `create`, and `update` operations unless querying is upgraded.

For the next chat, start with:

```text
Use Notion. Open docs/current-status.md first, then continue from the Agent Ops Hub.
```

## Current Git Working Tree

At the time this file was created, there were uncommitted documentation changes:

```text
M tickets/0001-bootstrap-telegram-news-channel.md
?? docs/thread-handoff-2026-06-26.md
?? docs/current-status.md
```

These changes are intentional handoff/status updates.

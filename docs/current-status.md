# Current Status

Last updated: 2026-08-09

## Project

- Primary local path: `/Users/ferbertigo/Development/VSCode/telegram-news-agent`
- Engineering-workflow worktree: `/Users/ferbertigo/Development/VSCode/telegram-news-agent-workflow`
- GitHub remote: `git@github.com:ferbert-dev/telegram-news-agent.git`
- `main` is at `68a4020` after PR #27 and is deployed through the checked-in
  GitHub Actions workflow.
- Active engineering setup branch: `codex/project-engineering-workflow`.
- Active Epic: [Engineer Telegram News Agent into a modular NestJS platform](https://app.notion.com/p/3b7d78850eab81348bcbec541f1c23bb).
- Migration implementation is paused until the reviewed blueprint and executable
  PostgreSQL contract gate are complete.

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
- The PostgreSQL registry is seeded with 49 topic-mapped RSS/Atom feeds and one
  GDELT API source across the full preset topic catalogue.
- The Node runtime now supports source management, 48-hour research and
  ranking, GPT-5.4 generation and web search with Gemini fallback, explicit
  approval, and idempotent Telegram publication.
- Private admin `/settings` controls English/Ukrainian/German output, a broad
  preset/custom topic mix, review-required versus automatic publication, and a
  paused/1h/3h/6h/12h/24h database-backed schedule. It also controls an enabled-by-
  default scheduled night pause from 22:00 to 08:00 Europe/Madrid. Due work is
  deferred to 08:00, and a draft completed after 22:00 is checkpointed for
  morning recovery without repeating research. Safe defaults remain broad,
  English, manual review, paused scheduling, and night pause enabled.
- Private admin `/labs` controls experimental, per-channel feature flags. The
  first V1 flag classifies articles against a PostgreSQL tag catalogue in
  Off/Collect/Enabled modes; story connections remain disabled pending tag
  quality evaluation.
- Normal runs use RSS/Atom and GDELT first, then perform tool-free AI candidate
  curation. Provider web search runs only when the free layer is empty: it first
  finds and validates reusable RSS sources for PostgreSQL, then uses a bounded
  article-search fallback only if source discovery still yields nothing.
- Repeated source failures are recorded without storing raw provider errors.
  Sources enter a 24-hour quarantine after three failures and a seven-day
  quarantine after five; they are not deleted automatically.
- When an approved publisher blocks primary-page extraction, the pipeline can
  use its already-persisted RSS summary as reduced first-party evidence instead
  of failing before draft generation.
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
  -> read the versioned channel configuration
  -> research recent configured topics across the public web
  -> collect source items
  -> synthesize a short human-readable article
  -> publish to Telegram
  -> log agent/task run status
```

## Pending Work

1. Merge the engineering-workflow setup after independent closure review.
2. Execute the PostgreSQL contract ticket on a disposable PostgreSQL 17 database.
3. Complete and review `DatabaseModule` before resuming repository slices.
4. Follow the ordered dependency graph in
   `docs/nestjs-drizzle-migration-blueprint.md`; do not begin a blocked slice.
5. Keep `.env.example` variables current:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
AI_PROVIDER_ORDER=openai,gemini
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-2026-03-05
OPENAI_REASONING_EFFORT=medium
GEMINI_API_KEY=
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATA_SOURCE_ID=8eef7282-532e-4cf9-b309-bf09f9e9afeb
NOTION_PIPELINE_AGENT_PAGE_ID=38bd7885-0eab-81f4-9879-e8b4b990e314
DATABASE_URL=postgresql://telegram_news_app:<password>@localhost:5432/telegram_news
```

6. Keep review-required mode as the default gate.
7. Add deployment monitoring and cost alerts before using the one-hour interval.
8. After each completed task, run the Orchestrator Next-Step Loop and create or
   update the next Notion ticket.

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

Single-data-source Notion queries are currently available with a plan limit.
Use them for bounded audits and use direct `fetch`, `search`, `create`, and
`update` operations when the limit is reached. Cross-data-source SQL may still
require a higher plan.

For the next chat, start with:

```text
Use Notion. Open docs/current-status.md first, then continue from the Agent Ops Hub.
```

## Historical Git Working Tree Snapshot

At the time this file was created, there were uncommitted documentation changes:

```text
M tickets/0001-bootstrap-telegram-news-channel.md
?? docs/thread-handoff-2026-06-26.md
?? docs/current-status.md
```

These changes are intentional handoff/status updates.

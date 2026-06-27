# Thread Handoff: Telegram News Agent MVP

## Source

- Codex thread: `019f04a9-46fb-78d0-acd7-dd1efa03b65e`
- Local transcript: `/Users/ferbertigo/.codex/sessions/2026/06/26/rollout-2026-06-26T18-00-30-019f04a9-46fb-78d0-acd7-dd1efa03b65e.jsonl`
- Project path: `/Users/ferbertigo/Development/VSCode/telegram-news-agent`
- GitHub remote: `git@github.com:ferbert-dev/telegram-news-agent.git`
- Last confirmed commit at handoff time: `96605f7 Initial agent ops project scaffold`

## Current Goal

Build a working, modern, extendable Telegram news bot MVP that can publish AI/news updates to a Telegram channel through an agent-operated workflow.

The system should support this flow:

```text
Scheduled routine
  -> research recent AI/news trends
  -> collect source items
  -> synthesize a short human-readable article
  -> publish to Telegram
  -> log agent/task run status
```

## User Intent From Previous Thread

The user wants the first real implementation cycle to start from `tickets/0001-bootstrap-telegram-news-channel.md`.

Main requirements captured from the previous chat:

- Create an MVP Telegram bot that can post messages to a Telegram channel.
- Keep integration with Codex/OpenAI straightforward so the agent can later research, write, and publish scheduled content.
- Support scheduled routines for recurring news posts.
- Focus initial content on recent AI trends/news.
- Make the output look like a short article written by a human, not raw scraped links.
- Initialize the agent system so the orchestrator can keep work aligned with the product goal.
- Keep the bot modern, cleanly written, and easy to extend.
- Add a Notion database/table for run logs, tentatively named `Agent Runs`.
- Log when an agent starts a task and when it completes it.

## Product Direction

The project is not only a Telegram bot. It is an agent-operated delivery system around a Telegram news channel.

Long-term shape:

```text
Notion = planning, tickets, run logs
GitHub = code, commits, reviews
Codex agents = planning, implementation, review, QA, ops
Telegram = publishing surface
```

## Decisions Already Made

- Notion is preferred over Jira for the first board because it is lighter and better for requirements/specs.
- GitHub remains the source-of-truth for code.
- Agent roles are documented in `agents/roles.md`.
- Minimal board workflow is:

```text
Inbox -> Ready -> In Progress -> Review -> Blocked / Done -> Archive
```

- Local development should prefer Telegram polling unless production deployment needs webhooks immediately.
- Secrets must stay out of Git. Use environment variables and `.env.example`.
- SSH access to GitHub was confirmed and the repository was pushed.

## MVP Scope

The next implementation should create the smallest useful bot system:

1. Project runtime scaffold.
2. Telegram bot skeleton.
3. Configuration loading from environment variables.
4. Safe command or script for posting a test message.
5. Scheduler entrypoint for recurring posts.
6. Content pipeline stub that can later call web research/OpenAI.
7. Agent run logging interface.
8. Documentation for local setup and required secrets.

## Required Environment Variables

Expected variables for the first MVP:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
OPENAI_API_KEY=
NOTION_API_KEY=
NOTION_AGENT_RUNS_DATABASE_ID=
```

`OPENAI_API_KEY` and Notion variables may remain unused in the earliest bot-only slice, but should be part of the planned integration.

## Pending Notion Work

Create or connect a Notion database named `Agent Runs` with fields similar to:

```text
Name
Task / Ticket
Agent
Status
Started At
Finished At
Duration
Result
Links
Error
```

Suggested statuses:

```text
Queued
Running
Succeeded
Failed
Blocked
Cancelled
```

## Immediate Next Steps

1. Update ticket `0001` so it represents the MVP implementation, not only planning.
2. Choose stack and packages.
3. Scaffold the bot runtime.
4. Add `.env.example` variables for Telegram, OpenAI, and Notion.
5. Implement a dry-run/test-post path before any unattended publishing.
6. Add the scheduler behind an explicit command or flag.
7. Add a minimal run logger that can write to console first and Notion later.

## Important Transcript Excerpt

User request from the previous thread:

```text
Нам нужен Telegram-бот, который будет постить сообщения... я конфигурирую рутину,
scheduled рутину здесь, чтобы ты пошел в интернет, нашел какие-то новости,
новые последние тренды относительно AI, собрал это всё воедино в маленькую статью,
написанную человеком, и запостил ее в Telegram.
```

Follow-up requirement:

```text
Нам сейчас нужно создать нашу систему, ее инициализировать, чтобы наши все агенты работали...
оркестратор всегда следовал цели, что нам нужен рабочий классный Telegram-бот,
современный, на классных технологиях, очень аккуратно написан с помощью лучших практик
и возможностью его дальнейшего расширения. Давай сейчас сделаем MVP.
```

Logging requirement:

```text
Создай еще в Notion одну таблицу, там, где будет лог, чтобы я видел,
когда каждый бот начал работу над каким-то заданием,
когда он закончил работу над каким-то заданием.
```

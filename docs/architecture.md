# Architecture

## Initial System

```text
Telegram channel
  <- Telegram Bot API
  <- Bot server
  <- Content pipeline
  <- News sources / curated input
```

## Components

### Bot Server

Receives commands or scheduled jobs, prepares channel posts, and sends messages through Telegram Bot API.

### Content Pipeline

Collects, normalizes, summarizes, and formats candidate news items.

### Scheduler

Runs recurring publishing jobs. For the first prototype this can be a simple local interval or cron job.

### Review Gate

Optional manual approval step before publishing. This should be designed before enabling unattended posting.

## First Technical Decision

Use polling for local development unless deployment requires webhook behavior immediately.

Polling is simpler to run locally. Webhooks are better for production because Telegram pushes updates to the server.


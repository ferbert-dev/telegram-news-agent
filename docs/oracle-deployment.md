# Oracle Docker deployment

## Architecture

GitHub Actions is the only deployment entry point. A merge to `main` runs the
test suite, publishes an immutable image to GitHub Container Registry, and then
deploys that exact image over SSH. Oracle stores the PostgreSQL volume and runs
the bot; it does not build application images.

The Telegram bot uses long polling, so neither the bot nor PostgreSQL needs an
inbound internet port. Only SSH is required for this deployment design.

A checked-in migration seeds the four approved primary RSS sources: OpenAI
News, Google DeepMind, Google AI, and Microsoft Research. Each feed was live
and parseable when this deployment was prepared. Every news run also performs
live provider web search across the public internet; those feeds are supporting
signals rather than a web-search domain allowlist.

## One-time Oracle bootstrap

Copy `ops/bootstrap-oracle.sh` to the instance and run it once:

```bash
sudo bash bootstrap-oracle.sh
```

The script installs Docker Engine and Compose from Docker's official Ubuntu
repository, enables Docker, adds the SSH user to the `docker` group, creates a
2 GB swap file for the 1 GB instance, and prepares
`/opt/telegram-news-agent`. Reconnect over SSH after it finishes.

Do not run the bootstrap script again as part of each deployment. Do not expose
ports `5432` or `55432` in the Oracle security list.

## GitHub production configuration

Create a GitHub environment named `production`. Configure these repository or
environment values:

Variables:

- `ORACLE_HOST`: the instance public IP or DNS name.
- `ORACLE_USER`: the non-root SSH account, normally `ubuntu`.

Secrets:

- `ORACLE_SSH_PRIVATE_KEY`: a dedicated private deployment key.
- `ORACLE_KNOWN_HOSTS`: the verified SSH host-key line for Oracle.
- `PRODUCTION_ENV_FILE`: the complete runtime environment file described below.
- `OPENAI_API_KEY`: store this as an environment secret in the GitHub
  `production` environment. Only the deploy job can read it.

Use a dedicated deployment key rather than a personal interactive SSH key. Add
only its public half to the Oracle user's `~/.ssh/authorized_keys`.

## Production environment file

Store this complete file as the multiline `PRODUCTION_ENV_FILE` GitHub secret:

```dotenv
POSTGRES_PASSWORD=<random-hex-value>
POSTGRES_APP_PASSWORD=<different-random-hex-value>
TELEGRAM_BOT_TOKEN=<secret>
TELEGRAM_CHANNEL_ID=<channel-id-or-handle>
TELEGRAM_UPDATE_MODE=polling
TELEGRAM_POLLING_MIGRATE_WEBHOOK=false
APPROVAL_POLICY=manual
AI_PROVIDER_ORDER=openai,gemini
OPENAI_MODEL=gpt-5.4-2026-03-05
OPENAI_REASONING_EFFORT=medium
GEMINI_API_KEY=<secret>
GEMINI_MODEL=gemini-2.5-flash
NOTION_API_KEY=<secret>
NOTION_AGENT_RUNS_DATA_SOURCE_ID=<id>
NOTION_PIPELINE_AGENT_PAGE_ID=<id>
NOTION_PIPELINE_TICKET_PAGE_ID=
```

The deploy job appends the separately stored `OPENAI_API_KEY` environment
secret to this file immediately before uploading the deployment bundle. With
the order above, OpenAI GPT-5.4 is primary and Gemini is the fallback. Keep
provider keys only in GitHub secrets, never in the repository.

Generate both database passwords independently. Hex values avoid URL-encoding
ambiguity in the internal PostgreSQL connection string. `DATABASE_URL` is not
needed here because Compose supplies the private `db:5432` connection directly
to the bot and migration containers.

## Normal deployment and verification

Merge a reviewed change to `main`, then inspect the `CI and deploy` workflow.
The deployment is complete only when the `deploy` job reports both `db` and
`bot` running.

For an independent server-side check:

```bash
cd /opt/telegram-news-agent
docker compose --env-file .env.production ps
docker compose --env-file .env.production logs --tail=100 bot
```

The workflow attempts a container-image rollback if the new bot fails its
startup check. Database migrations are forward-only, so schema changes must
remain backward compatible with the previous bot image.

## Data durability

PostgreSQL data lives in the Docker named volume
`telegram-news-agent_postgres_data`. Recreating a container does not delete the
volume. Never run `docker compose down -v` in production. A separate encrypted
off-host backup policy is still required before the database is treated as the
only durable copy of important data.

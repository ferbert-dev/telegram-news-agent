# Oracle Docker deployment

## Architecture

GitHub Actions is the only deployment entry point. A merge to `main` runs the
test suite, publishes an immutable image to GitHub Container Registry, and then
deploys that exact image over SSH. Oracle stores the PostgreSQL volume and runs
the bot; it does not build application images.

The Telegram bot uses long polling, so neither the bot nor PostgreSQL needs an
inbound internet port. Only SSH is required for this deployment design.
PostgreSQL may additionally bind `55432` to the VM's `127.0.0.1` interface for
an SSH tunnel; that loopback socket is not an internet-facing port.

OpenAI, Gemini, Exa, RSS, GDELT, and Telegram calls are outbound HTTPS. Do not
add an inbound `443` rule for web search. The Oracle subnet needs DNS resolution,
an egress rule permitting TCP `443`, and a `0.0.0.0/0` route through an Internet
Gateway for a public subnet or a NAT Gateway for a private subnet. Stateful
security rules permit response traffic automatically. If existing provider and
Telegram calls work from the VM, no Exa-specific port is normally required.

Checked-in migrations seed 49 topic-mapped RSS/Atom sources and the GDELT DOC
index. Normal runs fetch these free sources and use tool-free AI curation.
Provider web search is a recovery path: first to discover, validate, and persist
replacement feeds, and only then as an emergency article-search fallback when
the free source layer has no recent candidates. Source health, quarantine, and
discovery cooldown state live in PostgreSQL.

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
ports `5432` or `55432` in the Oracle security list. Read-only local access is
documented in [`database-access.md`](database-access.md).

## GitHub production configuration

Create a GitHub environment named `production`. Configure these repository or
environment values:

Variables:

- `ORACLE_HOST`: the instance public IP or DNS name.
- `ORACLE_USER`: the non-root SSH account, normally `ubuntu`.

Secrets:

- `ORACLE_SSH_PRIVATE_KEY`: a dedicated private deployment key.
- `ORACLE_KNOWN_HOSTS`: the verified SSH host-key line for Oracle.
- `SOPS_AGE_KEY`: the complete private `age` identity used only by the deploy
  job to decrypt `secrets/production.env.sops`.
- `SOPS_AGE_KEY`: the only GitHub secret that decrypts the complete encrypted
  production environment. OpenAI, Gemini, Exa, Notion, Telegram, and PostgreSQL
  credentials are all stored as encrypted values in
  `secrets/production.env.sops`.

Existing `OPENAI_API_KEY`, `EXA_API_KEY`, and `PRODUCTION_ENV_FILE` GitHub
secrets are retained as rollback-only recovery material during the SOPS
cutover. The active deployment workflow does not merge them into the decrypted
environment, so they cannot silently override the reviewed SOPS source.

Before deploying a changed encrypted environment, dispatch `CI and deploy` on
the candidate branch with operation `verify-production-db`. The read-only job
checks both PostgreSQL passwords over TCP on Oracle, prints only pass/fail, and
uses an in-session trap plus an independent `always()` cleanup step for the
run-specific remote plaintext. Runner plaintext is also removed in `always()`;
any failed remote cleanup remains a visible workflow failure.

The deployment health gate also runs `ops/verify-production-runtime.sh` before
declaring the release healthy. Missing, empty, or placeholder runtime
credentials and failed Telegram bot/channel probes trigger the existing atomic
environment and image rollback.

`PRODUCTION_ENV_FILE` is retained temporarily as rollback-only evidence from the
pre-SOPS deployment. The current workflow does not read it. Delete it only in a
separate authorized cleanup after the SOPS-backed deployment and rollback path
have been proven.

Use a dedicated deployment key rather than a personal interactive SSH key. Add
only its public half to the Oracle user's `~/.ssh/authorized_keys`.

## SOPS production environment

The repository contains `secrets/production.env.sops`. Its variable names and
SOPS metadata are visible, but every production value is authenticated and
encrypted for this public `age` recipient:

```text
age1hu8sepn3kau25tzy98nwlny9yr267k4xpnjlxhf9ek4lwlqpeumqlk5jkr
```

The matching private identity is not committed. The primary local copy is:

```text
~/.config/sops/age/telegram-news-agent-production.txt
```

Store a second copy in a password manager or encrypted offline backup. Without
that private identity, a new machine cannot decrypt or rotate the production
configuration. The public recipient in `.sops.yaml` is not a recovery key.

The decrypted base has this shape:

```dotenv
POSTGRES_PASSWORD=<random-hex-value>
POSTGRES_APP_PASSWORD=<different-random-hex-value>
POSTGRES_SSH_TUNNEL_PORT=55432
TELEGRAM_BOT_TOKEN=<secret>
TELEGRAM_CHANNEL_ID=<channel-id-or-handle>
TELEGRAM_UPDATE_MODE=polling
TELEGRAM_POLLING_MIGRATE_WEBHOOK=false
TELEGRAM_NEWS_JOB_MODE=off
APPROVAL_POLICY=manual
AI_PROVIDER_ORDER=exa,openai,gemini
EXA_ENABLED=true
EXA_SEARCH_TYPE=auto
EXA_MODEL=
EXA_DAILY_SEARCH_CAP=20
EXA_MAX_RESULTS=8
OPENAI_MODEL=gpt-5.4-2026-03-05
OPENAI_REASONING_EFFORT=medium
GEMINI_API_KEY=<secret>
GEMINI_MODEL=gemini-2.5-flash
NOTION_API_KEY=<secret>
NOTION_AGENT_RUNS_DATA_SOURCE_ID=<id>
NOTION_PIPELINE_AGENT_PAGE_ID=<id>
NOTION_PIPELINE_TICKET_PAGE_ID=
```

The deploy job appends separately stored `OPENAI_API_KEY` and, when present,
`EXA_API_KEY` environment secrets immediately before validation and upload.
Provider keys are therefore absent even from the encrypted base file.

Generate both database passwords independently. Hex values avoid URL-encoding
ambiguity in the internal PostgreSQL connection string. `DATABASE_URL` is not
needed here because Compose supplies the private `db:5432` connection directly
to the bot and migration containers.

## Local edit, commit, and deployment flow

Install the tools once:

```bash
brew install sops age
```

The recommended edit path never leaves a named plaintext file in the project:

```bash
npm run secrets:edit:production
npm run secrets:validate:production
git diff -- secrets/production.env.sops
```

SOPS opens decrypted dotenv content in `$EDITOR`, verifies its MAC, and
re-encrypts the file when the editor closes. Commit only
`secrets/production.env.sops` and related reviewed code or documentation. Open a
normal pull request; PR CI checks that required values remain encrypted but does
not receive the production private key.

If a separate plaintext file is explicitly needed for bulk editing:

```bash
npm run secrets:decrypt:production -- .env.production.local
# edit .env.production.local
npm run secrets:encrypt:production -- .env.production.local
npm run secrets:validate:production
rm .env.production.local
```

`.env.production.local` is ignored by Git and created with mode `0600`, but it
still contains real credentials. Delete it immediately after re-encryption.

On a new workstation, restore the private identity from the password manager to
the path above, set mode `0600`, and validate:

```bash
chmod 600 ~/.config/sops/age/telegram-news-agent-production.txt
npm run secrets:validate:production
```

To restore the GitHub copy of the same identity:

```bash
gh secret set SOPS_AGE_KEY \
  --repo ferbert-dev/telegram-news-agent \
  --env production \
  < ~/.config/sops/age/telegram-news-agent-production.txt
```

After a reviewed PR merges to `main`, GitHub Actions downloads the pinned SOPS
binary and verifies its SHA-256, writes `SOPS_AGE_KEY` to a runner-temporary
mode-`0600` file, decrypts and validates the complete committed environment,
and only then uploads the deployment bundle to Oracle. A decryption, placeholder,
or validation failure happens before upload, leaving the current Oracle
environment and bot untouched. Runner plaintext is removed in an
`always()` cleanup step; GitHub-hosted runners are also ephemeral.

The bundle contains `.env.production.incoming`, not the active environment. Oracle
removes the mode-`0600` plaintext archive through a remote `EXIT` trap even if
extraction fails. The deploy script validates both environments and compares
their SHA-256 digests without logging them. If they match, it removes the
incoming file and does not rewrite the active environment. If they differ, it
saves the active file as `.env.production.rollback` and atomically promotes the
incoming file.
If migration or bot health fails, rollback restores the previous environment,
recreates PostgreSQL with that environment, reapplies the previous application
role password, and force-recreates the previous immutable bot image. The Docker
volume is never removed.

For the first SOPS migration, the incoming file is checked against the strict
new contract while the already-running legacy environment is accepted through a
smaller backward-compatible rollback contract. The rollback backup is written
through a temporary mode-`0600` file and atomic rename before promotion. A
promotion flag prevents an older backup from being restored if backup creation
or candidate activation fails before the active environment changes.

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

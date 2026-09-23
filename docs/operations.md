# Operations

How to run and operate the Telegram News Agent: configuration, the Telegram
admin workflow, research and publishing, and deployment. The project overview is
in the [README](../README.md); the verified production snapshot is in
[current-status.md](current-status.md).

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
news, feed, and article-detail research. Exa performs retrieval only; structured
generation continues with OpenAI or Gemini because the fallback skips provider
operations that Exa does not implement.
`EXA_DAILY_SEARCH_CAP` is a per-process UTC-day guard, so account-wide quota
monitoring is still required when more than one process or restart can run.
When Exa is configured, a failed or capped Exa detail search does not fall
through to paid OpenAI or Gemini web search. Without Exa, the existing provider
fact-search fallback remains available.

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

When the `editorial_enrichment` Labs feature is enabled, the editorial pass may
request up to three narrowly scoped missing details for one article. Each Exa
request searches up to five candidate pages in one API call. A second or third
request is possible only after the previous result has been added to a valid
regenerated article. Only an exact Exa highlight from a recognized government,
academic, official, or reputable-news domain is accepted. Every accepted URL
must appear in both the final draft sources and evidence map; otherwise the bot
keeps the last fully grounded version. The same daily Exa cap covers feed, news,
and detail searches.

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

### Diagnosing a thin article

A post that ships as the short legacy baseline -- one paragraph, a
"Caveat: this account relies on one … article" line -- means the editorial pass
did not run for it. Every draft run writes two JSON lines to the bot's log,
which `inspect-production` shows in its log tail:

- `evidence_corroboration`, written before drafting, so it is present even for
  a run that then fails. `fact_plan` is `requests`, `empty` (the model found
  nothing to check), `invalid`, `failed` (no answer; `fact_plan_error` names
  why, for example `ai_providers_exhausted:timeout,authentication_failed`) or
  `not_configured`. `status` is `not_run`, `not_needed`, `corroborated`,
  `uncorroborated` or `error`. `searches` and `failed_searches` count Exa calls,
  and `search_errors` names failures such as `exa_daily_fact_search_cap`.
  `strong_publishers` lists the publishers that counted towards the two
  required.
- `editorial_pass`: `selected_version` is `enriched` or `baseline`, and
  `diagnostic` names why the baseline shipped -- `unverified_story` when
  corroboration did not reach two strong publishers, or the failure kind
  (`provider_failed`, `not_grounded`, `too_short`, …).

The same corroboration summary is stored on the draft, in `reviewer_notes`
under `evidence_corroboration`, next to `editorial_enrichment`. Both carry
codes and counts only, never provider messages.

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

Send `/status` in the private admin chat for an operational panel. PostgreSQL
and Telegram are green when the command itself completes. OpenAI, Gemini, and
Exa are green after a successful recorded call today, yellow when configured
but idle, and gray when disabled. Yellow does not mean broken. The `Test Exa`
button is the only live provider probe in this panel; it consumes exactly one
bounded Exa search, observes the shared daily cap, records a zero-token usage
event, and has a five-minute per-admin cooldown.

Provider attempts are recorded separately from the billing ledger with safe,
redacted operational metadata only. Normal fallback operations make up to
three attempts per configured provider for transient failures, using two
exponential jittered delays within a separate 30-second deadline for each
provider. A provider timeout therefore preserves the next provider's bounded
fallback window instead of exhausting the entire chain before trying the next
configured provider. One-shot structured generation retains its existing
one-call budget. The NestJS runtime's provider composition keeps the same
contract and adds a per-provider circuit breaker, so a provider that is rate
limiting stops being called instead of being retried into a request storm.

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

Published articles carry no editor signature: a line that is identical on every
post carries no information. The shape every article takes, and why, is in
[article-template.md](article-template.md).

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

On the NestJS runtime (production from v2.0.0) every manual `/news` runs
through a durable single-worker queue. On the legacy runtime the same queue is
behind `TELEGRAM_NEWS_JOB_MODE=enabled`; the default `off` keeps the legacy
synchronous path. With the queue, the Telegram update is acknowledged
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
[read-only DBeaver setup](database-access.md).

The image carries both runtimes: the compiled NestJS runtime in `dist/`, built
in a separate Docker stage so the TypeScript toolchain never reaches the final
image, and the legacy runtime in `src/`. `compose.yaml` runs
`node ${BOT_ENTRYPOINT:-src/telegram-bot.js}`. Production's value comes from
`ops/production-runtime.env` and takes effect at the next tagged release;
**from v2.0.0 it is the NestJS runtime**, and the legacy runtime is the
rollback. See the [cutover runbook](nestjs-cutover-runbook.md).

To run the NestJS runtime locally against a real database (it needs the same
`POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD` and `.env.production` as every
other compose recipe here):

```bash
docker compose -f compose.yaml -f compose.nest.yaml up -d bot
```

Database changes use SQL migrations as the source of truth and a Drizzle
TypeScript snapshot for typed repository work and CI drift detection. See the
[Drizzle migration roadmap](database-migration.md). Useful commands:

```bash
npm run database:new -- describe_the_change
DATABASE_URL=postgresql://... npm run database:status
DATABASE_URL=postgresql://... npm run database:drift
```

Building and releasing are separate events in `.github/workflows/deploy.yml`:

1. A merge to `main` (or a push to a `release/**` branch) runs the full test
   gate, migrates a clean PostgreSQL twice to prove idempotency, runs both
   integration suites, and pushes immutable `linux/amd64` and `linux/arm64`
   images to GHCR. **It deploys nothing.**
2. A `vMAJOR.MINOR.PATCH` tag on a `release/*` branch releases: the release job
   retags the image already built and gated for that commit — never rebuilding
   it — and refuses a tag that is off a release branch, has no gated image, or
   disagrees with `package.json`.
3. The deploy connects to Oracle over SSH, runs migrations, replaces the bot,
   and requires three consecutive `healthy` checks plus a runtime credential
   check. On any failure it restores the previous image and environment by
   itself.

See [releases.md](releases.md).

After every successful production health gate, the deploy script sends one
private Telegram notice to the saved review chat with the package version and
short immutable commit. It verifies that each destination is a private chat,
never sends this notice to the public channel, and stores the notified image in
`.deployment-notification-image` so rerunning the same image does not spam.
Notification failure is visible in deploy logs but does not roll back an
otherwise healthy release.

Production runtime configuration is committed only as the SOPS-encrypted
`secrets/production.env.sops` file. The private `age` key is stored outside Git
and in the protected GitHub `production` environment. Edit and validate the
encrypted file without creating persistent plaintext:

The encrypted file is the single source for PostgreSQL, Telegram, OpenAI,
Gemini, Exa, and Notion runtime credentials. Production validation rejects
placeholder values before any deployment bundle is uploaded to Oracle.

```bash
brew install sops age
npm run secrets:edit:production
npm run secrets:validate:production
```

Commit the encrypted file through a normal pull request. At release, GitHub
Actions decrypts it in runner-temporary storage, appends the runtime switch from
`ops/production-runtime.env`, validates the assembled environment, and deploys
it to Oracle. See [`docs/oracle-deployment.md`](oracle-deployment.md) for key
backup, explicit decrypt/re-encrypt commands, rollback, and the full lifecycle.

Server bootstrap and GitHub configuration are documented in
[`docs/oracle-deployment.md`](oracle-deployment.md). Do not open a public
port for PostgreSQL or the polling bot.

# Current Status

Last verified: **2026-09-29**, from a read-only
[production inspection](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/36624520959).

## Production

| Item | Verified state |
| --- | --- |
| Release | **v2.0.1** at [`4d634e4`](https://github.com/ferbert-dev/telegram-news-agent/commit/4d634e49e364785832bb0746cb7fd4836a8c25dc) |
| Image | `ghcr.io/ferbert-dev/telegram-news-agent:v2.0.1` |
| Runtime | NestJS — `dist/composition/runtime-entry.js`, workers `telegram-polling`, `news-scheduler`, `telegram-news-jobs`, `runtime-health` |
| Rollback | Legacy `src/telegram-bot.js` ships in the same image, unstarted. Rollback is one line in `ops/production-runtime.env` plus a patch release, or a host-side edit during an incident — see the [runbook](nestjs-cutover-runbook.md) |
| Container | Running, 0 restarts, not OOM-killed, started 2026-09-24 07:33 UTC |
| Release gate | Healthy; the inspected runtime reported all four NestJS workers and zero restarts |
| Telegram | Bot answers, polling mode, no webhook, 0 pending updates, channel reachable |
| Channel | Automatic approval, a run every 3 hours, night pause 22:00–08:00 Europe/Madrid |
| Database | PostgreSQL 17, 37 ordered migrations. Before the release a `pg_dump` was restored into a throwaway server and every one of 27 tables' row counts matched |
| AI | OpenAI key and `gpt-5.4-2026-03-05` accepted; Exa configured; Gemini key accepted, but the deployed `gemini-2.5-flash` generation endpoint returns 404 because that model is retired for new users |

Release evidence: [release and deploy](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/34528494521),
[backup proven by restore](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/34527426002),
[post-release inspection](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/34613856971).

## Known issues

1. **Scheduled runs fail when no ranked article yields readable text.** Some
   publishers block extraction (the New York Times returns 403), and when every
   ranked candidate is blocked the run ends with a plain error, logged only as
   `cause: "Error"`. The legacy runtime could fall back to a primary
   publisher's feed summary; whether the typed path lost that is being
   investigated, together with giving the failure a real error code.
2. **Production still selects retired Gemini model `gemini-2.5-flash`.** The
   key itself is accepted, but generation returns 404. A TypeScript-only change
   to `gemini-3.8-flash` has passed real structured curation and enrichment
   probes locally; it is not deployed yet.
3. **The Exa daily search cap is counted per process**, so a restart resets it.
   It bounds a run, not a calendar day.

## How v2.0.0 got here

The NestJS runtime ran on an isolated integration stage — its own bot, channel,
database and AI keys — from 2026-09-08 to 2026-09-10 before it replaced the
legacy runtime:

- manual `/news`, preview, Publish, Reject and `/settings` exercised by hand;
- **8 unattended scheduled runs**, one every three hours, with automatic
  approval: **7 published**, 1 failed on provider timeouts;
- **one full night with zero events** between 22:00 and 08:00 Madrid — the
  night pause refuses before research starts, so it costs nothing — and the
  first run of the morning at 08:00:21.

Then: a backup proven by restore, a release branch, a tag, and a health-gated
deploy. The pilot's criteria and results are in
[nestjs-cutover-readiness.md](nestjs-cutover-readiness.md).

## Next

1. Fix the extraction-failure runs above and ship them as a patch release.
2. Review and release the tested Gemini 3.8 model switch, longer provider
   deadlines and private Telegram incident alerts.
3. Only then, on an explicit decision, retire the legacy runtime —
   [ticket 0006](../tickets/0006-retire-legacy-runtime.md). Thirty legacy
   modules are still reached from typed code, so that is a porting job before
   it is a deletion.

## Release boundary

Production deploys only on a `vX.Y.Z` tag cut from a `release/*` branch; a
merge to `main` deploys nothing. Do not retire the legacy runtime, disable
rollback infrastructure, rotate secrets or change production settings without
explicit authority for that action.

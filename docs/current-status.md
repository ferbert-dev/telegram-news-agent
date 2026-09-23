# Current Status

Last verified: **2026-09-11**, from a read-only
[production inspection](https://github.com/ferbert-dev/telegram-news-agent/actions/runs/34613856971).

## Production

| Item | Verified state |
| --- | --- |
| Release | **v2.0.0** — tag on `release/v2.0.0` at [`bdf0d71`](https://github.com/ferbert-dev/telegram-news-agent/commit/bdf0d71) |
| Image | `ghcr.io/ferbert-dev/telegram-news-agent:v2.0.0`, retagged from the image already gated for that commit, never rebuilt |
| Runtime | NestJS — `dist/composition/runtime-entry.js`, workers `telegram-polling`, `news-scheduler`, `telegram-news-jobs`, `runtime-health` |
| Rollback | Legacy `src/telegram-bot.js` ships in the same image, unstarted. Rollback is one line in `ops/production-runtime.env` plus a patch release, or a host-side edit during an incident — see the [runbook](nestjs-cutover-runbook.md) |
| Container | Running, 0 restarts, not OOM-killed, started 2026-09-10 20:49 UTC |
| Release gate | Three consecutive `healthy` checks, then the runtime credential check: `Deployment healthy: …:v2.0.0` |
| Telegram | Bot answers, polling mode, no webhook, 0 pending updates, channel reachable |
| Channel | Automatic approval, a run every 3 hours, night pause 22:00–08:00 Europe/Madrid |
| Database | PostgreSQL 17, 37 ordered migrations. Before the release a `pg_dump` was restored into a throwaway server and every one of 27 tables' row counts matched |
| AI | OpenAI working; Exa configured; **Gemini key rejected** (see below) |

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
2. **Production's Gemini key is rejected** (`authentication_failed` on every
   attempt), so structured generation has one provider instead of two. The key
   lives in `secrets/production.env.sops` and takes effect at the next release.
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
2. Rotate the production Gemini key.
3. Let v2.0.0 soak for at least 72 hours.
4. Only then, on an explicit decision, retire the legacy runtime —
   [ticket 0006](../tickets/0006-retire-legacy-runtime.md). Thirty legacy
   modules are still reached from typed code, so that is a porting job before
   it is a deletion.

## Release boundary

Production deploys only on a `vX.Y.Z` tag cut from a `release/*` branch; a
merge to `main` deploys nothing. Do not retire the legacy runtime, disable
rollback infrastructure, rotate secrets or change production settings without
explicit authority for that action.

# Ops memory

## 2026-08-09 — Telegram cutovers require one poller

- Evidence: `docs/oracle-deployment.md` and production polling safeguards
- Lesson: replacement runtime verification must never allow two active Telegram pollers; retain a rollback path until the new runtime is verified.
- Applies when: deploying, migrating hosts, or changing the bot entrypoint.
- Invalidated when: the product moves to a separately reviewed webhook architecture.

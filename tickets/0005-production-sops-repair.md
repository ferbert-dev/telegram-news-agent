# Restore production credentials and harden SOPS deployment

- Notion: https://app.notion.com/p/3c3d78850eab81259131f86ca47fb076
- Parent Epic: https://app.notion.com/p/3b7d78850eab81348bcbec541f1c23bb
- Status: In Progress
- Priority: P0
- Branch: `codex/p0-production-sops-repair`

## Incident

The recovered SOPS base contained non-empty placeholder values. Validation
checked presence but not credential quality, so CI and deployment passed while
Telegram channel, Gemini, and Notion configuration were invalid.

## Objective

Make the encrypted SOPS file the single editable source for all production
runtime credentials and reject placeholders before Oracle upload.

## Acceptance criteria

- Preserve the PostgreSQL volume during rollback and repair.
- Encrypt PostgreSQL, Telegram, OpenAI, Gemini, Exa, and Notion credentials.
- Do not print plaintext values in tests, logs, tickets, or pull requests.
- Reject required empty, placeholder, and duplicate values.
- Stop injecting provider keys separately in the deployment workflow.
- Retain existing GitHub provider and legacy environment secrets as rollback
  material; do not delete them in this ticket.
- Prove local decrypt/validate, focused tests, exact-head review, CI, rollback,
  and production deployment.

## Rollback

Use the retained `PRODUCTION_ENV_FILE` workflow and immutable pre-SOPS image
until the repaired SOPS deployment passes production verification.

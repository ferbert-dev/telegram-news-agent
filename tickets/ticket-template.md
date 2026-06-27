# Ticket Template

## Title

Short action-oriented title.

## Type

Requirement / Feature / Bug / Research / Refactor / Ops / Design / Content / Automation

## Status

Inbox / Ready / In Progress / Review / Blocked / Done / Archive

## Priority

P0 / P1 / P2 / P3

## Agent Role

Orchestrator / Planner / Researcher / Builder / Reviewer / QA / Ops / Documentation

## Context

Why this task exists.

## Objective

What must be achieved.

## Acceptance Criteria

- Criterion 1
- Criterion 2
- Criterion 3

## Constraints

- No secrets in source control.
- Keep scope bounded.
- Implementation work must use a dedicated `codex/` branch.
- Implementation work must open a pull request.
- Pull requests must be reviewed by a Reviewer agent before Done.
- Every agent invocation must create and finalize a Notion `Agent Runs` audit
  entry.

## Outputs

Expected artifact or result.

## Branch

Expected branch name, for example `codex/<short-ticket-name>`.

## Pull Request

- PR URL:
- Reviewer:
- Review status: Not Started / In Review / Changes Requested / Approved
- Verification:
- Follow-up work:

## Agent Run Audit

- Agent Runs entry:
- Started At:
- Finished At:
- Final status:
- Result/evidence:
- Error/blocker:

## Orchestrator Next-Step Loop

After completion, answer:

- What changed?
- How did this move the Telegram article publishing service closer to the goal?
- What should be improved next: research, article quality, scheduling, Telegram posting, observability, deployment, or maintainability?
- What human input is needed?
- What is the recommended next ticket?

## Blockers

Known missing decisions, credentials, or dependencies.

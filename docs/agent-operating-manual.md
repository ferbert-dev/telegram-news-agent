# Agent Operating Manual

## Minimal Flow

1. User describes an idea.
2. Orchestrator creates or updates a ticket in Inbox.
3. Planner converts unclear ideas into requirements and acceptance criteria.
4. Orchestrator moves executable tickets to Ready.
5. Every agent creates an `Agent Runs` audit entry before starting work.
6. Builder creates a new branch for the implementation.
7. A specialist agent executes the ticket on that branch.
8. Builder opens a pull request for the implementation.
9. Reviewer checks the pull request for bugs, maintainability, security, and extensibility.
10. QA verifies behavior when needed.
11. Every agent finalizes its audit entry with the outcome and evidence.
12. Orchestrator moves the ticket to Done or Blocked.
13. Orchestrator runs the next-step loop before starting more work.

## Product Goal

Build and operate a service that publishes useful, well-researched articles to Telegram. The system should improve over time in these areas:

- Research quality and source coverage.
- Article synthesis and editorial quality.
- Scheduling and publishing reliability.
- Human approval and escalation points.
- Observability through Notion tickets and Agent Runs logs.
- Maintainable, extendable code.

## Orchestrator Next-Step Loop

After every completed task, the Orchestrator must ask and answer this prompt before selecting the next task:

```text
Given the product goal, what is the most valuable next step?

Goal:
Create a service that researches topics, writes useful articles, and publishes them to Telegram through a reliable, maintainable workflow.

Review:
- What changed in the last task?
- Did it move us closer to publishing high-quality articles?
- What did we learn about research quality, article quality, delivery, or operations?
- What still blocks a working end-to-end service?
- What human decision, credential, account access, or product input is needed?
- What should be improved next so the service is more reliable, maintainable, or useful?

Output:
- Recommended next ticket.
- Why it matters now.
- Human input needed, if any.
- Suggested agent role.
- Acceptance criteria.
```

The Orchestrator should create or update a Notion ticket from this output and record a run entry in `Agent Runs`.

## Mandatory Agent Run Audit

Every agent invocation must be recorded in the Notion `Agent Runs` database.
This applies to Orchestrator, Planner, Researcher, Builder, Reviewer, QA, Ops,
and Documentation runs, including read-only, failed, cancelled, and blocked
runs.

At run start, the agent must create an entry containing:

- Run name and agent role.
- Related ticket or task.
- `Started At` timestamp.
- Status set to the database's active/running value.
- Short objective or expected result.

Before the run ends, the same entry must be updated with:

- Final status: succeeded, failed, blocked, or cancelled using the database's
  available status values.
- `Finished At` and duration.
- Concise result summary.
- Links to relevant ticket, branch, pull request, files, publication, or
  external evidence.
- Error or blocker details when applicable.

Rules:

- Creating only a final summary is insufficient; the start must be logged.
- A failed or blocked run must still be finalized.
- Never put tokens, API keys, passwords, or other secrets in an audit entry.
- An agent task is not complete until its `Agent Runs` entry is finalized.
- If Notion is temporarily unavailable, record the audit payload locally and
  backfill it before marking the ticket Done.

## Branch And Pull Request Rules

- Every implementation must happen on a new branch.
- Use branch names that start with `codex/`.
- One ticket should map to one branch and one pull request unless the Orchestrator explicitly splits the work.
- Do not commit directly to `main`.
- A pull request must include the ticket link or ticket path, summary, tests or verification, risks, and follow-up work.
- No implementation is Done until a Reviewer agent has reviewed the pull request.
- The Reviewer should prioritize correctness, maintainability, extensibility, security, and missing tests.
- QA review is required for user-visible publishing behavior, scheduler behavior, Telegram posting, or production/deployment changes.
- Merge only after review findings are addressed or explicitly accepted by the Orchestrator.

## Orchestrator Rules

- Keep the project goal visible.
- Keep tickets small enough to execute independently.
- Assign one primary role per ticket.
- Spawn parallel agents only when their tasks are independent.
- Do not store secrets in Notion or source control.
- Escalate credential, cost, deletion, deployment, and production-risk decisions.
- Do not mark implementation tickets Done without a branch, pull request, review, and logged outcome.
- Require every agent to create and finalize an `Agent Runs` audit entry for
  every invocation.
- After each task, run the Orchestrator Next-Step Loop.

## Handoff Contract

Each agent task must include:

- Context
- Objective
- Inputs
- Constraints
- Acceptance criteria
- Expected output
- Escalation rule
- Branch name
- Pull request expectation
- Review requirement
- Agent Runs audit entry requirement

# Agent Operating Manual

## Minimal Flow

1. User describes an idea.
2. Orchestrator creates or updates a ticket in Inbox.
3. Planner converts unclear ideas into requirements and acceptance criteria.
4. Orchestrator moves executable tickets to Ready.
5. A specialist agent executes the ticket.
6. Reviewer checks the result.
7. QA verifies behavior when needed.
8. Orchestrator moves the ticket to Done or Blocked.

## Orchestrator Rules

- Keep the project goal visible.
- Keep tickets small enough to execute independently.
- Assign one primary role per ticket.
- Spawn parallel agents only when their tasks are independent.
- Do not store secrets in Notion or source control.
- Escalate credential, cost, deletion, deployment, and production-risk decisions.

## Handoff Contract

Each agent task must include:

- Context
- Objective
- Inputs
- Constraints
- Acceptance criteria
- Expected output
- Escalation rule


# Engineering Workflow

## Purpose

This project uses a traceable delivery loop instead of unstructured feature work. Notion keeps intent and status, GitHub keeps implementation evidence, the repository keeps executable truth, and Graphify accelerates navigation without replacing source verification.

## Work hierarchy

```text
Product goal
└── Epic
    ├── Research / design tickets
    ├── Implementation tickets
    ├── QA / operations tickets
    └── Epic retrospective
```

An Epic is required when work spans multiple independent slices, modules, migrations, releases, or agents. Every sub-task links to the Epic using the Notion `Parent Ticket` relation.

## Definition of Ready

A ticket may move to `Ready` only when it has:

- One outcome and one primary role.
- A parent Epic when applicable.
- Explicit dependencies and assumptions.
- Testable acceptance criteria.
- Safety, compatibility, and rollback requirements.
- Named evidence required for closure.
- User authority for any already-known cost, production, deletion, or external-write action.

## Execution

1. The Orchestrator creates its Agent Run.
2. The Orchestrator creates Agent Runs for bounded delegated work before spawning agents.
3. Independent agents may run in parallel. Dependent work stays sequential.
4. The Builder works on a dedicated `codex/*` branch and keeps the diff within the ticket.
5. Tests run in proportion to risk; database changes require a clean-database path.
6. Documentation and durable memory are updated from verified results, not plans.
7. All Agent Runs are finalized even on failure, blockage, or cancellation.

## Closure review

One independent closure review is mandatory for changes to code, schema, configuration, infrastructure, deployment, architecture, external project state, or project instructions.

The reviewer checks:

- Parent Epic and ticket scope.
- Acceptance criteria and dependency completion.
- Diff, migrations, tests, CI, and runtime evidence.
- Compatibility, security, data-loss, rollback, and observability risks.
- Documentation, Graphify freshness, Agent Runs, and release authority.
- Whether any finding belongs in the current ticket or a bounded follow-up.

The reviewer returns `PASS`, `FAIL`, or `BLOCKED`. It does not modify the artifact, spawn another reviewer, or change workflow rules. The Orchestrator integrates findings and owns the status transition.

## Epic retrospective

After delivery verification, one Retrospective run answers:

1. Did the Epic meet its measurable outcome?
2. Which assumptions were wrong?
3. Which regressions, incidents, or near misses occurred?
4. Which tests or gates prevented defects?
5. Did Graphify reduce search/context cost on real questions?
6. Did agent delegation reduce elapsed time without increasing integration defects?
7. Which lessons are reusable enough for durable memory?
8. Which follow-ups are justified by evidence?

The retrospective may propose process changes and create bounded tickets. It cannot recursively launch another retrospective or autonomously rewrite `AGENTS.md`.

## Status policy

| Status | Meaning |
| --- | --- |
| Inbox | Captured, incomplete, or not prioritized |
| Ready | Decision-complete and dependencies satisfied |
| In Progress | One primary owner is executing |
| Review | Evidence complete; independent review active |
| Blocked | Named decision or external state prevents progress |
| Done | All closure gates passed |
| Won't Do | Intentionally abandoned or superseded with reason |
| Archive | Obsolete organizational record preserved for history |

Never delete completed historical tickets merely because the implementation evolved. Use `Won't Do` when an acceptance gate was intentionally abandoned; do not mark it `Done` without evidence.

## Notion records

- Hub: [Agent Ops - News Channel Project](https://app.notion.com/p/38bd78850eab810ca73de57f1fbbcc1e)
- Tickets: [Delivery board](https://app.notion.com/p/8e0e1e80d85b4f3794e859be8c2dfeee)
- Agent Registry: [Role contracts](https://app.notion.com/p/339d95a5ab0d4c4898a41382615870da)
- Agent Runs: [Execution audit](https://app.notion.com/p/d9886d9543ed4a9f8d547748c80c5f7e)
- Active Epic: [NestJS platform migration](https://app.notion.com/p/3b7d78850eab81348bcbec541f1c23bb)

## Three-layer traceability

Every completed implementation should be traceable as:

```text
Notion Epic / Ticket / Agent Runs
        ↓
Git branch / commit / PR / CI
        ↓
Repository code / migrations / docs / tests
```

If one layer is unavailable, record the missing evidence and backfill it before `Done`.

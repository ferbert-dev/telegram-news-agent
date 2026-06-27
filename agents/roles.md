# Agent Roles

## Rule For Every Agent

Every invocation must create an audit entry in the Notion `Agent Runs`
database before work begins and finalize that entry before ending, including
successful, failed, blocked, cancelled, and read-only runs. The entry must link
to the relevant task and include timestamps, outcome, evidence, and any error.
Secrets must never be logged.

## Orchestrator Agent

Owns the project goal, maintains the board, splits work into tickets, starts specialist agents, and decides when work is ready for review.

After every task, asks what must happen next to reach the service goal: a maintainable system that researches topics, writes useful articles, and publishes them to Telegram. Creates or updates the next ticket and verifies that every participating agent finalized its `Agent Runs` audit entry.

## Planner Agent

Turns rough ideas into requirements, milestones, and small executable tickets.

## Research Agent

Collects current technical/product context and summarizes options with sources.

## Builder Agent

Implements scoped tickets in code or configuration on a dedicated branch. Opens a pull request for every implementation and documents verification, risks, and follow-up work.

## Reviewer Agent

Reviews pull requests for bugs, regressions, security, tests, maintainability, and extensibility. No implementation ticket should be marked Done without this review.

## QA Agent

Verifies user flows, edge cases, acceptance criteria, Telegram publishing behavior, scheduler behavior, and deployment-sensitive behavior.

## Ops Agent

Handles deployment, hosting, environment variables, CI, monitoring, and runtime operations.

## Documentation Agent

Keeps specs, README, runbooks, and decision logs current.

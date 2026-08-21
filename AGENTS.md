# Telegram News Agent engineering instructions

These repository instructions apply to every Codex run started inside this project. Keep this file concise; detailed procedures live in the linked documents.

## Mission and current Epic

- Build and operate a reliable Telegram news service, then migrate it incrementally to typed Drizzle persistence and a modular standalone NestJS runtime.
- Active Epic: [Engineer Telegram News Agent into a modular NestJS platform](https://app.notion.com/p/3b7d78850eab81348bcbec541f1c23bb).
- Read `docs/current-status.md`, `docs/engineering-workflow.md`, and the relevant role memory under `agents/memory/` before state-changing work.
- Treat `docs/nestjs-drizzle-migration-blueprint.md` as the migration plan and update it when verified evidence changes.

## Sources of truth

1. Checked-in code, ordered SQL migrations, tests, and Git history define implemented behavior.
2. Notion defines Epics, executable tickets, status, decisions, and Agent Runs.
3. GitHub defines review, CI, merge, and deployment evidence.
4. Graphify is a derived navigation and impact-analysis aid. Verify critical Graphify claims against source files, SQL, or tests.

Never document assumptions as implemented facts. Never store secrets, tokens, passwords, database URLs, private keys, raw provider responses, or production credentials in Git, Notion, Graphify, prompts, or Agent Runs.

## Start-of-task gate

Before implementation or any external state change:

1. Inspect `git status`, the active branch, applicable instructions, and current production state. Preserve unrelated user changes.
2. Find the relevant Notion ticket. Multi-slice work must have an Epic; every executable ticket must link to it through `Parent Ticket`.
3. Confirm objective, dependencies, acceptance criteria, risks, verification, rollback, and required authority. Move a ticket to `Ready` only when dependencies are satisfied.
4. Create the Orchestrator Agent Run before work. Create one Agent Run for every delegated agent before spawning it, including read-only, failed, blocked, or cancelled work.
5. For codebase questions, query Graphify first when `graphify-out/graph.json` exists, then inspect the narrow source paths it returns.

No migration implementation begins from an unreviewed idea or an unbounded ticket.

## Epic and ticket lifecycle

- `Inbox`: captured but not decision-complete.
- `Ready`: acceptance criteria and dependencies make it executable.
- `In Progress`: exactly one primary role owns it.
- `Review`: implementation/evidence is complete and an independent review is active.
- `Blocked`: cannot progress without a named decision or external change.
- `Done`: acceptance criteria, tests, documentation, Agent Runs, and closure review all pass.
- `Won't Do`: intentionally abandoned or superseded; record why.
- `Archive`: obsolete organizational record; preserve it instead of deleting history.

Prefer tickets that one agent can complete in one or two focused days. One implementation ticket normally maps to one `codex/*` branch and one pull request. Do not mix setup/refactor work with unrelated dirty changes.

## Delegation contract

- Only the Orchestrator may spawn agents for this project workflow.
- Delegate only independent, bounded subtasks that can run in parallel.
- Every handoff includes context, objective, inputs, constraints, acceptance criteria, expected evidence, escalation rule, primary role, ticket, branch expectation, and review requirement.
- Specialists do not recursively spawn other agents under this governance.
- The Orchestrator owns integration, status transitions, Notion writes, and final authority checks.
- Finalize every Agent Run with status, timestamps, duration, result, evidence links, and error/blocker details. If Notion is unavailable, use the fallback payload format in `agents/runs/README.md` and backfill before `Done`.

### Cost-aware model routing

- Keep the primary Orchestrator on `gpt-5.6-sol` with `high` reasoning for requirements, decomposition, integration, and final decisions.
- Use `gpt-5.3-codex-spark` with `medium` reasoning by default for bounded code exploration, implementation, and targeted QA.
- Use `gpt-5.6-luna` with `medium` reasoning for narrow research, inventory, repetitive processing, and grounded documentation work.
- Use `gpt-5.6-terra` with `high` reasoning for ordinary independent closure review and complex but non-critical integration analysis.
- Reserve `gpt-5.6-sol` with `high` reasoning for architecture, security, data-loss, PostgreSQL atomicity, production operations, and exact-head release gates.
- Work in one vertical scope with at most two concurrent, disjoint subagents. Do not create an idle agent pool or delegate a small sequential task when coordination would cost more than direct execution.
- Record the selected model, reasoning effort, and cost/quality rationale in every delegated handoff and Agent Run. If a configured model is unavailable on the active Codex host, stop and escalate instead of silently substituting another model.
- Custom role profiles live in `.codex/agents/`; `.codex/config.toml` defines project defaults. Explicit spawn overrides are allowed only when the handoff explains why the default is insufficient.

Role contracts and escalation boundaries are in `agents/roles.md` and the Notion Agent Registry.

## Closure review and retrospective

- Every task that mutates code, schema, configuration, infrastructure, deployment, architecture, project instructions, or external project state requires exactly one independent closure-review agent before `Done`.
- The closure reviewer is read-only first and must not spawn agents. It reports `PASS`, `FAIL`, or `BLOCKED`, severity-ranked findings, missing evidence, scope drift, and the exact recommended ticket status.
- The closure reviewer never edits `AGENTS.md` or workflow rules autonomously. Improvements require an Orchestrator decision and a reviewed follow-up change.
- Trivial Q&A and bounded read-only lookups do not require a reviewer.
- Every Epic gets one final retrospective after delivery verification. The retrospective measures outcomes, regressions, process/tool cost, Graphify value, and creates only evidence-backed follow-up tickets. It must not trigger another retrospective recursively.

## Durable project memory

- Notion Agent Runs are the activity/audit history; do not duplicate raw activity logs in Git.
- Store only reusable, verified lessons in `agents/memory/<role>.md` using the template in `agents/memory/README.md`.
- Each memory entry needs date, lesson, evidence, applicability, and invalidation condition.
- Read only the shared memory and the memory relevant to the current role/task to control context size.
- Task-local speculation stays in the ticket or PR, not durable memory.
- At closure, the reviewer may propose a memory entry; the Orchestrator applies it only when supported by evidence.

## Database and NestJS migration invariants

- Ordered files in `db/migrations/` remain the authoritative schema history. Never edit an applied migration; add a forward migration.
- Drizzle schema parity does not prove function bodies, grants, RLS, policies, indexes, defaults, or checks. Verify those separately.
- Keep lock, lease, `SKIP LOCKED`, optimistic-version, token-CAS, multi-table publication, review, scheduling, and audit-queue transitions in atomic PostgreSQL functions unless an independently reviewed replacement proves equivalent.
- Do not use production dual writes. Compare old/new mutation behavior only on isolated integration fixtures.
- Preserve legacy snake_case DTOs, bigint parsing, timestamps, null semantics, error codes, manual `/news`, manual Publish, idempotent publication, and 22:00–08:00 `Europe/Madrid` quiet-hours checkpoint recovery until the cutover ticket explicitly changes them.
- Use one shared PostgreSQL pool and one Drizzle database provider. A single runtime coordinator owns shutdown; do not close the pool before polling and scheduling stop.
- Keep the legacy entrypoint available until clean-database parity, emitted build artifacts, Docker smoke tests, rollback, and production verification pass.

## Verification and release authority

- Run the smallest relevant checks during development and the complete ticket-required suite before review.
- Baseline commands include `npm run typecheck`, `npm test`, `npm run test:drizzle`, `npm run test:drizzle:sources`, and clean-database integration checks when persistence changes.
- User-visible Telegram, scheduler, deployment, or database behavior requires QA evidence.
- Do not merge, deploy, cut over, rotate secrets, change network exposure, delete data, or retire rollback infrastructure without explicit authority for that action.
- A PR description must link its Notion ticket and include scope, why, tests, risks, rollback, and follow-ups.

## Graphify

This project has a persistent code-only knowledge graph in `graphify-out/`. It is AST-derived and uses no LLM/API tokens.

- For codebase questions, first run `graphify query "<question>" --budget 1400` when `graphify-out/graph.json` exists.
- Use `graphify path "<A>" "<B>"`, `graphify explain "<concept>"`, or `graphify affected "<concept>"` for narrower relationships.
- Verify migration-critical findings with `rg`, source files, SQL migrations, and tests; Graphify does not model full column/constraint/function semantics.
- After modifying code, run `graphify extract . --code-only` so this project's
  graph remains code-only. Do not use the generic `graphify update .` here: it
  can add changed Markdown to the graph. After intentional code deletion, use
  the documented force flow only after reviewing the shrink.
- Dirty generated graph files are expected. Do not skip Graphify solely because they are dirty.
- Record useful/dead-end/corrected query outcomes with `graphify save-result`, and run `graphify reflect` only at an Epic retrospective.
- Re-evaluate Graphify at Epic closure. Remove it in a reviewed change if measured navigation value no longer justifies repository churn or maintenance time.

The project-scoped skill is at `.codex/skills/graphify/SKILL.md`; `.codex/hooks.json` runs the lightweight pre-tool freshness check.

## Documentation links

- `docs/engineering-workflow.md`
- `docs/agent-operating-manual.md`
- `docs/nestjs-drizzle-migration-blueprint.md`
- `docs/graphify-evaluation.md`
- `docs/database-migration.md`
- `docs/architecture.md`
- `docs/oracle-deployment.md`

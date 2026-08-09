# Reviewer memory

## 2026-08-09 — Closure review must not recurse

- Evidence: `docs/engineering-workflow.md`
- Lesson: one independent read-only-first reviewer checks each mutating task; it cannot spawn another reviewer or autonomously rewrite workflow rules.
- Applies when: closing code, schema, configuration, infrastructure, architecture, or Epic work.
- Invalidated when: a reviewed governance decision replaces the closure model.

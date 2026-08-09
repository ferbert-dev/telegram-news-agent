# Orchestrator memory

## 2026-08-09 — Separate setup changes from dirty implementation work

- Evidence: `codex/project-engineering-workflow` was created in a clean worktree while ORM changes remained in the primary checkout; the user later switched that checkout from `codex/drizzle-nestjs-persistence` to `main` without losing the changes.
- Lesson: use a separate branch/worktree when process/tooling work would otherwise mix with unfinished product changes.
- Applies when: the active worktree contains unrelated or incomplete changes.
- Invalidated when: all changes belong to one reviewed ticket.

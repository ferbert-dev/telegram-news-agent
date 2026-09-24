# Retire the legacy JS runtime after v2.0.0 has held in production

- Status: Blocked -- not before 2026-09-13, and only on an explicit decision
- Priority: P2
- Type: Refactor / Ops
- Branch: `codex/retire-legacy-runtime` (not yet created)

## Context

v2.0.0 switched production from `src/telegram-bot.js` to the NestJS runtime
(`dist/composition/runtime-entry.js`). The legacy runtime is still in the
repository and in the image on purpose: it is the rollback, and flipping back
is one line in `ops/production-runtime.env` plus a patch release.

The owner's rule: legacy is not removed until the new runtime has held in
production for two to three days, and removing it is a separate decision taken
after that, not a side effect of the cutover.

## Objective

Remove the legacy runtime once it is no longer needed as a rollback, without
removing anything the NestJS runtime still reaches.

## What is not simply deletable

**Measured 2026-09-23: thirty legacy modules are reached from typed code**, by
about forty typed files. An earlier version of this ticket said "five seams",
which counted the `legacy-*.gateway.ts` files rather than what they and the
rest of the typed code actually import. The correct way to count is to resolve
every relative `.js` import in a `.ts` file and keep only those with no `.ts`
twin -- under NodeNext a typed import of a typed file is also written `.js`,
which is what made the first count wrong.

The most-reached are `telegram.js` (six importers), `news-settings.js` (five),
then `ai-usage.js`, `exa-provider.js`, `feed.js`, `excluded-topic-policy.js`
and `telegram-stats.js` with two or three each. The named gateway seams are
only part of it:

| Seam | Legacy modules it reaches |
| --- | --- |
| `legacy-editorial-draft` | `draft.js`, `editorial-enrichment.js`, `article-tags.js`, `telegram.js` |
| `legacy-editorial-publication` | `telegram.js` |
| `legacy-notion-audit` | none directly; the composition root builds its finalizer from `notion-audit.js` |
| `typed-research-execution` | `feed.js`, `ai-usage.js`, `excluded-topic-policy.js` (`news-settings.js` ported 2026-09-24; see below) |

`legacy-research-execution` was removed from this table: it and its module
were deleted (2026-09-24), the one seam with no porting behind it, matching
the acceptance criterion below.

So this is a porting job first and a deletion second: each of those slices is
ported to TypeScript, its gateway removed, and only then does the module it
wrapped become dead.

**Re-measured 2026-09-24, after "Port settings and scheduling helpers to
TypeScript":** thirty-one legacy modules are reached, both from
`src/composition/runtime-entry.ts` (resolving every relative import and
keeping only specifiers with no `.ts` twin, same rule as above) and from the
compiled `dist/composition/runtime-entry.js` (resolving every relative import
and keeping only the ones whose `dist/**/*.js` file has no `src/**/*.ts`
origin -- the two counts agree). `news-settings.js`, `quiet-hours.js`, and
`excluded-topics.js` got typed twins this round
(`src/settings/domain/news-settings.ts`, `src/scheduler/domain/quiet-hours.ts`,
`src/settings/domain/excluded-topics.ts`) and every typed (`.ts`) importer was
switched to them -- `checks/architecture/nestjs-boundaries.ts` now asserts
directly that no `.ts` file under `src/` resolves an import to any of the four
legacy modules. Only `pipeline-states.js` actually dropped out of the
transitive-reachability count (32 -> 31), because its typed twin
(`src/operations/domain/pipeline-states.ts`) had no other path back in.
`news-settings.js`, `quiet-hours.js`, and `excluded-topics.js` are still
reached transitively -- not by typed code, but by other still-legacy `.js`
modules that import them directly and are themselves still reachable.
`news-settings.js` is imported by `draft.js`, `editorial-enrichment.js`,
`gemini-provider.js`, `openai-provider.js`, `news-curation.js`, and
`telegram-settings.js`; `quiet-hours.js` only by `telegram-settings.js`;
`excluded-topics.js` only by `excluded-topic-policy.js`, exactly as expected
since that module is out of scope for this ticket and is ported separately.
(`pipeline.js`, `research.js`, `telegram-control.js`, `news-scheduler.js`, and
`news-search.js` do import one or both of the first two legacy modules, but
none of the five is itself reachable from `runtime-entry.ts` -- they belong to
the legacy `telegram-bot.js` entrypoint's own require graph, not this one, so
they do not appear in this count.) Retiring those three modules for real needs
the legacy callers themselves ported, not just their typed siblings switched.

## Acceptance criteria

- v2.0.0 (or a later 2.x) has run in production for at least 72 hours with no
  rollback, verified from production logs: scheduled runs publishing, quiet
  hours holding, no duplicate publication, no restart loop.
- [x] `legacy-research-execution` and its module are deleted first -- nothing
  imported them, so this was the one removal with no porting behind it.
  Done 2026-09-24.
- Every remaining seam above is ported and removed, one PR per slice, each with
  the differential or seam test that proves the port behaves as the legacy code
  it replaces.
- `src/telegram-bot.js` and the flat `src/*.js` runtime modules are deleted
  only after no typed module imports them, proven by
  `npm run test:architecture` rather than by search.
- `compose.yaml`'s default, `ops/validate-production-env.sh`,
  `ops/production-runtime.env` and `checks/ops/production-runtime.sh` stop
  offering `src/telegram-bot.js` as a runtime in the same change that removes it.
- The rollback story is rewritten before the last legacy file goes: after this,
  rollback means the previous image, not the previous runtime.

## Constraints

- Nothing here starts before the soak period ends and the owner decides.
- Migrations stay compatible with whatever runtime a rollback could still
  reach, until that runtime is gone from every image that could be rolled
  back to.
- One slice per PR; CI green before merge.

## Rollback

Until the last legacy file is deleted, rollback is `ops/production-runtime.env`
back to `src/telegram-bot.js` and a patch release. After it, rollback is the
previous image tag.

## Blockers

- The soak period: earliest 2026-09-13.
- An explicit go from the owner.

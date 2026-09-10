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

The typed runtime still imports legacy modules through the sanctioned
`legacy-*.gateway.ts` seams, and one typed gateway reaches shared helpers:

| Seam | Legacy modules it reaches |
| --- | --- |
| `legacy-editorial-draft` | `draft.js`, `editorial-enrichment.js`, `article-tags.js`, `telegram.js` |
| `legacy-editorial-publication` | `telegram.js` |
| `legacy-notion-audit` | none directly; the composition root builds its finalizer from `notion-audit.js` |
| `legacy-research-execution` | `research.js`, `feed.js`, `gdelt.js`, `reddit.js`, `article-extractor.js`, `retry.js` -- superseded, nothing imports it |
| `typed-research-execution` | `feed.js`, `ai-usage.js`, `excluded-topic-policy.js`, `news-settings.js` |

So this is a porting job first and a deletion second: each of those slices is
ported to TypeScript, its gateway removed, and only then does the module it
wrapped become dead.

## Acceptance criteria

- v2.0.0 (or a later 2.x) has run in production for at least 72 hours with no
  rollback, verified from production logs: scheduled runs publishing, quiet
  hours holding, no duplicate publication, no restart loop.
- `legacy-research-execution` and its module are deleted first -- nothing
  imports them, so this is the one removal with no porting behind it.
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

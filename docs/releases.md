# Releasing

Production is deployed by a tag, never by a merge.

## Why the split

Merging to `main` used to ship straight to production. There was no file filter,
so a corrected comment and a rewrite of the publication path were treated
identically: both rebuilt the image and restarted the live bot. That made every
safe change expensive and made "what is production running?" unanswerable — the
honest answer was a commit SHA nobody remembers.

Now `main` is safe to merge into, and a release is a deliberate act with a name.

## The flow

```bash
# 1. Cut the snapshot from main. This branch IS the release record.
git switch -c release/v1.0.0 main

# 2. Make the snapshot describe itself.
npm version 1.0.0 --no-git-tag-version
git commit -am "Release v1.0.0"
git push -u origin release/v1.0.0        # runs the full gate, builds :<sha>

# 3. Release it. This is the only thing that touches production.
git tag v1.0.0
git push origin v1.0.0
```

| Event | Gate | Image | Production |
|---|---|---|---|
| pull request | runs | — | untouched |
| merge to `main` | runs | `:<sha>` | **untouched** |
| push to `release/**` | runs | `:<sha>` | untouched |
| push tag `v*.*.*` | skipped — see below | `:v1.0.0` + `:latest` | **deployed** |

## What the tag actually deploys

The image that was **already built and tested for that exact commit**, retagged
rather than rebuilt. A rebuild at release time ships an artifact that has never
been through the gate, however identical the source looks — different base image
digests, different transitive dependencies, a different day.

That is also why the tag does not re-run the test gate. The per-commit image
exists *only* because the push that produced it passed; requiring the same proof
twice adds six minutes between the tag and production and no certainty.

## Four refusals

A tag reaches production, so each is asserted rather than assumed.

| Refuses when | Because |
|---|---|
| the tag is not `vMAJOR.MINOR.PATCH` | two-part tags sort unpredictably and break "latest release" |
| the commit is on no `release/*` branch | production would be running code no snapshot ever recorded |
| no `:<sha>` image exists | that commit never finished CI, so it has never been tested |
| `package.json` disagrees with the tag | the tag, the image and `/status` must not disagree about what is running |

## `latest` changed meaning

It used to be moved by every merge to `main` — so it pointed at code that had
never been in production, and nothing consumed it. It is now moved only by a
release, and means *what production is running*.

## Rolling back

Not built yet, and deliberately not half-built. Every released image is still in
the registry — `ghcr.io/ferbert-dev/telegram-news-agent:v0.9.0` does not go
away — so the artifact side of rollback is already solved. What is missing is a
one-button path to deploy a named version, and adding it properly means
factoring the deploy job's SSH sequence into something reusable rather than
copying a hundred lines into a second job. Until then, the automatic rollback
inside `ops/deploy.sh` still covers the case that matters most: a deploy that
fails while it is happening.

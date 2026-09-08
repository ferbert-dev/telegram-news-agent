#!/usr/bin/env bash
#
# Whether a freshly started container may be accepted as a release.
#
# Extracted from ops/deploy.sh so it can be driven into every refusal. A gate
# that has never been observed refusing is indistinguishable from a no-op, and
# this one decides whether a bad release stays in production.
#
# Every docker call goes through $DOCKER, so a test can supply a fake and drive
# each branch without a container, a daemon or a server.

# Refuses unless the container is running, has never restarted, and — when it
# declares a healthcheck — reports healthy.
#
# The health condition is the point. Until it existed the gate accepted a
# runtime that was up and serving nothing: the typed runtime publishes a
# readiness snapshot and confirms its poller lease against PostgreSQL, and none
# of that was read. Three consecutive passes of "the process exists" is not a
# release gate; it is a liveness check wearing one's clothes.
#
# A container that declares NO healthcheck is refused rather than waved
# through. compose.yaml declares one for the bot on both runtimes, so "none"
# means the definition was lost — which is exactly the regression that would
# otherwise silently return the gate to what it was.
container_is_deployable() {
  local container="$1"
  local docker="${DOCKER:-docker}"
  local running restarts health

  [[ -n "$container" ]] || { echo "no container" >&2; return 1; }

  running="$("$docker" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
  [[ "$running" == "true" ]] || { echo "container is not running (${running})" >&2; return 1; }

  restarts="$("$docker" inspect --format '{{.RestartCount}}' "$container" 2>/dev/null || echo unknown)"
  [[ "$restarts" == "0" ]] || { echo "container has restarted ${restarts} time(s)" >&2; return 1; }

  health="$("$docker" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$container" 2>/dev/null || echo unknown)"
  case "$health" in
    healthy) return 0 ;;
    none) echo "container declares no healthcheck, so the gate has nothing to read" >&2; return 1 ;;
    *) echo "container health is ${health}" >&2; return 1 ;;
  esac
}

#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:?Usage: deploy.sh <container-image>}"
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deploy_dir"

# The release gate, in its own file so it can be driven into every refusal.
# shellcheck source=ops/lib/deploy-gate.sh
. "$deploy_dir/ops/lib/deploy-gate.sh"

active_env=".env.production"
candidate_env=".env.production.incoming"
rollback_env=".env.production.rollback"
package_version="0.1.0"
if [[ -f package.json ]]; then
  detected_package_version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n 1 || true)"
  if [[ -n "$detected_package_version" ]]; then
    package_version="$detected_package_version"
  fi
fi
image_tag="${image##*:}"
app_version="v${package_version}+${image_tag:0:7}"

if [[ ! -f "$active_env" ]]; then
  echo "$active_env is missing; refusing to replace production without a rollback base" >&2
  exit 1
fi

if [[ ! -f "$candidate_env" ]]; then
  echo "$candidate_env is missing" >&2
  exit 1
fi

chmod 600 "$active_env" "$candidate_env"
ops/validate-production-env.sh --rollback-base "$active_env"
ops/validate-production-env.sh --complete "$candidate_env"

compose=(
  docker compose
  --env-file "$active_env"
  -f compose.yaml
  -f compose.ssh-access.yaml
)

previous_container="$("${compose[@]}" ps -q bot 2>/dev/null || true)"
previous_image=""
if [[ -n "$previous_container" ]]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_container" 2>/dev/null || true)"
fi

active_hash="$(sha256sum "$active_env" | awk '{print $1}')"
candidate_hash="$(sha256sum "$candidate_env" | awk '{print $1}')"
environment_changed=true
if [[ "$active_hash" == "$candidate_hash" ]]; then
  environment_changed=false
fi
environment_promoted=false
deployment_started=false

wait_for_db_healthy() {
  local db_container db_status
  db_container="$("${compose[@]}" ps -q db 2>/dev/null || true)"
  if [[ -z "$db_container" ]]; then
    return 1
  fi

  for _ in {1..60}; do
    db_status="$(
      docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        "$db_container" 2>/dev/null || true
    )"
    if [[ "$db_status" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done

  return 1
}

rollback() {
  local rollback_failed=false restore_temp rollback_image
  trap - ERR

  if [[ "$environment_promoted" == "false" && "$deployment_started" == "false" ]]; then
    echo "Deployment stopped before production state changed; rollback is not needed." >&2
    return 0
  fi

  if [[ "$environment_promoted" == "true" ]]; then
    if [[ ! -f "$rollback_env" ]]; then
      echo "Rollback environment is missing; cannot restore production configuration." >&2
      return 1
    fi

    echo "Restoring last-known-good production environment." >&2
    restore_temp="${active_env}.restore.$$"
    if ! install -m 600 "$rollback_env" "$restore_temp" || ! mv -f "$restore_temp" "$active_env"; then
      rm -f "$restore_temp"
      echo "Failed to restore the previous production environment." >&2
      return 1
    fi

    compose=(
      docker compose
      --env-file "$active_env"
      -f compose.yaml
      -f compose.ssh-access.yaml
    )

    if ! ops/validate-production-env.sh --rollback-base "$active_env"; then
      rollback_failed=true
    fi

    rollback_image="${previous_image:-$image}"
    if ! APP_IMAGE="$rollback_image" "${compose[@]}" up -d db; then
      rollback_failed=true
    elif ! wait_for_db_healthy; then
      echo "PostgreSQL did not become healthy while restoring the previous environment." >&2
      "${compose[@]}" logs --tail=80 db >&2 || true
      rollback_failed=true
    elif ! APP_IMAGE="$rollback_image" "${compose[@]}" exec -T db \
      /docker-entrypoint-initdb.d/00-create-app-role.sh; then
      echo "Failed to restore the previous application-role credential." >&2
      rollback_failed=true
    fi
  else
    echo "Production environment hash was unchanged; no environment rollback is needed." >&2
  fi

  if [[ -n "$previous_image" ]]; then
    echo "Restoring previous bot image ${previous_image}." >&2
    rollback_tag="${previous_image##*:}"
    if ! APP_IMAGE="$previous_image" APP_VERSION="rollback-${rollback_tag:0:7}" \
      "${compose[@]}" up -d --force-recreate --no-deps bot; then
      rollback_failed=true
    fi
  else
    echo "No previous bot image was found to restore." >&2
    rollback_failed=true
  fi

  [[ "$rollback_failed" == "false" ]]
}

rollback_on_error() {
  status=$?
  trap - ERR
  rollback || true
  exit "$status"
}

if [[ "$environment_changed" == "true" ]]; then
  rollback_temp="${rollback_env}.write.$$"
  if ! install -m 600 "$active_env" "$rollback_temp" \
    || ! mv -f "$rollback_temp" "$rollback_env"; then
    rm -f "$rollback_temp"
    echo "Failed to atomically save the rollback environment; active production is unchanged." >&2
    exit 1
  fi
fi

trap rollback_on_error ERR

if [[ "$environment_changed" == "true" ]]; then
  activate_temp="${active_env}.activate.$$"
  install -m 600 "$candidate_env" "$activate_temp"
  mv -f "$activate_temp" "$active_env"
  environment_promoted=true
  rm -f "$candidate_env"
else
  rm -f "$candidate_env"
fi

compose=(
  docker compose
  --env-file "$active_env"
  -f compose.yaml
  -f compose.ssh-access.yaml
)

APP_IMAGE="$image" "${compose[@]}" pull db bot
deployment_started=true
APP_IMAGE="$image" "${compose[@]}" up -d db

if ! wait_for_db_healthy; then
  echo "PostgreSQL did not become healthy before credential reconciliation." >&2
  "${compose[@]}" logs --tail=80 db >&2 || true
  false
fi

APP_IMAGE="$image" "${compose[@]}" exec -T db \
  /docker-entrypoint-initdb.d/00-create-app-role.sh
APP_IMAGE="$image" "${compose[@]}" run --rm migrate
APP_IMAGE="$image" APP_VERSION="$app_version" "${compose[@]}" up -d --no-deps bot

# Long enough for the runtime to be able to answer.
#
# The old loop gave 30 seconds, which was fine when the gate asked only whether
# the process existed. It asks about health now, and health cannot be true yet:
# the container healthcheck has a 120s start period, the poller may spend up to
# 70s acquiring its lease, and its first getUpdates long-polls for 25 more. A
# gate that gives up before the runtime can possibly be healthy does not refuse
# bad releases -- it refuses every release.
#
# Both are overridable so the rollback tests can run in seconds without
# pretending production is faster than it is.
poll_seconds="${DEPLOY_HEALTH_POLL_SECONDS:-5}"
health_timeout_seconds="${DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}"
health_deadline=$(( SECONDS + health_timeout_seconds ))
gate_reason="the container never became healthy within ${health_timeout_seconds}s"

healthy_checks=0
while (( SECONDS < health_deadline )); do
  sleep "$poll_seconds"
  container="$("${compose[@]}" ps -q bot 2>/dev/null || true)"
  if gate_reason="$(container_is_deployable "$container" 2>&1)"; then
    healthy_checks=$((healthy_checks + 1))
    if [[ "$healthy_checks" -ge 3 ]]; then
      if ! ops/verify-production-runtime.sh "$container"; then
        "${compose[@]}" logs --tail=80 bot >&2 || true
        echo "New bot container failed its runtime credential gate." >&2
        false
      fi
      trap - ERR
      if ! ops/notify-deployment.sh "$container" "$image"; then
        echo "Deployment notification warning: the healthy release was not rolled back." >&2
      fi
      echo "Deployment healthy: ${image}"
      "${compose[@]}" ps
      exit 0
    fi
  else
    healthy_checks=0
  fi
done

"${compose[@]}" logs --tail=80 bot >&2 || true
echo "New bot container failed its health gate: ${gate_reason}" >&2
false

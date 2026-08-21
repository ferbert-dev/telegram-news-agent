#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:?Usage: deploy.sh <container-image>}"
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deploy_dir"

if [[ ! -f .env.production ]]; then
  echo ".env.production is missing" >&2
  exit 1
fi

required_variables=(
  POSTGRES_PASSWORD
  POSTGRES_APP_PASSWORD
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHANNEL_ID
  TELEGRAM_UPDATE_MODE
  GEMINI_API_KEY
  NOTION_API_KEY
  NOTION_AGENT_RUNS_DATA_SOURCE_ID
  NOTION_PIPELINE_AGENT_PAGE_ID
)

for variable in "${required_variables[@]}"; do
  if ! grep -Eq "^${variable}=.+" .env.production; then
    echo "${variable} is missing from .env.production" >&2
    exit 1
  fi
done

chmod 600 .env.production
compose=(
  docker compose
  --env-file .env.production
  -f compose.yaml
  -f compose.ssh-access.yaml
)
previous_container="$("${compose[@]}" ps -q bot 2>/dev/null || true)"
previous_image=""
if [[ -n "$previous_container" ]]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_container" 2>/dev/null || true)"
fi

rollback() {
  if [[ -z "$previous_image" ]]; then
    return
  fi
  echo "New bot container failed; restoring ${previous_image}." >&2
  APP_IMAGE="$previous_image" "${compose[@]}" up -d --force-recreate --no-deps bot
}

rollback_on_error() {
  status=$?
  trap - ERR
  rollback || true
  exit "$status"
}

APP_IMAGE="$image" "${compose[@]}" pull db bot
APP_IMAGE="$image" "${compose[@]}" up -d db

db_container="$("${compose[@]}" ps -q db)"
db_healthy=false
for _ in {1..60}; do
  db_status="$(
    docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$db_container" 2>/dev/null || true
  )"
  if [[ "$db_status" == "healthy" ]]; then
    db_healthy=true
    break
  fi
  sleep 2
done

if [[ "$db_healthy" != "true" ]]; then
  echo "PostgreSQL did not become healthy before credential reconciliation." >&2
  "${compose[@]}" logs --tail=80 db >&2 || true
  exit 1
fi

trap rollback_on_error ERR
APP_IMAGE="$image" "${compose[@]}" exec -T db \
  /docker-entrypoint-initdb.d/00-create-app-role.sh
APP_IMAGE="$image" "${compose[@]}" run --rm migrate
APP_IMAGE="$image" "${compose[@]}" up -d --no-deps bot

healthy_checks=0
for _ in {1..6}; do
  sleep 5
  container="$("${compose[@]}" ps -q bot 2>/dev/null || true)"
  if [[ -n "$container" ]] \
    && [[ "$(docker inspect --format '{{.State.Running}}' "$container")" == "true" ]] \
    && [[ "$(docker inspect --format '{{.RestartCount}}' "$container")" == "0" ]]; then
    healthy_checks=$((healthy_checks + 1))
    if [[ "$healthy_checks" -ge 3 ]]; then
      trap - ERR
      echo "Deployment healthy: ${image}"
      "${compose[@]}" ps
      exit 0
    fi
  else
    healthy_checks=0
  fi
done

"${compose[@]}" logs --tail=80 bot >&2 || true
trap - ERR
rollback
exit 1

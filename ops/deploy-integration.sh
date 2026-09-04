#!/usr/bin/env bash
#
# Deploy the integration stage.
#
# Deliberately NOT ops/deploy.sh with a flag. That script's whole shape is the
# production contract: promote an environment file, snapshot it for rollback,
# restore the previous image and environment on any failure, reconcile the
# application-role credential. Integration needs none of that — it is the stage
# you are allowed to break, and fixing it forward is the correct response to a
# bad deploy. Threading a second mode through the highest-stakes script in the
# repository to save duplication would put production's rollback path one
# untested branch away from an integration bug.
#
# What this script owes production is not rollback. It is two guarantees:
#
#   1. It can never act on production's stack. Every compose invocation is
#      pinned to the integration project, and the deploy is refused if that
#      project, or any of its volumes, resolves to production's.
#   2. It cannot starve production. The host is measured first, and the deploy
#      is refused if the integration stack's ceilings do not fit alongside
#      production's with headroom left over.
#
set -Eeuo pipefail

check_only=false
if [[ "${1:-}" == "--check-only" ]]; then
  check_only=true
  shift
fi

# --check-only runs every guard and stops before anything is started. Useful as
# a dry run before a real deploy, and it is what the capacity check is tested
# through -- a guard that has never been observed refusing is not a guard.
image="${1:-preflight}"
if [[ "$check_only" == false && -z "${1:-}" ]]; then
  echo "Usage: deploy-integration.sh [--check-only] <container-image>" >&2
  exit 1
fi
deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deploy_dir"

readonly EXPECTED_PROJECT="telegram-news-agent-int"
readonly ENV_FILE=".env.integration"

# The integration stack's ceilings, from compose.integration.yaml. Kept in step
# by assert_limits_match below rather than by memory.
readonly INT_DB_LIMIT_MIB=128
readonly INT_BOT_LIMIT_MIB=224
readonly INT_MIGRATE_LIMIT_MIB=192

# Left free for the host itself and for production to burst into. Production's
# own usage is already spoken for in what the kernel reports as unavailable
# while its containers are running; this is the margin on top.
#
# 96MiB on a 952MiB box is thin, and deliberately so: the alternative was not
# running the stage at all. It is why this stage is brought up to test and torn
# down after rather than left running.
readonly HOST_HEADROOM_MIB=96

# The peak, not the sum. migrate and bot never run together -- the migration
# completes before the bot starts -- so the stack's high-water mark is the
# database plus whichever of the two is larger. The check immediately below
# keeps that assumption true.
if (( INT_MIGRATE_LIMIT_MIB > INT_BOT_LIMIT_MIB )); then
  echo "refusing to deploy: migrate's ceiling exceeds the bot's, so the peak this script sizes for is wrong" >&2
  exit 1
fi
readonly NEEDED_MIB=$((INT_DB_LIMIT_MIB + INT_BOT_LIMIT_MIB))

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE is missing; the integration stage has no environment to start from" >&2
  exit 1
fi
chmod 600 "$ENV_FILE"

# Fails closed on a file that is missing DEPLOY_STAGE, or carries the wrong one.
# Without this a production environment file dropped into this directory by
# mistake would deploy production's bot token against integration's database.
EXPECTED_DEPLOY_STAGE=integration ops/validate-production-env.sh --complete "$ENV_FILE"

compose=(
  docker compose
  --project-name "$EXPECTED_PROJECT"
  --env-file "$ENV_FILE"
  -f compose.yaml
  -f compose.integration.yaml
)

# --- guard 1: this can only ever be the integration project ------------------

# Asserting that compose resolved to EXPECTED_PROJECT would be a tautology: the
# CLI --project-name above sets it, so the check would compare a constant to
# itself. (It was written that way first, and the test for it is what showed
# the guard could not fail.)
#
# The check that is not circular compares against production's own project,
# resolved from compose.yaml on its own. That is the value this script must
# never equal, and it comes from a file this script does not control.
# Read straight from the file rather than through `compose config`: that command
# needs every interpolated variable to be resolvable just to report a name, and
# a probe that can fail for unrelated reasons is a poor thing to gate a deploy
# on. The declaration is one line and it is the authority.
production_project="$(sed -nE 's/^name:[[:space:]]*([A-Za-z0-9_.-]+)[[:space:]]*$/\1/p' compose.yaml | head -n 1 || true)"
if [[ -z "$production_project" ]]; then
  echo "refusing to deploy: could not resolve production's compose project to compare against" >&2
  exit 1
fi
if [[ "$EXPECTED_PROJECT" == "$production_project" ]]; then
  echo "refusing to deploy: this script targets project '$EXPECTED_PROJECT', which is production's" >&2
  exit 1
fi

# The volume is what actually separates the two stages: the containers could all
# be renamed and integration would still be safe as long as it writes to its own
# PGDATA. Docker derives the real volume name by prefixing the project name onto
# the declared one, so project scoping IS the volume scoping -- but only while
# the declaration stays relative. An `external: true`, or an explicit `name:`,
# pins the volume to one identity and both stages would land on it.
#
# With env resolution on, `config` reports the fully prefixed name, so the check
# is that every volume carries this project's prefix. (An earlier version looked
# for a literal `telegram-news-agent_pgdata`, which is neither the volume's name
# nor the form `config` reports -- it could never have fired.)
bad_volumes="$("${compose[@]}" config --format json 2>/dev/null \
  | python3 -c "
import json, sys
volumes = json.load(sys.stdin).get('volumes') or {}
prefix = '$EXPECTED_PROJECT' + '_'
for key, spec in volumes.items():
    spec = spec or {}
    if spec.get('external'):
        print(f'{key}: external')
        continue
    name = spec.get('name')
    if not name:
        print(f'{key}: no resolved name')
    elif not name.startswith(prefix):
        print(f'{key}: resolves to {name}')
" 2>/dev/null || true)"
if [[ -n "$bad_volumes" ]]; then
  echo "refusing to deploy: a volume is not scoped to $EXPECTED_PROJECT" >&2
  printf '%s\n' "$bad_volumes" >&2
  echo "an external or explicitly named volume is shared between stages, so integration would write into production's data" >&2
  exit 1
fi

assert_limits_match() {
  local service="$1" expected_mib="$2" resolved
  resolved="$("${compose[@]}" config --format json 2>/dev/null \
    | python3 -c "
import json,sys
services = json.load(sys.stdin)['services']
print(services['$service'].get('mem_limit', 0))
" 2>/dev/null || echo 0)"
  if [[ "$resolved" != "$((expected_mib * 1024 * 1024))" ]]; then
    echo "refusing to deploy: $service resolves to a ${resolved}B limit but this script budgets ${expected_mib}MiB" >&2
    echo "compose.integration.yaml and ops/deploy-integration.sh have drifted; the capacity check below would be measuring the wrong number" >&2
    exit 1
  fi
}

# The capacity check is only honest while these agree. A limit raised in compose
# without raising the budget here would be admitted by a check that measured the
# old, smaller figure.
assert_limits_match db "$INT_DB_LIMIT_MIB"
assert_limits_match bot "$INT_BOT_LIMIT_MIB"
assert_limits_match migrate "$INT_MIGRATE_LIMIT_MIB"

# --- guard 2: the host has room, with production left whole ------------------

# Overridable so the capacity check can be exercised against a known figure.
# It defaults to the real kernel source and is never set in the deploy path.
meminfo_path="${DEPLOY_INTEGRATION_MEMINFO:-/proc/meminfo}"

host_available_mib() {
  # MemAvailable, not MemFree: free memory excludes reclaimable page cache and
  # would refuse a deploy on a host that is perfectly able to take it.
  local value
  value="$(awk '/^MemAvailable:/ { print int($2 / 1024); exit }' "$meminfo_path" 2>/dev/null || true)"
  if [[ -z "$value" ]]; then
    echo "refusing to deploy: could not read MemAvailable from $meminfo_path" >&2
    echo "the capacity guard cannot be skipped; without it a deploy could starve production" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# Memory the integration stack is already holding. On a redeploy its containers
# are running, so the kernel already counts their usage as unavailable — without
# adding it back, every deploy after the first would be refused by the stack's
# own footprint.
integration_held_mib() {
  local ids total=0 bytes
  ids="$("${compose[@]}" ps -q 2>/dev/null || true)"
  [[ -z "$ids" ]] && { echo 0; return; }
  while read -r id; do
    [[ -z "$id" ]] && continue
    bytes="$(docker inspect --format '{{.HostConfig.Memory}}' "$id" 2>/dev/null || echo 0)"
    total=$((total + bytes / 1024 / 1024))
  done <<< "$ids"
  echo "$total"
}

available="$(host_available_mib)"
held="$(integration_held_mib)"
budget=$((available + held))
required=$((NEEDED_MIB + HOST_HEADROOM_MIB))

printf 'HostCapacity available=%sMiB integration_already_held=%sMiB budget=%sMiB required=%sMiB (stack %s + headroom %s)\n' \
  "$available" "$held" "$budget" "$required" "$NEEDED_MIB" "$HOST_HEADROOM_MIB"

if (( budget < required )); then
  cat >&2 <<EOF
refusing to deploy: the host cannot take the integration stage.

  available now      ${available}MiB
  integration holds  ${held}MiB
  budget             ${budget}MiB
  required           ${required}MiB  (${NEEDED_MIB}MiB stack + ${HOST_HEADROOM_MIB}MiB headroom)

Production is untouched. Nothing was started.

This is the check refusing, not failing. The options are a larger instance, a
smaller integration footprint (lower the mem_limits in compose.integration.yaml
and the budget in this script together), or running integration somewhere else.
EOF
  exit 1
fi

if [[ "$check_only" == true ]]; then
  echo "Preflight passed: the host can take the integration stage. Nothing was started."
  exit 0
fi

# --- deploy ------------------------------------------------------------------

package_version="0.1.0"
if [[ -f package.json ]]; then
  detected="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' package.json | head -n 1 || true)"
  [[ -n "$detected" ]] && package_version="$detected"
fi
image_tag="${image##*:}"
app_version="v${package_version}+${image_tag:0:7}-int"

export APP_IMAGE="$image"
export APP_VERSION="$app_version"

"${compose[@]}" pull db bot
"${compose[@]}" up -d db

# Wait for the database rather than racing it. Integration's postgres is smaller
# than production's and starts faster, but a cold volume still has to initialise.
for attempt in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' \
    "$("${compose[@]}" ps -q db)" 2>/dev/null || echo starting)"
  [[ "$status" == "healthy" ]] && break
  if (( attempt == 30 )); then
    echo "integration database did not become healthy within 150s" >&2
    "${compose[@]}" logs --tail=50 db >&2 || true
    exit 1
  fi
  sleep 5
done

"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --no-deps bot

# --- liveness ----------------------------------------------------------------
#
# Three consecutive checks, matching production's gate. Integration has no
# automatic rollback, so this reports rather than reverts — but a container that
# is crash-looping should fail the job rather than be announced as deployed.

bot_id="$("${compose[@]}" ps -q bot)"
consecutive=0
for _ in $(seq 1 12); do
  sleep 5
  running="$(docker inspect --format '{{.State.Running}}' "$bot_id" 2>/dev/null || echo false)"
  restarts="$(docker inspect --format '{{.RestartCount}}' "$bot_id" 2>/dev/null || echo 99)"
  if [[ "$running" == "true" && "$restarts" == "0" ]]; then
    consecutive=$((consecutive + 1))
    (( consecutive >= 3 )) && break
  else
    consecutive=0
  fi
done

if (( consecutive < 3 )); then
  echo "integration bot did not stay up: running=${running:-?} restart_count=${restarts:-?}" >&2
  "${compose[@]}" logs --tail=80 bot >&2 || true
  exit 1
fi

# The readiness probe is the point of the typed runtime, so run it rather than
# trusting liveness. Integration is where a broken probe should be discovered.
if ! "${compose[@]}" exec -T bot node dist/composition/health-cli.js; then
  echo "integration runtime is live but reports unhealthy" >&2
  exit 1
fi

docker inspect --format \
  'IntegrationBot status={{.State.Status}} running={{.State.Running}} restart_count={{.RestartCount}} oom_killed={{.State.OOMKilled}} mem_limit={{.HostConfig.Memory}}' \
  "$bot_id"

echo "Integration stage deployed: $image ($app_version)"

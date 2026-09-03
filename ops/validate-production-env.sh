#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
env_file="${2:-}"

if [[ "$mode" != "--base" && "$mode" != "--complete" && "$mode" != "--legacy-complete" \
  && "$mode" != "--rollback-base" ]] \
  || [[ -z "$env_file" ]]; then
  echo "Usage: validate-production-env.sh <--base|--complete|--legacy-complete|--rollback-base> <env-file>" >&2
  exit 2
fi

if [[ ! -f "$env_file" ]]; then
  echo "Production environment file is missing" >&2
  exit 1
fi

if LC_ALL=C grep -n $'\r' "$env_file" >/dev/null; then
  echo "Production environment file contains CRLF line endings" >&2
  exit 1
fi

if grep -Ev '^[A-Za-z_][A-Za-z0-9_]*=.*$|^[[:space:]]*(#.*)?$' "$env_file" >/dev/null; then
  echo "Production environment file contains an invalid line" >&2
  exit 1
fi

duplicates="$(
  sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$env_file" \
    | LC_ALL=C sort \
    | uniq -d
)"
if [[ -n "$duplicates" ]]; then
  echo "Production environment file contains duplicate variable names:" >&2
  printf '%s\n' "$duplicates" >&2
  exit 1
fi

required_variables=(
  POSTGRES_PASSWORD
  POSTGRES_APP_PASSWORD
  TELEGRAM_BOT_TOKEN
)

credential_variables=(
  POSTGRES_PASSWORD
  POSTGRES_APP_PASSWORD
  TELEGRAM_BOT_TOKEN
)

if [[ "$mode" != "--rollback-base" ]]; then
  required_variables+=(
  TELEGRAM_CHANNEL_ID
  TELEGRAM_UPDATE_MODE
  OPENAI_API_KEY
  GEMINI_API_KEY
  EXA_API_KEY
  NOTION_API_KEY
  NOTION_AGENT_RUNS_DATA_SOURCE_ID
  NOTION_PIPELINE_AGENT_PAGE_ID
  )

  credential_variables+=(
    TELEGRAM_CHANNEL_ID
    OPENAI_API_KEY
    GEMINI_API_KEY
    EXA_API_KEY
    NOTION_API_KEY
    NOTION_AGENT_RUNS_DATA_SOURCE_ID
    NOTION_PIPELINE_AGENT_PAGE_ID
  )
fi

if [[ "$mode" != "--legacy-complete" && "$mode" != "--rollback-base" ]]; then
  required_variables+=(
    POSTGRES_SSH_TUNNEL_PORT
    TELEGRAM_POLLING_MIGRATE_WEBHOOK
    TELEGRAM_NEWS_JOB_MODE
    APPROVAL_POLICY
    AI_PROVIDER_ORDER
    EXA_ENABLED
    EXA_SEARCH_TYPE
    EXA_DAILY_SEARCH_CAP
    EXA_MAX_RESULTS
    OPENAI_MODEL
    OPENAI_REASONING_EFFORT
    GEMINI_MODEL
  )
fi

for variable in "${required_variables[@]}"; do
  if ! grep -Eq "^${variable}=.+" "$env_file"; then
    echo "${variable} is missing from production environment" >&2
    exit 1
  fi
done

for variable in "${credential_variables[@]}"; do
  value="$(sed -nE "s/^${variable}=//p" "$env_file")"
  if printf '%s' "$value" \
    | grep -Eqi 'placeholder|change-me|changeme|local-integration'; then
    echo "${variable} contains a forbidden production placeholder" >&2
    exit 1
  fi
done

# Stage guard. The two stages share this validator, one age recipient and one
# host, so the only thing standing between them is which environment file is
# promoted. A file that says which stage it belongs to lets the deploy refuse a
# mismatch outright, instead of discovering it when the wrong bot starts posting
# to the wrong channel.
#
# Absent means production, so today's file needs no change.
# Absent means production, so today's file needs no change. Present-but-empty is
# rejected rather than defaulted: an integration file whose stage was blanked by
# accident would otherwise read as production, and this is the one value where
# guessing has real consequences.
if grep -Eq '^DEPLOY_STAGE=[[:space:]]*$' "$env_file"; then
  echo "DEPLOY_STAGE is present but empty; remove the line or set production or integration" >&2
  exit 1
fi
stage="$(sed -nE 's/^DEPLOY_STAGE=//p' "$env_file" | head -1)"
case "${stage:-production}" in
  production|integration) ;;
  *)
    echo "DEPLOY_STAGE must be production or integration, got '${stage}'" >&2
    exit 1
    ;;
esac

if [[ -n "${EXPECTED_DEPLOY_STAGE:-}" && "${stage:-production}" != "$EXPECTED_DEPLOY_STAGE" ]]; then
  echo "This environment is for '${stage:-production}' but the deploy expects '${EXPECTED_DEPLOY_STAGE}'" >&2
  exit 1
fi

# Integration must never be able to reach production's channel. The validator
# cannot see production's value -- it is encrypted, and decrypting it here would
# be worse than the problem -- so the rule is expressed the other way round: the
# integration file has to name its own channel, and the deploy passes the one it
# expects.
if [[ "${stage:-production}" == "integration" && -n "${EXPECTED_CHANNEL_ID:-}" ]]; then
  channel="$(sed -nE 's/^TELEGRAM_CHANNEL_ID=//p' "$env_file" | head -1)"
  if [[ "$channel" != "$EXPECTED_CHANNEL_ID" ]]; then
    echo "Integration environment names channel '${channel}', not the expected integration channel" >&2
    exit 1
  fi
fi

# The cutover switch. Optional -- an environment that never mentions it runs the
# legacy entrypoint, which is compose.yaml's default. But a typo here does not
# produce a helpful error at deploy time, it produces a container that cannot
# start and a rollback that has to be driven by hand, so only the two real
# runtimes are accepted. Checked in every mode, including --rollback-base: a bad
# value is dangerous whichever direction it is travelling.
if grep -Eq '^BOT_ENTRYPOINT=' "$env_file"; then
  bot_entrypoint="$(sed -nE 's/^BOT_ENTRYPOINT=//p' "$env_file")"
  case "$bot_entrypoint" in
    src/telegram-bot.js|dist/composition/runtime-entry.js) ;;
    *)
      echo "BOT_ENTRYPOINT must be src/telegram-bot.js or dist/composition/runtime-entry.js, or the line removed entirely, got '${bot_entrypoint}'" >&2
      exit 1
      ;;
  esac
fi

if [[ "$mode" != "--legacy-complete" && "$mode" != "--rollback-base" ]]; then
  present_variables=(
    EXA_MODEL
    NOTION_PIPELINE_TICKET_PAGE_ID
  )

  for variable in "${present_variables[@]}"; do
    if ! grep -Eq "^${variable}=" "$env_file"; then
      echo "${variable} is missing from production environment" >&2
      exit 1
    fi
  done
fi

if [[ "$mode" != "--base" ]] \
  && grep -Eqi '^EXA_ENABLED=(1|true|yes|on)$' "$env_file" \
  && ! grep -Eq '^EXA_API_KEY=.+' "$env_file"; then
  echo "EXA_API_KEY is required when EXA_ENABLED is true" >&2
  exit 1
fi

echo "Production environment validation passed (${mode#--})."

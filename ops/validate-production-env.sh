#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
env_file="${2:-}"

if [[ "$mode" != "--base" && "$mode" != "--complete" && "$mode" != "--legacy-complete" ]] \
  || [[ -z "$env_file" ]]; then
  echo "Usage: validate-production-env.sh <--base|--complete|--legacy-complete> <env-file>" >&2
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
  TELEGRAM_CHANNEL_ID
  TELEGRAM_UPDATE_MODE
  OPENAI_API_KEY
  GEMINI_API_KEY
  EXA_API_KEY
  NOTION_API_KEY
  NOTION_AGENT_RUNS_DATA_SOURCE_ID
  NOTION_PIPELINE_AGENT_PAGE_ID
)

if [[ "$mode" != "--legacy-complete" ]]; then
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

credential_variables=(
  POSTGRES_PASSWORD
  POSTGRES_APP_PASSWORD
  TELEGRAM_BOT_TOKEN
  TELEGRAM_CHANNEL_ID
  OPENAI_API_KEY
  GEMINI_API_KEY
  EXA_API_KEY
  NOTION_API_KEY
  NOTION_AGENT_RUNS_DATA_SOURCE_ID
  NOTION_PIPELINE_AGENT_PAGE_ID
)

for variable in "${credential_variables[@]}"; do
  value="$(sed -nE "s/^${variable}=//p" "$env_file")"
  if printf '%s' "$value" \
    | grep -Eqi 'placeholder|change-me|changeme|local-integration'; then
    echo "${variable} contains a forbidden production placeholder" >&2
    exit 1
  fi
done

if [[ "$mode" != "--legacy-complete" ]]; then
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

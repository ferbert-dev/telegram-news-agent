#!/usr/bin/env bash
#
# The two guards in ops/deploy-integration.sh that exist to protect production.
#
# Both are refusals, and a refusal that has never been observed refusing is
# indistinguishable from a no-op. These drive the script with --check-only and a
# controlled MemAvailable, so the arithmetic and the drift check are exercised
# rather than assumed.
#
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo/ops/deploy-integration.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

meminfo() {
  printf 'MemTotal:       %8d kB\nMemFree:         1000000 kB\nMemAvailable:   %8d kB\n' \
    $(( $1 * 1024 * 2 )) $(( $1 * 1024 )) > "$work/meminfo"
  printf '%s' "$work/meminfo"
}

# The script requires an environment file it can validate. Build a minimal one
# that satisfies ops/validate-production-env.sh in integration mode.
#
# Any existing file is set aside and restored afterwards, rather than reused.
# CI creates an empty `.env.integration` so `docker compose config` can resolve
# the project, and adopting that as the fixture would fail validation here --
# which is exactly what happened. Owning the fixture unconditionally means this
# suite does not care what else has written to that path.
env_file="$repo/.env.integration"
saved_env=""
if [[ -f "$env_file" ]]; then
  saved_env="$work/env.integration.saved"
  cp "$env_file" "$saved_env"
fi
cat > "$env_file" <<'EOF'
DEPLOY_STAGE=integration
BOT_ENTRYPOINT=dist/composition/runtime-entry.js
POSTGRES_PASSWORD=test-superuser-password
POSTGRES_APP_PASSWORD=test-application-password
TELEGRAM_BOT_TOKEN=000:test-token
TELEGRAM_CHANNEL_ID=@test-integration
TELEGRAM_UPDATE_MODE=polling
TELEGRAM_POLLING_MIGRATE_WEBHOOK=false
TELEGRAM_NEWS_JOB_MODE=enabled
APPROVAL_POLICY=manual
POSTGRES_SSH_TUNNEL_PORT=55434
AI_PROVIDER_ORDER=gemini,openai
OPENAI_API_KEY=test-openai
OPENAI_MODEL=gpt-test
OPENAI_REASONING_EFFORT=low
GEMINI_API_KEY=test-gemini
GEMINI_MODEL=gemini-test
EXA_API_KEY=test-exa-unused
EXA_ENABLED=false
EXA_SEARCH_TYPE=auto
EXA_DAILY_SEARCH_CAP=0
EXA_MAX_RESULTS=0
EXA_MODEL=
NOTION_API_KEY=test-notion
NOTION_AGENT_RUNS_DATA_SOURCE_ID=test-ds
NOTION_PIPELINE_AGENT_PAGE_ID=test-page
NOTION_PIPELINE_TICKET_PAGE_ID=test-ticket
EOF
chmod 600 "$env_file"
cleanup_env() {
  if [[ -n "$saved_env" ]]; then
    cp "$saved_env" "$env_file"
  else
    rm -f "$env_file"
  fi
}
# cleanup_env restores from a copy inside $work, so $work is removed last.
trap 'cleanup_env; rm -rf "$work"' EXIT

echo "deploy-integration guards"

# --- capacity ----------------------------------------------------------------
# Stack is 352MiB (db 128 + bot 224), headroom 96MiB, so the threshold is
# 448MiB. The host this is sized for reports 461MiB available.

run_check() {
  DEPLOY_INTEGRATION_MEMINFO="$1" "$script" --check-only 2>&1 || true
}

out="$(run_check "$(meminfo 400)")"
if grep -q "refusing to deploy: the host cannot take" <<< "$out"; then
  pass "400MiB available is refused (below the 448MiB threshold)"
else
  fail "400MiB available should be refused, got: $(head -3 <<< "$out")"
fi

out="$(run_check "$(meminfo 447)")"
if grep -q "refusing to deploy: the host cannot take" <<< "$out"; then
  pass "447MiB is refused — the boundary is not off by one in the permissive direction"
else
  fail "447MiB should be refused, got: $(head -3 <<< "$out")"
fi

out="$(run_check "$(meminfo 448)")"
if grep -q "Preflight passed" <<< "$out"; then
  pass "448MiB is admitted — exactly the requirement is enough"
else
  fail "448MiB should be admitted, got: $(head -3 <<< "$out")"
fi

out="$(run_check "$(meminfo 461)")"
if grep -q "Preflight passed" <<< "$out"; then
  pass "461MiB is admitted — the figure the real Oracle host reported"
else
  fail "461MiB (the real host) should be admitted, got: $(head -3 <<< "$out")"
fi

# The guard must never be skippable. A missing or unreadable meminfo has to be a
# refusal, not a default that lets the deploy through.
out="$(DEPLOY_INTEGRATION_MEMINFO="$work/does-not-exist" "$script" --check-only 2>&1 || true)"
if grep -q "could not read MemAvailable" <<< "$out"; then
  pass "an unreadable meminfo refuses rather than defaulting"
else
  fail "unreadable meminfo should refuse, got: $(head -3 <<< "$out")"
fi

# A meminfo without the MemAvailable line at all — an older kernel, or a
# truncated read. Same requirement: refuse.
printf 'MemTotal: 2000000 kB\nMemFree: 900000 kB\n' > "$work/no-available"
out="$(DEPLOY_INTEGRATION_MEMINFO="$work/no-available" "$script" --check-only 2>&1 || true)"
if grep -q "could not read MemAvailable" <<< "$out"; then
  pass "a meminfo with no MemAvailable line refuses"
else
  fail "missing MemAvailable should refuse, got: $(head -3 <<< "$out")"
fi

# --- limit drift -------------------------------------------------------------
# The capacity number is only meaningful while the script's budget matches what
# compose actually applies. Raise the compose limit and the check must refuse,
# because it would otherwise be admitting a deploy it measured too small.

overlay="$repo/compose.integration.yaml"
cp "$overlay" "$work/overlay.bak"
restore_overlay() { cp "$work/overlay.bak" "$overlay"; }
trap 'restore_overlay; cleanup_env; rm -rf "$work"' EXIT

sed -i.tmp 's/^    mem_limit: 224m$/    mem_limit: 900m/' "$overlay" && rm -f "$overlay.tmp"
out="$(run_check "$(meminfo 4096)")"
if grep -q "have drifted" <<< "$out"; then
  pass "raising the compose limit without the script's budget is refused"
else
  fail "a raised compose limit should be refused, got: $(head -3 <<< "$out")"
fi
restore_overlay

# And the control: with the overlay restored, the same generous host passes.
out="$(run_check "$(meminfo 4096)")"
if grep -q "Preflight passed" <<< "$out"; then
  pass "the restored overlay passes again (the drift test was the cause)"
else
  fail "restored overlay should pass, got: $(head -3 <<< "$out")"
fi

# --- isolation ---------------------------------------------------------------
# The volume is the boundary that matters. A volume pinned to a fixed name, or
# declared external, is shared between the stages no matter what the containers
# are called — which is precisely how integration would end up writing into
# production's PGDATA.

cat >> "$overlay" <<'YAML'

volumes:
  postgres_data:
    name: telegram-news-agent_postgres_data
YAML
out="$(run_check "$(meminfo 4096)")"
if grep -q "not scoped to telegram-news-agent-int" <<< "$out"; then
  pass "a volume pinned to production's name is refused"
else
  fail "a production-named volume should be refused, got: $(head -3 <<< "$out")"
fi
restore_overlay

cat >> "$overlay" <<'YAML'

volumes:
  postgres_data:
    external: true
    name: shared_pgdata
YAML
out="$(run_check "$(meminfo 4096)")"
if grep -q "not scoped to telegram-news-agent-int" <<< "$out"; then
  pass "an external volume is refused"
else
  fail "an external volume should be refused, got: $(head -3 <<< "$out")"
fi
restore_overlay

# The script must refuse to target production's project. This is the guard that
# replaced a tautological one: asserting compose resolved to the project the
# script itself passed on the CLI compared a constant to itself and could never
# fail. Here the comparison value comes from compose.yaml, which this script
# does not control.
script_copy="$repo/ops/.deploy-integration-hijacked.sh"
cp "$script" "$script_copy"
chmod 755 "$script_copy"
sed -i.tmp 's/^readonly EXPECTED_PROJECT="telegram-news-agent-int"$/readonly EXPECTED_PROJECT="telegram-news-agent"/' \
  "$script_copy" && rm -f "$script_copy.tmp"
# Run it from the repo so it resolves the real compose files.
out="$(DEPLOY_INTEGRATION_MEMINFO="$(meminfo 4096)" bash "$script_copy" --check-only 2>&1 || true)"
if grep -q "which is production's" <<< "$out"; then
  pass "a script retargeted at production's project refuses"
else
  fail "targeting production's project should refuse, got: $(head -3 <<< "$out")"
fi
rm -f "$script_copy"

out="$(run_check "$(meminfo 4096)")"
if grep -q "Preflight passed" <<< "$out"; then
  pass "the restored overlay still passes after the isolation mutations"
else
  fail "restored overlay should pass, got: $(head -3 <<< "$out")"
fi

echo
if (( failures > 0 )); then
  echo "$failures guard check(s) failed" >&2
  exit 1
fi
echo "all deploy-integration guards behave as required"

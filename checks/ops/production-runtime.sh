#!/usr/bin/env bash
#
# ops/production-runtime.env is the production runtime switch. The deploy job
# appends it to a decrypted secrets file on every release, so it must be
# exactly one BOT_ENTRYPOINT line naming a runtime that exists -- anything else
# either fails the release late, on the server, or smuggles a second setting in
# beside the secrets without review.
#
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
file="$repo/ops/production-runtime.env"
workflow="$repo/.github/workflows/deploy.yml"

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

settings="$(grep -vE '^[[:space:]]*(#|$)' "$file" || true)"
count="$(printf '%s' "$settings" | grep -c . || true)"

if [[ "$count" == 1 ]]; then pass "exactly one setting"; else fail "expected exactly one setting, found ${count}"; fi
if [[ "$settings" =~ ^BOT_ENTRYPOINT= ]]; then pass "the setting is BOT_ENTRYPOINT"; else fail "only BOT_ENTRYPOINT may live here, found: ${settings}"; fi

value="${settings#BOT_ENTRYPOINT=}"
case "$value" in
  src/telegram-bot.js|dist/composition/runtime-entry.js) pass "names a runtime the validator accepts (${value})" ;;
  *) fail "BOT_ENTRYPOINT=${value} is not a runtime ops/validate-production-env.sh accepts" ;;
esac

# The compiled entry only exists in the image if its source does.
if [[ "$value" == dist/* ]]; then
  source="src/${value#dist/}"; source="${source%.js}.ts"
else
  source="$value"
fi
if [[ -f "$repo/$source" ]]; then pass "${value} is built from ${source}"; else fail "${value} has no source at ${source}"; fi

# The two things the deploy job must do with it, or the file is decoration.
if grep -qF 'grep -E '"'"'^BOT_ENTRYPOINT='"'"' ops/production-runtime.env >> "$RUNNER_TEMP/production.env"' "$workflow"; then
  pass "the deploy job appends the switch"
else
  fail "the deploy job no longer appends ops/production-runtime.env"
fi
if grep -qF 'it belongs in ops/production-runtime.env only' "$workflow"; then
  pass "the deploy job refuses a second definition in SOPS"
else
  fail "the deploy job no longer refuses BOT_ENTRYPOINT in SOPS"
fi

if (( failures > 0 )); then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "production runtime switch: all checks passed"

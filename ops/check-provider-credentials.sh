#!/usr/bin/env bash
#
# Ask each AI provider whether it accepts the key in an encrypted environment
# file. Run this BEFORE committing a key change.
#
# Three deploy cycles were spent discovering a rejected OpenAI key through the
# integration stage. Each one is a multi-architecture image build, a push, and a
# deploy, to learn something the provider will answer in under a second.
#
# Nothing is printed but the key's length and the provider's verdict. The value
# is held in a shell variable, never echoed, never written to disk, never passed
# as an argument (which would put it in `ps` output), and unset on exit.
#
# Usage:
#   ops/check-provider-credentials.sh [secrets/integration.env.sops]
#
set -Eeuo pipefail

file="${1:-secrets/integration.env.sops}"

if [[ ! -f "$file" ]]; then
  echo "no such file: $file" >&2
  exit 1
fi

if ! command -v sops >/dev/null 2>&1; then
  echo "sops is not installed" >&2
  exit 1
fi

plaintext=""
cleanup() { plaintext=""; unset plaintext; }
trap cleanup EXIT

if ! plaintext="$(sops decrypt --input-type dotenv --output-type dotenv "$file" 2>/dev/null)"; then
  echo "could not decrypt $file — is your age key at ~/.config/sops/age/keys.txt?" >&2
  exit 1
fi

value_of() {
  printf '%s\n' "$plaintext" | sed -nE "s/^$1=//p" | head -n 1
}

status=0

probe() {
  local name="$1" key="$2" url="$3" header="$4"
  if [[ -z "$key" ]]; then
    printf '  %-10s not set\n' "$name"
    return
  fi
  local trimmed="${key#"${key%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  local whitespace="no"
  [[ "$key" != "$trimmed" ]] && whitespace="YES — this alone will cause a 401"

  local code
  if [[ -n "$header" ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" -H "${header}${key}" || echo 000)"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${url}${key}" || echo 000)"
  fi

  local verdict
  case "$code" in
    200) verdict="accepted" ;;
    401|403) verdict="REJECTED — the provider does not recognise this key"; status=1 ;;
    429) verdict="rate limited — the key is valid but throttled right now" ;;
    000) verdict="no response — network or timeout, not a verdict on the key" ;;
    *)   verdict="unexpected status"; status=1 ;;
  esac
  printf '  %-10s len=%-4s whitespace=%-4s http=%-4s %s\n' "$name" "${#key}" "$whitespace" "$code" "$verdict"
}

echo "Credentials in $file"
probe openai "$(value_of OPENAI_API_KEY)" "https://api.openai.com/v1/models" "Authorization: Bearer "
probe gemini "$(value_of GEMINI_API_KEY)" "https://generativelanguage.googleapis.com/v1beta/models?key=" ""

# OpenRouter DOES have a free credential endpoint, unlike Exa below. Verified
# rather than assumed: GET /api/v1/key with a deliberately invalid key returns
# 401, so a 200 here means the key is genuinely accepted. It reads key metadata
# and runs no inference, so the check costs nothing.
probe openrouter "$(value_of OPEN_ROUTER_API_KEY)" "https://openrouter.ai/api/v1/key" "Authorization: Bearer "

# Exa is reported but deliberately NOT probed. Checked against Exa's API
# reference (exa.ai/docs) rather than assumed:
#
#   - There is no free credential endpoint. No /usage, /account or /me. The
#     only way to learn whether a key is accepted is to run a search, and
#     searches are metered -- EXA_DAILY_SEARCH_CAP exists because they cost.
#     A credential check that spends quota every time it runs is a bad trade.
#   - Auth is `Authorization: Bearer <key>`, and /search is POST-only.
#
# An earlier version of this probe sent `x-api-key` in a GET and reported the
# resulting 404 as a rejected key. Both the header and the method were wrong;
# the key was fine. Our own provider does not hand-roll this at all -- it uses
# the official exa-js SDK (src/exa-provider.js) -- so there is no request shape
# here worth duplicating.
exa_key="$(value_of EXA_API_KEY)"
if [[ "$(value_of EXA_ENABLED)" != "true" ]]; then
  printf '  %-10s not enabled (EXA_ENABLED is not true)\n' "exa"
elif [[ -z "$exa_key" ]]; then
  printf '  %-10s ENABLED BUT NOT SET\n' "exa"
  status=1
else
  exa_trimmed="${exa_key#"${exa_key%%[![:space:]]*}"}"
  exa_trimmed="${exa_trimmed%"${exa_trimmed##*[![:space:]]}"}"
  if [[ "$exa_key" != "$exa_trimmed" ]]; then
    printf '  %-10s len=%-4s whitespace=YES — this alone will cause a 401\n' "exa" "${#exa_key}"
    status=1
  else
    printf '  %-10s len=%-4s whitespace=no   set, not probed (a probe costs a metered search)\n' \
      "exa" "${#exa_key}"
  fi
fi
unset exa_key exa_trimmed

echo
if (( status == 0 )); then
  echo "All configured providers accepted their key."
else
  echo "At least one key was rejected. Fix it before committing:" >&2
  echo "  EDITOR=\"code --wait\" sops edit $file" >&2
  echo "  (the --wait matters: without it the editor returns immediately and sops re-encrypts the unmodified file)" >&2
fi
exit "$status"

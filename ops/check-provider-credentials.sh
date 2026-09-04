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
    printf '  %-8s not set\n' "$name"
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
  printf '  %-8s len=%-4s whitespace=%-4s http=%-4s %s\n' "$name" "${#key}" "$whitespace" "$code" "$verdict"
}

echo "Credentials in $file"
probe openai "$(value_of OPENAI_API_KEY)" "https://api.openai.com/v1/models" "Authorization: Bearer "
probe gemini "$(value_of GEMINI_API_KEY)" "https://generativelanguage.googleapis.com/v1beta/models?key=" ""

echo
if (( status == 0 )); then
  echo "All configured providers accepted their key."
else
  echo "At least one key was rejected. Fix it before committing:" >&2
  echo "  EDITOR=\"code --wait\" sops edit $file" >&2
  echo "  (the --wait matters: without it the editor returns immediately and sops re-encrypts the unmodified file)" >&2
fi
exit "$status"

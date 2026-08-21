#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
encrypted_file="$repo_root/secrets/production.env.sops"
key_file="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/telegram-news-agent-production.txt}"
command_name="${1:-}"

usage() {
  cat >&2 <<'EOF'
Usage:
  sops-production-env.sh edit
  sops-production-env.sh validate
  sops-production-env.sh decrypt [output-file]
  sops-production-env.sh encrypt [input-file]
EOF
  exit 2
}

for executable in sops age-keygen; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "$executable is required; on macOS run: brew install sops age" >&2
    exit 1
  fi
done

if [[ ! -f "$key_file" ]]; then
  echo "SOPS age key is missing: $key_file" >&2
  exit 1
fi

validate_encrypted() {
  local plaintext
  plaintext="$(mktemp "${TMPDIR:-/tmp}/telegram-news-production.XXXXXX")"
  chmod 600 "$plaintext"
  trap 'rm -f "$plaintext"' RETURN
  SOPS_AGE_KEY_FILE="$key_file" \
    sops decrypt --input-type dotenv --output-type dotenv "$encrypted_file" > "$plaintext"
  "$repo_root/ops/validate-production-env.sh" --base "$plaintext"
  rm -f "$plaintext"
  trap - RETURN
}

case "$command_name" in
  edit)
    SOPS_AGE_KEY_FILE="$key_file" \
      sops --input-type dotenv --output-type dotenv "$encrypted_file"
    validate_encrypted
    ;;
  validate)
    validate_encrypted
    ;;
  decrypt)
    output_file="${2:-$repo_root/.env.production.local}"
    temp_output="$(mktemp "${TMPDIR:-/tmp}/telegram-news-production.XXXXXX")"
    trap 'rm -f "$temp_output"' EXIT
    chmod 600 "$temp_output"
    SOPS_AGE_KEY_FILE="$key_file" \
      sops decrypt --input-type dotenv --output-type dotenv "$encrypted_file" > "$temp_output"
    "$repo_root/ops/validate-production-env.sh" --base "$temp_output"
    install -m 600 "$temp_output" "$output_file"
    echo "Decrypted production base written to $output_file; delete it after re-encryption."
    ;;
  encrypt)
    input_file="${2:-$repo_root/.env.production.local}"
    if [[ ! -f "$input_file" ]]; then
      echo "Plaintext input is missing: $input_file" >&2
      exit 1
    fi
    "$repo_root/ops/validate-production-env.sh" --base "$input_file"
    recipient="$(age-keygen -y "$key_file")"
    install -d -m 755 "$(dirname "$encrypted_file")"
    encrypted_temp="$(mktemp "$repo_root/secrets/.production.env.sops.XXXXXX")"
    trap 'rm -f "$encrypted_temp"' EXIT
    sops encrypt \
      --filename-override "$encrypted_file" \
      --input-type dotenv \
      --output-type dotenv \
      --age "$recipient" \
      "$input_file" > "$encrypted_temp"
    chmod 644 "$encrypted_temp"
    mv "$encrypted_temp" "$encrypted_file"
    trap - EXIT
    validate_encrypted
    echo "Encrypted production configuration updated: $encrypted_file"
    echo "Plaintext input remains at $input_file; delete it when no longer needed."
    ;;
  *)
    usage
    ;;
esac

#!/usr/bin/env bash
#
# The release gate in ops/lib/deploy-gate.sh, driven into every refusal.
#
# It decides whether a bad release stays in production, and until recently it
# accepted a runtime that was up and serving nothing: three consecutive passes
# of "the process exists" is a liveness check wearing a release gate's clothes.
# A gate that has never been observed refusing is indistinguishable from a
# no-op, so each branch is exercised here with a fake docker.
#
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# shellcheck source=../../ops/lib/deploy-gate.sh
. "$repo/ops/lib/deploy-gate.sh"

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

# A docker whose answers are read from files, so each branch is reachable
# without a daemon, a container or a server.
cat > "$work/docker" <<'FAKE'
#!/usr/bin/env bash
format="$3"
case "$format" in
  *State.Running*) cat "$FAKE_STATE_DIR/running" ;;
  *RestartCount*)  cat "$FAKE_STATE_DIR/restarts" ;;
  *Health*)        cat "$FAKE_STATE_DIR/health" ;;
  *) echo "unexpected format: $format" >&2; exit 2 ;;
esac
FAKE
chmod +x "$work/docker"
export DOCKER="$work/docker" FAKE_STATE_DIR="$work"

state() { printf '%s' "$1" > "$work/running"; printf '%s' "$2" > "$work/restarts"; printf '%s' "$3" > "$work/health"; }

expect_pass() {
  if container_is_deployable "container" 2>/dev/null; then pass "$1"; else fail "$1"; fi
}
expect_refusal() {
  local label="$1" pattern="$2" reason
  if reason="$(container_is_deployable "container" 2>&1)"; then
    fail "$label — accepted when it should have refused"
  elif [[ "$reason" == *"$pattern"* ]]; then
    pass "$label"
  else
    fail "$label — refused, but said: $reason"
  fi
}

state true 0 healthy
expect_pass "a running, never-restarted, healthy container is accepted"

state true 0 unhealthy
expect_refusal "an unhealthy container is refused" "health is unhealthy"

state true 0 starting
expect_refusal "a container still starting is refused, not waited out here" "health is starting"

# The regression this exists to catch. compose.yaml declares a healthcheck for
# the bot on both runtimes, so "none" means the definition was lost -- and
# waving it through would silently return the gate to what it was before.
state true 0 none
expect_refusal "a container with no healthcheck is refused" "no healthcheck"

state false 0 healthy
expect_refusal "a container that is not running is refused" "not running"

state true 2 healthy
expect_refusal "a container that has restarted is refused" "restarted 2 time(s)"

if ! container_is_deployable "" 2>/dev/null; then
  pass "an empty container id is refused"
else
  fail "an empty container id is refused"
fi

# Every file deploy.sh sources must be in the deployment bundle.
#
# The bundle names each script explicitly, so a file the script reads but
# nobody installs fails on the server and nowhere else. Extracting the gate
# into ops/lib/ would have done exactly that.
workflow="$repo/.github/workflows/deploy.yml"
while read -r sourced; do
  [[ -n "$sourced" ]] || continue
  if grep -q "install -m [0-7]* ${sourced} deployment/${sourced}" "$workflow"; then
    pass "the deployment bundle installs ${sourced}"
  else
    fail "deploy.sh sources ${sourced}, and the bundle never installs it"
  fi
done < <(grep -oE '\$deploy_dir/(ops/[A-Za-z0-9_/.-]+)' "$repo/ops/deploy.sh" | sed 's#^\$deploy_dir/##' | sort -u)

echo
if (( failures == 0 )); then
  echo "the release gate refuses every state it should"
else
  echo "$failures gate check(s) failed" >&2
  exit 1
fi

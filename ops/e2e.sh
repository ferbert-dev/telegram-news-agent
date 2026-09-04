#!/usr/bin/env bash
#
# The local end-to-end rig: a disposable PostgreSQL, the real migrations, and
# the full /news flow with every paid or networked dependency faked.
#
# The point is that it costs nothing and needs nothing. No API keys, no bot
# token, no production environment file, no network beyond pulling the postgres
# image once.
#
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

readonly PROJECT="telegram-news-agent-e2e"
readonly PORT=55499
readonly URL="postgresql://telegram_news_app:e2e-local-only-app@127.0.0.1:${PORT}/telegram_news"

compose=(docker compose -p "$PROJECT" -f compose.e2e.yaml)

case "${1:-run}" in
  up)
    "${compose[@]}" up -d db
    printf 'waiting for postgres'
    for _ in $(seq 1 60); do
      id="$("${compose[@]}" ps -q db)"
      state="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)"
      [[ "$state" == "healthy" ]] && { echo " ready"; break; }
      printf '.'; sleep 2
    done
    [[ "${state:-}" == "healthy" ]] || { echo " never became healthy" >&2; "${compose[@]}" logs --tail=30 db >&2; exit 1; }
    # Migrate as the APPLICATION role, not as postgres.
    #
    # This is not a detail. Several tables have row-level security enabled with
    # no permissive policy, so access depends on ownership -- and a table's
    # owner is whoever created it. Migrating as postgres leaves the app role
    # locked out of its own schema, and every integration test fails with
    # "new row violates row-level security policy" against a schema that looks
    # completely correct.
    #
    # CI and production both migrate as telegram_news_app. A rig that did
    # otherwise would not be testing the same database.
    DATABASE_URL="$URL" node scripts/migrate.mjs
    echo "Rig ready on 127.0.0.1:${PORT}"
    ;;
  down)
    # -v because a rig that accumulates state stops being a clean check.
    "${compose[@]}" down -v --remove-orphans
    echo "Rig removed, volume included."
    ;;
  run)
    RUN_DATABASE_INTEGRATION=1 DATABASE_TEST_URL="$URL" \
      npx tsx --test checks/e2e/*.ts
    ;;
  all)
    "$0" up
    trap '"$0" down >/dev/null 2>&1 || true' EXIT
    "$0" run
    ;;
  *)
    echo "Usage: ops/e2e.sh [up|run|down|all]" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
set -Eeuo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deploy_dir"

if [[ ! -f .env.production ]]; then
  echo ".env.production is missing" >&2
  exit 1
fi
if [[ ! -f compose.ssh-access.yaml ]]; then
  echo "compose.ssh-access.yaml is missing" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the observer password" >&2
  exit 1
fi

compose=(
  docker compose
  --env-file .env.production
  -f compose.yaml
  -f compose.ssh-access.yaml
)

"${compose[@]}" up -d db

observer_password="$(openssl rand -hex 24)"

"${compose[@]}" exec -T db psql \
  --set=ON_ERROR_STOP=1 \
  --set=observer_password="$observer_password" \
  --username postgres \
  --dbname telegram_news <<'SQL'
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'telegram_news_observer'
  ) then
    create role telegram_news_observer nologin;
  end if;
end
$$;

alter role telegram_news_observer
  nologin
  nosuperuser
  nocreatedb
  nocreaterole
  noreplication
  bypassrls
  connection limit 2;

select format(
  'alter role telegram_news_observer password %L',
  :'observer_password'
)
\gexec

revoke all on database telegram_news from telegram_news_observer;
grant connect on database telegram_news to telegram_news_observer;
revoke all on schema public from telegram_news_observer;
grant usage on schema public to telegram_news_observer;
revoke all on all tables in schema public from telegram_news_observer;
grant select on all tables in schema public to telegram_news_observer;
revoke all on all sequences in schema public from telegram_news_observer;
revoke execute on all functions in schema public from telegram_news_observer;

alter default privileges for role telegram_news_app in schema public
  grant select on tables to telegram_news_observer;
alter default privileges for role telegram_news_app
  revoke execute on functions from public;
alter default privileges for role telegram_news_app in schema public
  revoke execute on functions from telegram_news_observer;

alter role telegram_news_observer set default_transaction_read_only = on;
alter role telegram_news_observer set statement_timeout = '30s';
alter role telegram_news_observer
  set idle_in_transaction_session_timeout = '60s';

alter role telegram_news_observer login;
SQL

port="${POSTGRES_SSH_TUNNEL_PORT:-55432}"
echo "Database observer is ready."
echo "Host from the Oracle VM: 127.0.0.1"
echo "Port from the Oracle VM: ${port}"
echo "Database: telegram_news"
echo "User: telegram_news_observer"
echo "Password: ${observer_password}"
echo "The generated password was displayed only during this run; rerun the script to rotate it."

unset observer_password

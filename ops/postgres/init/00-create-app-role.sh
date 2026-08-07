#!/bin/sh
set -eu

if [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
  echo "POSTGRES_APP_PASSWORD is required" >&2
  exit 1
fi

psql \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
select format('create role telegram_news_app login password %L', :'app_password')
where not exists (select 1 from pg_roles where rolname = 'telegram_news_app')
\gexec

select format('alter role telegram_news_app password %L', :'app_password')
\gexec

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end
$$;

grant service_role to telegram_news_app;
alter database telegram_news owner to telegram_news_app;
alter schema public owner to telegram_news_app;
grant all on schema public to telegram_news_app;
SQL

alter table public.news_feature_flags
  drop constraint news_feature_flags_feature_key_check;

alter table public.news_feature_flags
  add constraint news_feature_flags_feature_key_check
    check (feature_key in ('article_tags', 'editorial_enrichment'));

create or replace function public.get_or_create_news_feature_flags(
  p_telegram_channel_id text,
  p_updated_by bigint
)
returns setof public.news_feature_flags
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(btrim(p_telegram_channel_id), '') is null then
    raise exception 'Telegram channel ID is required';
  end if;

  insert into public.news_feature_flags (
    telegram_channel_id,
    feature_key,
    state,
    config,
    updated_by
  )
  select
    btrim(p_telegram_channel_id),
    feature.feature_key,
    'off',
    '{}'::jsonb,
    p_updated_by
  from (
    values ('article_tags'), ('editorial_enrichment')
  ) as feature(feature_key)
  on conflict (telegram_channel_id, feature_key) do nothing;

  return query
  select feature.*
  from public.news_feature_flags as feature
  where feature.telegram_channel_id = btrim(p_telegram_channel_id)
  order by feature.feature_key;
end;
$$;

create or replace function public.update_news_feature_flag(
  p_telegram_channel_id text,
  p_feature_key text,
  p_state text,
  p_updated_by bigint,
  p_expected_version integer
)
returns setof public.news_feature_flags
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_feature_key text;
begin
  if nullif(btrim(p_telegram_channel_id), '') is null then
    raise exception 'Telegram channel ID is required';
  end if;
  v_feature_key := lower(btrim(p_feature_key));
  if p_feature_key is null
     or v_feature_key not in ('article_tags', 'editorial_enrichment') then
    raise exception 'Unknown news feature key';
  end if;
  if p_state is null
     or lower(btrim(p_state)) not in ('off', 'collect', 'enabled') then
    raise exception 'Invalid news feature state';
  end if;
  if p_expected_version is null or p_expected_version <= 0 then
    raise exception 'Expected feature version must be positive';
  end if;

  return query
  update public.news_feature_flags as feature
  set state = lower(btrim(p_state)),
      version = feature.version + 1,
      updated_by = p_updated_by,
      updated_at = now()
  where feature.telegram_channel_id = btrim(p_telegram_channel_id)
    and feature.feature_key = v_feature_key
    and feature.version = p_expected_version
  returning feature.*;
end;
$$;

revoke all on function public.get_or_create_news_feature_flags(text, bigint)
  from public, anon, authenticated;
revoke all on function public.update_news_feature_flag(
  text, text, text, bigint, integer
) from public, anon, authenticated;

grant execute on function public.get_or_create_news_feature_flags(text, bigint)
  to service_role;
grant execute on function public.update_news_feature_flag(
  text, text, text, bigint, integer
) to service_role;

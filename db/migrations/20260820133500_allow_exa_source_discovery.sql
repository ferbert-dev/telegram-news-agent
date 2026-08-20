alter table public.sources
  drop constraint if exists sources_discovered_by_check;

alter table public.sources
  add constraint sources_discovered_by_check
  check (discovered_by in ('seed', 'manual', 'openai', 'gemini', 'exa'));

create or replace function public.upsert_discovered_source(
  p_name text,
  p_homepage_url text,
  p_feed_url text,
  p_reliability_score integer,
  p_topic_codes text[],
  p_discovered_by text,
  p_discovery_metadata jsonb default '{}'::jsonb
)
returns setof public.sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.sources%rowtype;
  v_topic_count integer;
begin
  if p_name is null or length(trim(p_name)) not between 2 and 160 then
    raise exception 'Invalid discovered source name';
  end if;
  if p_feed_url is null or length(p_feed_url) > 2000 then
    raise exception 'Invalid discovered feed URL';
  end if;
  if p_homepage_url is not null and length(p_homepage_url) > 2000 then
    raise exception 'Invalid discovered homepage URL';
  end if;
  if p_reliability_score is null or p_reliability_score not between 0 and 80 then
    raise exception 'Invalid discovered source reliability score';
  end if;
  if p_discovered_by not in ('openai', 'gemini', 'exa') then
    raise exception 'Invalid discovered source provider';
  end if;
  if p_discovery_metadata is null or jsonb_typeof(p_discovery_metadata) <> 'object' then
    raise exception 'Invalid discovered source metadata';
  end if;

  select count(*)
  into v_topic_count
  from unnest(coalesce(p_topic_codes, '{}'::text[])) as requested(topic_code)
  join public.topics t on t.name = requested.topic_code and t.enabled = true;

  if v_topic_count <> cardinality(coalesce(p_topic_codes, '{}'::text[])) then
    raise exception 'Unknown discovered source topic';
  end if;

  insert into public.sources (
    name,
    homepage_url,
    feed_url,
    source_type,
    reliability_score,
    enabled,
    is_primary,
    last_checked_at,
    last_success_at,
    consecutive_failures,
    last_error_code,
    disabled_until,
    discovered_by,
    discovery_metadata
  )
  values (
    trim(p_name),
    p_homepage_url,
    p_feed_url,
    'rss',
    p_reliability_score,
    true,
    false,
    now(),
    now(),
    0,
    null,
    null,
    p_discovered_by,
    p_discovery_metadata
  )
  on conflict (feed_url) do update
  set name = case
        when public.sources.discovered_by in ('openai', 'gemini', 'exa')
          then excluded.name
        else public.sources.name
      end,
      homepage_url = coalesce(public.sources.homepage_url, excluded.homepage_url),
      reliability_score = greatest(
        coalesce(public.sources.reliability_score, 0),
        excluded.reliability_score
      ),
      last_checked_at = now(),
      last_success_at = now(),
      consecutive_failures = 0,
      last_error_code = null,
      disabled_until = null,
      discovery_metadata = public.sources.discovery_metadata || excluded.discovery_metadata,
      updated_at = now()
  returning * into v_source;

  insert into public.source_topics (source_id, topic_id)
  select v_source.id, t.id
  from unnest(coalesce(p_topic_codes, '{}'::text[])) as requested(topic_code)
  join public.topics t on t.name = requested.topic_code and t.enabled = true
  on conflict (source_id, topic_id) do nothing;

  return next v_source;
end;
$$;

revoke all on function public.upsert_discovered_source(
  text,
  text,
  text,
  integer,
  text[],
  text,
  jsonb
) from public;

grant execute on function public.upsert_discovered_source(
  text,
  text,
  text,
  integer,
  text[],
  text,
  jsonb
) to service_role;

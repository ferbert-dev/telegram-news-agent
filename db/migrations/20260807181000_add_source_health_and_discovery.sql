alter table public.sources
  add column last_success_at timestamptz,
  add column last_failed_at timestamptz,
  add column consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  add column last_error_code text,
  add column disabled_until timestamptz,
  add column discovered_by text not null default 'manual'
    check (discovered_by in ('seed', 'manual', 'openai', 'gemini')),
  add column discovery_metadata jsonb not null default '{}'::jsonb;

update public.sources
set discovered_by = 'seed'
where discovered_by = 'manual';

create index sources_available_topic_scan_idx
  on public.sources (enabled, disabled_until, reliability_score desc);

create table public.source_discovery_state (
  topic_key text primary key,
  status text not null check (status in ('running', 'completed', 'failed')),
  last_attempt_at timestamptz not null default now(),
  next_attempt_at timestamptz not null,
  provider text,
  model text,
  result_count integer not null default 0 check (result_count >= 0),
  last_error_code text,
  updated_at timestamptz not null default now()
);

alter table public.source_discovery_state enable row level security;
revoke all on table public.source_discovery_state from anon, authenticated;
grant all on table public.source_discovery_state to service_role;

create function public.mark_source_fetch_success(p_source_id uuid)
returns setof public.sources
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.sources
  set last_checked_at = now(),
      last_success_at = now(),
      consecutive_failures = 0,
      last_error_code = null,
      disabled_until = null,
      updated_at = now()
  where id = p_source_id
  returning *;
$$;

create function public.mark_source_fetch_failure(
  p_source_id uuid,
  p_error_code text
)
returns setof public.sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_error_code is null or p_error_code !~ '^[a-z0-9_]{2,64}$' then
    raise exception 'Invalid source error code';
  end if;

  return query
  update public.sources
  set last_checked_at = now(),
      last_failed_at = now(),
      consecutive_failures = consecutive_failures + 1,
      last_error_code = p_error_code,
      disabled_until = case
        when consecutive_failures + 1 >= 5 then now() + interval '7 days'
        when consecutive_failures + 1 >= 3 then now() + interval '24 hours'
        else disabled_until
      end,
      updated_at = now()
  where id = p_source_id
  returning *;
end;
$$;

create function public.claim_source_discovery(p_topic_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed text;
begin
  if p_topic_key is null or length(p_topic_key) not between 16 and 128 then
    raise exception 'Invalid source discovery key';
  end if;

  insert into public.source_discovery_state (
    topic_key,
    status,
    last_attempt_at,
    next_attempt_at,
    result_count,
    last_error_code,
    updated_at
  )
  values (
    p_topic_key,
    'running',
    now(),
    now() + interval '24 hours',
    0,
    null,
    now()
  )
  on conflict (topic_key) do update
  set status = 'running',
      last_attempt_at = now(),
      next_attempt_at = now() + interval '24 hours',
      result_count = 0,
      last_error_code = null,
      updated_at = now()
  where public.source_discovery_state.next_attempt_at <= now()
  returning topic_key into v_claimed;

  return v_claimed is not null;
end;
$$;

create function public.complete_source_discovery(
  p_topic_key text,
  p_provider text,
  p_model text,
  p_result_count integer,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated text;
begin
  if p_result_count is null or p_result_count < 0 then
    raise exception 'Invalid source discovery result count';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{2,64}$' then
    raise exception 'Invalid source discovery error code';
  end if;

  update public.source_discovery_state
  set status = case when p_error_code is null then 'completed' else 'failed' end,
      provider = nullif(left(coalesce(p_provider, ''), 80), ''),
      model = nullif(left(coalesce(p_model, ''), 120), ''),
      result_count = p_result_count,
      last_error_code = p_error_code,
      next_attempt_at = now() + case
        when p_error_code is null and p_result_count > 0 then interval '7 days'
        else interval '24 hours'
      end,
      updated_at = now()
  where topic_key = p_topic_key and status = 'running'
  returning topic_key into v_updated;

  return v_updated is not null;
end;
$$;

create function public.upsert_discovered_source(
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
  if p_discovered_by not in ('openai', 'gemini') then
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
        when public.sources.discovered_by in ('openai', 'gemini')
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

revoke all on function public.mark_source_fetch_success(uuid) from public;
revoke all on function public.mark_source_fetch_failure(uuid, text) from public;
revoke all on function public.claim_source_discovery(text) from public;
revoke all on function public.complete_source_discovery(text, text, text, integer, text) from public;
revoke all on function public.upsert_discovered_source(text, text, text, integer, text[], text, jsonb) from public;

grant execute on function public.mark_source_fetch_success(uuid) to service_role;
grant execute on function public.mark_source_fetch_failure(uuid, text) to service_role;
grant execute on function public.claim_source_discovery(text) to service_role;
grant execute on function public.complete_source_discovery(text, text, text, integer, text) to service_role;
grant execute on function public.upsert_discovered_source(text, text, text, integer, text[], text, jsonb) to service_role;

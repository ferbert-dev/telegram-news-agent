create table public.telegram_news_jobs (
  id uuid primary key default gen_random_uuid(),
  request_update_id bigint not null unique
    references public.telegram_updates(update_id) on delete restrict,
  telegram_channel_id text not null,
  control_chat_id bigint not null,
  requested_by bigint not null,
  settings_snapshot jsonb not null,
  status text not null default 'queued',
  worker_slot smallint not null default 1,
  active_job_id uuid references public.telegram_news_jobs(id) on delete restrict,
  claim_token uuid,
  claimed_at timestamptz,
  available_at timestamptz not null default now(),
  execution_attempt_count integer not null default 0,
  delivery_attempt_count integer not null default 0,
  outcome_status text,
  draft_id uuid references public.drafts(id) on delete restrict,
  publication_message_id bigint,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint telegram_news_jobs_channel_check
    check (btrim(telegram_channel_id) <> '' and length(telegram_channel_id) <= 255),
  constraint telegram_news_jobs_actor_check
    check (control_chat_id > 0 and requested_by > 0),
  constraint telegram_news_jobs_settings_snapshot_check
    check (jsonb_typeof(settings_snapshot) = 'object'),
  constraint telegram_news_jobs_status_check
    check (status in (
      'queued', 'processing', 'outcome_ready', 'delivering',
      'completed', 'failed', 'suppressed'
    )),
  constraint telegram_news_jobs_worker_slot_check check (worker_slot = 1),
  constraint telegram_news_jobs_attempts_check
    check (execution_attempt_count >= 0 and delivery_attempt_count >= 0),
  constraint telegram_news_jobs_outcome_status_check
    check (outcome_status is null or outcome_status in (
      'review_ready', 'published', 'no_candidates',
      'blocked_by_policy', 'failed', 'already_running'
    )),
  constraint telegram_news_jobs_error_code_check
    check (error_code is null or (
      btrim(error_code) <> '' and length(error_code) <= 64
    )),
  constraint telegram_news_jobs_claim_check
    check (
      (status in ('processing', 'delivering'))
        = (claim_token is not null and claimed_at is not null)
    ),
  constraint telegram_news_jobs_completion_check
    check ((status in ('completed', 'failed', 'suppressed')) = (completed_at is not null)),
  constraint telegram_news_jobs_suppressed_check
    check (
      (status = 'suppressed' and outcome_status = 'already_running' and active_job_id is not null)
      or (status <> 'suppressed' and outcome_status is distinct from 'already_running' and active_job_id is null)
    ),
  constraint telegram_news_jobs_result_check
    check (
      (outcome_status is null and draft_id is null and publication_message_id is null)
      or (outcome_status in ('no_candidates', 'failed') and draft_id is null and publication_message_id is null)
      or (outcome_status in ('review_ready', 'blocked_by_policy') and draft_id is not null and publication_message_id is null)
      or (outcome_status = 'published' and draft_id is not null and publication_message_id > 0)
      or (outcome_status = 'already_running' and draft_id is null and publication_message_id is null)
    )
);

alter table public.telegram_news_jobs enable row level security;

create unique index telegram_news_jobs_single_worker_idx
  on public.telegram_news_jobs (worker_slot)
  where status in ('processing', 'delivering');

create unique index telegram_news_jobs_active_channel_idx
  on public.telegram_news_jobs (telegram_channel_id)
  where status in ('queued', 'processing', 'outcome_ready', 'delivering');

create index telegram_news_jobs_available_idx
  on public.telegram_news_jobs (available_at, created_at)
  where status in ('queued', 'outcome_ready');

create function public.enqueue_telegram_news_job(
  p_update_id bigint,
  p_update_claim_token uuid,
  p_telegram_channel_id text,
  p_control_chat_id bigint,
  p_requested_by bigint,
  p_settings_snapshot jsonb
)
returns table (
  id uuid,
  enqueue_outcome text,
  job_status text,
  active_job_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.telegram_news_jobs%rowtype;
  v_active_id uuid;
begin
  if p_update_id is null or p_update_id <= 0
     or p_update_claim_token is null then
    raise exception 'Invalid Telegram update claim';
  end if;
  if p_telegram_channel_id is null or btrim(p_telegram_channel_id) = ''
     or length(p_telegram_channel_id) > 255
     or p_control_chat_id is null or p_control_chat_id <= 0
     or p_requested_by is null or p_requested_by <= 0
     or p_settings_snapshot is null
     or jsonb_typeof(p_settings_snapshot) <> 'object' then
    raise exception 'Invalid Telegram news job request';
  end if;

  perform 1
  from public.telegram_updates
  where update_id = p_update_id
    and status = 'processing'
    and claim_token = p_update_claim_token
  for update;
  if not found then
    raise exception 'Telegram update claim not found';
  end if;

  select * into v_existing
  from public.telegram_news_jobs
  where request_update_id = p_update_id;
  if found then
    return query select
      v_existing.id,
      case when v_existing.status = 'suppressed'
        then 'already_running' else 'queued' end,
      v_existing.status,
      v_existing.active_job_id;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('telegram-news-job-channel:' || btrim(p_telegram_channel_id), 0)
  );

  select jobs.id into v_active_id
  from public.telegram_news_jobs as jobs
  where jobs.telegram_channel_id = btrim(p_telegram_channel_id)
    and jobs.status in ('queued', 'processing', 'outcome_ready', 'delivering')
  order by jobs.created_at, jobs.id
  limit 1;

  if v_active_id is not null then
    return query
    insert into public.telegram_news_jobs (
      request_update_id,
      telegram_channel_id,
      control_chat_id,
      requested_by,
      settings_snapshot,
      status,
      active_job_id,
      outcome_status,
      completed_at
    ) values (
      p_update_id,
      btrim(p_telegram_channel_id),
      p_control_chat_id,
      p_requested_by,
      p_settings_snapshot,
      'suppressed',
      v_active_id,
      'already_running',
      now()
    )
    returning
      telegram_news_jobs.id,
      'already_running'::text,
      telegram_news_jobs.status,
      telegram_news_jobs.active_job_id;
    return;
  end if;

  return query
  insert into public.telegram_news_jobs (
    request_update_id,
    telegram_channel_id,
    control_chat_id,
    requested_by,
    settings_snapshot
  ) values (
    p_update_id,
    btrim(p_telegram_channel_id),
    p_control_chat_id,
    p_requested_by,
    p_settings_snapshot
  )
  returning
    telegram_news_jobs.id,
    'queued'::text,
    telegram_news_jobs.status,
    null::uuid;
end;
$$;

create function public.claim_next_telegram_news_job(
  p_claim_token uuid,
  p_stale_after_seconds integer default 1800,
  p_max_execution_attempts integer default 3,
  p_max_delivery_attempts integer default 10
)
returns table (
  id uuid,
  request_update_id bigint,
  telegram_channel_id text,
  control_chat_id bigint,
  requested_by bigint,
  settings_snapshot jsonb,
  claim_phase text,
  claim_token uuid,
  outcome_status text,
  draft_id uuid,
  publication_message_id bigint,
  error_code text,
  execution_attempt_count integer,
  delivery_attempt_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_job_status text;
  v_execution_attempt_count integer;
  v_delivery_attempt_count integer;
begin
  if p_claim_token is null then
    raise exception 'Telegram news job claim token is required';
  end if;
  if p_stale_after_seconds < 30 or p_stale_after_seconds > 3600 then
    raise exception 'Telegram news job stale timeout must be between 30 and 3600 seconds';
  end if;
  if p_max_execution_attempts is null
     or p_max_execution_attempts < 1 or p_max_execution_attempts > 20
     or p_max_delivery_attempts is null
     or p_max_delivery_attempts < 1 or p_max_delivery_attempts > 50 then
    raise exception 'Invalid Telegram news job attempt limits';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram-news-job-worker', 0));

  if exists (
    select 1 from public.telegram_news_jobs
    where status in ('processing', 'delivering')
      and claimed_at > now() - make_interval(secs => p_stale_after_seconds)
  ) then
    return;
  end if;

  select
    jobs.id,
    jobs.status,
    jobs.execution_attempt_count,
    jobs.delivery_attempt_count
  into
    v_job_id,
    v_job_status,
    v_execution_attempt_count,
    v_delivery_attempt_count
  from public.telegram_news_jobs as jobs
  where (
    jobs.status in ('processing', 'delivering')
      and jobs.claimed_at <= now() - make_interval(secs => p_stale_after_seconds)
  ) or (
    jobs.status in ('queued', 'outcome_ready')
      and jobs.available_at <= now()
  )
  order by
    case when jobs.status in ('processing', 'delivering') then 0 else 1 end,
    jobs.available_at,
    jobs.created_at,
    jobs.id
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  if v_job_status = 'processing'
     and v_execution_attempt_count + 1 >= p_max_execution_attempts then
    update public.telegram_news_jobs as jobs
    set status = 'outcome_ready',
        execution_attempt_count = jobs.execution_attempt_count + 1,
        outcome_status = 'failed',
        error_code = 'stale_execution_claim',
        claim_token = null,
        claimed_at = null,
        available_at = now(),
        completed_at = null,
        updated_at = now()
    where jobs.id = v_job_id
      and jobs.status = 'processing';
    return;
  end if;

  if v_job_status = 'delivering'
     and v_delivery_attempt_count + 1 >= p_max_delivery_attempts then
    update public.telegram_news_jobs as jobs
    set status = 'failed',
        delivery_attempt_count = jobs.delivery_attempt_count + 1,
        error_code = 'stale_delivery_claim',
        claim_token = null,
        claimed_at = null,
        completed_at = now(),
        updated_at = now()
    where jobs.id = v_job_id
      and jobs.status = 'delivering';
    return;
  end if;

  return query
  update public.telegram_news_jobs as jobs
  set status = case
        when jobs.status in ('queued', 'processing') then 'processing'
        else 'delivering'
      end,
      claim_token = p_claim_token,
      claimed_at = now(),
      execution_attempt_count = jobs.execution_attempt_count
        + case when jobs.status = 'processing' then 1 else 0 end,
      delivery_attempt_count = jobs.delivery_attempt_count
        + case when jobs.status = 'delivering' then 1 else 0 end,
      updated_at = now()
  where jobs.id = v_job_id
  returning
    jobs.id,
    jobs.request_update_id,
    jobs.telegram_channel_id,
    jobs.control_chat_id,
    jobs.requested_by,
    jobs.settings_snapshot,
    case when jobs.status = 'processing' then 'execute' else 'deliver' end,
    jobs.claim_token,
    jobs.outcome_status,
    jobs.draft_id,
    jobs.publication_message_id,
    jobs.error_code,
    jobs.execution_attempt_count,
    jobs.delivery_attempt_count;
end;
$$;

create function public.renew_telegram_news_job_claim(
  p_job_id uuid,
  p_claim_token uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with renewed as (
    update public.telegram_news_jobs
    set claimed_at = now(), updated_at = now()
    where id = p_job_id
      and status in ('processing', 'delivering')
      and claim_token = p_claim_token
    returning 1
  )
  select exists(select 1 from renewed);
$$;

create function public.record_telegram_news_job_outcome(
  p_job_id uuid,
  p_claim_token uuid,
  p_outcome_status text,
  p_draft_id uuid default null,
  p_publication_message_id bigint default null,
  p_error_code text default null
)
returns setof public.telegram_news_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_outcome_status not in (
    'review_ready', 'published', 'no_candidates', 'blocked_by_policy'
  ) then
    raise exception 'Invalid Telegram news job outcome';
  end if;
  if (p_outcome_status = 'no_candidates' and (
        p_draft_id is not null or p_publication_message_id is not null
      ))
     or (p_outcome_status in ('review_ready', 'blocked_by_policy') and (
        p_draft_id is null or p_publication_message_id is not null
      ))
     or (p_outcome_status = 'published' and (
        p_draft_id is null or p_publication_message_id is null
        or p_publication_message_id <= 0
      ))
     or (p_error_code is not null and (
        btrim(p_error_code) = '' or length(p_error_code) > 64
      )) then
    raise exception 'Invalid Telegram news job outcome fields';
  end if;

  return query
  update public.telegram_news_jobs
  set status = 'outcome_ready',
      outcome_status = p_outcome_status,
      draft_id = p_draft_id,
      publication_message_id = p_publication_message_id,
      error_code = p_error_code,
      claim_token = null,
      claimed_at = null,
      available_at = now(),
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning *;
end;
$$;

create function public.retry_telegram_news_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_max_attempts integer default 3,
  p_terminal boolean default false
)
returns setof public.telegram_news_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_error_code is null or btrim(p_error_code) = ''
     or length(p_error_code) > 64
     or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Invalid Telegram news job retry';
  end if;

  return query
  update public.telegram_news_jobs
  set execution_attempt_count = execution_attempt_count + 1,
      status = case
        when p_terminal or execution_attempt_count + 1 >= p_max_attempts
          then 'outcome_ready' else 'queued' end,
      outcome_status = case
        when p_terminal or execution_attempt_count + 1 >= p_max_attempts
          then 'failed' else null end,
      error_code = btrim(p_error_code),
      claim_token = null,
      claimed_at = null,
      available_at = case
        when p_terminal or execution_attempt_count + 1 >= p_max_attempts
          then now()
        else now() + make_interval(secs => least(300, power(2, execution_attempt_count + 1)::integer))
      end,
      completed_at = null,
      updated_at = now()
  where id = p_job_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning *;
end;
$$;

create function public.retry_telegram_news_job_delivery(
  p_job_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_max_attempts integer default 10
)
returns setof public.telegram_news_jobs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_error_code is null or btrim(p_error_code) = ''
     or length(p_error_code) > 64
     or p_max_attempts < 1 or p_max_attempts > 50 then
    raise exception 'Invalid Telegram news job delivery retry';
  end if;

  return query
  update public.telegram_news_jobs
  set delivery_attempt_count = delivery_attempt_count + 1,
      status = case
        when delivery_attempt_count + 1 >= p_max_attempts
          then 'failed' else 'outcome_ready' end,
      error_code = btrim(p_error_code),
      claim_token = null,
      claimed_at = null,
      available_at = case
        when delivery_attempt_count + 1 >= p_max_attempts
          then available_at
        else now() + make_interval(secs => least(300, power(2, delivery_attempt_count + 1)::integer))
      end,
      completed_at = case
        when delivery_attempt_count + 1 >= p_max_attempts
          then now() else null end,
      updated_at = now()
  where id = p_job_id
    and status = 'delivering'
    and claim_token = p_claim_token
  returning *;
end;
$$;

create function public.complete_telegram_news_job(
  p_job_id uuid,
  p_claim_token uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with completed as (
    update public.telegram_news_jobs
    set status = 'completed',
        claim_token = null,
        claimed_at = null,
        error_code = case
          when outcome_status = 'failed' then error_code else null end,
        completed_at = now(),
        updated_at = now()
    where id = p_job_id
      and status = 'delivering'
      and claim_token = p_claim_token
    returning 1
  )
  select exists(select 1 from completed);
$$;

revoke all on table public.telegram_news_jobs from public, anon, authenticated;
grant select, insert, update on table public.telegram_news_jobs to service_role;

revoke all on function public.enqueue_telegram_news_job(bigint, uuid, text, bigint, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_next_telegram_news_job(uuid, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.renew_telegram_news_job_claim(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.record_telegram_news_job_outcome(uuid, uuid, text, uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.retry_telegram_news_job(uuid, uuid, text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.retry_telegram_news_job_delivery(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_telegram_news_job(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.enqueue_telegram_news_job(bigint, uuid, text, bigint, bigint, jsonb)
  to service_role;
grant execute on function public.claim_next_telegram_news_job(uuid, integer, integer, integer)
  to service_role;
grant execute on function public.renew_telegram_news_job_claim(uuid, uuid)
  to service_role;
grant execute on function public.record_telegram_news_job_outcome(uuid, uuid, text, uuid, bigint, text)
  to service_role;
grant execute on function public.retry_telegram_news_job(uuid, uuid, text, integer, boolean)
  to service_role;
grant execute on function public.retry_telegram_news_job_delivery(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.complete_telegram_news_job(uuid, uuid)
  to service_role;

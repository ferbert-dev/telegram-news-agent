create function public.valid_news_topic_codes(p_topic_codes text[])
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select
    p_topic_codes <@ array[
      'ai',
      'world',
      'science',
      'nature',
      'animals',
      'history',
      'culture',
      'technology',
      'society'
    ]::text[]
    and cardinality(p_topic_codes) = (
      select count(distinct topic_code)
      from unnest(p_topic_codes) as topic_code
    );
$$;

create function public.valid_news_custom_topics(p_custom_topics text[])
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select
    cardinality(p_custom_topics) <= 5
    and cardinality(p_custom_topics) = (
      select count(distinct topic)
      from unnest(p_custom_topics) as topic
    )
    and not exists (
      select 1
      from unnest(p_custom_topics) as topic
      where topic <> btrim(topic)
        or char_length(topic) < 2
        or char_length(topic) > 80
        or topic ~ '[[:cntrl:]]'
        or topic ~* '(https?://|www\.)'
    );
$$;

create table public.news_bot_settings (
  telegram_channel_id text primary key
    check (char_length(btrim(telegram_channel_id)) between 1 and 255),
  review_chat_id bigint not null,
  schedule_interval_minutes integer
    check (schedule_interval_minutes in (60, 360, 720, 1440)),
  language_code text not null default 'en'
    check (language_code in ('en', 'uk', 'de')),
  topic_codes text[] not null default array[
    'ai',
    'world',
    'science',
    'nature',
    'animals',
    'history',
    'culture',
    'technology',
    'society'
  ]::text[],
  custom_topics text[] not null default '{}'::text[],
  approval_policy text not null default 'manual'
    check (approval_policy in ('manual', 'automatic')),
  next_run_at timestamptz,
  version integer not null default 1 check (version > 0),
  updated_by bigint not null,
  schedule_claim_token uuid,
  schedule_claimed_at timestamptz,
  schedule_run_id uuid,
  schedule_run_due_at timestamptz,
  schedule_settings_snapshot jsonb
    check (
      schedule_settings_snapshot is null
      or jsonb_typeof(schedule_settings_snapshot) = 'object'
    ),
  schedule_draft_id uuid references public.drafts(id) on delete restrict,
  schedule_preview text,
  schedule_window_hours integer check (schedule_window_hours > 0),
  schedule_publication_message_id bigint
    check (schedule_publication_message_id > 0),
  last_run_at timestamptz,
  last_run_status text
    check (
      last_run_status is null
      or char_length(last_run_status) between 1 and 64
    ),
  last_error_code text
    check (
      last_error_code is null
      or char_length(last_error_code) between 1 and 128
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (public.valid_news_topic_codes(topic_codes)),
  check (public.valid_news_custom_topics(custom_topics)),
  check (cardinality(topic_codes) + cardinality(custom_topics) between 1 and 12),
  check ((schedule_interval_minutes is null) = (next_run_at is null)),
  check ((schedule_claim_token is null) = (schedule_claimed_at is null)),
  check (
    (schedule_run_id is null
      and schedule_run_due_at is null
      and schedule_settings_snapshot is null
      and schedule_draft_id is null
      and schedule_preview is null
      and schedule_window_hours is null
      and schedule_publication_message_id is null)
    or
    (schedule_run_id is not null
      and schedule_run_due_at is not null
      and schedule_settings_snapshot is not null
      and (
        (schedule_draft_id is null
          and schedule_preview is null
          and schedule_window_hours is null
          and schedule_publication_message_id is null)
        or
        (schedule_draft_id is not null
          and schedule_preview is not null
          and schedule_window_hours is not null)
      ))
  )
);

create index news_bot_settings_due_idx
  on public.news_bot_settings (next_run_at)
  where schedule_interval_minutes is not null;

create table public.telegram_settings_inputs (
  id uuid primary key default gen_random_uuid(),
  control_chat_id bigint not null,
  requested_by bigint not null,
  prompt_message_id bigint not null check (prompt_message_id > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (control_chat_id, requested_by),
  check (expires_at > created_at)
);

create index telegram_settings_inputs_expires_idx
  on public.telegram_settings_inputs (expires_at);

alter table public.news_bot_settings enable row level security;
alter table public.telegram_settings_inputs enable row level security;

revoke all on table
  public.news_bot_settings,
  public.telegram_settings_inputs
from anon, authenticated;

grant select, insert, update on table public.news_bot_settings to service_role;
grant select, insert, update, delete on table public.telegram_settings_inputs
  to service_role;

alter table public.telegram_review_sessions
  add column telegram_channel_id text
    check (
      telegram_channel_id is null
      or char_length(btrim(telegram_channel_id)) between 1 and 255
    );

create index telegram_review_sessions_pending_channel_idx
  on public.telegram_review_sessions (telegram_channel_id, expires_at)
  where decision is null;

alter table public.telegram_news_request_checkpoints
  drop constraint telegram_news_request_checkpoints_status_check,
  drop constraint telegram_news_request_checkpoints_check,
  add column publication_message_id bigint
    check (publication_message_id > 0),
  add column settings_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings_snapshot) = 'object'),
  add constraint telegram_news_request_checkpoints_status_check
    check (status in ('review_ready', 'published', 'no_candidates')),
  add constraint telegram_news_request_checkpoints_result_check check (
    (
      status = 'review_ready'
      and draft_id is not null
      and preview is not null
      and publication_message_id is null
    )
    or (
      status = 'published'
      and draft_id is not null
      and preview is not null
      and publication_message_id is not null
    )
    or (
      status = 'no_candidates'
      and draft_id is null
      and preview is null
      and publication_message_id is null
    )
  );

create function public.get_or_create_news_settings(
  p_telegram_channel_id text,
  p_review_chat_id bigint,
  p_updated_by bigint
)
returns setof public.news_bot_settings
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if nullif(btrim(p_telegram_channel_id), '') is null then
    raise exception 'Telegram channel ID is required';
  end if;

  insert into public.news_bot_settings (
    telegram_channel_id,
    review_chat_id,
    updated_by
  )
  values (
    btrim(p_telegram_channel_id),
    p_review_chat_id,
    p_updated_by
  )
  on conflict (telegram_channel_id) do update
  set review_chat_id = excluded.review_chat_id,
      version = news_bot_settings.version + 1,
      updated_by = excluded.updated_by,
      updated_at = now()
  where news_bot_settings.review_chat_id is distinct from excluded.review_chat_id
     or news_bot_settings.updated_by is distinct from excluded.updated_by;

  return query
  select *
  from public.news_bot_settings
  where telegram_channel_id = btrim(p_telegram_channel_id);
end;
$$;

create function public.get_news_settings(p_telegram_channel_id text)
returns setof public.news_bot_settings
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from public.news_bot_settings
  where telegram_channel_id = btrim(p_telegram_channel_id);
$$;

create function public.update_news_settings(
  p_telegram_channel_id text,
  p_review_chat_id bigint,
  p_schedule_interval_minutes integer,
  p_language_code text,
  p_topic_codes text[],
  p_custom_topics text[],
  p_approval_policy text,
  p_updated_by bigint,
  p_expected_version integer
)
returns setof public.news_bot_settings
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_topic_codes text[];
  v_custom_topics text[];
begin
  if p_topic_codes is null or p_custom_topics is null then
    raise exception 'Topic arrays are required';
  end if;

  select coalesce(array_agg(topic_code order by first_position), '{}'::text[])
  into v_topic_codes
  from (
    select lower(btrim(topic_code)) as topic_code, min(position) as first_position
    from unnest(p_topic_codes) with ordinality as value(topic_code, position)
    group by lower(btrim(topic_code))
  ) normalized_topics;

  select coalesce(array_agg(topic order by first_position), '{}'::text[])
  into v_custom_topics
  from (
    select btrim(topic) as topic, min(position) as first_position
    from unnest(p_custom_topics) with ordinality as value(topic, position)
    group by btrim(topic)
  ) normalized_topics;

  if not public.valid_news_topic_codes(v_topic_codes) then
    raise exception 'Invalid preset topic codes';
  end if;
  if not public.valid_news_custom_topics(v_custom_topics) then
    raise exception 'Invalid custom topics';
  end if;
  if cardinality(v_topic_codes) + cardinality(v_custom_topics) not between 1 and 12 then
    raise exception 'Between 1 and 12 topics must be selected';
  end if;

  return query
  update public.news_bot_settings
  set review_chat_id = p_review_chat_id,
      schedule_interval_minutes = p_schedule_interval_minutes,
      language_code = lower(btrim(p_language_code)),
      topic_codes = v_topic_codes,
      custom_topics = v_custom_topics,
      approval_policy = lower(btrim(p_approval_policy)),
      next_run_at = case
        when p_schedule_interval_minutes is null then null
        when schedule_run_id is not null then now()
        else now() + make_interval(mins => p_schedule_interval_minutes)
      end,
      version = version + 1,
      updated_by = p_updated_by,
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and version = p_expected_version
  returning *;
end;
$$;

create function public.begin_telegram_settings_input(
  p_control_chat_id bigint,
  p_requested_by bigint,
  p_prompt_message_id bigint,
  p_expires_at timestamptz
)
returns setof public.telegram_settings_inputs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_prompt_message_id <= 0 then
    raise exception 'Settings input prompt message ID must be positive';
  end if;
  if p_expires_at <= now() then
    raise exception 'Settings input expiry must be in the future';
  end if;

  return query
  insert into public.telegram_settings_inputs (
    control_chat_id,
    requested_by,
    prompt_message_id,
    expires_at
  )
  values (
    p_control_chat_id,
    p_requested_by,
    p_prompt_message_id,
    p_expires_at
  )
  on conflict (control_chat_id, requested_by) do update
  set prompt_message_id = excluded.prompt_message_id,
      expires_at = excluded.expires_at,
      created_at = now()
  returning *;
end;
$$;

create function public.consume_telegram_settings_input(
  p_control_chat_id bigint,
  p_requested_by bigint,
  p_prompt_message_id bigint
)
returns setof public.telegram_settings_inputs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input public.telegram_settings_inputs%rowtype;
begin
  delete from public.telegram_settings_inputs
  where control_chat_id = p_control_chat_id
    and requested_by = p_requested_by
    and prompt_message_id = p_prompt_message_id
  returning * into v_input;

  if found and v_input.expires_at > now() then
    return next v_input;
  end if;
end;
$$;

create function public.claim_due_news_schedule(
  p_claim_token uuid,
  p_stale_after_seconds integer default 1800
)
returns setof public.news_bot_settings
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_claim_token is null then
    raise exception 'Schedule claim token is required';
  end if;
  if p_stale_after_seconds < 30 or p_stale_after_seconds > 3600 then
    raise exception 'Schedule stale threshold must be between 30 and 3600 seconds';
  end if;

  return query
  with candidate as (
    select settings.telegram_channel_id
    from public.news_bot_settings as settings
    where settings.schedule_interval_minutes is not null
      and settings.next_run_at <= now()
      and not exists (
        select 1
        from public.pipeline_leases as pipeline_lease
        where pipeline_lease.name = 'daily-news-pipeline'
          and pipeline_lease.expires_at > now()
      )
      and (
        settings.schedule_claim_token is null
        or settings.schedule_claimed_at
          <= now() - make_interval(secs => p_stale_after_seconds)
      )
    order by settings.next_run_at, settings.telegram_channel_id
    for update skip locked
    limit 1
  )
  update public.news_bot_settings as settings
  set schedule_claim_token = p_claim_token,
      schedule_claimed_at = now(),
      schedule_run_id = coalesce(settings.schedule_run_id, gen_random_uuid()),
      schedule_run_due_at = coalesce(
        settings.schedule_run_due_at,
        settings.next_run_at
      ),
      schedule_settings_snapshot = coalesce(
        settings.schedule_settings_snapshot,
        jsonb_build_object(
          'channelId', settings.telegram_channel_id,
          'reviewChatId', settings.review_chat_id,
          'scheduleIntervalMinutes', settings.schedule_interval_minutes,
          'languageCode', settings.language_code,
          'topicCodes', settings.topic_codes,
          'customTopics', settings.custom_topics,
          'approvalPolicy', settings.approval_policy,
          'nextRunAt', settings.next_run_at,
          'version', settings.version,
          'updatedBy', settings.updated_by
        )
      ),
      updated_at = now()
  from candidate
  where settings.telegram_channel_id = candidate.telegram_channel_id
  returning settings.*;
end;
$$;

create function public.save_news_schedule_draft(
  p_telegram_channel_id text,
  p_claim_token uuid,
  p_draft_id uuid,
  p_preview text,
  p_window_hours integer
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_saved boolean;
begin
  if p_draft_id is null or nullif(btrim(p_preview), '') is null
     or p_window_hours <= 0 then
    raise exception 'Invalid scheduled draft checkpoint';
  end if;

  update public.news_bot_settings
  set schedule_draft_id = p_draft_id,
      schedule_preview = p_preview,
      schedule_window_hours = p_window_hours,
      schedule_claimed_at = now(),
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
    and schedule_run_id is not null
    and (schedule_draft_id is null or schedule_draft_id = p_draft_id)
  returning true into v_saved;

  return coalesce(v_saved, false);
end;
$$;

create function public.save_news_schedule_publication(
  p_telegram_channel_id text,
  p_claim_token uuid,
  p_draft_id uuid,
  p_publication_message_id bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_saved boolean;
begin
  if p_publication_message_id <= 0 then
    raise exception 'Invalid scheduled publication message ID';
  end if;

  update public.news_bot_settings
  set schedule_publication_message_id = p_publication_message_id,
      schedule_claimed_at = now(),
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
    and schedule_draft_id = p_draft_id
  returning true into v_saved;

  return coalesce(v_saved, false);
end;
$$;

create function public.renew_news_schedule_claim(
  p_telegram_channel_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_renewed boolean;
begin
  update public.news_bot_settings
  set schedule_claimed_at = now(),
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
    and schedule_run_id is not null
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

create function public.pause_news_schedule_unresolved(
  p_telegram_channel_id text,
  p_claim_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_paused boolean;
begin
  update public.news_bot_settings
  set schedule_interval_minutes = null,
      next_run_at = null,
      schedule_claim_token = null,
      schedule_claimed_at = null,
      last_run_at = now(),
      last_run_status = 'publication_unresolved',
      last_error_code = nullif(btrim(p_error_code), ''),
      version = version + 1,
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
  returning true into v_paused;

  return coalesce(v_paused, false);
end;
$$;

create function public.renew_telegram_review_session(
  p_draft_id uuid,
  p_expires_at timestamptz
)
returns setof public.telegram_review_sessions
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_expires_at <= now() then
    raise exception 'Review session expiry must be in the future';
  end if;

  return query
  update public.telegram_review_sessions as review_session
  set expires_at = p_expires_at
  from public.drafts as draft
  where review_session.draft_id = p_draft_id
    and draft.id = review_session.draft_id
    and draft.status = 'review'
    and review_session.decision is null
    and review_session.expires_at <= now()
  returning review_session.*;
end;
$$;

create function public.rebind_telegram_review_session(
  p_draft_id uuid,
  p_control_chat_id bigint,
  p_expected_preview_message_id bigint,
  p_preview_message_id bigint,
  p_expires_at timestamptz
)
returns setof public.telegram_review_sessions
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_expected_preview_message_id <= 0 or p_preview_message_id <= 0 then
    raise exception 'Review preview message IDs must be positive';
  end if;
  if p_expires_at <= now() then
    raise exception 'Review session expiry must be in the future';
  end if;

  return query
  update public.telegram_review_sessions as review_session
  set preview_message_id = p_preview_message_id,
      expires_at = p_expires_at
  from public.drafts as draft
  where review_session.draft_id = p_draft_id
    and draft.id = review_session.draft_id
    and draft.status = 'review'
    and review_session.decision is null
    and review_session.control_chat_id = p_control_chat_id
    and review_session.preview_message_id = p_expected_preview_message_id
  returning review_session.*;
end;
$$;

create function public.finish_news_schedule(
  p_telegram_channel_id text,
  p_claim_token uuid,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_finished boolean;
begin
  if nullif(btrim(p_status), '') is null or char_length(btrim(p_status)) > 64 then
    raise exception 'Invalid schedule result status';
  end if;
  if p_error_code is not null
     and (nullif(btrim(p_error_code), '') is null or char_length(btrim(p_error_code)) > 128) then
    raise exception 'Invalid schedule error code';
  end if;

  update public.news_bot_settings
  set next_run_at = case
        when schedule_interval_minutes is null then null
        else now() + make_interval(mins => schedule_interval_minutes)
      end,
      schedule_claim_token = null,
      schedule_claimed_at = null,
      schedule_run_id = null,
      schedule_run_due_at = null,
      schedule_settings_snapshot = null,
      schedule_draft_id = null,
      schedule_preview = null,
      schedule_window_hours = null,
      schedule_publication_message_id = null,
      last_run_at = now(),
      last_run_status = btrim(p_status),
      last_error_code = nullif(btrim(p_error_code), ''),
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
  returning true into v_finished;

  return coalesce(v_finished, false);
end;
$$;

create function public.has_pending_telegram_review(p_telegram_channel_id text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.telegram_review_sessions as review_session
    join public.drafts as draft on draft.id = review_session.draft_id
    where (
        review_session.telegram_channel_id = btrim(p_telegram_channel_id)
        or (
          review_session.telegram_channel_id is null
          and exists (
            select 1
            from public.news_bot_settings as settings
            where settings.telegram_channel_id = btrim(p_telegram_channel_id)
              and settings.review_chat_id = review_session.control_chat_id
          )
        )
      )
      and review_session.decision is null
      and review_session.expires_at > now()
      and draft.status = 'review'
  );
$$;

revoke all on function public.valid_news_topic_codes(text[])
  from public, anon, authenticated;
revoke all on function public.valid_news_custom_topics(text[])
  from public, anon, authenticated;
revoke all on function public.get_or_create_news_settings(text, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.get_news_settings(text)
  from public, anon, authenticated;
revoke all on function public.update_news_settings(
  text, bigint, integer, text, text[], text[], text, bigint, integer
) from public, anon, authenticated;
revoke all on function public.begin_telegram_settings_input(
  bigint, bigint, bigint, timestamptz
) from public, anon, authenticated;
revoke all on function public.consume_telegram_settings_input(bigint, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.claim_due_news_schedule(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.save_news_schedule_draft(
  text, uuid, uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.save_news_schedule_publication(
  text, uuid, uuid, bigint
) from public, anon, authenticated;
revoke all on function public.renew_news_schedule_claim(text, uuid)
  from public, anon, authenticated;
revoke all on function public.pause_news_schedule_unresolved(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.finish_news_schedule(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.has_pending_telegram_review(text)
  from public, anon, authenticated;
revoke all on function public.renew_telegram_review_session(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.rebind_telegram_review_session(
  uuid, bigint, bigint, bigint, timestamptz
) from public, anon, authenticated;

grant execute on function public.valid_news_topic_codes(text[]) to service_role;
grant execute on function public.valid_news_custom_topics(text[]) to service_role;
grant execute on function public.get_or_create_news_settings(text, bigint, bigint)
  to service_role;
grant execute on function public.get_news_settings(text) to service_role;
grant execute on function public.update_news_settings(
  text, bigint, integer, text, text[], text[], text, bigint, integer
) to service_role;
grant execute on function public.begin_telegram_settings_input(
  bigint, bigint, bigint, timestamptz
) to service_role;
grant execute on function public.consume_telegram_settings_input(bigint, bigint, bigint)
  to service_role;
grant execute on function public.claim_due_news_schedule(uuid, integer)
  to service_role;
grant execute on function public.save_news_schedule_draft(
  text, uuid, uuid, text, integer
) to service_role;
grant execute on function public.save_news_schedule_publication(
  text, uuid, uuid, bigint
) to service_role;
grant execute on function public.renew_news_schedule_claim(text, uuid)
  to service_role;
grant execute on function public.pause_news_schedule_unresolved(text, uuid, text)
  to service_role;
grant execute on function public.finish_news_schedule(text, uuid, text, text)
  to service_role;
grant execute on function public.has_pending_telegram_review(text)
  to service_role;
grant execute on function public.renew_telegram_review_session(uuid, timestamptz)
  to service_role;
grant execute on function public.rebind_telegram_review_session(
  uuid, bigint, bigint, bigint, timestamptz
) to service_role;

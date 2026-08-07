alter table public.news_bot_settings
  add column quiet_hours_enabled boolean not null default true;

create function public.is_news_quiet_hours(p_at timestamptz)
returns boolean
language sql
stable
strict
security invoker
set search_path = ''
as $$
  select
    (p_at at time zone 'Europe/Madrid')::time >= time '22:00'
    or (p_at at time zone 'Europe/Madrid')::time < time '08:00';
$$;

create function public.next_allowed_news_schedule_at(
  p_candidate timestamptz,
  p_quiet_hours_enabled boolean
)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when p_candidate is null then null
    when not coalesce(p_quiet_hours_enabled, false) then p_candidate
    when (p_candidate at time zone 'Europe/Madrid')::time < time '08:00'
      then (
        (p_candidate at time zone 'Europe/Madrid')::date + time '08:00'
      ) at time zone 'Europe/Madrid'
    when (p_candidate at time zone 'Europe/Madrid')::time >= time '22:00'
      then (
        (p_candidate at time zone 'Europe/Madrid')::date + 1 + time '08:00'
      ) at time zone 'Europe/Madrid'
    else p_candidate
  end;
$$;

create function public.update_news_settings(
  p_telegram_channel_id text,
  p_review_chat_id bigint,
  p_schedule_interval_minutes integer,
  p_language_code text,
  p_topic_codes text[],
  p_custom_topics text[],
  p_approval_policy text,
  p_quiet_hours_enabled boolean,
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
  if p_quiet_hours_enabled is null then
    raise exception 'Night pause setting is required';
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
      quiet_hours_enabled = p_quiet_hours_enabled,
      next_run_at = case
        when p_schedule_interval_minutes is null then null
        when schedule_run_id is not null
          then public.next_allowed_news_schedule_at(
            now(),
            p_quiet_hours_enabled
          )
        else public.next_allowed_news_schedule_at(
          now() + make_interval(mins => p_schedule_interval_minutes),
          p_quiet_hours_enabled
        )
      end,
      version = version + 1,
      updated_by = p_updated_by,
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and version = p_expected_version
  returning *;
end;
$$;

create or replace function public.update_news_settings(
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
  v_quiet_hours_enabled boolean;
begin
  select settings.quiet_hours_enabled
  into v_quiet_hours_enabled
  from public.news_bot_settings as settings
  where settings.telegram_channel_id = btrim(p_telegram_channel_id)
    and settings.version = p_expected_version;

  if not found then
    return;
  end if;

  return query
  select *
  from public.update_news_settings(
    p_telegram_channel_id,
    p_review_chat_id,
    p_schedule_interval_minutes,
    p_language_code,
    p_topic_codes,
    p_custom_topics,
    p_approval_policy,
    v_quiet_hours_enabled,
    p_updated_by,
    p_expected_version
  );
end;
$$;

create or replace function public.claim_due_news_schedule(
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

  update public.news_bot_settings as settings
  set next_run_at = public.next_allowed_news_schedule_at(now(), true),
      last_run_status = 'quiet_hours_deferred',
      last_error_code = null,
      updated_at = now()
  where settings.schedule_interval_minutes is not null
    and settings.next_run_at <= now()
    and settings.quiet_hours_enabled
    and public.is_news_quiet_hours(now())
    and (
      settings.schedule_claim_token is null
      or settings.schedule_claimed_at
        <= now() - make_interval(secs => p_stale_after_seconds)
    );

  return query
  with candidate as (
    select settings.telegram_channel_id
    from public.news_bot_settings as settings
    where settings.schedule_interval_minutes is not null
      and settings.next_run_at <= now()
      and (
        not settings.quiet_hours_enabled
        or not public.is_news_quiet_hours(now())
      )
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
          'quietHoursEnabled', settings.quiet_hours_enabled,
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

create function public.defer_news_schedule_for_quiet_hours(
  p_telegram_channel_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deferred boolean;
begin
  update public.news_bot_settings
  set next_run_at = case
        when schedule_interval_minutes is null then null
        else public.next_allowed_news_schedule_at(now(), true)
      end,
      schedule_claim_token = null,
      schedule_claimed_at = null,
      last_run_status = 'quiet_hours_deferred',
      last_error_code = null,
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and schedule_claim_token = p_claim_token
    and public.is_news_quiet_hours(now())
  returning true into v_deferred;

  return coalesce(v_deferred, false);
end;
$$;

create or replace function public.finish_news_schedule(
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
        else public.next_allowed_news_schedule_at(
          now() + make_interval(mins => schedule_interval_minutes),
          quiet_hours_enabled
        )
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

revoke all on function public.is_news_quiet_hours(timestamptz)
  from public, anon, authenticated;
revoke all on function public.next_allowed_news_schedule_at(timestamptz, boolean)
  from public, anon, authenticated;
revoke all on function public.update_news_settings(
  text, bigint, integer, text, text[], text[], text, boolean, bigint, integer
) from public, anon, authenticated;
revoke all on function public.defer_news_schedule_for_quiet_hours(text, uuid)
  from public, anon, authenticated;

grant execute on function public.is_news_quiet_hours(timestamptz)
  to service_role;
grant execute on function public.next_allowed_news_schedule_at(timestamptz, boolean)
  to service_role;
grant execute on function public.update_news_settings(
  text, bigint, integer, text, text[], text[], text, boolean, bigint, integer
) to service_role;
grant execute on function public.defer_news_schedule_for_quiet_hours(text, uuid)
  to service_role;

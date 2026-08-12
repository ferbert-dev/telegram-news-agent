create function public.valid_news_excluded_topic_codes(p_topic_codes text[])
returns boolean
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select
    (
      cardinality(p_topic_codes) = 0
      or (
        array_ndims(p_topic_codes) = 1
        and array_lower(p_topic_codes, 1) = 1
      )
    )
    and cardinality(p_topic_codes) <= 1
    and cardinality(p_topic_codes) = (
      select count(distinct topic_code)
      from unnest(p_topic_codes) as topic_code
    )
    and not exists (
      select 1
      from unnest(p_topic_codes) as topic_code
      where topic_code is null
        or topic_code <> lower(btrim(topic_code))
        or topic_code <> 'war_conflict'
    );
$$;

alter table public.news_bot_settings
  add column excluded_topic_codes text[] not null
    default array['war_conflict']::text[],
  add constraint news_bot_settings_excluded_topic_codes_check
    check (public.valid_news_excluded_topic_codes(excluded_topic_codes));

create function public.update_news_excluded_topics(
  p_telegram_channel_id text,
  p_excluded_topic_codes text[],
  p_updated_by bigint,
  p_expected_version integer
)
returns setof public.news_bot_settings
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_excluded_topic_codes text[];
begin
  if p_excluded_topic_codes is null then
    raise exception 'Excluded topic codes are required';
  end if;

  select coalesce(
    array_agg(topic_code order by first_position),
    '{}'::text[]
  )
  into v_excluded_topic_codes
  from (
    select
      lower(btrim(topic_code)) as topic_code,
      min(position) as first_position
    from unnest(p_excluded_topic_codes)
      with ordinality as value(topic_code, position)
    group by lower(btrim(topic_code))
  ) as normalized_topics;

  if not public.valid_news_excluded_topic_codes(v_excluded_topic_codes) then
    raise exception 'Invalid excluded topic codes';
  end if;

  return query
  update public.news_bot_settings
  set excluded_topic_codes = v_excluded_topic_codes,
      version = version + 1,
      updated_by = p_updated_by,
      updated_at = now()
  where telegram_channel_id = btrim(p_telegram_channel_id)
    and version = p_expected_version
  returning *;
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
          'excludedTopicCodes', settings.excluded_topic_codes,
          'excludedTopicsProvenance', jsonb_build_object(
            'source', 'news_bot_settings',
            'settingsVersion', settings.version
          ),
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

revoke all on function public.valid_news_excluded_topic_codes(text[])
  from public, anon, authenticated;
revoke all on function public.update_news_excluded_topics(
  text, text[], bigint, integer
) from public, anon, authenticated;
revoke all on function public.claim_due_news_schedule(uuid, integer)
  from public, anon, authenticated;

grant execute on function public.valid_news_excluded_topic_codes(text[])
  to service_role;
grant execute on function public.update_news_excluded_topics(
  text, text[], bigint, integer
) to service_role;
grant execute on function public.claim_due_news_schedule(uuid, integer)
  to service_role;

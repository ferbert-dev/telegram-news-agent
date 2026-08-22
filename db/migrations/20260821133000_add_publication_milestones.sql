alter table public.news_feature_flags
  drop constraint news_feature_flags_feature_key_check;

alter table public.news_feature_flags
  add constraint news_feature_flags_feature_key_check
    check (feature_key in (
      'article_tags',
      'editorial_enrichment',
      'publication_milestones'
    ));

create table public.publication_milestones (
  id uuid primary key default gen_random_uuid(),
  telegram_channel_id text not null references public.news_bot_settings(telegram_channel_id) on delete cascade,
  ordinal integer not null,
  published_post_id uuid not null references public.published_posts(id) on delete cascade,
  language_code text not null,
  editor_name text not null,
  state text not null default 'pending',
  claim_token uuid,
  telegram_message_id bigint,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  uncertain_at timestamptz,
  constraint publication_milestones_channel_ordinal_key unique (telegram_channel_id, ordinal),
  constraint publication_milestones_published_post_id_key unique (published_post_id),
  constraint publication_milestones_ordinal_check check (ordinal > 0),
  constraint publication_milestones_language_code_check check (language_code in ('en', 'uk', 'de')),
  constraint publication_milestones_state_check check (state in ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  constraint publication_milestones_attempt_count_check check (attempt_count >= 0),
  constraint publication_milestones_claim_check check (
    (state = 'sending' and claim_token is not null and claimed_at is not null)
    or
    (state <> 'sending' and claim_token is null and claimed_at is null)
  )
);

create index publication_milestones_state_idx
  on public.publication_milestones (state);

alter table public.publication_milestones enable row level security;

create policy publication_milestones_service_role_all
on public.publication_milestones
for all
to service_role
using (true)
with check (true);

grant select, insert, update on table public.publication_milestones to service_role;

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
    values
      ('article_tags'),
      ('editorial_enrichment'),
      ('publication_milestones')
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
     or v_feature_key not in (
       'article_tags',
       'editorial_enrichment',
       'publication_milestones'
     ) then
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

create or replace function public.claim_publication_milestone(
  p_published_post_id uuid,
  p_language_code text,
  p_editor_name text
)
returns setof public.publication_milestones
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_post public.published_posts%rowtype;
  v_channel_id text;
  v_ordinal integer;
begin
  if p_published_post_id is null then
    raise exception 'Published post ID is required';
  end if;
  if lower(btrim(coalesce(p_language_code, ''))) not in ('en', 'uk', 'de') then
    raise exception 'Valid language code is required';
  end if;
  if nullif(btrim(p_editor_name), '') is null then
    raise exception 'Editor name is required';
  end if;

  select * into v_post
  from public.published_posts
  where id = p_published_post_id;

  if not found then
    raise exception 'Published post not found';
  end if;

  v_channel_id := v_post.telegram_channel_id;

  select count(*)::integer into v_ordinal
  from public.published_posts as post
  where post.telegram_channel_id = v_channel_id
    and (
      post.published_at < v_post.published_at
      or (post.published_at = v_post.published_at and post.id <= v_post.id)
    );

  if mod(v_ordinal, 50) <> 0 then
    return;
  end if;

  insert into public.publication_milestones (
    telegram_channel_id,
    ordinal,
    published_post_id,
    language_code,
    editor_name
  )
  values (
    v_channel_id,
    v_ordinal,
    p_published_post_id,
    lower(btrim(p_language_code)),
    btrim(p_editor_name)
  )
  on conflict (telegram_channel_id, ordinal) do nothing;

  return query
  update public.publication_milestones as milestone
  set state = 'sending',
      claim_token = gen_random_uuid(),
      attempt_count = milestone.attempt_count + 1,
      last_error = null,
      updated_at = now(),
      claimed_at = now(),
      failed_at = null,
      uncertain_at = null
  where milestone.telegram_channel_id = v_channel_id
    and milestone.ordinal = v_ordinal
    and milestone.state in ('pending', 'failed')
  returning milestone.*;
end;
$$;

create or replace function public.retry_publication_milestone(p_milestone_id uuid)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'sending',
      claim_token = gen_random_uuid(),
      attempt_count = milestone.attempt_count + 1,
      last_error = null,
      updated_at = now(),
      claimed_at = now(),
      failed_at = null,
      uncertain_at = null
  where milestone.id = p_milestone_id
    and milestone.state = 'failed'
  returning milestone.*;
$$;

create or replace function public.mark_publication_milestone_sent(
  p_milestone_id uuid,
  p_claim_token uuid,
  p_telegram_message_id bigint
)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'sent',
      claim_token = null,
      telegram_message_id = p_telegram_message_id,
      last_error = null,
      updated_at = now(),
      claimed_at = null,
      sent_at = now(),
      failed_at = null,
      uncertain_at = null
  where milestone.id = p_milestone_id
    and milestone.state = 'sending'
    and milestone.claim_token = p_claim_token
    and p_telegram_message_id > 0
  returning milestone.*;
$$;

create or replace function public.mark_publication_milestone_failed(
  p_milestone_id uuid,
  p_claim_token uuid,
  p_error text
)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'failed',
      claim_token = null,
      last_error = left(btrim(p_error), 500),
      updated_at = now(),
      claimed_at = null,
      failed_at = now(),
      uncertain_at = null
  where milestone.id = p_milestone_id
    and milestone.state = 'sending'
    and milestone.claim_token = p_claim_token
    and nullif(btrim(p_error), '') is not null
  returning milestone.*;
$$;

create or replace function public.mark_publication_milestone_uncertain(
  p_milestone_id uuid,
  p_claim_token uuid,
  p_error text
)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'uncertain',
      claim_token = null,
      last_error = left(btrim(p_error), 500),
      updated_at = now(),
      claimed_at = null,
      failed_at = null,
      uncertain_at = now()
  where milestone.id = p_milestone_id
    and milestone.state = 'sending'
    and milestone.claim_token = p_claim_token
    and nullif(btrim(p_error), '') is not null
  returning milestone.*;
$$;

create or replace function public.reconcile_publication_milestone_sent(
  p_milestone_id uuid,
  p_telegram_message_id bigint
)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'sent',
      claim_token = null,
      telegram_message_id = p_telegram_message_id,
      last_error = null,
      updated_at = now(),
      claimed_at = null,
      sent_at = now(),
      failed_at = null,
      uncertain_at = null
  where milestone.id = p_milestone_id
    and milestone.state = 'uncertain'
    and p_telegram_message_id > 0
  returning milestone.*;
$$;

create or replace function public.reconcile_publication_milestone_not_sent(
  p_milestone_id uuid
)
returns setof public.publication_milestones
language sql
security invoker
set search_path = ''
as $$
  update public.publication_milestones as milestone
  set state = 'failed',
      claim_token = null,
      last_error = 'operator_confirmed_not_sent',
      updated_at = now(),
      claimed_at = null,
      failed_at = now(),
      uncertain_at = null
  where milestone.id = p_milestone_id
    and milestone.state = 'uncertain'
  returning milestone.*;
$$;

revoke all on function public.get_or_create_news_feature_flags(text, bigint)
  from public, anon, authenticated;
revoke all on function public.update_news_feature_flag(text, text, text, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.claim_publication_milestone(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.retry_publication_milestone(uuid)
  from public, anon, authenticated;
revoke all on function public.mark_publication_milestone_sent(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.mark_publication_milestone_failed(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.mark_publication_milestone_uncertain(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.reconcile_publication_milestone_sent(uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.reconcile_publication_milestone_not_sent(uuid)
  from public, anon, authenticated;

grant execute on function public.get_or_create_news_feature_flags(text, bigint)
  to service_role;
grant execute on function public.update_news_feature_flag(text, text, text, bigint, integer)
  to service_role;
grant execute on function public.claim_publication_milestone(uuid, text, text)
  to service_role;
grant execute on function public.retry_publication_milestone(uuid)
  to service_role;
grant execute on function public.mark_publication_milestone_sent(uuid, uuid, bigint)
  to service_role;
grant execute on function public.mark_publication_milestone_failed(uuid, uuid, text)
  to service_role;
grant execute on function public.mark_publication_milestone_uncertain(uuid, uuid, text)
  to service_role;
grant execute on function public.reconcile_publication_milestone_sent(uuid, bigint)
  to service_role;
grant execute on function public.reconcile_publication_milestone_not_sent(uuid)
  to service_role;

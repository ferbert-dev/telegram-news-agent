create table public.topic_translations (
  topic_id uuid not null references public.topics(id) on delete cascade,
  language_code text not null check (language_code in ('en', 'uk', 'de')),
  label text not null
    check (
      label = btrim(label)
      and char_length(label) between 1 and 80
      and label !~ '[[:cntrl:]]'
    ),
  hashtag text not null
    check (
      hashtag = btrim(hashtag)
      and char_length(hashtag) between 2 and 64
      and hashtag ~ '^#[[:alnum:]_]+$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (topic_id, language_code)
);

with topic_data (name, description, keywords) as (
  values
    ('ai', 'Artificial intelligence', array['AI', 'artificial intelligence', 'model', 'agent']::text[]),
    ('world', 'World events', array['world', 'international', 'global']::text[]),
    ('science', 'Science and discoveries', array['science', 'research', 'discovery']::text[]),
    ('nature', 'Nature and environment', array['nature', 'environment', 'climate', 'ecosystem']::text[]),
    ('animals', 'Animals and wildlife', array['animals', 'wildlife', 'species']::text[]),
    ('history', 'History and archaeology', array['history', 'archaeology', 'historical']::text[]),
    ('culture', 'Culture and ideas', array['culture', 'ideas', 'arts', 'literature']::text[]),
    ('technology', 'Technology and innovation', array['technology', 'innovation', 'engineering']::text[]),
    ('society', 'Society and human development', array['society', 'education', 'human development']::text[]),
    ('climate', 'Climate and climate change', array['climate', 'climate change', 'emissions']::text[]),
    ('health', 'Health and medicine', array['health', 'medicine', 'public health']::text[]),
    ('conflict', 'Conflict and security', array['conflict', 'war', 'security']::text[]),
    ('politics', 'Politics and government', array['politics', 'government', 'election']::text[]),
    ('economy', 'Economy and business', array['economy', 'business', 'markets']::text[]),
    ('space', 'Space and astronomy', array['space', 'astronomy', 'spaceflight']::text[])
)
insert into public.topics (name, description, keywords)
select name, description, keywords
from topic_data
on conflict (name) do update
set description = excluded.description,
    keywords = excluded.keywords,
    updated_at = now();

with translation_data (topic_code, language_code, label, hashtag) as (
  values
    ('ai', 'en', 'Artificial intelligence', '#AI'),
    ('ai', 'uk', 'Штучний інтелект', '#ШІ'),
    ('ai', 'de', 'Künstliche Intelligenz', '#KI'),
    ('world', 'en', 'World', '#World'),
    ('world', 'uk', 'Світ', '#Світ'),
    ('world', 'de', 'Welt', '#Welt'),
    ('science', 'en', 'Science', '#Science'),
    ('science', 'uk', 'Наука', '#Наука'),
    ('science', 'de', 'Wissenschaft', '#Wissenschaft'),
    ('nature', 'en', 'Nature', '#Nature'),
    ('nature', 'uk', 'Природа', '#Природа'),
    ('nature', 'de', 'Natur', '#Natur'),
    ('animals', 'en', 'Animals', '#Animals'),
    ('animals', 'uk', 'Тварини', '#Тварини'),
    ('animals', 'de', 'Tiere', '#Tiere'),
    ('history', 'en', 'History', '#History'),
    ('history', 'uk', 'Історія', '#Історія'),
    ('history', 'de', 'Geschichte', '#Geschichte'),
    ('culture', 'en', 'Culture', '#Culture'),
    ('culture', 'uk', 'Культура', '#Культура'),
    ('culture', 'de', 'Kultur', '#Kultur'),
    ('technology', 'en', 'Technology', '#Technology'),
    ('technology', 'uk', 'Технології', '#Технології'),
    ('technology', 'de', 'Technologie', '#Technologie'),
    ('society', 'en', 'Society', '#Society'),
    ('society', 'uk', 'Суспільство', '#Суспільство'),
    ('society', 'de', 'Gesellschaft', '#Gesellschaft'),
    ('climate', 'en', 'Climate', '#Climate'),
    ('climate', 'uk', 'Клімат', '#Клімат'),
    ('climate', 'de', 'Klima', '#Klima'),
    ('health', 'en', 'Health', '#Health'),
    ('health', 'uk', 'Здоров’я', '#Здоровя'),
    ('health', 'de', 'Gesundheit', '#Gesundheit'),
    ('conflict', 'en', 'Conflict', '#Conflict'),
    ('conflict', 'uk', 'Конфлікти', '#Конфлікти'),
    ('conflict', 'de', 'Konflikte', '#Konflikte'),
    ('politics', 'en', 'Politics', '#Politics'),
    ('politics', 'uk', 'Політика', '#Політика'),
    ('politics', 'de', 'Politik', '#Politik'),
    ('economy', 'en', 'Economy', '#Economy'),
    ('economy', 'uk', 'Економіка', '#Економіка'),
    ('economy', 'de', 'Wirtschaft', '#Wirtschaft'),
    ('space', 'en', 'Space', '#Space'),
    ('space', 'uk', 'Космос', '#Космос'),
    ('space', 'de', 'Weltraum', '#Weltraum')
)
insert into public.topic_translations (
  topic_id,
  language_code,
  label,
  hashtag
)
select topic.id, translation.language_code, translation.label, translation.hashtag
from translation_data as translation
join public.topics as topic on topic.name = translation.topic_code
on conflict (topic_id, language_code) do update
set label = excluded.label,
    hashtag = excluded.hashtag,
    updated_at = now();

alter table public.article_topics
  add column assignment_source text not null default 'ai',
  add column assigned_model text,
  add constraint article_topics_assignment_source_check
    check (assignment_source in ('ai', 'manual', 'rule')),
  add constraint article_topics_assigned_model_check
    check (
      assigned_model is null
      or (
        assigned_model = btrim(assigned_model)
        and char_length(assigned_model) between 1 and 255
        and assigned_model !~ '[[:cntrl:]]'
      )
    );

create table public.news_feature_flags (
  telegram_channel_id text not null
    references public.news_bot_settings(telegram_channel_id) on delete cascade,
  feature_key text not null check (feature_key = 'article_tags'),
  state text not null default 'off'
    check (state in ('off', 'collect', 'enabled')),
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  version integer not null default 1 check (version > 0),
  updated_by bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (telegram_channel_id, feature_key)
);

alter table public.topic_translations enable row level security;
alter table public.news_feature_flags enable row level security;

revoke all on table
  public.topic_translations,
  public.news_feature_flags
from anon, authenticated;

grant select on table public.topic_translations to service_role;
grant select, insert, update on table public.news_feature_flags to service_role;

create function public.get_or_create_news_feature_flags(
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
  values (
    btrim(p_telegram_channel_id),
    'article_tags',
    'off',
    '{}'::jsonb,
    p_updated_by
  )
  on conflict (telegram_channel_id, feature_key) do nothing;

  return query
  select feature.*
  from public.news_feature_flags as feature
  where feature.telegram_channel_id = btrim(p_telegram_channel_id)
  order by feature.feature_key;
end;
$$;

create function public.get_news_feature_flags(p_telegram_channel_id text)
returns setof public.news_feature_flags
language sql
stable
security invoker
set search_path = ''
as $$
  select feature.*
  from public.news_feature_flags as feature
  where feature.telegram_channel_id = btrim(p_telegram_channel_id)
  order by feature.feature_key;
$$;

create function public.update_news_feature_flag(
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
begin
  if nullif(btrim(p_telegram_channel_id), '') is null then
    raise exception 'Telegram channel ID is required';
  end if;
  if p_feature_key is null
     or lower(btrim(p_feature_key)) <> 'article_tags' then
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
    and feature.feature_key = 'article_tags'
    and feature.version = p_expected_version
  returning feature.*;
end;
$$;

create function public.replace_article_topics(
  p_article_id uuid,
  p_assignments jsonb,
  p_assignment_source text,
  p_assigned_model text
)
returns setof public.article_topics
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_assignment_count integer;
  v_distinct_count integer;
  v_assignment_source text;
  v_assigned_model text;
  v_topic_code text;
  v_topic_enabled boolean;
begin
  if p_article_id is null then
    raise exception 'Article ID is required';
  end if;
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'Article topic assignments must be a JSON array';
  end if;

  v_assignment_count := jsonb_array_length(p_assignments);
  if v_assignment_count > 3 then
    raise exception 'At most 3 article topics may be assigned';
  end if;

  v_assignment_source := lower(btrim(p_assignment_source));
  if p_assignment_source is null
     or v_assignment_source not in ('ai', 'manual', 'rule') then
    raise exception 'Invalid article topic assignment source';
  end if;

  if p_assigned_model is not null then
    v_assigned_model := btrim(p_assigned_model);
    if nullif(v_assigned_model, '') is null
       or char_length(v_assigned_model) > 255
       or v_assigned_model ~ '[[:cntrl:]]' then
      raise exception 'Invalid assigned model';
    end if;
  end if;

  perform 1
  from public.articles as article
  where article.id = p_article_id
  for update;
  if not found then
    raise exception 'Article not found';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_assignments) as item(value)
    where jsonb_typeof(item.value) is distinct from 'object'
      or jsonb_typeof(item.value -> 'code') is distinct from 'string'
      or nullif(btrim(item.value ->> 'code'), '') is null
      or jsonb_typeof(item.value -> 'confidence') is distinct from 'number'
  ) then
    raise exception 'Each article topic assignment requires a code and numeric confidence';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_assignments) as item(value)
    where (item.value ->> 'confidence')::numeric < 0
       or (item.value ->> 'confidence')::numeric > 1
  ) then
    raise exception 'Article topic scores must be between 0 and 1';
  end if;

  select count(distinct lower(btrim(item.value ->> 'code')))
  into v_distinct_count
  from jsonb_array_elements(p_assignments) as item(value);
  if v_distinct_count <> v_assignment_count then
    raise exception 'Article topic codes must be unique';
  end if;

  for v_topic_code in
    select lower(btrim(item.value ->> 'code'))
    from jsonb_array_elements(p_assignments) as item(value)
    order by 1
  loop
    select topic.enabled
    into v_topic_enabled
    from public.topics as topic
    where topic.name = v_topic_code
    for share;

    if not found or not v_topic_enabled then
      raise exception 'Assignments must reference enabled topic codes';
    end if;
  end loop;

  delete from public.article_topics as article_topic
  where article_topic.article_id = p_article_id;

  insert into public.article_topics (
    article_id,
    topic_id,
    relevance_score,
    assignment_source,
    assigned_model
  )
  select
    p_article_id,
    topic.id,
    (item.value ->> 'confidence')::numeric,
    v_assignment_source,
    v_assigned_model
  from jsonb_array_elements(p_assignments) as item(value)
  join public.topics as topic
    on topic.name = lower(btrim(item.value ->> 'code'));

  return query
  select article_topic.*
  from public.article_topics as article_topic
  where article_topic.article_id = p_article_id
  order by article_topic.relevance_score desc, article_topic.topic_id;
end;
$$;

create function public.create_review_draft_with_topics(
  p_article_id uuid,
  p_body text,
  p_model text,
  p_prompt_version text,
  p_reviewer_notes text,
  p_lease_name text,
  p_lease_owner_id uuid,
  p_topic_assignments jsonb,
  p_topic_assignment_source text,
  p_topic_assigned_model text
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_draft public.drafts%rowtype;
begin
  select *
  into strict v_draft
  from public.create_review_draft(
    p_article_id,
    p_body,
    p_model,
    p_prompt_version,
    p_reviewer_notes,
    p_lease_name,
    p_lease_owner_id
  );

  perform public.replace_article_topics(
    p_article_id,
    p_topic_assignments,
    p_topic_assignment_source,
    p_topic_assigned_model
  );

  return next v_draft;
end;
$$;

revoke all on function public.get_or_create_news_feature_flags(text, bigint)
  from public, anon, authenticated;
revoke all on function public.get_news_feature_flags(text)
  from public, anon, authenticated;
revoke all on function public.update_news_feature_flag(
  text, text, text, bigint, integer
) from public, anon, authenticated;
revoke all on function public.replace_article_topics(uuid, jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.create_review_draft_with_topics(
  uuid, text, text, text, text, text, uuid, jsonb, text, text
) from public, anon, authenticated;

grant execute on function public.get_or_create_news_feature_flags(text, bigint)
  to service_role;
grant execute on function public.get_news_feature_flags(text)
  to service_role;
grant execute on function public.update_news_feature_flag(
  text, text, text, bigint, integer
) to service_role;
grant execute on function public.replace_article_topics(uuid, jsonb, text, text)
  to service_role;
grant execute on function public.create_review_draft_with_topics(
  uuid, text, text, text, text, text, uuid, jsonb, text, text
) to service_role;

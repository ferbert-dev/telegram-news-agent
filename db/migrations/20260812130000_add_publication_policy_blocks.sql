create table public.publication_policy_blocks (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  telegram_channel_id text not null
    references public.news_bot_settings(telegram_channel_id) on delete restrict,
  draft_id uuid
    references public.drafts(id) on delete restrict,
  article_id uuid
    references public.articles(id) on delete restrict,
  stage text not null,
  publication_path text not null,
  topic_code text not null,
  classification text not null,
  settings_version integer not null,
  outbound_text_sha256 bytea not null,
  provider text,
  model text,
  prompt_version text,
  reason_code text not null,
  created_at timestamptz not null default now(),
  constraint publication_policy_blocks_idempotency_key_check
    check (idempotency_key ~ '^[a-f0-9]{64}$'),
  constraint publication_policy_blocks_channel_check
    check (char_length(btrim(telegram_channel_id)) between 1 and 255),
  constraint publication_policy_blocks_stage_check
    check (stage in ('final_publication', 'direct_publication', 'reconciliation')),
  constraint publication_policy_blocks_path_check
    check (publication_path in (
      'automatic', 'automatic_news', 'manual_review', 'scheduler',
      'drafts_cli', 'reconciliation', 'direct'
    )),
  constraint publication_policy_blocks_topic_check
    check (public.valid_news_excluded_topic_codes(array[topic_code]::text[])),
  constraint publication_policy_blocks_classification_check
    check (classification in ('main_subject', 'uncertain', 'classifier_error')),
  constraint publication_policy_blocks_settings_version_check
    check (settings_version >= 1),
  constraint publication_policy_blocks_outbound_hash_check
    check (octet_length(outbound_text_sha256) = 32),
  constraint publication_policy_blocks_provider_check
    check (
      provider is null
      or provider ~ '^[A-Za-z0-9._:/-]{1,100}$'
    ),
  constraint publication_policy_blocks_model_check
    check (
      model is null
      or model ~ '^[A-Za-z0-9._:/-]{1,100}$'
    ),
  constraint publication_policy_blocks_prompt_version_check
    check (
      prompt_version is null
      or prompt_version ~ '^[A-Za-z0-9._:/-]{1,100}$'
    ),
  constraint publication_policy_blocks_reason_check
    check (reason_code in (
      'excluded_topic_main_subject',
      'excluded_topic_uncertain',
      'excluded_topic_classifier_error'
    ))
);

create unique index publication_policy_blocks_draft_unique
  on public.publication_policy_blocks (telegram_channel_id, draft_id)
  where draft_id is not null;
create index publication_policy_blocks_article_created_idx
  on public.publication_policy_blocks (article_id, created_at desc)
  where article_id is not null;
create index publication_policy_blocks_channel_created_idx
  on public.publication_policy_blocks (telegram_channel_id, created_at desc);

alter table public.publication_policy_blocks enable row level security;

revoke all on table public.publication_policy_blocks
  from public, anon, authenticated;
grant select, insert on table public.publication_policy_blocks
  to service_role;

alter table public.telegram_news_request_checkpoints
  drop constraint telegram_news_request_checkpoints_status_check,
  drop constraint telegram_news_request_checkpoints_result_check,
  add constraint telegram_news_request_checkpoints_status_check
    check (status in (
      'review_ready', 'published', 'no_candidates', 'blocked_by_policy'
    )),
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
    or (
      status = 'blocked_by_policy'
      and draft_id is not null
      and preview is not null
      and publication_message_id is null
    )
  );

create function public.claim_draft_for_publication_with_policy(
  p_draft_id uuid,
  p_channel_id text,
  p_settings_version integer,
  p_outbound_text_sha256 bytea
)
returns table (
  outcome text,
  id uuid,
  article_id uuid,
  body text,
  status text,
  model text,
  prompt_version text,
  reviewer_notes text,
  approved_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_version integer;
  v_draft public.drafts%rowtype;
begin
  if nullif(btrim(p_channel_id), '') is null then
    raise exception 'Telegram channel is required';
  end if;
  if p_settings_version is null or p_settings_version < 1 then
    raise exception 'Valid settings version is required';
  end if;
  if p_outbound_text_sha256 is null
     or octet_length(p_outbound_text_sha256) <> 32 then
    raise exception 'Exact 32-byte outbound text digest is required';
  end if;

  p_channel_id := btrim(p_channel_id);

  select settings.version
  into v_current_version
  from public.news_bot_settings as settings
  where settings.telegram_channel_id = p_channel_id
  for update;

  select draft.*
  into v_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if exists (
    select 1
    from public.published_posts as publication
    where publication.draft_id = p_draft_id
  ) then
    return query select
      'already_published'::text,
      v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
      v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
      v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
    return;
  end if;

  if exists (
    select 1
    from public.publication_policy_blocks as policy_block
    where policy_block.telegram_channel_id = p_channel_id
      and policy_block.draft_id = p_draft_id
  ) then
    return query select
      'already_blocked'::text,
      v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
      v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
      v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
    return;
  end if;

  if v_current_version is null or v_current_version <> p_settings_version then
    return query select
      'stale_settings'::text,
      v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
      v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
      v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
    return;
  end if;

  if v_draft.id is null or v_draft.status <> 'approved' then
    return query select
      'not_publishable'::text,
      v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
      v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
      v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
    return;
  end if;

  if sha256(convert_to(v_draft.body, 'UTF8')) <> p_outbound_text_sha256 then
    return query select
      'outbound_changed'::text,
      v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
      v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
      v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
    return;
  end if;

  select claimed.*
  into v_draft
  from public.claim_draft_for_publication(p_draft_id, p_channel_id) as claimed;

  if v_draft.id is null then
    raise exception 'Publication claim returned no draft';
  end if;

  return query select
    'claimed'::text,
    v_draft.id, v_draft.article_id, v_draft.body, v_draft.status,
    v_draft.model, v_draft.prompt_version, v_draft.reviewer_notes,
    v_draft.approved_at, v_draft.created_at, v_draft.updated_at;
end;
$$;

create function public.block_draft_publication(
  p_draft_id uuid,
  p_channel_id text,
  p_stage text,
  p_publication_path text,
  p_topic_code text,
  p_classification text,
  p_settings_version integer,
  p_outbound_text text,
  p_outbound_text_sha256 bytea,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_reason_code text
)
returns table (
  outcome text,
  block_id uuid,
  draft_id uuid,
  article_id uuid,
  draft_status text,
  reason_code text,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_version integer;
  v_draft public.drafts%rowtype;
  v_block public.publication_policy_blocks%rowtype;
  v_idempotency_key text;
begin
  if nullif(btrim(p_channel_id), '') is null then
    raise exception 'Telegram channel is required';
  end if;
  if p_outbound_text is null then
    raise exception 'Exact outbound text is required';
  end if;
  if p_outbound_text_sha256 is null
     or octet_length(p_outbound_text_sha256) <> 32
     or sha256(convert_to(p_outbound_text, 'UTF8')) <> p_outbound_text_sha256 then
    raise exception 'Exact outbound text digest mismatch';
  end if;

  p_channel_id := btrim(p_channel_id);

  select settings.version
  into v_current_version
  from public.news_bot_settings as settings
  where settings.telegram_channel_id = p_channel_id
  for update;

  select draft.*
  into v_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if exists (
    select 1
    from public.published_posts as publication
    where publication.draft_id = p_draft_id
  ) then
    return query select
      'already_published'::text, null::uuid, v_draft.id,
      v_draft.article_id, v_draft.status, null::text, null::timestamptz;
    return;
  end if;

  select policy_block.*
  into v_block
  from public.publication_policy_blocks as policy_block
  where policy_block.telegram_channel_id = p_channel_id
    and policy_block.draft_id = p_draft_id;

  if v_block.id is not null then
    return query select
      'already_blocked'::text, v_block.id, v_block.draft_id,
      v_block.article_id, v_draft.status, v_block.reason_code,
      v_block.created_at;
    return;
  end if;

  if v_current_version is null or v_current_version <> p_settings_version then
    return query select
      'stale_settings'::text, null::uuid, v_draft.id,
      v_draft.article_id, v_draft.status, null::text, null::timestamptz;
    return;
  end if;

  if v_draft.id is null or v_draft.status <> 'approved' then
    return query select
      'not_publishable'::text, null::uuid, v_draft.id,
      v_draft.article_id, v_draft.status, null::text, null::timestamptz;
    return;
  end if;

  if v_draft.body <> p_outbound_text then
    return query select
      'outbound_changed'::text, null::uuid, v_draft.id,
      v_draft.article_id, v_draft.status, null::text, null::timestamptz;
    return;
  end if;

  v_idempotency_key := encode(sha256(convert_to(concat_ws(
    E'\x1f',
    p_channel_id,
    p_draft_id::text,
    v_draft.article_id::text,
    p_stage,
    p_publication_path,
    p_topic_code,
    p_classification,
    p_settings_version::text,
    encode(p_outbound_text_sha256, 'hex'),
    p_reason_code
  ), 'UTF8')), 'hex');

  insert into public.publication_policy_blocks (
    idempotency_key, telegram_channel_id, draft_id, article_id,
    stage, publication_path, topic_code, classification, settings_version,
    outbound_text_sha256, provider, model, prompt_version, reason_code
  ) values (
    v_idempotency_key, p_channel_id, p_draft_id, v_draft.article_id,
    p_stage, p_publication_path, p_topic_code, p_classification,
    p_settings_version, p_outbound_text_sha256, p_provider, p_model,
    p_prompt_version, p_reason_code
  )
  returning * into v_block;

  update public.drafts
  set status = 'rejected', updated_at = now()
  where public.drafts.id = p_draft_id
    and public.drafts.status = 'approved'
  returning * into v_draft;

  if v_draft.id is null then
    raise exception 'Draft policy block lost its approved-state claim';
  end if;

  update public.articles
  set status = 'rejected', updated_at = now()
  where public.articles.id = v_draft.article_id
    and public.articles.status in ('drafted', 'approved');

  return query select
    'blocked'::text, v_block.id, v_block.draft_id, v_block.article_id,
    v_draft.status, v_block.reason_code, v_block.created_at;
end;
$$;

create function public.record_direct_publication_policy_block(
  p_channel_id text,
  p_article_id uuid,
  p_publication_path text,
  p_topic_code text,
  p_classification text,
  p_settings_version integer,
  p_outbound_text text,
  p_outbound_text_sha256 bytea,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_reason_code text
)
returns setof public.publication_policy_blocks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_version integer;
  v_idempotency_key text;
begin
  if nullif(btrim(p_channel_id), '') is null then
    raise exception 'Telegram channel is required';
  end if;
  if p_outbound_text is null
     or p_outbound_text_sha256 is null
     or octet_length(p_outbound_text_sha256) <> 32
     or sha256(convert_to(p_outbound_text, 'UTF8')) <> p_outbound_text_sha256 then
    raise exception 'Exact outbound text digest mismatch';
  end if;

  p_channel_id := btrim(p_channel_id);
  select settings.version
  into v_current_version
  from public.news_bot_settings as settings
  where settings.telegram_channel_id = p_channel_id
  for update;

  if v_current_version is null or v_current_version <> p_settings_version then
    raise exception using
      errcode = 'P0001',
      message = 'stale_publication_policy_settings';
  end if;

  v_idempotency_key := encode(sha256(convert_to(concat_ws(
    E'\x1f',
    p_channel_id,
    coalesce(p_article_id::text, ''),
    'direct_publication',
    p_publication_path,
    p_topic_code,
    p_classification,
    p_settings_version::text,
    encode(p_outbound_text_sha256, 'hex'),
    p_reason_code
  ), 'UTF8')), 'hex');

  return query
  insert into public.publication_policy_blocks (
    idempotency_key, telegram_channel_id, draft_id, article_id,
    stage, publication_path, topic_code, classification, settings_version,
    outbound_text_sha256, provider, model, prompt_version, reason_code
  ) values (
    v_idempotency_key, p_channel_id, null, p_article_id,
    'direct_publication', p_publication_path, p_topic_code, p_classification,
    p_settings_version, p_outbound_text_sha256, p_provider, p_model,
    p_prompt_version, p_reason_code
  )
  on conflict (idempotency_key) do nothing
  returning *;

  if found then
    return;
  end if;

  return query
  select policy_block.*
  from public.publication_policy_blocks as policy_block
  where policy_block.idempotency_key = v_idempotency_key;
end;
$$;

revoke all on function public.claim_draft_for_publication_with_policy(
  uuid, text, integer, bytea
) from public, anon, authenticated;
revoke all on function public.block_draft_publication(
  uuid, text, text, text, text, text, integer, text, bytea,
  text, text, text, text
) from public, anon, authenticated;
revoke all on function public.record_direct_publication_policy_block(
  text, uuid, text, text, text, integer, text, bytea,
  text, text, text, text
) from public, anon, authenticated;

grant execute on function public.claim_draft_for_publication_with_policy(
  uuid, text, integer, bytea
) to service_role;
grant execute on function public.block_draft_publication(
  uuid, text, text, text, text, text, integer, text, bytea,
  text, text, text, text
) to service_role;
grant execute on function public.record_direct_publication_policy_block(
  text, uuid, text, text, text, integer, text, bytea,
  text, text, text, text
) to service_role;

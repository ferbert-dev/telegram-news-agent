create table public.article_story_decisions (
  article_id uuid primary key
    references public.articles(id) on delete cascade,
  story_fingerprint text not null,
  relation text not null,
  duplicate_of_article_id uuid
    references public.articles(id) on delete set null,
  confidence numeric(5, 4),
  reason text,
  decision_source text not null,
  metadata jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint article_story_decisions_relation_check
    check (relation in ('distinct', 'duplicate', 'follow_up', 'uncertain')),
  constraint article_story_decisions_source_check
    check (decision_source in ('deterministic', 'ai', 'fallback')),
  constraint article_story_decisions_confidence_check
    check (confidence is null or confidence between 0 and 1),
  constraint article_story_decisions_duplicate_target_check
    check (
      (relation in ('duplicate', 'follow_up') and duplicate_of_article_id is not null)
      or (relation in ('distinct', 'uncertain') and duplicate_of_article_id is null)
    )
);

create index article_story_decisions_fingerprint_idx
  on public.article_story_decisions (story_fingerprint);
create index article_story_decisions_duplicate_of_idx
  on public.article_story_decisions (duplicate_of_article_id)
  where duplicate_of_article_id is not null;

create table public.story_publication_claims (
  telegram_channel_id text not null,
  story_fingerprint text not null,
  draft_id uuid not null unique
    references public.drafts(id) on delete restrict,
  article_id uuid not null
    references public.articles(id) on delete restrict,
  status text not null default 'publishing',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (telegram_channel_id, story_fingerprint),
  constraint story_publication_claims_channel_check
    check (btrim(telegram_channel_id) <> ''),
  constraint story_publication_claims_fingerprint_check
    check (btrim(story_fingerprint) <> ''),
  constraint story_publication_claims_status_check
    check (status in ('publishing', 'published'))
);

create index story_publication_claims_article_id_idx
  on public.story_publication_claims (article_id);

alter table public.article_story_decisions enable row level security;
alter table public.story_publication_claims enable row level security;

revoke all on table public.article_story_decisions
  from public, anon, authenticated;
revoke all on table public.story_publication_claims
  from public, anon, authenticated;
grant select, insert, update on table public.article_story_decisions
  to service_role;
grant select, insert, update, delete on table public.story_publication_claims
  to service_role;

drop function public.claim_draft_for_publication(uuid);

create function public.claim_draft_for_publication(
  p_draft_id uuid,
  p_channel_id text
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_article_id uuid;
  v_fingerprint text;
  v_relation text;
  v_duplicate_of_article_id uuid;
  v_conflicting_article_id uuid;
begin
  if nullif(btrim(p_channel_id), '') is null then
    raise exception 'Telegram channel is required';
  end if;
  p_channel_id := btrim(p_channel_id);

  if exists (
    select 1 from public.published_posts where draft_id = p_draft_id
  ) then
    raise exception 'Draft is already published';
  end if;

  select
    d.article_id,
    decision.story_fingerprint,
    decision.relation,
    decision.duplicate_of_article_id
  into
    v_article_id,
    v_fingerprint,
    v_relation,
    v_duplicate_of_article_id
  from public.drafts d
  left join public.article_story_decisions decision
    on decision.article_id = d.article_id
  where d.id = p_draft_id
    and d.status = 'approved'
  for update of d;

  if v_article_id is null then
    raise exception 'Draft is not approved or is already being published';
  end if;

  if v_relation = 'duplicate' and exists (
    select 1
    from public.published_posts publication
    where publication.article_id = v_duplicate_of_article_id
      and publication.telegram_channel_id = p_channel_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'duplicate_story_publication',
      detail = v_duplicate_of_article_id::text;
  end if;

  if v_relation = 'uncertain' then
    raise exception using
      errcode = 'P0001',
      message = 'uncertain_story_publication';
  end if;

  if v_fingerprint is not null then
    insert into public.story_publication_claims (
      telegram_channel_id,
      story_fingerprint,
      draft_id,
      article_id,
      status
    ) values (
      p_channel_id,
      v_fingerprint,
      p_draft_id,
      v_article_id,
      'publishing'
    )
    on conflict (telegram_channel_id, story_fingerprint) do update
    set draft_id = excluded.draft_id,
        article_id = excluded.article_id,
        status = 'publishing',
        created_at = now(),
        updated_at = now()
    where public.story_publication_claims.status = 'published'
      and public.story_publication_claims.updated_at < now() - interval '14 days';

    if not found then
      select claim.article_id
      into v_conflicting_article_id
      from public.story_publication_claims claim
      where claim.telegram_channel_id = p_channel_id
        and claim.story_fingerprint = v_fingerprint;
      raise exception using
        errcode = 'P0001',
        message = 'duplicate_story_publication',
        detail = coalesce(v_conflicting_article_id::text, 'unknown');
    end if;
  end if;

  update public.drafts
  set status = 'publishing', updated_at = now()
  where id = p_draft_id and status = 'approved';

  if not found then
    raise exception 'Draft is not approved or is already being published';
  end if;

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

-- Keep the N-1 runtime and automated rollback image compatible while the
-- deployment migration is applied before the new bot container starts.
create function public.claim_draft_for_publication(p_draft_id uuid)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_channel_id text;
begin
  select coalesce(
    (
      select review_session.telegram_channel_id
      from public.telegram_review_sessions review_session
      where review_session.draft_id = p_draft_id
        and nullif(btrim(review_session.telegram_channel_id), '') is not null
      limit 1
    ),
    (
      select settings.telegram_channel_id
      from public.news_bot_settings settings
      where settings.schedule_draft_id = p_draft_id
      limit 1
    ),
    (
      select min(settings.telegram_channel_id)
      from public.news_bot_settings settings
      having count(*) = 1
    )
  ) into v_channel_id;

  if v_channel_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'legacy_publication_channel_unresolved';
  end if;

  return query
  select *
  from public.claim_draft_for_publication(p_draft_id, v_channel_id);
end;
$$;

create or replace function public.finalize_draft_publication(
  p_draft_id uuid,
  p_channel_id text,
  p_message_id bigint,
  p_message_text text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.published_posts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_article_id uuid;
  v_claim_channel_id text;
begin
  if nullif(btrim(p_channel_id), '') is null then
    raise exception 'Telegram channel is required';
  end if;
  p_channel_id := btrim(p_channel_id);

  select article_id into v_article_id
  from public.drafts
  where id = p_draft_id and status = 'publishing'
  for update;

  if v_article_id is null then
    raise exception 'Draft is not in publishing state';
  end if;

  select claim.telegram_channel_id
  into v_claim_channel_id
  from public.story_publication_claims claim
  where claim.draft_id = p_draft_id
  for update;

  if v_claim_channel_id is not null
    and v_claim_channel_id <> p_channel_id then
    raise exception using
      errcode = 'P0001',
      message = 'story_publication_channel_mismatch',
      detail = v_claim_channel_id;
  end if;

  insert into public.published_posts (
    draft_id, article_id, telegram_channel_id, telegram_message_id,
    message_text, metadata
  ) values (
    p_draft_id, v_article_id, p_channel_id, p_message_id,
    p_message_text, p_metadata
  );

  update public.drafts
  set status = 'published', updated_at = now()
  where id = p_draft_id;

  update public.articles
  set status = 'published', updated_at = now()
  where id = v_article_id and status = 'approved';

  if not found then
    raise exception 'Article is not in approved state';
  end if;

  update public.story_publication_claims
  set status = 'published', updated_at = now()
  where draft_id = p_draft_id
    and telegram_channel_id = p_channel_id;

  if v_claim_channel_id is not null and not found then
    raise exception 'Story publication claim was not finalized';
  end if;

  return query
  select * from public.published_posts where draft_id = p_draft_id;
end;
$$;

create or replace function public.reset_draft_publication(
  p_draft_id uuid,
  p_confirmation text
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_confirmation <> 'TELEGRAM_NOT_SENT' then
    raise exception 'Exact TELEGRAM_NOT_SENT confirmation is required';
  end if;

  update public.drafts
  set status = 'approved', updated_at = now()
  where id = p_draft_id
    and status = 'publishing'
    and not exists (
      select 1
      from public.published_posts
      where draft_id = p_draft_id
    );

  if not found then
    raise exception 'Draft is not an unresolved publication';
  end if;

  delete from public.story_publication_claims
  where draft_id = p_draft_id and status = 'publishing';

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

create or replace function public.release_rejected_draft_publication(
  p_draft_id uuid
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.drafts
  set status = 'approved', updated_at = now()
  where id = p_draft_id
    and status = 'publishing'
    and not exists (
      select 1
      from public.published_posts
      where draft_id = p_draft_id
    );

  if not found then
    raise exception 'Draft publication is not releasable';
  end if;

  delete from public.story_publication_claims
  where draft_id = p_draft_id and status = 'publishing';

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

revoke all on function public.claim_draft_for_publication(uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_draft_for_publication(uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_draft_publication(
  uuid, text, bigint, text, jsonb
) from public, anon, authenticated;
revoke all on function public.reset_draft_publication(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_rejected_draft_publication(uuid)
  from public, anon, authenticated;

grant execute on function public.claim_draft_for_publication(uuid, text)
  to service_role;
grant execute on function public.claim_draft_for_publication(uuid)
  to service_role;
grant execute on function public.finalize_draft_publication(
  uuid, text, bigint, text, jsonb
) to service_role;
grant execute on function public.reset_draft_publication(uuid, text)
  to service_role;
grant execute on function public.release_rejected_draft_publication(uuid)
  to service_role;

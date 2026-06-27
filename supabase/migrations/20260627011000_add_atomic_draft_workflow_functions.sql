create or replace function public.approve_draft(p_draft_id uuid)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_article_id uuid;
begin
  update public.drafts
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_draft_id and status = 'review'
  returning article_id into v_article_id;

  if v_article_id is null then
    raise exception 'Draft is not in review state';
  end if;

  update public.articles
  set status = 'approved', updated_at = now()
  where id = v_article_id and status = 'drafted';

  if not found then
    raise exception 'Article is not in drafted state';
  end if;

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

create or replace function public.claim_draft_for_publication(p_draft_id uuid)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.published_posts where draft_id = p_draft_id
  ) then
    raise exception 'Draft is already published';
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
begin
  select article_id into v_article_id
  from public.drafts
  where id = p_draft_id and status = 'publishing'
  for update;

  if v_article_id is null then
    raise exception 'Draft is not in publishing state';
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

  return query
  select * from public.published_posts where draft_id = p_draft_id;
end;
$$;

revoke all on function public.approve_draft(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_draft_for_publication(uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_draft_publication(
  uuid, text, bigint, text, jsonb
) from public, anon, authenticated;
grant execute on function public.approve_draft(uuid) to service_role;
grant execute on function public.claim_draft_for_publication(uuid)
  to service_role;
grant execute on function public.finalize_draft_publication(
  uuid, text, bigint, text, jsonb
) to service_role;

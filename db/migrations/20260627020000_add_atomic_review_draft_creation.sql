create or replace function public.create_review_draft(
  p_article_id uuid,
  p_body text,
  p_model text default null,
  p_prompt_version text default null,
  p_reviewer_notes text default null,
  p_lease_name text default null,
  p_lease_owner_id uuid default null
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_draft_id uuid;
begin
  if nullif(btrim(p_body), '') is null then
    raise exception 'Draft body is required';
  end if;

  if (p_lease_name is null) <> (p_lease_owner_id is null) then
    raise exception 'Lease name and owner must be provided together';
  end if;

  if p_lease_name is not null then
    perform 1
    from public.pipeline_leases
    where name = p_lease_name
      and owner_id = p_lease_owner_id
      and expires_at > now()
    for update;

    if not found then
      raise exception 'Pipeline lease is expired or owned by another run';
    end if;
  end if;

  perform 1
  from public.articles
  where id = p_article_id and status = 'discovered'
  for update;

  if not found then
    raise exception 'Article is not in discovered state';
  end if;

  update public.articles
  set status = 'extracted', updated_at = now()
  where id = p_article_id and status = 'discovered';

  if not found then
    raise exception 'Article state changed before extraction';
  end if;

  update public.articles
  set status = 'reviewed', updated_at = now()
  where id = p_article_id and status = 'extracted';

  if not found then
    raise exception 'Article state changed before review';
  end if;

  insert into public.drafts (
    article_id,
    body,
    status,
    model,
    prompt_version,
    reviewer_notes
  )
  values (
    p_article_id,
    p_body,
    'review',
    p_model,
    p_prompt_version,
    p_reviewer_notes
  )
  returning id into v_draft_id;

  update public.articles
  set status = 'drafted', updated_at = now()
  where id = p_article_id and status = 'reviewed';

  if not found then
    raise exception 'Article state changed while creating draft';
  end if;

  return query
  select * from public.drafts where id = v_draft_id;
end;
$$;

revoke all on function public.create_review_draft(
  uuid, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_review_draft(
  uuid, text, text, text, text, text, uuid
) to service_role;

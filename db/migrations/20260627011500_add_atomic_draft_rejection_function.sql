create or replace function public.reject_draft(
  p_draft_id uuid,
  p_reason text default null
)
returns setof public.drafts
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_article_id uuid;
begin
  update public.drafts
  set status = 'rejected',
      reviewer_notes = coalesce(p_reason, reviewer_notes),
      updated_at = now()
  where id = p_draft_id and status in ('review', 'approved')
  returning article_id into v_article_id;

  if v_article_id is null then
    raise exception 'Draft cannot be rejected from its current state';
  end if;

  update public.articles
  set status = 'rejected', updated_at = now()
  where id = v_article_id and status in ('drafted', 'approved');

  if not found then
    raise exception 'Article cannot be rejected from its current state';
  end if;

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

revoke all on function public.reject_draft(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reject_draft(uuid, text) to service_role;

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

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

revoke all on function public.reset_draft_publication(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reset_draft_publication(uuid, text)
  to service_role;

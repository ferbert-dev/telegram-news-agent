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

  return query select * from public.drafts where id = p_draft_id;
end;
$$;

create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_update_kind text,
  p_stale_after_seconds integer default 120
)
returns table (
  claimed boolean,
  claim_token uuid,
  claim_status text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_stale_after_seconds < 30 or p_stale_after_seconds > 3600 then
    raise exception 'Stale threshold must be between 30 and 3600 seconds';
  end if;

  return query
  insert into public.telegram_updates (
    update_id,
    update_kind,
    status,
    claim_token,
    claimed_at,
    completed_at,
    error_code
  )
  values (
    p_update_id,
    p_update_kind,
    'processing',
    gen_random_uuid(),
    now(),
    null,
    null
  )
  on conflict (update_id) do update
  set update_kind = excluded.update_kind,
      status = 'processing',
      claim_token = excluded.claim_token,
      claimed_at = excluded.claimed_at,
      completed_at = null,
      error_code = null
  where public.telegram_updates.status = 'failed'
     or (
       public.telegram_updates.status = 'processing'
       and public.telegram_updates.claimed_at
         <= now() - make_interval(secs => p_stale_after_seconds)
     )
  returning true, telegram_updates.claim_token, 'claimed'::text;

  if not found then
    return query
    select
      false,
      null::uuid,
      case
        when telegram_updates.status = 'processing' then 'busy'
        else 'terminal'
      end
    from public.telegram_updates
    where update_id = p_update_id;
  end if;
end;
$$;

revoke all on function public.release_rejected_draft_publication(uuid)
  from public, anon, authenticated;
grant execute on function public.release_rejected_draft_publication(uuid)
  to service_role;

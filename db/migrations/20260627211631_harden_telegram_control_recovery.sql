alter table public.telegram_updates
  add column claim_token uuid,
  add column claimed_at timestamptz;

update public.telegram_updates
set claim_token = gen_random_uuid(),
    claimed_at = received_at
where claim_token is null;

alter table public.telegram_updates
  alter column claim_token set not null,
  alter column claimed_at set not null,
  alter column claim_token set default gen_random_uuid(),
  alter column claimed_at set default now();

create index telegram_updates_stale_processing_idx
  on public.telegram_updates (claimed_at)
  where status = 'processing';

create or replace function public.decide_telegram_review_session(
  p_session_id text,
  p_action text,
  p_chat_id bigint,
  p_message_id bigint,
  p_actor_id bigint
)
returns table (
  session_id text,
  draft_id uuid,
  decision text,
  decision_won boolean,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.telegram_review_sessions%rowtype;
  v_article_id uuid;
begin
  if p_action not in ('publish', 'reject') then
    raise exception 'Invalid review action';
  end if;

  select * into v_session
  from public.telegram_review_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Review session not found';
  end if;
  if v_session.control_chat_id <> p_chat_id
     or v_session.preview_message_id <> p_message_id then
    raise exception 'Review session binding mismatch';
  end if;

  if v_session.decision is not null then
    return query select
      v_session.id, v_session.draft_id, v_session.decision, false,
      v_session.expires_at;
    return;
  end if;

  if v_session.expires_at <= now() then
    raise exception 'Review session expired';
  end if;

  update public.telegram_review_sessions
  set decision = p_action, decided_by = p_actor_id, decided_at = now()
  where id = p_session_id;

  if p_action = 'publish' then
    update public.drafts
    set status = 'approved', approved_at = now(), updated_at = now()
    where id = v_session.draft_id and status = 'review'
    returning article_id into v_article_id;

    if v_article_id is null then
      raise exception 'Draft is not in review state';
    end if;

    update public.articles
    set status = 'approved', updated_at = now()
    where id = v_article_id and status = 'drafted';
  else
    update public.drafts
    set status = 'rejected',
        reviewer_notes = 'Rejected from Telegram review',
        updated_at = now()
    where id = v_session.draft_id and status = 'review'
    returning article_id into v_article_id;

    if v_article_id is null then
      raise exception 'Draft is not in review state';
    end if;

    update public.articles
    set status = 'rejected', updated_at = now()
    where id = v_article_id and status = 'drafted';
  end if;

  if not found then
    raise exception 'Article is not in the expected state';
  end if;

  return query select
    v_session.id, v_session.draft_id, p_action, true, v_session.expires_at;
end;
$$;

drop function public.claim_telegram_update(bigint, text);

create function public.claim_telegram_update(
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
  where public.telegram_updates.status = 'processing'
    and public.telegram_updates.claimed_at
      <= now() - make_interval(secs => p_stale_after_seconds)
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

create function public.finish_telegram_update(
  p_update_id bigint,
  p_claim_token uuid,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_finished boolean;
begin
  if p_status not in ('completed', 'failed') then
    raise exception 'Invalid terminal update status';
  end if;

  update public.telegram_updates
  set status = p_status,
      completed_at = now(),
      error_code = p_error_code
  where update_id = p_update_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning true into v_finished;

  return coalesce(v_finished, false);
end;
$$;

create or replace function public.renew_pipeline_lease(
  p_name text,
  p_owner_id uuid,
  p_ttl_seconds integer default 60
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_renewed boolean;
begin
  if p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'Lease TTL must be between 30 and 3600 seconds';
  end if;

  update public.pipeline_leases
  set expires_at = now() + make_interval(secs => p_ttl_seconds)
  where name = p_name
    and owner_id = p_owner_id
    and expires_at > now()
  returning true into v_renewed;

  return coalesce(v_renewed, false);
end;
$$;

revoke all on function public.claim_telegram_update(bigint, text, integer)
  from public, anon, authenticated;
revoke all on function public.finish_telegram_update(bigint, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.renew_pipeline_lease(text, uuid, integer)
  from public, anon, authenticated;

grant execute on function public.claim_telegram_update(bigint, text, integer)
  to service_role;
grant execute on function public.finish_telegram_update(bigint, uuid, text, text)
  to service_role;
grant execute on function public.renew_pipeline_lease(text, uuid, integer)
  to service_role;

alter table public.telegram_updates
  add column failure_count integer not null default 0,
  add column last_error_at timestamptz,
  add column quarantined_at timestamptz;

alter table public.telegram_updates
  drop constraint telegram_updates_status_check;

alter table public.telegram_updates
  add constraint telegram_updates_status_check
    check (status in ('processing', 'completed', 'failed', 'quarantined')),
  add constraint telegram_updates_failure_count_check
    check (failure_count >= 0),
  add constraint telegram_updates_quarantine_metadata_check
    check ((status = 'quarantined') = (quarantined_at is not null));

create index telegram_updates_quarantined_at_idx
  on public.telegram_updates (quarantined_at)
  where status = 'quarantined';

create function public.record_telegram_update_failure(
  p_update_id bigint,
  p_update_kind text,
  p_error_code text,
  p_max_attempts integer default 3,
  p_terminal boolean default false,
  p_claim_token uuid default null
)
returns table (
  attempt_count integer,
  terminal boolean,
  failure_status text,
  recorded boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'Maximum update attempts must be between 1 and 20';
  end if;
  if p_update_kind is null or btrim(p_update_kind) = ''
     or length(p_update_kind) > 64 then
    raise exception 'Invalid Telegram update kind';
  end if;
  if p_error_code is null or btrim(p_error_code) = ''
     or length(p_error_code) > 64 then
    raise exception 'Invalid Telegram update error code';
  end if;

  if p_claim_token is not null then
    return query
    update public.telegram_updates as existing
    set update_kind = btrim(p_update_kind),
        status = case
          when p_terminal or existing.failure_count + 1 >= p_max_attempts
            then 'quarantined'
          else 'failed'
        end,
        claim_token = gen_random_uuid(),
        claimed_at = now(),
        completed_at = now(),
        error_code = btrim(p_error_code),
        failure_count = existing.failure_count + 1,
        last_error_at = now(),
        quarantined_at = case
          when p_terminal or existing.failure_count + 1 >= p_max_attempts
            then coalesce(existing.quarantined_at, now())
          else null
        end
    where existing.update_id = p_update_id
      and existing.status = 'processing'
      and existing.claim_token = p_claim_token
    returning
      existing.failure_count,
      existing.status in ('completed', 'quarantined'),
      existing.status,
      true;

    if found then
      return;
    end if;

    return query
    select
      telegram_updates.failure_count,
      telegram_updates.status in ('completed', 'quarantined'),
      telegram_updates.status,
      false
    from public.telegram_updates
    where update_id = p_update_id;

    if not found then
      raise exception 'Telegram update claim not found';
    end if;
    return;
  end if;

  return query
  insert into public.telegram_updates as existing (
    update_id,
    update_kind,
    status,
    claim_token,
    claimed_at,
    completed_at,
    error_code,
    failure_count,
    last_error_at,
    quarantined_at
  )
  values (
    p_update_id,
    btrim(p_update_kind),
    case when p_terminal or p_max_attempts = 1
      then 'quarantined' else 'failed' end,
    gen_random_uuid(),
    now(),
    now(),
    btrim(p_error_code),
    1,
    now(),
    case when p_terminal or p_max_attempts = 1 then now() else null end
  )
  on conflict (update_id) do update
  set update_kind = excluded.update_kind,
      status = case
        when p_terminal or existing.failure_count + 1 >= p_max_attempts
          then 'quarantined'
        else 'failed'
      end,
      claim_token = gen_random_uuid(),
      claimed_at = now(),
      completed_at = now(),
      error_code = excluded.error_code,
      failure_count = existing.failure_count + 1,
      last_error_at = now(),
      quarantined_at = case
        when p_terminal or existing.failure_count + 1 >= p_max_attempts
          then coalesce(existing.quarantined_at, now())
        else null
      end
  where existing.status = 'failed'
  returning
    existing.failure_count,
    existing.status in ('completed', 'quarantined'),
    existing.status,
    true;

  if not found then
    return query
    select
      telegram_updates.failure_count,
      telegram_updates.status in ('completed', 'quarantined'),
      telegram_updates.status,
      false
    from public.telegram_updates
    where update_id = p_update_id;
  end if;
end;
$$;

revoke all on function public.record_telegram_update_failure(
  bigint,
  text,
  text,
  integer,
  boolean,
  uuid
) from public, anon, authenticated;

grant execute on function public.record_telegram_update_failure(
  bigint,
  text,
  text,
  integer,
  boolean,
  uuid
) to service_role;

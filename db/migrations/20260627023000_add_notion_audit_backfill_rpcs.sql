alter table public.notion_audit_outbox
  add column claimed_at timestamptz;

create or replace function public.claim_notion_audit_backfill(
  p_limit integer default 25
)
returns setof public.notion_audit_outbox
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 100 then
    raise exception 'Backfill claim limit must be between 1 and 100';
  end if;

  return query
  with claimed as (
    select id
    from public.notion_audit_outbox
    where completed_at is null
      and available_at <= now()
      and (claimed_at is null or claimed_at <= now() - interval '5 minutes')
    order by available_at, created_at
    for update skip locked
    limit p_limit
  )
  update public.notion_audit_outbox as outbox
  set claimed_at = now(),
      attempt_count = outbox.attempt_count + 1,
      updated_at = now()
  from claimed
  where outbox.id = claimed.id
  returning outbox.*;
end;
$$;

create or replace function public.complete_notion_audit_backfill(p_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_completed boolean;
begin
  update public.notion_audit_outbox
  set completed_at = now(), claimed_at = null, updated_at = now()
  where id = p_id and completed_at is null and claimed_at is not null
  returning true into v_completed;

  return coalesce(v_completed, false);
end;
$$;

create or replace function public.retry_notion_audit_backfill(
  p_id uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_retried boolean;
begin
  update public.notion_audit_outbox
  set claimed_at = null,
      last_error = p_error,
      available_at = now() + make_interval(
        secs => least(
          3600,
          30 * power(2, least(attempt_count, 7))::integer
        )
      ),
      updated_at = now()
  where id = p_id and completed_at is null and claimed_at is not null
  returning true into v_retried;

  return coalesce(v_retried, false);
end;
$$;

revoke all on function public.claim_notion_audit_backfill(integer)
  from public, anon, authenticated;
revoke all on function public.complete_notion_audit_backfill(uuid)
  from public, anon, authenticated;
revoke all on function public.retry_notion_audit_backfill(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_notion_audit_backfill(integer)
  to service_role;
grant execute on function public.complete_notion_audit_backfill(uuid)
  to service_role;
grant execute on function public.retry_notion_audit_backfill(uuid, text)
  to service_role;

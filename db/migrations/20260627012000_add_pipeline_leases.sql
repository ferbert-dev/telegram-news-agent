create table if not exists public.pipeline_leases (
  name text primary key,
  owner_id uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.pipeline_leases enable row level security;
revoke all on table public.pipeline_leases from anon, authenticated;
grant select, insert, update, delete on table public.pipeline_leases to service_role;

create or replace function public.acquire_pipeline_lease(
  p_name text,
  p_owner_id uuid,
  p_ttl_seconds integer default 900
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acquired boolean;
begin
  if p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'Lease TTL must be between 30 and 3600 seconds';
  end if;

  insert into public.pipeline_leases (name, owner_id, acquired_at, expires_at)
  values (
    p_name,
    p_owner_id,
    now(),
    now() + make_interval(secs => p_ttl_seconds)
  )
  on conflict (name) do update
  set owner_id = excluded.owner_id,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
  where public.pipeline_leases.expires_at <= now()
     or public.pipeline_leases.owner_id = excluded.owner_id
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_pipeline_lease(
  p_name text,
  p_owner_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_released boolean;
begin
  delete from public.pipeline_leases
  where name = p_name and owner_id = p_owner_id
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

revoke all on function public.acquire_pipeline_lease(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_pipeline_lease(text, uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_pipeline_lease(text, uuid, integer)
  to service_role;
grant execute on function public.release_pipeline_lease(text, uuid)
  to service_role;

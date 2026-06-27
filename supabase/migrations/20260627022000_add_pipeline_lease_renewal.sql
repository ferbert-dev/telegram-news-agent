create or replace function public.renew_pipeline_lease(
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

revoke all on function public.renew_pipeline_lease(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_pipeline_lease(text, uuid, integer)
  to service_role;

create table public.notion_audit_outbox (
  id uuid primary key default gen_random_uuid(),
  notion_page_id text not null,
  event_type text not null check (event_type in ('finalize_success')),
  payload jsonb not null,
  last_error text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notion_page_id, event_type)
);

create index notion_audit_outbox_pending_idx
  on public.notion_audit_outbox (available_at, created_at)
  where completed_at is null;

alter table public.notion_audit_outbox enable row level security;
revoke all on table public.notion_audit_outbox from anon, authenticated;
grant select, insert, update, delete on table public.notion_audit_outbox
  to service_role;

create table public.telegram_news_request_checkpoints (
  update_id bigint primary key references public.telegram_updates(update_id)
    on delete cascade,
  status text not null check (status in ('review_ready', 'no_candidates')),
  draft_id uuid references public.drafts(id) on delete restrict,
  preview text,
  window_hours integer check (window_hours > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'review_ready' and draft_id is not null and preview is not null)
    or (status = 'no_candidates' and draft_id is null and preview is null)
  )
);

alter table public.telegram_news_request_checkpoints enable row level security;
revoke all on table public.telegram_news_request_checkpoints
  from anon, authenticated;
grant select, insert, update on table public.telegram_news_request_checkpoints
  to service_role;

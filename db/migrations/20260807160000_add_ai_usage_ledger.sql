create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (char_length(provider) between 1 and 64),
  provider_response_id text,
  model text not null check (char_length(model) between 1 and 128),
  operation text not null check (char_length(operation) between 1 and 64),
  telegram_channel_id text,
  search_run_id uuid references public.search_runs(id) on delete set null,
  article_id uuid references public.articles(id) on delete set null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  cached_input_tokens bigint not null default 0
    check (cached_input_tokens between 0 and input_tokens),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  reasoning_tokens bigint not null default 0
    check (reasoning_tokens >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  estimated_cost_usd numeric(16, 8) check (estimated_cost_usd >= 0),
  pricing_snapshot jsonb check (
    pricing_snapshot is null or jsonb_typeof(pricing_snapshot) = 'object'
  ),
  created_at timestamptz not null default now(),
  unique (provider, provider_response_id)
);

create index ai_usage_events_channel_created_idx
  on public.ai_usage_events (telegram_channel_id, created_at desc);
create index ai_usage_events_search_run_idx
  on public.ai_usage_events (search_run_id)
  where search_run_id is not null;
create index ai_usage_events_article_idx
  on public.ai_usage_events (article_id)
  where article_id is not null;

alter table public.ai_usage_events enable row level security;
revoke all on table public.ai_usage_events from anon, authenticated;
grant select, insert on table public.ai_usage_events to service_role;

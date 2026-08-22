create table public.ai_provider_attempts (
  id uuid primary key,
  correlation_id uuid not null,
  operation text not null check (char_length(operation) between 1 and 96),
  provider text not null check (char_length(provider) between 1 and 64),
  model text check (char_length(model) between 1 and 128),
  attempt_number integer not null check (attempt_number >= 1),
  status text not null check (status in ('started', 'succeeded', 'failed')),
  error_code text check (char_length(error_code) between 1 and 64),
  http_status integer check (http_status between 100 and 599),
  provider_response_id text check (char_length(provider_response_id) between 1 and 256),
  response_status text check (char_length(response_status) between 1 and 64),
  incomplete_reason text check (char_length(incomplete_reason) between 1 and 64),
  refusal boolean,
  latency_ms integer check (latency_ms >= 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  reasoning_tokens bigint check (reasoning_tokens >= 0),
  error_fingerprint text check (char_length(error_fingerprint) = 64),
  ai_usage_event_id uuid references public.ai_usage_events(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'started') = (completed_at is null)),
  unique (correlation_id, attempt_number)
);

create index ai_provider_attempts_recent_idx
  on public.ai_provider_attempts (started_at desc);
create index ai_provider_attempts_provider_recent_idx
  on public.ai_provider_attempts (provider, started_at desc);
create index ai_provider_attempts_correlation_idx
  on public.ai_provider_attempts (correlation_id, attempt_number);

alter table public.ai_provider_attempts enable row level security;
revoke all on table public.ai_provider_attempts from anon, authenticated;
grant select, insert, update on table public.ai_provider_attempts to service_role;

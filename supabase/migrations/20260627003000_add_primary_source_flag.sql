alter table public.sources
  add column is_primary boolean not null default false;

create index sources_enabled_primary_score_idx
  on public.sources (enabled, is_primary, reliability_score desc);

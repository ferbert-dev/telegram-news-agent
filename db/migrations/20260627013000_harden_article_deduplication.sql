create unique index if not exists drafts_one_active_article_idx
  on public.drafts (article_id)
  where status <> 'rejected';

create or replace function public.create_article_if_new(
  p_source_id uuid,
  p_search_run_id uuid,
  p_canonical_url text,
  p_title text,
  p_author text,
  p_published_at timestamptz,
  p_content_hash text,
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.articles
language sql
security invoker
set search_path = ''
as $$
  insert into public.articles (
    source_id,
    search_run_id,
    canonical_url,
    title,
    author,
    published_at,
    content_hash,
    status,
    metadata
  )
  values (
    p_source_id,
    p_search_run_id,
    p_canonical_url,
    p_title,
    p_author,
    p_published_at,
    p_content_hash,
    'discovered',
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (canonical_url) do nothing
  returning *;
$$;

revoke all on function public.create_article_if_new(
  uuid, uuid, text, text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_article_if_new(
  uuid, uuid, text, text, text, timestamptz, text, jsonb
) to service_role;

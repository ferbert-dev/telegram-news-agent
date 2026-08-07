create or replace function public.create_or_resume_article_candidate(
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
  insert into public.articles as existing (
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
  on conflict (canonical_url) do update
  set source_id = excluded.source_id,
      search_run_id = excluded.search_run_id,
      title = excluded.title,
      author = excluded.author,
      published_at = excluded.published_at,
      content_hash = excluded.content_hash,
      metadata = existing.metadata || excluded.metadata,
      updated_at = now()
  where existing.status = 'discovered'
  returning *;
$$;

revoke all on function public.create_or_resume_article_candidate(
  uuid, uuid, text, text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_or_resume_article_candidate(
  uuid, uuid, text, text, text, timestamptz, text, jsonb
) to service_role;

drop function public.create_article_if_new(
  uuid, uuid, text, text, text, timestamptz, text, jsonb
);

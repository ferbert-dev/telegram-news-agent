create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  homepage_url text,
  feed_url text unique,
  source_type text not null
    check (source_type in ('rss', 'website', 'api', 'manual')),
  reliability_score smallint check (reliability_score between 0 and 100),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.topics (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  keywords text[] not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.source_topics (
  source_id uuid not null references public.sources(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (source_id, topic_id)
);

create table public.search_runs (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  source_id uuid references public.sources(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result_count integer not null default 0 check (result_count >= 0),
  error text,
  metadata jsonb not null default '{}'::jsonb
);

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete set null,
  search_run_id uuid references public.search_runs(id) on delete set null,
  canonical_url text not null unique,
  title text not null,
  author text,
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  content_hash text,
  status text not null default 'discovered'
    check (status in (
      'discovered', 'extracted', 'reviewed', 'drafted', 'approved',
      'published', 'rejected', 'failed'
    )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index articles_content_hash_unique
  on public.articles (content_hash)
  where content_hash is not null;
create index articles_source_published_idx
  on public.articles (source_id, published_at desc);
create index articles_status_discovered_idx
  on public.articles (status, discovered_at desc);

create table public.raw_contents (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  content text not null,
  content_type text not null default 'text'
    check (content_type in ('text', 'html', 'markdown', 'json')),
  language_code text,
  fetched_at timestamptz not null default now(),
  extractor text,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (article_id, content_hash)
);

create index raw_contents_article_fetched_idx
  on public.raw_contents (article_id, fetched_at desc);

create table public.article_topics (
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  relevance_score numeric(5,4) check (relevance_score between 0 and 1),
  created_at timestamptz not null default now(),
  primary key (article_id, topic_id)
);

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  body text not null,
  status text not null default 'draft'
    check (status in ('draft', 'review', 'approved', 'rejected', 'published')),
  model text,
  prompt_version text,
  reviewer_notes text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index drafts_status_created_idx
  on public.drafts (status, created_at desc);

create table public.published_posts (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.drafts(id) on delete restrict,
  article_id uuid not null references public.articles(id) on delete restrict,
  telegram_channel_id text not null,
  telegram_message_id bigint not null,
  published_at timestamptz not null default now(),
  message_text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (telegram_channel_id, telegram_message_id)
);

create index published_posts_published_idx
  on public.published_posts (published_at desc);

alter table public.sources enable row level security;
alter table public.topics enable row level security;
alter table public.source_topics enable row level security;
alter table public.search_runs enable row level security;
alter table public.articles enable row level security;
alter table public.raw_contents enable row level security;
alter table public.article_topics enable row level security;
alter table public.drafts enable row level security;
alter table public.published_posts enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant all on table
  public.sources,
  public.topics,
  public.source_topics,
  public.search_runs,
  public.articles,
  public.raw_contents,
  public.article_topics,
  public.drafts,
  public.published_posts
to service_role;

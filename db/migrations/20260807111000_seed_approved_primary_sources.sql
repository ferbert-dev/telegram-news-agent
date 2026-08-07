insert into public.sources (
  name,
  homepage_url,
  feed_url,
  source_type,
  reliability_score,
  enabled,
  is_primary
)
values
  (
    'OpenAI News',
    'https://openai.com/news/',
    'https://openai.com/news/rss.xml',
    'rss',
    95,
    true,
    true
  ),
  (
    'Google DeepMind',
    'https://deepmind.google/',
    'https://deepmind.google/blog/rss.xml',
    'rss',
    95,
    true,
    true
  ),
  (
    'Google AI',
    'https://blog.google/technology/ai/',
    'https://blog.google/technology/ai/rss/',
    'rss',
    90,
    true,
    true
  ),
  (
    'Microsoft Research',
    'https://www.microsoft.com/en-us/research/blog/',
    'https://www.microsoft.com/en-us/research/feed/',
    'rss',
    90,
    true,
    true
  )
on conflict (feed_url) do update
set name = excluded.name,
    homepage_url = excluded.homepage_url,
    source_type = excluded.source_type,
    reliability_score = excluded.reliability_score,
    enabled = excluded.enabled,
    is_primary = excluded.is_primary,
    updated_at = now();

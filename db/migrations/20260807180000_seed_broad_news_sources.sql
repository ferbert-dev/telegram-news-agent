insert into public.topics (name, description, keywords)
values
  ('ai', 'Artificial intelligence', array['AI', 'artificial intelligence', 'model', 'agent']),
  ('world', 'World events', array['world', 'international', 'global']),
  ('science', 'Science and discoveries', array['science', 'research', 'discovery']),
  ('nature', 'Nature and environment', array['nature', 'environment', 'climate', 'ecosystem']),
  ('animals', 'Animals and wildlife', array['animals', 'wildlife', 'species']),
  ('history', 'History and archaeology', array['history', 'archaeology', 'historical']),
  ('culture', 'Culture and ideas', array['culture', 'ideas', 'arts', 'literature']),
  ('technology', 'Technology and innovation', array['technology', 'innovation', 'engineering']),
  ('society', 'Society and human development', array['society', 'education', 'human development'])
on conflict (name) do update
set description = excluded.description,
    keywords = excluded.keywords,
    enabled = true,
    updated_at = now();

with source_data (
  name,
  homepage_url,
  feed_url,
  source_type,
  reliability_score,
  is_primary,
  topic_codes
) as (
  values
    ('OpenAI News', 'https://openai.com/news/', 'https://openai.com/news/rss.xml', 'rss', 95, true, array['ai', 'technology']::text[]),
    ('Google DeepMind', 'https://deepmind.google/', 'https://deepmind.google/blog/rss.xml', 'rss', 95, true, array['ai', 'science', 'technology']::text[]),
    ('Google AI', 'https://blog.google/technology/ai/', 'https://blog.google/technology/ai/rss/', 'rss', 90, true, array['ai', 'technology']::text[]),
    ('Microsoft Research', 'https://www.microsoft.com/en-us/research/blog/', 'https://www.microsoft.com/en-us/research/feed/', 'rss', 90, true, array['ai', 'science', 'technology']::text[]),
    ('Google Research', 'https://research.google/blog/', 'https://research.google/blog/rss/', 'rss', 90, true, array['ai', 'science', 'technology']::text[]),
    ('Hugging Face Blog', 'https://huggingface.co/blog', 'https://huggingface.co/blog/feed.xml', 'rss', 85, true, array['ai', 'technology']::text[]),

    ('BBC World', 'https://www.bbc.com/news/world', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'rss', 92, true, array['world', 'society']::text[]),
    ('BBC Science and Environment', 'https://www.bbc.com/news/science_and_environment', 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'rss', 92, true, array['science', 'nature', 'animals']::text[]),
    ('BBC Technology', 'https://www.bbc.com/news/technology', 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'rss', 90, true, array['ai', 'technology', 'society']::text[]),
    ('Guardian World', 'https://www.theguardian.com/world', 'https://www.theguardian.com/world/rss', 'rss', 90, true, array['world', 'society']::text[]),
    ('Guardian Science', 'https://www.theguardian.com/science', 'https://www.theguardian.com/science/rss', 'rss', 90, true, array['science', 'nature', 'animals']::text[]),
    ('Guardian Environment', 'https://www.theguardian.com/environment', 'https://www.theguardian.com/environment/rss', 'rss', 90, true, array['nature', 'animals', 'science']::text[]),
    ('Guardian Technology', 'https://www.theguardian.com/technology', 'https://www.theguardian.com/technology/rss', 'rss', 88, true, array['ai', 'technology', 'society']::text[]),
    ('Guardian Culture', 'https://www.theguardian.com/culture', 'https://www.theguardian.com/culture/rss', 'rss', 88, true, array['culture', 'history', 'society']::text[]),
    ('NPR News', 'https://www.npr.org/sections/news/', 'https://feeds.npr.org/1001/rss.xml', 'rss', 90, true, array['world', 'society', 'culture']::text[]),
    ('NPR World', 'https://www.npr.org/sections/world/', 'https://feeds.npr.org/1004/rss.xml', 'rss', 90, true, array['world', 'society']::text[]),
    ('NPR Science', 'https://www.npr.org/sections/science/', 'https://feeds.npr.org/1007/rss.xml', 'rss', 90, true, array['science', 'nature', 'animals', 'society']::text[]),
    ('New York Times World', 'https://www.nytimes.com/section/world', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'rss', 90, true, array['world', 'society']::text[]),
    ('New York Times Science', 'https://www.nytimes.com/section/science', 'https://rss.nytimes.com/services/xml/rss/nyt/Science.xml', 'rss', 90, true, array['science', 'nature', 'animals']::text[]),
    ('New York Times Technology', 'https://www.nytimes.com/section/technology', 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml', 'rss', 88, true, array['ai', 'technology', 'society']::text[]),
    ('New York Times Arts', 'https://www.nytimes.com/section/arts', 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml', 'rss', 88, true, array['culture', 'history', 'society']::text[]),
    ('Al Jazeera', 'https://www.aljazeera.com/', 'https://www.aljazeera.com/xml/rss/all.xml', 'rss', 88, true, array['world', 'society']::text[]),
    ('UN News', 'https://news.un.org/en/', 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', 'rss', 95, true, array['world', 'nature', 'society']::text[]),
    ('ProPublica', 'https://www.propublica.org/', 'https://feeds.propublica.org/propublica/main', 'rss', 92, true, array['world', 'society', 'technology']::text[]),

    ('NASA Recent Content', 'https://www.nasa.gov/', 'https://www.nasa.gov/feed/', 'rss', 96, true, array['science', 'technology', 'history']::text[]),
    ('NASA News Releases', 'https://www.nasa.gov/news/', 'https://www.nasa.gov/news-release/feed/', 'rss', 96, true, array['science', 'technology']::text[]),
    ('European Space Agency', 'https://www.esa.int/', 'https://www.esa.int/rssfeed/Our_Activities/Space_News', 'rss', 95, true, array['science', 'technology']::text[]),
    ('NOAA', 'https://www.noaa.gov/', 'https://www.noaa.gov/rss.xml', 'rss', 95, true, array['science', 'nature', 'animals']::text[]),
    ('World Health Organization', 'https://www.who.int/news', 'https://www.who.int/rss-feeds/news-english.xml', 'rss', 96, true, array['science', 'society', 'world']::text[]),
    ('ScienceDaily Top Science', 'https://www.sciencedaily.com/news/', 'https://www.sciencedaily.com/rss/top/science.xml', 'rss', 82, true, array['science', 'nature', 'animals', 'technology']::text[]),
    ('ScienceDaily Environment', 'https://www.sciencedaily.com/news/earth_climate/', 'https://www.sciencedaily.com/rss/top/environment.xml', 'rss', 82, true, array['nature', 'animals', 'science']::text[]),
    ('Phys.org', 'https://phys.org/', 'https://phys.org/rss-feed/', 'rss', 84, true, array['science', 'nature', 'technology']::text[]),
    ('arXiv Artificial Intelligence', 'https://arxiv.org/list/cs.AI/recent', 'https://rss.arxiv.org/rss/cs.AI', 'rss', 94, true, array['ai', 'science', 'technology']::text[]),
    ('arXiv Quantitative Biology', 'https://arxiv.org/list/q-bio/recent', 'https://rss.arxiv.org/rss/q-bio', 'rss', 94, true, array['science', 'nature', 'animals']::text[]),
    ('Mongabay', 'https://news.mongabay.com/', 'https://news.mongabay.com/feed/', 'rss', 88, true, array['nature', 'animals', 'science']::text[]),
    ('Our World in Data', 'https://ourworldindata.org/', 'https://ourworldindata.org/atom.xml', 'rss', 94, true, array['science', 'society', 'world', 'nature']::text[]),
    ('The Conversation Global', 'https://theconversation.com/global', 'https://theconversation.com/global/articles.atom', 'rss', 84, true, array['science', 'society', 'culture', 'world']::text[]),

    ('Smithsonian Latest', 'https://www.smithsonianmag.com/', 'https://www.smithsonianmag.com/rss/latest_articles/', 'rss', 88, true, array['science', 'history', 'culture', 'animals', 'nature']::text[]),
    ('Smithsonian History', 'https://www.smithsonianmag.com/history/', 'https://www.smithsonianmag.com/rss/history/', 'rss', 90, true, array['history', 'culture']::text[]),
    ('Archaeology Magazine', 'https://archaeology.org/', 'https://archaeology.org/feed/', 'rss', 90, true, array['history', 'science', 'culture']::text[]),
    ('History Today', 'https://www.historytoday.com/', 'https://www.historytoday.com/feed/rss.xml', 'rss', 86, true, array['history', 'culture']::text[]),
    ('JSTOR Daily', 'https://daily.jstor.org/', 'https://daily.jstor.org/feed/', 'rss', 88, true, array['history', 'culture', 'science', 'society']::text[]),
    ('Aeon', 'https://aeon.co/', 'https://aeon.co/feed.rss', 'rss', 82, true, array['culture', 'society', 'science', 'history']::text[]),

    ('Ars Technica', 'https://arstechnica.com/', 'https://feeds.arstechnica.com/arstechnica/index', 'rss', 88, true, array['ai', 'technology', 'science']::text[]),
    ('TechCrunch', 'https://techcrunch.com/', 'https://techcrunch.com/feed/', 'rss', 82, true, array['ai', 'technology']::text[]),
    ('MIT Technology Review', 'https://www.technologyreview.com/', 'https://www.technologyreview.com/feed/', 'rss', 90, true, array['ai', 'technology', 'science', 'society']::text[]),
    ('Wired', 'https://www.wired.com/', 'https://www.wired.com/feed/rss', 'rss', 86, true, array['ai', 'technology', 'science', 'culture']::text[]),
    ('The Verge', 'https://www.theverge.com/', 'https://www.theverge.com/rss/index.xml', 'rss', 84, true, array['ai', 'technology', 'culture']::text[]),
    ('IEEE Spectrum', 'https://spectrum.ieee.org/', 'https://spectrum.ieee.org/feeds/feed.rss', 'rss', 92, true, array['ai', 'technology', 'science']::text[]),

    ('GDELT DOC 2.0', 'https://www.gdeltproject.org/', 'https://api.gdeltproject.org/api/v2/doc/doc', 'api', 75, false, array['ai', 'world', 'science', 'nature', 'animals', 'history', 'culture', 'technology', 'society']::text[])
),
upserted as (
  insert into public.sources (
    name,
    homepage_url,
    feed_url,
    source_type,
    reliability_score,
    enabled,
    is_primary
  )
  select
    name,
    homepage_url,
    feed_url,
    source_type,
    reliability_score,
    true,
    is_primary
  from source_data
  on conflict (feed_url) do update
  set name = excluded.name,
      homepage_url = excluded.homepage_url,
      source_type = excluded.source_type,
      reliability_score = excluded.reliability_score,
      enabled = true,
      is_primary = excluded.is_primary,
      updated_at = now()
  returning id, feed_url
)
insert into public.source_topics (source_id, topic_id)
select u.id, t.id
from upserted u
join source_data d on d.feed_url = u.feed_url
cross join lateral unnest(d.topic_codes) as selected(topic_code)
join public.topics t on t.name = selected.topic_code
on conflict (source_id, topic_id) do nothing;

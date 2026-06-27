alter table public.drafts
  drop constraint drafts_status_check;

alter table public.drafts
  add constraint drafts_status_check
  check (status in (
    'draft', 'review', 'approved', 'publishing', 'rejected', 'published'
  ));

create unique index published_posts_draft_id_unique
  on public.published_posts (draft_id);

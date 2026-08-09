create index if not exists news_bot_settings_schedule_draft_id_idx
  on public.news_bot_settings (schedule_draft_id)
  where schedule_draft_id is not null;

create index if not exists telegram_news_request_checkpoints_draft_id_idx
  on public.telegram_news_request_checkpoints (draft_id)
  where draft_id is not null;

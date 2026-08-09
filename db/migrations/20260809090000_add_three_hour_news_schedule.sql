alter table public.news_bot_settings
  drop constraint news_bot_settings_schedule_interval_minutes_check,
  add constraint news_bot_settings_schedule_interval_minutes_check
    check (schedule_interval_minutes in (60, 180, 360, 720, 1440));

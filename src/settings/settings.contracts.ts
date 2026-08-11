export type NewsLanguageCode = "en" | "uk" | "de";
export type NewsApprovalPolicy = "manual" | "automatic";
export type NewsFeatureKey = "article_tags" | "editorial_enrichment";
export type NewsFeatureState = "off" | "collect" | "enabled";

export type NewsSettingsRow = {
  telegram_channel_id: string;
  review_chat_id: number;
  schedule_interval_minutes: number | null;
  language_code: NewsLanguageCode;
  topic_codes: string[];
  custom_topics: string[];
  approval_policy: NewsApprovalPolicy;
  next_run_at: string | null;
  version: number;
  updated_by: number;
  schedule_claim_token: string | null;
  schedule_claimed_at: string | null;
  schedule_run_id: string | null;
  schedule_run_due_at: string | null;
  schedule_settings_snapshot: Record<string, unknown> | null;
  schedule_draft_id: string | null;
  schedule_preview: string | null;
  schedule_window_hours: number | null;
  schedule_publication_message_id: number | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  quiet_hours_enabled: boolean;
};

export type NewsFeatureFlagRow = {
  telegram_channel_id: string;
  feature_key: NewsFeatureKey;
  state: NewsFeatureState;
  config: Record<string, unknown>;
  version: number;
  updated_by: number;
  created_at: string;
  updated_at: string;
};

export type TelegramSettingsInputRow = {
  id: string;
  control_chat_id: number;
  requested_by: number;
  prompt_message_id: number;
  expires_at: string;
  created_at: string;
};

export type GetOrCreateNewsSettingsInput = {
  channelId: string;
  reviewChatId: number;
  updatedBy: number;
};

export type UpdateNewsSettingsInput = {
  channelId: string;
  reviewChatId: number;
  scheduleIntervalMinutes: 60 | 180 | 360 | 720 | 1440 | null;
  languageCode: NewsLanguageCode | string;
  topicCodes: string[];
  customTopics: string[];
  approvalPolicy: NewsApprovalPolicy | string;
  quietHoursEnabled: boolean;
  updatedBy: number;
  expectedVersion: number;
};

export type GetOrCreateNewsFeatureFlagsInput = {
  channelId: string;
  updatedBy: number;
};

export type UpdateNewsFeatureFlagInput = {
  channelId: string;
  featureKey: NewsFeatureKey | string;
  state: NewsFeatureState | string;
  updatedBy: number;
  expectedVersion: number;
};

export type BeginTelegramSettingsInput = {
  controlChatId: number;
  requestedBy: number;
  promptMessageId: number;
  expiresAt: string | Date;
};

export type ConsumeTelegramSettingsInput = {
  controlChatId: number;
  requestedBy: number;
  promptMessageId: number;
};

export interface NewsSettingsPersistence {
  getOrCreateNewsSettings(
    input: GetOrCreateNewsSettingsInput,
  ): Promise<NewsSettingsRow | null>;
  getNewsSettings(channelId: string): Promise<NewsSettingsRow | null>;
  updateNewsSettings(
    input: UpdateNewsSettingsInput,
  ): Promise<NewsSettingsRow | null>;
}

export interface NewsFeatureFlagsPersistence {
  getOrCreateNewsFeatureFlags(
    input: GetOrCreateNewsFeatureFlagsInput,
  ): Promise<NewsFeatureFlagRow[]>;
  getNewsFeatureFlags(channelId: string): Promise<NewsFeatureFlagRow[]>;
  updateNewsFeatureFlag(
    input: UpdateNewsFeatureFlagInput,
  ): Promise<NewsFeatureFlagRow | null>;
}

export interface TelegramSettingsInputPersistence {
  beginTelegramSettingsInput(
    input: BeginTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null>;
  consumeTelegramSettingsInput(
    input: ConsumeTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null>;
}

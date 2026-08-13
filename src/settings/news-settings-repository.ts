import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import {
  postgresRows,
  RepositorySupport,
} from "../database/repositories/repository-support.js";
import { newsBotSettings } from "../database/schema/settings.js";
import type {
  GetOrCreateNewsSettingsInput,
  NewsSettingsPersistence,
  NewsSettingsRow,
  UpdateNewsSettingsInput,
  UpdateNewsExcludedTopicsInput,
} from "./settings.contracts.js";
import {
  mapNewsSettingsRow,
  type NewsSettingsDatabaseRow,
} from "./settings-row-mappers.js";

const newsSettingsSelection = {
  telegram_channel_id: newsBotSettings.telegramChannelId,
  review_chat_id: newsBotSettings.reviewChatId,
  schedule_interval_minutes: newsBotSettings.scheduleIntervalMinutes,
  language_code: newsBotSettings.languageCode,
  topic_codes: newsBotSettings.topicCodes,
  custom_topics: newsBotSettings.customTopics,
  excluded_topic_codes: newsBotSettings.excludedTopicCodes,
  approval_policy: newsBotSettings.approvalPolicy,
  next_run_at: newsBotSettings.nextRunAt,
  version: newsBotSettings.version,
  updated_by: newsBotSettings.updatedBy,
  schedule_claim_token: newsBotSettings.scheduleClaimToken,
  schedule_claimed_at: newsBotSettings.scheduleClaimedAt,
  schedule_run_id: newsBotSettings.scheduleRunId,
  schedule_run_due_at: newsBotSettings.scheduleRunDueAt,
  schedule_settings_snapshot: newsBotSettings.scheduleSettingsSnapshot,
  schedule_draft_id: newsBotSettings.scheduleDraftId,
  schedule_preview: newsBotSettings.schedulePreview,
  schedule_window_hours: newsBotSettings.scheduleWindowHours,
  schedule_publication_message_id:
    newsBotSettings.schedulePublicationMessageId,
  last_run_at: newsBotSettings.lastRunAt,
  last_run_status: newsBotSettings.lastRunStatus,
  last_error_code: newsBotSettings.lastErrorCode,
  created_at: newsBotSettings.createdAt,
  updated_at: newsBotSettings.updatedAt,
  quiet_hours_enabled: newsBotSettings.quietHoursEnabled,
};

const getOrCreateNewsSettingsFunction =
  postgresRows<NewsSettingsDatabaseRow>(
    "public.get_or_create_news_settings",
    3,
  );
const updateNewsSettingsFunction = postgresRows<NewsSettingsDatabaseRow>(
  "public.update_news_settings",
  10,
);
const updateNewsExcludedTopicsFunction =
  postgresRows<NewsSettingsDatabaseRow>(
    "public.update_news_excluded_topics",
    4,
  );

@Injectable()
export class NewsSettingsRepository
  extends RepositorySupport
  implements NewsSettingsPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async getOrCreateNewsSettings({
    channelId,
    reviewChatId,
    updatedBy,
  }: GetOrCreateNewsSettingsInput): Promise<NewsSettingsRow | null> {
    const rows = await this.functionRows(
      "Get or create news settings",
      getOrCreateNewsSettingsFunction,
      [channelId, reviewChatId, updatedBy],
    );
    const row = this.optionalOne(rows, "Get or create news settings");
    return row === null ? null : mapNewsSettingsRow(row);
  }

  async getNewsSettings(channelId: string): Promise<NewsSettingsRow | null> {
    const rows = await this.operation("Get news settings", () =>
      this.database
        .select(newsSettingsSelection)
        .from(newsBotSettings)
        .where(eq(newsBotSettings.telegramChannelId, channelId.trim()))
        .limit(2),
    );
    const row = this.optionalOne(rows, "Get news settings");
    return row === null ? null : mapNewsSettingsRow(row);
  }

  async updateNewsSettings({
    channelId,
    reviewChatId,
    scheduleIntervalMinutes,
    languageCode,
    topicCodes,
    customTopics,
    approvalPolicy,
    quietHoursEnabled,
    updatedBy,
    expectedVersion,
  }: UpdateNewsSettingsInput): Promise<NewsSettingsRow | null> {
    const rows = await this.functionRows(
      "Update news settings",
      updateNewsSettingsFunction,
      [
        channelId,
        reviewChatId,
        scheduleIntervalMinutes,
        languageCode,
        topicCodes,
        customTopics,
        approvalPolicy,
        quietHoursEnabled,
        updatedBy,
        expectedVersion,
      ],
    );
    const row = this.optionalOne(rows, "Update news settings");
    return row === null ? null : mapNewsSettingsRow(row);
  }

  async updateNewsExcludedTopics({
    channelId,
    excludedTopicCodes,
    updatedBy,
    expectedVersion,
  }: UpdateNewsExcludedTopicsInput): Promise<NewsSettingsRow | null> {
    const rows = await this.functionRows(
      "Update news excluded topics",
      updateNewsExcludedTopicsFunction,
      [channelId, excludedTopicCodes, updatedBy, expectedVersion],
    );
    const row = this.optionalOne(rows, "Update news excluded topics");
    return row === null ? null : mapNewsSettingsRow(row);
  }
}

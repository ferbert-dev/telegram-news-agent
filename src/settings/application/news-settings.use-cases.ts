import { Inject, Injectable } from "@nestjs/common";

import type {
  GetOrCreateNewsSettingsInput,
  NewsSettingsPersistence,
  NewsSettingsRow,
  UpdateNewsSettingsInput,
  UpdateNewsExcludedTopicsInput,
} from "../settings.contracts.js";
import { NEWS_SETTINGS_REPOSITORY } from "../settings.tokens.js";

/**
 * Transport-neutral news-settings use cases.
 *
 * Inputs and results intentionally pass through unchanged. PostgreSQL remains
 * authoritative for validation, optimistic-version conflicts, scheduling
 * timestamps, and legacy snake_case DTOs during the strangler migration.
 */
@Injectable()
export class NewsSettingsUseCases {
  constructor(
    @Inject(NEWS_SETTINGS_REPOSITORY)
    private readonly settings: NewsSettingsPersistence,
  ) {}

  getOrCreate(
    input: GetOrCreateNewsSettingsInput,
  ): Promise<NewsSettingsRow | null> {
    return this.settings.getOrCreateNewsSettings(input);
  }

  get(channelId: string): Promise<NewsSettingsRow | null> {
    return this.settings.getNewsSettings(channelId);
  }

  update(input: UpdateNewsSettingsInput): Promise<NewsSettingsRow | null> {
    return this.settings.updateNewsSettings(input);
  }

  updateExcludedTopics(
    input: UpdateNewsExcludedTopicsInput,
  ): Promise<NewsSettingsRow | null> {
    return this.settings.updateNewsExcludedTopics(input);
  }
}

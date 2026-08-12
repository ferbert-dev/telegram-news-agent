import { Inject, Injectable } from "@nestjs/common";

import type {
  BeginTelegramSettingsInput,
  ConsumeTelegramSettingsInput,
  GetOrCreateNewsFeatureFlagsInput,
  GetOrCreateNewsSettingsInput,
  NewsFeatureFlagRow,
  NewsSettingsRow,
  TelegramSettingsInputRow,
  UpdateNewsFeatureFlagInput,
  UpdateNewsSettingsInput,
  UpdateNewsExcludedTopicsInput,
} from "../settings.contracts.js";
import { NewsFeatureFlagsUseCases } from "./news-feature-flags.use-cases.js";
import { NewsSettingsUseCases } from "./news-settings.use-cases.js";
import { TelegramSettingsInputUseCases } from "./telegram-settings-input.use-cases.js";

/**
 * Public application facade for the settings and Labs migration slice.
 *
 * Method names deliberately match the legacy persistence-facing API so a
 * later transport migration can change composition without changing command
 * parsing or Telegram rendering in this reversible slice.
 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(NewsSettingsUseCases)
    private readonly newsSettings: NewsSettingsUseCases,
    @Inject(NewsFeatureFlagsUseCases)
    private readonly featureFlags: NewsFeatureFlagsUseCases,
    @Inject(TelegramSettingsInputUseCases)
    private readonly settingsInput: TelegramSettingsInputUseCases,
  ) {}

  getOrCreateNewsSettings(
    input: GetOrCreateNewsSettingsInput,
  ): Promise<NewsSettingsRow | null> {
    return this.newsSettings.getOrCreate(input);
  }

  getNewsSettings(channelId: string): Promise<NewsSettingsRow | null> {
    return this.newsSettings.get(channelId);
  }

  updateNewsSettings(
    input: UpdateNewsSettingsInput,
  ): Promise<NewsSettingsRow | null> {
    return this.newsSettings.update(input);
  }

  updateNewsExcludedTopics(
    input: UpdateNewsExcludedTopicsInput,
  ): Promise<NewsSettingsRow | null> {
    return this.newsSettings.updateExcludedTopics(input);
  }

  beginTelegramSettingsInput(
    input: BeginTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null> {
    return this.settingsInput.begin(input);
  }

  consumeTelegramSettingsInput(
    input: ConsumeTelegramSettingsInput,
  ): Promise<TelegramSettingsInputRow | null> {
    return this.settingsInput.consume(input);
  }

  getOrCreateNewsFeatureFlags(
    input: GetOrCreateNewsFeatureFlagsInput,
  ): Promise<NewsFeatureFlagRow[]> {
    return this.featureFlags.getOrCreate(input);
  }

  getNewsFeatureFlags(channelId: string): Promise<NewsFeatureFlagRow[]> {
    return this.featureFlags.get(channelId);
  }

  updateNewsFeatureFlag(
    input: UpdateNewsFeatureFlagInput,
  ): Promise<NewsFeatureFlagRow | null> {
    return this.featureFlags.update(input);
  }
}

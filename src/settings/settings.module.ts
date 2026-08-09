import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { FeatureFlagsRepository } from "./feature-flags-repository.js";
import { NewsSettingsRepository } from "./news-settings-repository.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
  TELEGRAM_SETTINGS_INPUT_REPOSITORY,
} from "./settings.tokens.js";
import { TelegramSettingsInputRepository } from "./telegram-settings-input-repository.js";

const settingsRepositoryProviders: Provider[] = [
  NewsSettingsRepository,
  FeatureFlagsRepository,
  TelegramSettingsInputRepository,
  {
    provide: NEWS_SETTINGS_REPOSITORY,
    useExisting: NewsSettingsRepository,
  },
  {
    provide: NEWS_FEATURE_FLAGS_REPOSITORY,
    useExisting: FeatureFlagsRepository,
  },
  {
    provide: TELEGRAM_SETTINGS_INPUT_REPOSITORY,
    useExisting: TelegramSettingsInputRepository,
  },
];

@Module({
  imports: [DatabaseModule],
  providers: settingsRepositoryProviders,
  exports: [
    NEWS_SETTINGS_REPOSITORY,
    NEWS_FEATURE_FLAGS_REPOSITORY,
    TELEGRAM_SETTINGS_INPUT_REPOSITORY,
  ],
})
export class SettingsModule {}

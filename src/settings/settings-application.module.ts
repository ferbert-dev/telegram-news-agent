import "reflect-metadata";

import { Module } from "@nestjs/common";

import { NewsFeatureFlagsUseCases } from "./application/news-feature-flags.use-cases.js";
import { NewsSettingsUseCases } from "./application/news-settings.use-cases.js";
import { SettingsService } from "./application/settings.service.js";
import { TelegramSettingsInputUseCases } from "./application/telegram-settings-input.use-cases.js";
import { SettingsPersistenceModule } from "./settings-persistence.module.js";

@Module({
  imports: [SettingsPersistenceModule],
  providers: [
    NewsSettingsUseCases,
    NewsFeatureFlagsUseCases,
    TelegramSettingsInputUseCases,
    SettingsService,
  ],
  exports: [SettingsService],
})
export class SettingsApplicationModule {}

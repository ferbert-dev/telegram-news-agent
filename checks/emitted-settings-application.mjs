import assert from "node:assert/strict";

const { NewsFeatureFlagsUseCases } = await import(
  "../dist/settings/application/news-feature-flags.use-cases.js"
);
const { NewsSettingsUseCases } = await import(
  "../dist/settings/application/news-settings.use-cases.js"
);
const { SettingsService } = await import(
  "../dist/settings/application/settings.service.js"
);
const { TelegramSettingsInputUseCases } = await import(
  "../dist/settings/application/telegram-settings-input.use-cases.js"
);
const { SettingsApplicationModule } = await import(
  "../dist/settings/settings-application.module.js"
);

const settingsRow = { telegram_channel_id: "@emitted", version: 2 };
const featureRow = { feature_key: "article_tags", state: "collect", version: 3 };
const inputRow = { id: "input", expires_at: "2026-08-09T08:15:00.000Z" };

const settings = new NewsSettingsUseCases({
  async getOrCreateNewsSettings() { return settingsRow; },
  async getNewsSettings() { return settingsRow; },
  async updateNewsSettings() { return null; },
});
const featureFlags = new NewsFeatureFlagsUseCases({
  async getOrCreateNewsFeatureFlags() { return [featureRow]; },
  async getNewsFeatureFlags() { return [featureRow]; },
  async updateNewsFeatureFlag() { return null; },
});
const settingsInput = new TelegramSettingsInputUseCases({
  async beginTelegramSettingsInput() { return inputRow; },
  async consumeTelegramSettingsInput() { return null; },
});
const service = new SettingsService(settings, featureFlags, settingsInput);

assert.equal(await service.getNewsSettings("@emitted"), settingsRow);
assert.equal(
  (await service.getOrCreateNewsFeatureFlags({
    channelId: "@emitted",
    updatedBy: 5,
  }))[0],
  featureRow,
);
assert.equal(
  await service.beginTelegramSettingsInput({
    controlChatId: 9,
    requestedBy: 5,
    promptMessageId: 88,
    expiresAt: new Date("2026-08-09T08:15:00.000Z"),
  }),
  inputRow,
);
assert.equal(typeof SettingsApplicationModule, "function");

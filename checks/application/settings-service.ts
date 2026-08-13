import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants.js";

import { NewsFeatureFlagsUseCases } from "../../src/settings/application/news-feature-flags.use-cases.js";
import { NewsSettingsUseCases } from "../../src/settings/application/news-settings.use-cases.js";
import { SettingsService } from "../../src/settings/application/settings.service.js";
import { TelegramSettingsInputUseCases } from "../../src/settings/application/telegram-settings-input.use-cases.js";
import type {
  BeginTelegramSettingsInput,
  ConsumeTelegramSettingsInput,
  GetOrCreateNewsFeatureFlagsInput,
  GetOrCreateNewsSettingsInput,
  NewsFeatureFlagRow,
  NewsFeatureFlagsPersistence,
  NewsSettingsPersistence,
  NewsSettingsRow,
  TelegramSettingsInputPersistence,
  TelegramSettingsInputRow,
  UpdateNewsFeatureFlagInput,
  UpdateNewsExcludedTopicsInput,
  UpdateNewsSettingsInput,
} from "../../src/settings/settings.contracts.js";
import { SettingsApplicationModule } from "../../src/settings/settings-application.module.js";
import { SettingsPersistenceModule } from "../../src/settings/settings-persistence.module.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
  TELEGRAM_SETTINGS_INPUT_REPOSITORY,
} from "../../src/settings/settings.tokens.js";
import {
  normalizeNewsSettings,
  SCHEDULE_INTERVAL_MINUTES,
} from "../../src/news-settings.js";
import { renderSettingsKeyboard } from "../../src/telegram-settings.js";

const SETTINGS_ROW: NewsSettingsRow = {
  telegram_channel_id: "@channel",
  review_chat_id: 9,
  schedule_interval_minutes: 180,
  language_code: "uk",
  topic_codes: ["nature", "science"],
  custom_topics: ["Морська біологія"],
  excluded_topic_codes: ["war_conflict"],
  approval_policy: "automatic",
  next_run_at: "2026-08-10T06:00:00.000Z",
  version: 7,
  updated_by: 5,
  schedule_claim_token: null,
  schedule_claimed_at: null,
  schedule_run_id: null,
  schedule_run_due_at: null,
  schedule_settings_snapshot: null,
  schedule_draft_id: null,
  schedule_preview: null,
  schedule_window_hours: null,
  schedule_publication_message_id: null,
  last_run_at: null,
  last_run_status: null,
  last_error_code: null,
  created_at: "2026-08-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:01:00.000Z",
  quiet_hours_enabled: true,
};

const FEATURE_ROW: NewsFeatureFlagRow = {
  telegram_channel_id: "@channel",
  feature_key: "article_tags",
  state: "collect",
  config: {},
  version: 4,
  updated_by: 5,
  created_at: "2026-08-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:01:00.000Z",
};

const INPUT_ROW: TelegramSettingsInputRow = {
  id: "bound-input",
  control_chat_id: 9,
  requested_by: 5,
  prompt_message_id: 88,
  expires_at: "2026-08-09T08:15:00.000Z",
  created_at: "2026-08-09T08:00:00.000Z",
};

function serviceFrom(
  settings: NewsSettingsPersistence,
  featureFlags: NewsFeatureFlagsPersistence,
  settingsInput: TelegramSettingsInputPersistence,
): SettingsService {
  return new SettingsService(
    new NewsSettingsUseCases(settings),
    new NewsFeatureFlagsUseCases(featureFlags),
    new TelegramSettingsInputUseCases(settingsInput),
  );
}

test("SettingsService preserves exact news-settings DTOs, nullable CAS conflicts, and repository errors", async () => {
  const getOrCreateInput: GetOrCreateNewsSettingsInput = {
    channelId: "@channel",
    reviewChatId: 9,
    updatedBy: 5,
  };
  const updateInput: UpdateNewsSettingsInput = {
    channelId: "@channel",
    reviewChatId: 9,
    scheduleIntervalMinutes: 180,
    languageCode: "uk",
    topicCodes: ["nature", "science"],
    customTopics: ["Морська біологія"],
    approvalPolicy: "automatic",
    quietHoursEnabled: true,
    updatedBy: 5,
    expectedVersion: 7,
  };
  const excludedInput: UpdateNewsExcludedTopicsInput = {
    channelId: "@channel",
    excludedTopicCodes: [],
    updatedBy: 5,
    expectedVersion: 7,
  };
  const calls: unknown[] = [];
  const conflict = new Error("settings CAS conflict");
  let updateMode: "success" | "null" | "error" = "success";
  const settings: NewsSettingsPersistence = {
    async getOrCreateNewsSettings(input) {
      calls.push(["create", input]);
      return SETTINGS_ROW;
    },
    async getNewsSettings(channelId) {
      calls.push(["get", channelId]);
      return SETTINGS_ROW;
    },
    async updateNewsSettings(input) {
      calls.push(["update", input]);
      if (updateMode === "null") return null;
      if (updateMode === "error") throw conflict;
      return SETTINGS_ROW;
    },
    async updateNewsExcludedTopics(input) {
      calls.push(["updateExcluded", input]);
      return SETTINGS_ROW;
    },
  };
  const service = serviceFrom(settings, {
    async getOrCreateNewsFeatureFlags() { return []; },
    async getNewsFeatureFlags() { return []; },
    async updateNewsFeatureFlag() { return null; },
  }, {
    async beginTelegramSettingsInput() { return null; },
    async consumeTelegramSettingsInput() { return null; },
  });

  assert.equal(await service.getOrCreateNewsSettings(getOrCreateInput), SETTINGS_ROW);
  assert.equal(await service.getNewsSettings("@channel"), SETTINGS_ROW);
  assert.equal(await service.updateNewsSettings(updateInput), SETTINGS_ROW);
  assert.equal(
    await service.updateNewsExcludedTopics(excludedInput),
    SETTINGS_ROW,
  );
  assert.equal((calls[0] as unknown[])[1], getOrCreateInput);
  assert.equal((calls[2] as unknown[])[1], updateInput);
  assert.equal((calls[3] as unknown[])[1], excludedInput);

  updateMode = "null";
  assert.equal(await service.updateNewsSettings(updateInput), null);
  updateMode = "error";
  await assert.rejects(
    service.updateNewsSettings(updateInput),
    (error) => error === conflict,
  );
});

test("SettingsService preserves bound-input expiry and one-shot consume DTOs", async () => {
  const expiry = new Date("2026-08-09T08:15:00.000Z");
  const begin: BeginTelegramSettingsInput = {
    controlChatId: 9,
    requestedBy: 5,
    promptMessageId: 88,
    expiresAt: expiry,
  };
  const consume: ConsumeTelegramSettingsInput = {
    controlChatId: 9,
    requestedBy: 5,
    promptMessageId: 88,
  };
  const calls: unknown[] = [];
  let consumed = false;
  const service = serviceFrom({
    async getOrCreateNewsSettings() { return null; },
    async getNewsSettings() { return null; },
    async updateNewsSettings() { return null; },
    async updateNewsExcludedTopics() { return null; },
  }, {
    async getOrCreateNewsFeatureFlags() { return []; },
    async getNewsFeatureFlags() { return []; },
    async updateNewsFeatureFlag() { return null; },
  }, {
    async beginTelegramSettingsInput(input) {
      calls.push(["begin", input]);
      return INPUT_ROW;
    },
    async consumeTelegramSettingsInput(input) {
      calls.push(["consume", input]);
      if (consumed) return null;
      consumed = true;
      return INPUT_ROW;
    },
  });

  assert.equal(await service.beginTelegramSettingsInput(begin), INPUT_ROW);
  assert.equal((calls[0] as unknown[])[1], begin);
  assert.equal((begin.expiresAt as Date), expiry);
  assert.equal(await service.consumeTelegramSettingsInput(consume), INPUT_ROW);
  assert.equal(await service.consumeTelegramSettingsInput(consume), null);
  assert.equal((calls[1] as unknown[])[1], consume);
});

test("SettingsService preserves Labs rows and nullable stale-version updates", async () => {
  const createInput: GetOrCreateNewsFeatureFlagsInput = {
    channelId: "@channel",
    updatedBy: 5,
  };
  const updateInput: UpdateNewsFeatureFlagInput = {
    channelId: "@channel",
    featureKey: "article_tags",
    state: "enabled",
    updatedBy: 5,
    expectedVersion: 4,
  };
  const calls: unknown[] = [];
  let stale = false;
  const service = serviceFrom({
    async getOrCreateNewsSettings() { return null; },
    async getNewsSettings() { return null; },
    async updateNewsSettings() { return null; },
    async updateNewsExcludedTopics() { return null; },
  }, {
    async getOrCreateNewsFeatureFlags(input) {
      calls.push(["create", input]);
      return [FEATURE_ROW];
    },
    async getNewsFeatureFlags(channelId) {
      calls.push(["get", channelId]);
      return [FEATURE_ROW];
    },
    async updateNewsFeatureFlag(input) {
      calls.push(["update", input]);
      return stale ? null : FEATURE_ROW;
    },
  }, {
    async beginTelegramSettingsInput() { return null; },
    async consumeTelegramSettingsInput() { return null; },
  });

  assert.equal((await service.getOrCreateNewsFeatureFlags(createInput))[0], FEATURE_ROW);
  assert.equal((await service.getNewsFeatureFlags("@channel"))[0], FEATURE_ROW);
  assert.equal(await service.updateNewsFeatureFlag(updateInput), FEATURE_ROW);
  assert.equal((calls[0] as unknown[])[1], createInput);
  assert.equal((calls[2] as unknown[])[1], updateInput);
  stale = true;
  assert.equal(await service.updateNewsFeatureFlag(updateInput), null);
});

test("application use cases inject only the three narrow persistence tokens", () => {
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, NewsSettingsUseCases),
    [{ index: 0, param: NEWS_SETTINGS_REPOSITORY }],
  );
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, NewsFeatureFlagsUseCases),
    [{ index: 0, param: NEWS_FEATURE_FLAGS_REPOSITORY }],
  );
  assert.deepEqual(
    Reflect.getMetadata(
      SELF_DECLARED_DEPS_METADATA,
      TelegramSettingsInputUseCases,
    ),
    [{ index: 0, param: TELEGRAM_SETTINGS_INPUT_REPOSITORY }],
  );
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, SettingsService),
    [
      { index: 2, param: TelegramSettingsInputUseCases },
      { index: 1, param: NewsFeatureFlagsUseCases },
      { index: 0, param: NewsSettingsUseCases },
    ],
  );
});

test("SettingsApplicationModule owns composition and exports only SettingsService", () => {
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, SettingsApplicationModule),
    [SettingsPersistenceModule],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SettingsApplicationModule),
    [
      NewsSettingsUseCases,
      NewsFeatureFlagsUseCases,
      TelegramSettingsInputUseCases,
      SettingsService,
    ],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.EXPORTS, SettingsApplicationModule),
    [SettingsService],
  );
});

test("legacy normalization, scheduling, quiet-hours, and auto-publish confirmation remain unchanged", () => {
  assert.deepEqual(SCHEDULE_INTERVAL_MINUTES, [60, 180, 360, 720, 1440]);
  for (const languageCode of ["en", "uk", "de"]) {
    assert.equal(normalizeNewsSettings({ languageCode }).languageCode, languageCode);
  }
  const normalized = normalizeNewsSettings({
    languageCode: "UK",
    topicCodes: ["nature", "nature", "science"],
    customTopics: ["  marine   biology  "],
    scheduleIntervalMinutes: 180,
    approvalPolicy: "automatic",
    quietHoursEnabled: true,
  });
  assert.deepEqual(normalized.topicCodes, ["nature", "science"]);
  assert.deepEqual(normalized.customTopics, ["marine biology"]);
  assert.equal(normalized.approvalPolicy, "automatic");
  assert.equal(normalized.quietHoursEnabled, true);

  const confirmation = renderSettingsKeyboard(
    { ...SETTINGS_ROW, approval_policy: "manual" },
    "automatic",
  );
  assert.equal(confirmation[0][0].text, "Enable auto-publish ⚠️");
  assert.equal(confirmation[0][0].callback_data, "cfg:a:a:7");
});

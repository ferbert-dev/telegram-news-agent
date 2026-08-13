import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import {
  DATABASE_LIFECYCLE,
  DRIZZLE_DB,
  PG_POOL,
} from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import type { DrizzleDatabase } from "../../src/database/drizzle-client.js";
import {
  newsBotSettings,
  newsFeatureFlags,
} from "../../src/database/schema/settings.js";
import { FeatureFlagsRepository } from "../../src/settings/feature-flags-repository.js";
import { NewsSettingsRepository } from "../../src/settings/news-settings-repository.js";
import type {
  NewsFeatureFlagsPersistence,
  NewsSettingsPersistence,
  TelegramSettingsInputPersistence,
} from "../../src/settings/settings.contracts.js";
import { SettingsPersistenceModule } from "../../src/settings/settings-persistence.module.js";
import {
  mapNewsFeatureFlagRow,
  mapNewsSettingsRow,
  mapTelegramSettingsInputRow,
  type NewsFeatureFlagDatabaseRow,
  type NewsSettingsDatabaseRow,
  type TelegramSettingsInputDatabaseRow,
} from "../../src/settings/settings-row-mappers.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
  TELEGRAM_SETTINGS_INPUT_REPOSITORY,
} from "../../src/settings/settings.tokens.js";
import { TelegramSettingsInputRepository } from "../../src/settings/telegram-settings-input-repository.js";

const postgresTimestamp = "2026-08-09 14:34:56.123456+02";
const canonicalTimestamp = "2026-08-09T12:34:56.123Z";

const settingsRow: NewsSettingsDatabaseRow = {
  telegram_channel_id: "@channel",
  review_chat_id: "700000000001",
  schedule_interval_minutes: 180,
  language_code: "de",
  topic_codes: ["world", "nature"],
  custom_topics: ["Ocean exploration"],
  excluded_topic_codes: ["war_conflict"],
  approval_policy: "manual",
  next_run_at: postgresTimestamp,
  version: 2,
  updated_by: "700000000002",
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
  created_at: new Date(canonicalTimestamp),
  updated_at: postgresTimestamp,
  quiet_hours_enabled: true,
};

const featureFlagRow: NewsFeatureFlagDatabaseRow = {
  telegram_channel_id: "@channel",
  feature_key: "article_tags",
  state: "off",
  config: { threshold: 0.75 },
  version: 1,
  updated_by: "700000000002",
  created_at: new Date(canonicalTimestamp),
  updated_at: postgresTimestamp,
};

const settingsInputRow: TelegramSettingsInputDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  control_chat_id: "700000000001",
  requested_by: "700000000002",
  prompt_message_id: "9001",
  expires_at: postgresTimestamp,
  created_at: new Date(canonicalTimestamp),
};

test("settings DTO mappers preserve snake_case values and canonicalize database types", () => {
  const settings = mapNewsSettingsRow(settingsRow);
  assert.equal(settings.review_chat_id, 700_000_000_001);
  assert.equal(settings.updated_by, 700_000_000_002);
  assert.equal(settings.schedule_interval_minutes, 180);
  assert.equal(settings.next_run_at, canonicalTimestamp);
  assert.equal(settings.created_at, canonicalTimestamp);
  assert.deepEqual(settings.topic_codes, ["world", "nature"]);

  const feature = mapNewsFeatureFlagRow(featureFlagRow);
  assert.equal(feature.feature_key, "article_tags");
  assert.equal(feature.updated_by, 700_000_000_002);
  assert.equal(feature.created_at, canonicalTimestamp);
  assert.equal(feature.config, featureFlagRow.config);

  const input = mapTelegramSettingsInputRow(settingsInputRow);
  assert.equal(input.control_chat_id, 700_000_000_001);
  assert.equal(input.prompt_message_id, 9001);
  assert.equal(input.expires_at, canonicalTimestamp);

  assert.throws(
    () =>
      mapNewsSettingsRow({
        ...settingsRow,
        review_chat_id: "9007199254740992",
      }),
    /Invalid PostgreSQL bigint for review_chat_id/,
  );
  assert.throws(
    () => mapNewsFeatureFlagRow({ ...featureFlagRow, state: "unknown" }),
    /Invalid news feature state/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class FunctionPool extends EventEmitter {
  readonly calls: RecordedCall[] = [];

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    let rows: unknown[];
    if (text.includes("get_or_create_news_settings")) {
      rows = [settingsRow];
    } else if (text.includes("update_news_settings")) {
      rows = [];
    } else if (text.includes("update_news_excluded_topics")) {
      rows = [];
    } else if (text.includes("get_or_create_news_feature_flags")) {
      rows = [featureFlagRow];
    } else if (text.includes("update_news_feature_flag")) {
      rows = [];
    } else if (text.includes("begin_telegram_settings_input")) {
      rows = [settingsInputRow];
    } else if (text.includes("consume_telegram_settings_input")) {
      rows = [];
    } else {
      throw new Error(`Unexpected test query: ${text}`);
    }

    return { rows } as QueryResult;
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

test("settings mutations retain parameterized PostgreSQL function boundaries", async () => {
  const pool = new FunctionPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const settings = new NewsSettingsRepository(
    pool as unknown as Pool,
    database,
  );
  const features = new FeatureFlagsRepository(
    pool as unknown as Pool,
    database,
  );
  const inputs = new TelegramSettingsInputRepository(
    pool as unknown as Pool,
    database,
  );
  const expiresAt = "2026-08-09T16:00:00.000Z";

  assert.equal(
    (
      await settings.getOrCreateNewsSettings({
        channelId: "@channel",
        reviewChatId: 42,
        updatedBy: 7,
      })
    )?.version,
    2,
  );
  assert.equal(
    await settings.updateNewsSettings({
      channelId: "@channel",
      reviewChatId: 42,
      scheduleIntervalMinutes: 180,
      languageCode: "uk",
      topicCodes: ["world", "nature"],
      customTopics: ["Ocean exploration"],
      approvalPolicy: "manual",
      quietHoursEnabled: true,
      updatedBy: 7,
      expectedVersion: 2,
    }),
    null,
  );
  assert.equal(
    await settings.updateNewsExcludedTopics({
      channelId: "@channel",
      excludedTopicCodes: [],
      updatedBy: 7,
      expectedVersion: 2,
    }),
    null,
  );
  assert.equal(
    (
      await features.getOrCreateNewsFeatureFlags({
        channelId: "@channel",
        updatedBy: 7,
      })
    )[0].state,
    "off",
  );
  assert.equal(
    await features.updateNewsFeatureFlag({
      channelId: "@channel",
      featureKey: "article_tags",
      state: "collect",
      updatedBy: 7,
      expectedVersion: 1,
    }),
    null,
  );
  assert.equal(
    (
      await inputs.beginTelegramSettingsInput({
        controlChatId: 10,
        requestedBy: 20,
        promptMessageId: 30,
        expiresAt,
      })
    )?.id,
    settingsInputRow.id,
  );
  assert.equal(
    await inputs.consumeTelegramSettingsInput({
      controlChatId: 10,
      requestedBy: 20,
      promptMessageId: 30,
    }),
    null,
  );

  assert.deepEqual(pool.calls, [
    {
      text: 'select * from "public"."get_or_create_news_settings"($1, $2, $3)',
      values: ["@channel", 42, 7],
    },
    {
      text: 'select * from "public"."update_news_settings"($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      values: [
        "@channel",
        42,
        180,
        "uk",
        ["world", "nature"],
        ["Ocean exploration"],
        "manual",
        true,
        7,
        2,
      ],
    },
    {
      text: 'select * from "public"."update_news_excluded_topics"($1, $2, $3, $4)',
      values: ["@channel", [], 7, 2],
    },
    {
      text: 'select * from "public"."get_or_create_news_feature_flags"($1, $2)',
      values: ["@channel", 7],
    },
    {
      text: 'select * from "public"."update_news_feature_flag"($1, $2, $3, $4, $5)',
      values: ["@channel", "article_tags", "collect", 7, 1],
    },
    {
      text: 'select * from "public"."begin_telegram_settings_input"($1, $2, $3, $4)',
      values: [10, 20, 30, expiresAt],
    },
    {
      text: 'select * from "public"."consume_telegram_settings_input"($1, $2, $3)',
      values: [10, 20, 30],
    },
  ]);
});

test("settings reads use typed Drizzle selections instead of PostgreSQL functions", async () => {
  const selectedTables: unknown[] = [];
  const database = {
    execute() {
      throw new Error("Typed settings reads must not execute a raw function");
    },
    transaction() {
      throw new Error("Typed settings reads must not start a transaction");
    },
    select() {
      return {
        from(table: unknown) {
          selectedTables.push(table);
          if (table === newsBotSettings) {
            return {
              where() {
                return {
                  limit() {
                    return Promise.resolve([settingsRow]);
                  },
                };
              },
            };
          }
          if (table === newsFeatureFlags) {
            return {
              where() {
                return {
                  orderBy() {
                    return Promise.resolve([featureFlagRow]);
                  },
                };
              },
            };
          }
          throw new Error("Unexpected settings read table");
        },
      };
    },
  } as unknown as DrizzleDatabase;
  const pool = {
    query() {
      throw new Error("Typed settings reads must not use Pool.query directly");
    },
  } as unknown as Pool;
  const settings = new NewsSettingsRepository(pool, database);
  const features = new FeatureFlagsRepository(pool, database);

  assert.equal(
    (await settings.getNewsSettings(" @channel "))?.telegram_channel_id,
    "@channel",
  );
  assert.equal(
    (await features.getNewsFeatureFlags(" @channel "))[0].feature_key,
    "article_tags",
  );
  assert.deepEqual(selectedTables, [newsBotSettings, newsFeatureFlags]);
});

test("SettingsPersistenceModule exposes only narrow Symbol-token repository contracts", async () => {
  const pool = new FunctionPool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const moduleRef = await Test.createTestingModule({
    imports: [SettingsPersistenceModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(database)
    .overrideProvider(DATABASE_LIFECYCLE)
    .useValue({ close: () => Promise.resolve() })
    .compile();

  try {
    const settings = moduleRef.get<NewsSettingsPersistence>(
      NEWS_SETTINGS_REPOSITORY,
    );
    const features = moduleRef.get<NewsFeatureFlagsPersistence>(
      NEWS_FEATURE_FLAGS_REPOSITORY,
    );
    const inputs = moduleRef.get<TelegramSettingsInputPersistence>(
      TELEGRAM_SETTINGS_INPUT_REPOSITORY,
    );

    assert.ok(settings instanceof NewsSettingsRepository);
    assert.ok(features instanceof FeatureFlagsRepository);
    assert.ok(inputs instanceof TelegramSettingsInputRepository);
    assert.equal(settings, moduleRef.get(NewsSettingsRepository));
    assert.equal(features, moduleRef.get(FeatureFlagsRepository));
    assert.equal(inputs, moduleRef.get(TelegramSettingsInputRepository));
    assert.equal(
      new Set([
        NEWS_SETTINGS_REPOSITORY,
        NEWS_FEATURE_FLAGS_REPOSITORY,
        TELEGRAM_SETTINGS_INPUT_REPOSITORY,
      ]).size,
      3,
    );
  } finally {
    await moduleRef.close();
  }
});

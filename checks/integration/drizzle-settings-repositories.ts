import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { FeatureFlagsRepository } from "../../src/settings/feature-flags-repository.js";
import { NewsSettingsRepository } from "../../src/settings/news-settings-repository.js";
import { TelegramSettingsInputRepository } from "../../src/settings/telegram-settings-input-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Drizzle settings repositories preserve normalization, CAS, expiry, and legacy DTOs",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const database = createDrizzleDatabase(pool);
    const settingsRepository = new NewsSettingsRepository(pool, database);
    const featureFlagsRepository = new FeatureFlagsRepository(pool, database);
    const settingsInputRepository = new TelegramSettingsInputRepository(
      pool,
      database,
    );
    const suffix = randomUUID();
    const channelId = `@drizzle-settings-${suffix}`;
    const reviewChatId = 700_000_000_001;
    const updatedBy = 700_000_000_002;
    const controlChatId = 700_000_000_003;
    const promptMessageId = 9001;

    try {
      const created = await settingsRepository.getOrCreateNewsSettings({
        channelId: ` ${channelId} `,
        reviewChatId,
        updatedBy,
      });
      assert.ok(created);
      assert.equal(created.telegram_channel_id, channelId);
      assert.equal(created.review_chat_id, reviewChatId);
      assert.equal(created.updated_by, updatedBy);
      assert.equal(created.schedule_interval_minutes, null);
      assert.equal(created.language_code, "en");
      assert.equal(created.approval_policy, "manual");
      assert.equal(created.quiet_hours_enabled, true);
      assert.equal(new Date(created.created_at).toISOString(), created.created_at);

      const typedRead = await settingsRepository.getNewsSettings(
        ` ${channelId} `,
      );
      assert.deepEqual(typedRead, created);

      const updated = await settingsRepository.updateNewsSettings({
        channelId: ` ${channelId} `,
        reviewChatId,
        scheduleIntervalMinutes: 180,
        languageCode: " DE ",
        topicCodes: ["World", " world ", "nature"],
        customTopics: [" Ocean exploration ", "Ocean exploration"],
        approvalPolicy: " AUTOMATIC ",
        quietHoursEnabled: false,
        updatedBy,
        expectedVersion: created.version,
      });
      assert.ok(updated);
      assert.equal(updated.version, created.version + 1);
      assert.equal(updated.schedule_interval_minutes, 180);
      assert.equal(updated.language_code, "de");
      assert.deepEqual(updated.topic_codes, ["world", "nature"]);
      assert.deepEqual(updated.custom_topics, ["Ocean exploration"]);
      assert.equal(updated.approval_policy, "automatic");
      assert.equal(updated.quiet_hours_enabled, false);
      assert.ok(updated.next_run_at);
      assert.equal(
        new Date(updated.next_run_at).toISOString(),
        updated.next_run_at,
      );
      assert.equal(
        await settingsRepository.updateNewsSettings({
          channelId,
          reviewChatId,
          scheduleIntervalMinutes: null,
          languageCode: "uk",
          topicCodes: ["history"],
          customTopics: [],
          approvalPolicy: "manual",
          quietHoursEnabled: true,
          updatedBy,
          expectedVersion: created.version,
        }),
        null,
      );
      assert.deepEqual(
        await settingsRepository.getNewsSettings(channelId),
        updated,
      );

      const createdFlags =
        await featureFlagsRepository.getOrCreateNewsFeatureFlags({
          channelId,
          updatedBy,
        });
      assert.deepEqual(
        createdFlags.map((flag) => flag.feature_key),
        ["article_tags", "editorial_enrichment"],
      );
      const articleTagsFlag = createdFlags.find(
        (flag) => flag.feature_key === "article_tags",
      );
      assert.ok(articleTagsFlag);
      assert.equal(articleTagsFlag.state, "off");
      assert.equal(articleTagsFlag.updated_by, updatedBy);
      assert.deepEqual(
        await featureFlagsRepository.getNewsFeatureFlags(` ${channelId} `),
        createdFlags,
      );

      const updatedFlag = await featureFlagsRepository.updateNewsFeatureFlag({
        channelId: ` ${channelId} `,
        featureKey: " ARTICLE_TAGS ",
        state: " COLLECT ",
        updatedBy,
        expectedVersion: articleTagsFlag.version,
      });
      assert.ok(updatedFlag);
      assert.equal(updatedFlag.state, "collect");
      assert.equal(updatedFlag.version, articleTagsFlag.version + 1);
      assert.equal(
        await featureFlagsRepository.updateNewsFeatureFlag({
          channelId,
          featureKey: "article_tags",
          state: "enabled",
          updatedBy,
          expectedVersion: articleTagsFlag.version,
        }),
        null,
      );

      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const input =
        await settingsInputRepository.beginTelegramSettingsInput({
          controlChatId,
          requestedBy: updatedBy,
          promptMessageId,
          expiresAt,
        });
      assert.ok(input);
      assert.equal(input.control_chat_id, controlChatId);
      assert.equal(input.requested_by, updatedBy);
      assert.equal(input.prompt_message_id, promptMessageId);
      assert.equal(input.expires_at, expiresAt);
      assert.equal(
        await settingsInputRepository.consumeTelegramSettingsInput({
          controlChatId,
          requestedBy: updatedBy,
          promptMessageId: promptMessageId + 1,
        }),
        null,
      );
      assert.equal(
        (
          await settingsInputRepository.consumeTelegramSettingsInput({
            controlChatId,
            requestedBy: updatedBy,
            promptMessageId,
          })
        )?.id,
        input.id,
      );

      await settingsInputRepository.beginTelegramSettingsInput({
        controlChatId,
        requestedBy: updatedBy,
        promptMessageId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await pool.query(
        `update public.telegram_settings_inputs
         set created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         where control_chat_id = $1 and requested_by = $2`,
        [controlChatId, updatedBy],
      );
      assert.equal(
        await settingsInputRepository.consumeTelegramSettingsInput({
          controlChatId,
          requestedBy: updatedBy,
          promptMessageId,
        }),
        null,
      );
      const expiredRow = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from public.telegram_settings_inputs
         where control_chat_id = $1 and requested_by = $2`,
        [controlChatId, updatedBy],
      );
      assert.equal(expiredRow.rows[0].count, "0");
    } finally {
      await pool
        .query(
          "delete from public.telegram_settings_inputs where control_chat_id = $1 and requested_by = $2",
          [controlChatId, updatedBy],
        )
        .catch(() => {});
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = $1",
          [channelId],
        )
        .catch(() => {});
      await pool.end();
    }
  },
);

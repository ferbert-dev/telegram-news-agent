import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { PG_POOL } from "../../src/database/database.tokens.js";
import { SettingsService } from "../../src/settings/application/settings.service.js";
import { SettingsApplicationModule } from "../../src/settings/settings-application.module.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "SettingsApplicationModule preserves settings, Labs CAS, and expiring-input PostgreSQL behavior",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const moduleRef = await Test.createTestingModule({
      imports: [SettingsApplicationModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    await moduleRef.init();

    const service = moduleRef.get(SettingsService);
    const suffix = randomUUID();
    const channelId = `@settings-application-${suffix}`;
    const reviewChatId = 700_000_000_101;
    const updatedBy = 700_000_000_102;
    const controlChatId = 700_000_000_103;
    const promptMessageId = 9201;

    try {
      const created = await service.getOrCreateNewsSettings({
        channelId: ` ${channelId} `,
        reviewChatId,
        updatedBy,
      });
      assert.ok(created);
      assert.equal(created.telegram_channel_id, channelId);
      assert.equal(created.language_code, "en");
      assert.equal(created.schedule_interval_minutes, null);
      assert.equal(created.approval_policy, "manual");
      assert.equal(created.quiet_hours_enabled, true);

      let current = created;
      const supportedUpdates = [
        { interval: 60 as const, language: "en" },
        { interval: 180 as const, language: "uk" },
        { interval: 360 as const, language: "de" },
        { interval: 720 as const, language: "en" },
        { interval: 1440 as const, language: "uk" },
      ];
      for (const [index, option] of supportedUpdates.entries()) {
        const updated = await service.updateNewsSettings({
          channelId: ` ${channelId} `,
          reviewChatId,
          scheduleIntervalMinutes: option.interval,
          languageCode: ` ${option.language.toUpperCase()} `,
          topicCodes: ["World", " world ", "nature"],
          customTopics: [" Marine biology ", "Marine biology"],
          approvalPolicy: index === supportedUpdates.length - 1
            ? " AUTOMATIC "
            : "manual",
          quietHoursEnabled: index !== supportedUpdates.length - 1,
          updatedBy,
          expectedVersion: current.version,
        });
        assert.ok(updated);
        assert.equal(updated.schedule_interval_minutes, option.interval);
        assert.equal(updated.language_code, option.language);
        assert.deepEqual(updated.topic_codes, ["world", "nature"]);
        assert.deepEqual(updated.custom_topics, ["Marine biology"]);
        current = updated;
      }
      assert.equal(current.approval_policy, "automatic");
      assert.equal(current.quiet_hours_enabled, false);

      assert.equal(
        await service.updateNewsSettings({
          channelId,
          reviewChatId,
          scheduleIntervalMinutes: null,
          languageCode: "de",
          topicCodes: ["science"],
          customTopics: [],
          approvalPolicy: "manual",
          quietHoursEnabled: true,
          updatedBy,
          expectedVersion: created.version,
        }),
        null,
      );
      assert.deepEqual(await service.getNewsSettings(channelId), current);

      const flags = await service.getOrCreateNewsFeatureFlags({
        channelId,
        updatedBy,
      });
      assert.equal(flags.length, 1);
      assert.equal(flags[0].feature_key, "article_tags");
      assert.equal(flags[0].state, "off");

      const enabledFlag = await service.updateNewsFeatureFlag({
        channelId,
        featureKey: " ARTICLE_TAGS ",
        state: " ENABLED ",
        updatedBy,
        expectedVersion: flags[0].version,
      });
      assert.ok(enabledFlag);
      assert.equal(enabledFlag.state, "enabled");
      assert.equal(
        await service.updateNewsFeatureFlag({
          channelId,
          featureKey: "article_tags",
          state: "collect",
          updatedBy,
          expectedVersion: flags[0].version,
        }),
        null,
      );
      assert.deepEqual(await service.getNewsFeatureFlags(channelId), [
        enabledFlag,
      ]);

      const input = await service.beginTelegramSettingsInput({
        controlChatId,
        requestedBy: updatedBy,
        promptMessageId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.ok(input);
      assert.equal(
        await service.consumeTelegramSettingsInput({
          controlChatId,
          requestedBy: updatedBy,
          promptMessageId: promptMessageId + 1,
        }),
        null,
      );
      assert.equal(
        (
          await service.consumeTelegramSettingsInput({
            controlChatId,
            requestedBy: updatedBy,
            promptMessageId,
          })
        )?.id,
        input.id,
      );

      await service.beginTelegramSettingsInput({
        controlChatId,
        requestedBy: updatedBy,
        promptMessageId,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await pool.query(
        `update public.telegram_settings_inputs
         set created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         where control_chat_id = $1 and requested_by = $2`,
        [controlChatId, updatedBy],
      );
      assert.equal(
        await service.consumeTelegramSettingsInput({
          controlChatId,
          requestedBy: updatedBy,
          promptMessageId,
        }),
        null,
      );
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
      await moduleRef.close().catch(() => {});
    }
  },
);

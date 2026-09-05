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
      const roleEvidence = await pool.query<{
        current_user: string;
        is_superuser: boolean;
        inherits_service_role: boolean;
      }>(`
        select
          current_user,
          role.rolsuper as is_superuser,
          pg_has_role(current_user, 'service_role', 'member') as inherits_service_role
        from pg_catalog.pg_roles as role
        where role.rolname = current_user
      `);
      assert.equal(roleEvidence.rows[0].is_superuser, false);
      assert.equal(roleEvidence.rows[0].inherits_service_role, true);

      const securityEvidence = await pool.query<{
        rls_enabled: boolean;
        service_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        public_execute: boolean;
      }>(`
        select
          relation.relrowsecurity as rls_enabled,
          has_function_privilege(
            'service_role',
            'public.update_news_excluded_topics(text,text[],bigint,integer)',
            'execute'
          ) as service_execute,
          has_function_privilege(
            'anon',
            'public.update_news_excluded_topics(text,text[],bigint,integer)',
            'execute'
          ) as anon_execute,
          has_function_privilege(
            'authenticated',
            'public.update_news_excluded_topics(text,text[],bigint,integer)',
            'execute'
          ) as authenticated_execute,
          exists (
            select 1
            from pg_catalog.pg_proc as function_value
            cross join lateral aclexplode(
              coalesce(
                function_value.proacl,
                acldefault('f', function_value.proowner)
              )
            ) as grant_value
            join pg_catalog.pg_namespace as namespace
              on namespace.oid = function_value.pronamespace
            where namespace.nspname = 'public'
              and function_value.proname = 'update_news_excluded_topics'
              and pg_get_function_identity_arguments(function_value.oid)
                = 'p_telegram_channel_id text, p_excluded_topic_codes text[], p_updated_by bigint, p_expected_version integer'
              and grant_value.grantee = 0
              and grant_value.privilege_type = 'EXECUTE'
          ) as public_execute
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'news_bot_settings'
      `);
      assert.deepEqual(securityEvidence.rows[0], {
        rls_enabled: true,
        service_execute: true,
        anon_execute: false,
        authenticated_execute: false,
        public_execute: false,
      });

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
      // Empty, not ['war_conflict']: a new database must not opt itself
      // into a per-article AI classifier. This pins that default -- the one
      // whose old value cost 20,278 provider calls in a day on the
      // integration stage against production's 42.
      assert.deepEqual(created.excluded_topic_codes, []);
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
      const normalizedExclusions =
        await settingsRepository.updateNewsExcludedTopics({
          channelId: ` ${channelId} `,
          excludedTopicCodes: [" WAR_CONFLICT ", "war_conflict"],
          updatedBy,
          expectedVersion: updated.version,
        });
      assert.ok(normalizedExclusions);
      assert.deepEqual(normalizedExclusions.excluded_topic_codes, [
        "war_conflict",
      ]);
      assert.equal(normalizedExclusions.version, updated.version + 1);
      const storedShape = await pool.query<{
        dimensions: number;
        lower_bound: number;
        item_count: number;
      }>(
        `select
           array_ndims(excluded_topic_codes) as dimensions,
           array_lower(excluded_topic_codes, 1) as lower_bound,
           cardinality(excluded_topic_codes) as item_count
         from public.news_bot_settings
         where telegram_channel_id = $1`,
        [channelId],
      );
      assert.deepEqual(storedShape.rows[0], {
        dimensions: 1,
        lower_bound: 1,
        item_count: 1,
      });
      const validatorEvidence = await pool.query<{
        empty_valid: boolean;
        canonical_valid: boolean;
        two_dimensional_valid: boolean;
        zero_lower_bound_valid: boolean;
      }>(`
        select
          public.valid_news_excluded_topic_codes('{}'::text[])
            as empty_valid,
          public.valid_news_excluded_topic_codes(array['war_conflict']::text[])
            as canonical_valid,
          public.valid_news_excluded_topic_codes(array[['war_conflict']]::text[])
            as two_dimensional_valid,
          public.valid_news_excluded_topic_codes(
            '[0:0]={war_conflict}'::text[]
          ) as zero_lower_bound_valid
      `);
      assert.deepEqual(validatorEvidence.rows[0], {
        empty_valid: true,
        canonical_valid: true,
        two_dimensional_valid: false,
        zero_lower_bound_valid: false,
      });
      await assert.rejects(
        settingsRepository.updateNewsExcludedTopics({
          channelId,
          excludedTopicCodes: ["unknown_topic"],
          updatedBy,
          expectedVersion: normalizedExclusions.version,
        }),
        /Invalid excluded topic codes/,
      );
      await assert.rejects(
        pool.query(
          `update public.news_bot_settings
           set excluded_topic_codes = array['unknown_topic']::text[]
           where telegram_channel_id = $1`,
          [channelId],
        ),
        /news_bot_settings_excluded_topic_codes_check/,
      );
      for (const malformedArray of [
        "array[['war_conflict']]::text[]",
        "'[0:0]={war_conflict}'::text[]",
      ]) {
        await assert.rejects(
          pool.query(
            `update public.news_bot_settings
             set excluded_topic_codes = ${malformedArray}
             where telegram_channel_id = $1`,
            [channelId],
          ),
          /news_bot_settings_excluded_topic_codes_check/,
        );
      }
      const exclusionsUpdated =
        await settingsRepository.updateNewsExcludedTopics({
          channelId: ` ${channelId} `,
          excludedTopicCodes: [],
          updatedBy,
          expectedVersion: normalizedExclusions.version,
        });
      assert.ok(exclusionsUpdated);
      assert.deepEqual(exclusionsUpdated.excluded_topic_codes, []);
      assert.equal(exclusionsUpdated.version, normalizedExclusions.version + 1);
      assert.equal(
        await settingsRepository.updateNewsExcludedTopics({
          channelId,
          excludedTopicCodes: ["war_conflict"],
          updatedBy,
          expectedVersion: updated.version,
        }),
        null,
      );
      assert.deepEqual(
        await settingsRepository.getNewsSettings(channelId),
        exclusionsUpdated,
      );

      const createdFlags =
        await featureFlagsRepository.getOrCreateNewsFeatureFlags({
          channelId,
          updatedBy,
        });
      assert.deepEqual(
        createdFlags.map((flag) => flag.feature_key),
        ["article_tags", "editorial_enrichment", "publication_milestones"],
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import "../../src/database.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EditorialRepository } from "../../src/database/repositories/editorial-repository.js";
import { NotionAuditOutboxRepository } from "../../src/database/repositories/notion-audit-outbox-repository.js";
import { PipelineLeasesRepository } from "../../src/database/repositories/pipeline-leases-repository.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import { StoryDeduplicationRepository } from "../../src/database/repositories/story-deduplication-repository.js";
import { SchedulerRepository } from "../../src/database/repositories/scheduler-repository.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";
import { UsageReportingRepository } from "../../src/database/repositories/usage-reporting-repository.js";
import { NewsRepository } from "../../src/news-repository.js";
import type { LegacyPersistence } from "../../src/persistence/legacy-persistence.contracts.js";
import { LegacyPersistenceFacade } from "../../src/persistence/legacy-persistence.facade.js";
import { FeatureFlagsRepository } from "../../src/settings/feature-flags-repository.js";
import { NewsSettingsRepository } from "../../src/settings/news-settings-repository.js";
import { TelegramSettingsInputRepository } from "../../src/settings/telegram-settings-input-repository.js";
import { TelegramCheckpointsRepository } from "../../src/telegram/telegram-checkpoints-repository.js";
import { TelegramNewsJobsRepository } from "../../src/telegram/telegram-news-jobs-repository.js";
import { TelegramReviewSessionsRepository } from "../../src/telegram/telegram-review-sessions-repository.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

function canonical<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString() as T;
  }
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value)
  ) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString() as T;
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonical(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonical(entry)]),
    ) as T;
  }
  return value;
}

test(
  "legacy and facade paths preserve cross-domain rows, idempotency, CAS and concurrency on PostgreSQL 17",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 16 });
    const database = createDrizzleDatabase(pool);
    const legacy = new NewsRepository(pool) as unknown as LegacyPersistence;
    const catalog = new SourcesRepository(pool, database);
    const research = new ResearchIngestionRepository(pool, database);
    const storyDeduplication = new StoryDeduplicationRepository(pool, database);
    const editorial = new EditorialRepository(pool, database);
    const usage = new UsageReportingRepository(pool, database);
    const pipelineLeases = new PipelineLeasesRepository(pool, database);
    const notionAudit = new NotionAuditOutboxRepository(pool, database);
    const settings = new NewsSettingsRepository(pool, database);
    const featureFlags = new FeatureFlagsRepository(pool, database);
    const settingsInput = new TelegramSettingsInputRepository(pool, database);
    const scheduler = new SchedulerRepository(pool, database);
    const telegramUpdates = new TelegramUpdatesRepository(pool, database);
    const telegramNewsJobs = new TelegramNewsJobsRepository(pool, database);
    const telegramCheckpoints = new TelegramCheckpointsRepository(pool, database);
    const telegramReviews = new TelegramReviewSessionsRepository(pool, database);
    const facade = new LegacyPersistenceFacade(
      catalog,
      research,
      storyDeduplication,
      editorial,
      usage,
      pipelineLeases,
      notionAudit,
      settings,
      featureFlags,
      settingsInput,
      scheduler,
      telegramUpdates,
      telegramNewsJobs,
      telegramCheckpoints,
      telegramReviews,
    );

    const suffix = randomUUID();
    const compact = suffix.replaceAll("-", "");
    const channelId = `@facade_${compact}`;
    const sourceFeed = `https://facade-parity.test/${suffix}.xml`;
    const canonicalUrl = `https://facade-parity.test/articles/${suffix}`;
    const leaseName = `facade-parity-${suffix}`;
    const pageId = `facade-parity-${suffix}`;
    const responseId = `facade-parity-${suffix}`;
    const scheduleClaimToken = randomUUID();
    const updateId = Date.now();
    const reviewChatId = -1_000_000_000_001;
    const actorId = 7_000_000_001;
    const promptMessageId = 7_000_000_002;
    const previewMessageId = 7_000_000_003;
    const sourceIds: string[] = [];
    const searchRunIds: string[] = [];
    const articleIds: string[] = [];
    const draftIds: string[] = [];
    const reviewSessionIds: string[] = [];

    try {
      const source = await legacy.upsertSource({
        name: `Facade parity ${suffix}`,
        homepage_url: "https://facade-parity.test",
        feed_url: sourceFeed,
        source_type: "rss",
        reliability_score: 87,
        enabled: true,
        is_primary: false,
      });
      sourceIds.push(source.id);
      const facadeSource = await facade.upsertSource({
        name: `Facade parity ${suffix}`,
        homepage_url: "https://facade-parity.test",
        feed_url: sourceFeed,
        source_type: "rss",
        reliability_score: 87,
        enabled: true,
        is_primary: false,
      });
      assert.equal(facadeSource.id, source.id);
      assert.equal(new Date(facadeSource.created_at).toISOString(), facadeSource.created_at);
      assert.deepEqual(
        canonical(
          (await facade.listEnabledSources()).find(
            (row) => row.feed_url === sourceFeed,
          ),
        ),
        canonical(
          (await legacy.listEnabledSources()).find(
            (row) => row.feed_url === sourceFeed,
          ),
        ),
      );
      assert.deepEqual(
        canonical(
          (await facade.listSourceHealth()).find(
            (row) => row.feed_url === sourceFeed,
          ),
        ),
        canonical(
          (await legacy.listSourceHealth()).find(
            (row) => row.feed_url === sourceFeed,
          ),
        ),
      );
      assert.deepEqual(
        canonical(await facade.listEnabledArticleTags("de")),
        canonical(await legacy.listEnabledArticleTags("de")),
      );

      const searchRun = await legacy.startSearchRun({
        query: `facade parity ${suffix}`,
        sourceId: source.id,
        metadata: { path: "legacy" },
      });
      searchRunIds.push(searchRun.id);
      const candidateInput = {
        source_id: source.id,
        search_run_id: searchRun.id,
        canonical_url: canonicalUrl,
        title: "Facade parity candidate",
        author: null,
        published_at: null,
        content_hash: `facade-${suffix}`,
        metadata: { initial: true },
      };
      const candidateResults = await Promise.all([
        legacy.createOrResumeArticleCandidate(candidateInput),
        facade.createOrResumeArticleCandidate({
          ...candidateInput,
          metadata: { resumed: true },
        }),
      ]);
      assert.ok(candidateResults[0]);
      assert.ok(candidateResults[1]);
      assert.equal(candidateResults[0].id, candidateResults[1].id);
      const articleId = candidateResults[0].id;
      articleIds.push(articleId);

      const raw = await legacy.saveRawContent({
        article_id: articleId,
        content: "legacy evidence",
        content_type: "text",
        language_code: "de",
        extractor: "legacy",
        content_hash: `raw-${suffix}`,
        metadata: { pass: 1 },
      });
      const recoveredRaw = await facade.saveRawContent({
        article_id: articleId,
        content: "facade evidence",
        content_type: "text",
        language_code: "de",
        extractor: "facade",
        content_hash: `raw-${suffix}`,
        metadata: { pass: 2 },
      });
      assert.equal(recoveredRaw.id, raw.id);
      assert.equal(recoveredRaw.content, "facade evidence");
      assert.equal(new Date(recoveredRaw.fetched_at).toISOString(), recoveredRaw.fetched_at);

      const reviewDraftResults = await Promise.allSettled([
        legacy.createReviewDraft({
          article_id: articleId,
          body: "Legacy concurrent review draft",
          model: "parity-model",
        }),
        facade.createReviewDraft({
          article_id: articleId,
          body: "Facade concurrent review draft",
          model: "parity-model",
        }),
      ]);
      const reviewDraftSuccesses = reviewDraftResults.filter(
        (result) => result.status === "fulfilled" && result.value,
      );
      assert.equal(reviewDraftSuccesses.length, 1);
      const draftId = (reviewDraftSuccesses[0] as PromiseFulfilledResult<{ id: string }>).value.id;
      draftIds.push(draftId);
      assert.deepEqual(
        canonical(await facade.getDraft(draftId)),
        canonical(await legacy.getDraft(draftId)),
      );
      assert.deepEqual(
        canonical(
          (await facade.listDrafts("review")).find(
            (row) => row.id === draftId,
          ),
        ),
        canonical(
          (await legacy.listDrafts("review")).find(
            (row) => row.id === draftId,
          ),
        ),
      );

      const settingsRow = await legacy.getOrCreateNewsSettings({
        channelId,
        reviewChatId,
        updatedBy: actorId,
      });
      assert.ok(settingsRow);
      assert.deepEqual(
        canonical(await facade.getNewsSettings(channelId)),
        canonical(await legacy.getNewsSettings(channelId)),
      );
      assert.deepEqual(
        canonical(await facade.getOrCreateNewsFeatureFlags({ channelId, updatedBy: actorId })),
        canonical(await legacy.getNewsFeatureFlags(channelId)),
      );

      const settingsUpdates = await Promise.all([
        legacy.updateNewsSettings({
          channelId,
          reviewChatId,
          scheduleIntervalMinutes: 180,
          languageCode: "de",
          topicCodes: ["science"],
          customTopics: ["deep ocean"],
          approvalPolicy: "manual",
          quietHoursEnabled: true,
          updatedBy: actorId,
          expectedVersion: settingsRow.version,
        }),
        facade.updateNewsSettings({
          channelId,
          reviewChatId,
          scheduleIntervalMinutes: 180,
          languageCode: "de",
          topicCodes: ["science"],
          customTopics: ["deep ocean"],
          approvalPolicy: "manual",
          quietHoursEnabled: true,
          updatedBy: actorId,
          expectedVersion: settingsRow.version,
        }),
      ]);
      assert.equal(settingsUpdates.filter((row) => row !== null).length, 1);

      const currentSettings = await legacy.getNewsSettings(channelId);
      assert.ok(currentSettings);
      const excludedUpdates = await Promise.all([
        legacy.updateNewsExcludedTopics({
          channelId,
          excludedTopicCodes: [],
          updatedBy: actorId,
          expectedVersion: currentSettings.version,
        }),
        facade.updateNewsExcludedTopics({
          channelId,
          excludedTopicCodes: [],
          updatedBy: actorId,
          expectedVersion: currentSettings.version,
        }),
      ]);
      assert.equal(excludedUpdates.filter((row) => row !== null).length, 1);
      assert.deepEqual(
        (await facade.getNewsSettings(channelId))?.excluded_topic_codes,
        [],
      );

      const input = await legacy.beginTelegramSettingsInput({
        controlChatId: reviewChatId,
        requestedBy: actorId,
        promptMessageId,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
      assert.ok(input);
      const consumed = await facade.consumeTelegramSettingsInput({
        controlChatId: reviewChatId,
        requestedBy: actorId,
        promptMessageId,
      });
      assert.equal(consumed?.id, input.id);
      assert.equal(await legacy.consumeTelegramSettingsInput({
        controlChatId: reviewChatId,
        requestedBy: actorId,
        promptMessageId,
      }), null);

      const usageRows = [
        await legacy.recordAiUsage({
          provider: "openai",
          providerResponseId: responseId,
          model: "parity-model",
          operation: "facade_parity",
          telegramChannelId: channelId,
          searchRunId: searchRun.id,
          articleId,
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUsd: "0.00001234",
        }),
        await facade.recordAiUsage({
          provider: "openai",
          providerResponseId: responseId,
          model: "must-not-overwrite",
          operation: "duplicate",
          telegramChannelId: channelId,
          inputTokens: 99,
        }),
      ];
      assert.equal(usageRows[0].id, usageRows[1].id);
      assert.equal(usageRows[0].model, usageRows[1].model);
      assert.equal(typeof usageRows[1].estimated_cost_usd, "string");
      assert.deepEqual(
        canonical(await facade.getDailyUsageDashboard({ channelId, now: new Date(), timeZone: "Europe/Madrid" })),
        canonical(await legacy.getDailyUsageDashboard({ channelId, now: new Date(), timeZone: "Europe/Madrid" })),
      );

      const leaseOwners = [randomUUID(), randomUUID()];
      const leaseResults = await Promise.all([
        legacy.acquirePipelineLease(leaseName, leaseOwners[0], 30),
        facade.acquirePipelineLease(leaseName, leaseOwners[1], 30),
      ]);
      assert.equal(leaseResults.filter(Boolean).length, 1);
      const winningOwner = leaseResults[0] ? leaseOwners[0] : leaseOwners[1];
      const losingOwner = leaseResults[0] ? leaseOwners[1] : leaseOwners[0];
      assert.equal(await facade.renewPipelineLease(leaseName, losingOwner, 30), false);
      assert.equal(await legacy.releasePipelineLease(leaseName, winningOwner), true);

      const auditRows = await Promise.all([
        legacy.enqueueNotionAuditBackfill({
          notion_page_id: pageId,
          event_type: "finalize_success",
          payload: { path: "legacy" },
          last_error: "legacy",
        }),
        facade.enqueueNotionAuditBackfill({
          notion_page_id: pageId,
          event_type: "finalize_success",
          payload: { path: "facade" },
          last_error: "facade",
        }),
      ]);
      assert.equal(auditRows[0].id, auditRows[1].id);
      assert.equal(typeof auditRows[1].created_at, "string");

      const updateClaims = await Promise.all([
        legacy.claimTelegramUpdate(updateId, "callback_query", 30),
        facade.claimTelegramUpdate(updateId, "callback_query", 30),
      ]);
      assert.equal(updateClaims.filter((claim) => claim.claimed).length, 1);
      assert.equal(updateClaims.find((claim) => !claim.claimed)?.claim_status, "busy");
      const updateWinner = updateClaims.find((claim) => claim.claimed);
      assert.ok(updateWinner?.claim_token);
      assert.equal(
        await facade.finishTelegramUpdate(updateId, randomUUID(), "completed"),
        false,
      );
      assert.equal(
        await legacy.finishTelegramUpdate(updateId, updateWinner.claim_token, "completed"),
        true,
      );

      const checkpoint = await legacy.saveTelegramNewsCheckpoint({
        update_id: updateId,
        status: "review_ready",
        draft_id: draftId,
        preview: "Facade parity preview",
        window_hours: 24,
        publication_message_id: null,
        settings_snapshot: { languageCode: "de" },
      });
      assert.deepEqual(
        canonical(await facade.getTelegramNewsCheckpoint(updateId)),
        canonical(checkpoint),
      );

      const sessionId = `${compact}${compact}`;
      reviewSessionIds.push(sessionId);
      const reviewSession = await legacy.createTelegramReviewSession({
        id: sessionId,
        draft_id: draftId,
        telegram_channel_id: channelId,
        control_chat_id: reviewChatId,
        preview_message_id: previewMessageId,
        requested_by: actorId,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      });
      assert.deepEqual(
        canonical(await facade.findTelegramReviewSessionByDraft(draftId)),
        canonical(reviewSession),
      );
      assert.equal(await facade.hasPendingTelegramReview(channelId), true);
      const decisions = await Promise.all([
        legacy.decideTelegramReviewSession({
          sessionId,
          action: "publish",
          chatId: reviewChatId,
          messageId: previewMessageId,
          actorId,
        }),
        facade.decideTelegramReviewSession({
          sessionId,
          action: "reject",
          chatId: reviewChatId,
          messageId: previewMessageId,
          actorId,
        }),
      ]);
      assert.equal(decisions.filter((decision) => decision.decision_won).length, 1);

      await pool.query(
        `update public.news_bot_settings
         set schedule_claim_token = $1,
             schedule_claimed_at = now(),
             schedule_run_id = gen_random_uuid(),
             schedule_run_due_at = now(),
             schedule_settings_snapshot = '{}'::jsonb
         where telegram_channel_id = $2`,
        [scheduleClaimToken, channelId],
      );
      const scheduleInput = {
        channelId,
        claimToken: scheduleClaimToken,
        draftId,
        preview: "Facade schedule preview",
        windowHours: 24,
      };
      assert.equal(await legacy.saveNewsScheduleDraft(scheduleInput), true);
      assert.equal(await facade.saveNewsScheduleDraft(scheduleInput), true);
      assert.equal(
        await facade.saveNewsScheduleDraft({
          ...scheduleInput,
          claimToken: randomUUID(),
        }),
        false,
      );

      await assert.rejects(
        facade.transitionArticle(articleId, "discovered", "extracted"),
        /expected one row, received 0/,
      );
    } finally {
      await pool.query("delete from public.telegram_news_request_checkpoints where update_id = $1", [updateId]).catch(() => {});
      await pool.query("delete from public.telegram_updates where update_id = $1", [updateId]).catch(() => {});
      await pool.query("delete from public.telegram_review_sessions where id = any($1::text[])", [reviewSessionIds]).catch(() => {});
      await pool.query("delete from public.ai_usage_events where telegram_channel_id = $1", [channelId]).catch(() => {});
      await pool.query("delete from public.notion_audit_outbox where notion_page_id = $1", [pageId]).catch(() => {});
      await pool.query("delete from public.pipeline_leases where name = $1", [leaseName]).catch(() => {});
      await pool.query("delete from public.news_bot_settings where telegram_channel_id = $1", [channelId]).catch(() => {});
      await pool.query("delete from public.drafts where id = any($1::uuid[])", [draftIds]).catch(() => {});
      await pool.query("delete from public.raw_contents where article_id = any($1::uuid[])", [articleIds]).catch(() => {});
      await pool.query("delete from public.articles where id = any($1::uuid[])", [articleIds]).catch(() => {});
      await pool.query("delete from public.search_runs where id = any($1::uuid[])", [searchRunIds]).catch(() => {});
      await pool.query("delete from public.sources where id = any($1::uuid[])", [sourceIds]).catch(() => {});
      await pool.end();
    }
  },
);

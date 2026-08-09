import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { NewsRepository } from "../../src/news-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "NewsRepository works against a clean PostgreSQL schema",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const repository = new NewsRepository(pool);
    const suffix = randomUUID();
    const updateId = Date.now() + Math.floor(Math.random() * 10_000);
    const publishedUpdateId = updateId + 1_000_000;
    const leaseName = `integration-${suffix}`;
    const ownerId = randomUUID();
    const settingsChannel = `@integration_${suffix.replaceAll("-", "")}`;
    const idBase = Date.now() * 1_000 + Math.floor(Math.random() * 500);
    const reviewChatId = idBase;
    const settingsUserId = idBase + 1;
    const promptMessageId = idBase + 2;
    const previewMessageId = idBase + 3;
    let source;
    let discoveredSource;
    let searchRun;
    let article;
    let sessionId;

    try {
      source = await repository.upsertSource({
        name: `Integration ${suffix}`,
        homepage_url: "https://integration.test",
        feed_url: `https://integration.test/${suffix}.xml`,
        source_type: "rss",
        reliability_score: 90,
        enabled: true,
        is_primary: true,
      });
      assert.ok(
        (await repository.listEnabledSources()).some(
          (candidate) => candidate.id === source.id,
        ),
      );
      assert.equal((await repository.setSourceEnabled(source.id, false)).enabled, false);
      assert.equal((await repository.setSourceEnabled(source.id, true)).enabled, true);
      assert.ok((await repository.markSourceChecked(source.id)).last_checked_at);
      await repository.markSourceFetchFailure(source.id, "http_503");
      await repository.markSourceFetchFailure(source.id, "http_503");
      const quarantined = await repository.markSourceFetchFailure(
        source.id,
        "http_503",
      );
      assert.equal(quarantined.consecutive_failures, 3);
      assert.ok(quarantined.disabled_until);
      assert.equal(
        (await repository.listEnabledSources()).some(
          (candidate) => candidate.id === source.id,
        ),
        false,
      );
      const healthyAgain = await repository.markSourceFetchSuccess(source.id);
      assert.equal(healthyAgain.consecutive_failures, 0);
      assert.equal(healthyAgain.disabled_until, null);

      const sourceDiscoveryKey = suffix.replaceAll("-", "").padEnd(64, "0");
      assert.equal(
        await repository.claimSourceDiscovery(sourceDiscoveryKey),
        true,
      );
      assert.equal(
        await repository.claimSourceDiscovery(sourceDiscoveryKey),
        false,
      );
      discoveredSource = await repository.upsertDiscoveredSource({
        name: `Discovered ${suffix}`,
        homepageUrl: "https://discovered.integration.test/",
        feedUrl: `https://discovered.integration.test/${suffix}.xml`,
        reliabilityScore: 65,
        topicCodes: ["science"],
        discoveredBy: "openai",
        discoveryMetadata: { custom_topics: ["Ocean exploration"] },
      });
      assert.equal(discoveredSource.discovered_by, "openai");
      assert.ok(
        (await repository.listEnabledSources()).some(
          (candidate) =>
            candidate.id === discoveredSource.id &&
            candidate.topic_codes.includes("science"),
        ),
      );
      assert.equal(
        await repository.completeSourceDiscovery({
          topicKey: sourceDiscoveryKey,
          provider: "openai",
          model: "integration-model",
          resultCount: 1,
        }),
        true,
      );

      const defaultSettings = await repository.getOrCreateNewsSettings({
        channelId: settingsChannel,
        reviewChatId,
        updatedBy: settingsUserId,
      });
      assert.equal(defaultSettings.schedule_interval_minutes, null);
      assert.equal(defaultSettings.language_code, "en");
      assert.equal(defaultSettings.approval_policy, "manual");
      assert.equal(defaultSettings.quiet_hours_enabled, true);
      assert.deepEqual(defaultSettings.topic_codes, [
        "ai",
        "world",
        "science",
        "nature",
        "animals",
        "history",
        "culture",
        "technology",
        "society",
      ]);

      const defaultFeatures = await repository.getOrCreateNewsFeatureFlags({
        channelId: settingsChannel,
        updatedBy: settingsUserId,
      });
      const articleTagsFeature = defaultFeatures.find(
        (feature) => feature.feature_key === "article_tags",
      );
      assert.equal(articleTagsFeature.state, "off");
      const collectingTags = await repository.updateNewsFeatureFlag({
        channelId: settingsChannel,
        featureKey: "article_tags",
        state: "collect",
        updatedBy: settingsUserId,
        expectedVersion: articleTagsFeature.version,
      });
      assert.equal(collectingTags.state, "collect");
      assert.equal(collectingTags.version, articleTagsFeature.version + 1);
      assert.equal(
        await repository.updateNewsFeatureFlag({
          channelId: settingsChannel,
          featureKey: "article_tags",
          state: "enabled",
          updatedBy: settingsUserId,
          expectedVersion: articleTagsFeature.version,
        }),
        null,
      );
      const germanTags = await repository.listEnabledArticleTags("de");
      assert.ok(
        germanTags.some(
          (tag) => tag.code === "science" && tag.hashtag === "#Wissenschaft",
        ),
      );

      const updatedSettings = await repository.updateNewsSettings({
        channelId: settingsChannel,
        reviewChatId,
        scheduleIntervalMinutes: 180,
        languageCode: "de",
        topicCodes: ["world", "nature"],
        customTopics: ["Ocean exploration"],
        approvalPolicy: "automatic",
        quietHoursEnabled: false,
        updatedBy: settingsUserId,
        expectedVersion: defaultSettings.version,
      });
      assert.equal(updatedSettings.version, defaultSettings.version + 1);
      assert.equal(updatedSettings.language_code, "de");
      assert.equal(updatedSettings.schedule_interval_minutes, 180);
      assert.equal(updatedSettings.quiet_hours_enabled, false);
      assert.equal(
        await repository.updateNewsSettings({
          channelId: settingsChannel,
          reviewChatId,
          scheduleIntervalMinutes: null,
          languageCode: "uk",
          topicCodes: ["history"],
          customTopics: [],
          approvalPolicy: "manual",
          quietHoursEnabled: true,
          updatedBy: settingsUserId,
          expectedVersion: defaultSettings.version,
        }),
        null,
      );
      assert.equal(
        (await repository.getNewsSettings(settingsChannel)).version,
        updatedSettings.version,
      );

      const settingsInput = await repository.beginTelegramSettingsInput({
        controlChatId: reviewChatId,
        requestedBy: settingsUserId,
        promptMessageId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(Number(settingsInput.prompt_message_id), promptMessageId);
      assert.equal(
        await repository.consumeTelegramSettingsInput({
          controlChatId: reviewChatId,
          requestedBy: settingsUserId,
          promptMessageId: promptMessageId + 1,
        }),
        null,
      );
      assert.equal(
        (
          await repository.consumeTelegramSettingsInput({
            controlChatId: reviewChatId,
            requestedBy: settingsUserId,
            promptMessageId,
          })
        ).id,
        settingsInput.id,
      );
      assert.equal(
        await repository.consumeTelegramSettingsInput({
          controlChatId: reviewChatId,
          requestedBy: settingsUserId,
          promptMessageId,
        }),
        null,
      );

      searchRun = await repository.startSearchRun({
        query: `integration ${suffix}`,
        sourceId: source.id,
        metadata: { integration: true },
      });
      article = await repository.createOrResumeArticleCandidate({
        source_id: source.id,
        search_run_id: searchRun.id,
        canonical_url: `https://integration.test/articles/${suffix}`,
        title: "Repository integration",
        author: "Codex",
        published_at: new Date().toISOString(),
        content_hash: `feed-${suffix}`,
        metadata: { integration: true },
      });
      assert.equal(article.status, "discovered");

      const articleTopics = await repository.replaceArticleTopics({
        articleId: article.id,
        assignments: [
          { code: "science", confidence: 0.95 },
          { code: "space", confidence: 0.8 },
        ],
        assignedModel: "integration-tagger",
      });
      assert.equal(articleTopics.length, 2);
      assert.ok(
        articleTopics.every(
          (assignment) =>
            assignment.assignment_source === "ai" &&
            assignment.assigned_model === "integration-tagger",
        ),
      );
      await assert.rejects(
        repository.replaceArticleTopics({
          articleId: article.id,
          assignments: [
            { code: "ai", confidence: 0.9 },
            { code: "world", confidence: 0.8 },
            { code: "science", confidence: 0.7 },
            { code: "space", confidence: 0.6 },
          ],
        }),
        /At most 3 article topics may be assigned/,
      );
      await assert.rejects(
        repository.replaceArticleTopics({
          articleId: article.id,
          assignments: [{ code: "science" }],
        }),
        /requires a code and numeric confidence/,
      );

      const usageResponseId = `integration-${suffix}`;
      const usage = await repository.recordAiUsage({
        provider: "openai",
        providerResponseId: usageResponseId,
        model: "gpt-5.4-2026-03-05",
        operation: "news_search",
        telegramChannelId: settingsChannel,
        searchRunId: searchRun.id,
        articleId: article.id,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        webSearchCalls: 1,
        estimatedCostUsd: 0.0105275,
        pricingSnapshot: { tier: "standard" },
      });
      assert.equal(usage.provider_response_id, usageResponseId);
      assert.equal(
        (
          await repository.recordAiUsage({
            provider: "openai",
            providerResponseId: usageResponseId,
            model: "gpt-5.4-2026-03-05",
            operation: "news_search",
          })
        ).id,
        usage.id,
      );
      const usageDashboard = await repository.getDailyUsageDashboard({
        channelId: settingsChannel,
      });
      assert.equal(Number(usageDashboard.summary.request_count), 1);
      assert.equal(Number(usageDashboard.summary.input_tokens), 100);
      assert.equal(Number(usageDashboard.summary.published_post_count), 0);

      const raw = await repository.saveRawContent({
        article_id: article.id,
        content: "Verified integration evidence.",
        content_type: "text",
        language_code: "en",
        extractor: "integration-test",
        content_hash: `page-${suffix}`,
        metadata: { integration: true },
      });
      assert.equal(raw.article_id, article.id);

      await assert.rejects(
        repository.createReviewDraft({
          article_id: article.id,
          body: "This draft must roll back with its invalid topic assignment.",
          model: "integration-model",
          prompt_version: "integration-v1",
          topic_assignments: [{ code: "not-in-the-catalog", confidence: 0.9 }],
          topic_assignment_source: "ai",
          topic_assigned_model: "integration-transactional-tagger",
        }),
        /Assignments must reference enabled topic codes/,
      );
      const rolledBackDraft = await pool.query(
        `select article.status,
                (select count(*)::integer from public.drafts where article_id = article.id) as draft_count
         from public.articles as article
         where article.id = $1`,
        [article.id],
      );
      assert.equal(rolledBackDraft.rows[0].status, "discovered");
      assert.equal(rolledBackDraft.rows[0].draft_count, 0);

      const draft = await repository.createReviewDraft({
        article_id: article.id,
        body: "Short grounded integration draft.",
        model: "integration-model",
        prompt_version: "integration-v1",
        topic_assignments: [{ code: "science", confidence: 0.99 }],
        topic_assignment_source: "ai",
        topic_assigned_model: "integration-transactional-tagger",
      });
      assert.equal(draft.status, "review");
      const persistedTopics = await pool.query(
        `select topic.name, article_topic.relevance_score,
                article_topic.assigned_model
         from public.article_topics as article_topic
         join public.topics as topic on topic.id = article_topic.topic_id
         where article_topic.article_id = $1`,
        [article.id],
      );
      assert.equal(persistedTopics.rows.length, 1);
      assert.equal(persistedTopics.rows[0].name, "science");
      assert.equal(
        persistedTopics.rows[0].assigned_model,
        "integration-transactional-tagger",
      );
      assert.equal((await repository.getDraft(draft.id)).articles.id, article.id);
      assert.ok(
        (await repository.listDrafts()).some(
          (candidate) => candidate.id === draft.id,
        ),
      );

      const claimedUpdate = await repository.claimTelegramUpdate(
        updateId,
        "integration",
      );
      assert.equal(claimedUpdate.claimed, true);
      await repository.saveTelegramNewsCheckpoint({
        update_id: updateId,
        status: "no_candidates",
        draft_id: null,
        preview: null,
        window_hours: null,
        updated_at: new Date().toISOString(),
      });
      assert.equal(
        (await repository.getTelegramNewsCheckpoint(updateId)).status,
        "no_candidates",
      );
      assert.equal(
        await repository.finishTelegramUpdate(
          updateId,
          claimedUpdate.claim_token,
          "completed",
        ),
        true,
      );

      const claimedPublishedUpdate = await repository.claimTelegramUpdate(
        publishedUpdateId,
        "integration_published",
      );
      const publishedCheckpoint = await repository.saveTelegramNewsCheckpoint({
        update_id: publishedUpdateId,
        status: "published",
        draft_id: draft.id,
        preview: "Published integration preview",
        window_hours: 48,
        publication_message_id: 909,
        settings_snapshot: {
          languageCode: "de",
          topicCodes: ["world", "nature"],
        },
        updated_at: new Date().toISOString(),
      });
      assert.equal(Number(publishedCheckpoint.publication_message_id), 909);
      assert.equal(publishedCheckpoint.settings_snapshot.languageCode, "de");
      assert.equal(
        await repository.finishTelegramUpdate(
          publishedUpdateId,
          claimedPublishedUpdate.claim_token,
          "completed",
        ),
        true,
      );

      sessionId =
        randomUUID().replaceAll("-", "") +
        randomUUID().replaceAll("-", "");
      await repository.createTelegramReviewSession({
        id: sessionId,
        draft_id: draft.id,
        telegram_channel_id: settingsChannel,
        control_chat_id: reviewChatId,
        preview_message_id: previewMessageId,
        requested_by: settingsUserId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(
        (await repository.findTelegramReviewSessionByDraft(draft.id)).id,
        sessionId,
      );
      assert.equal(await repository.hasPendingTelegramReview(settingsChannel), true);
      await pool.query(
        "update public.telegram_review_sessions set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = $1",
        [sessionId],
      );
      const renewedReview = await repository.renewTelegramReviewSession({
        draftId: draft.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(renewedReview.id, sessionId);
      const reboundReview = await repository.rebindTelegramReviewSession({
        draftId: draft.id,
        controlChatId: reviewChatId,
        expectedPreviewMessageId: previewMessageId,
        previewMessageId: previewMessageId + 100,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(Number(reboundReview.preview_message_id), previewMessageId + 100);
      const decision = await repository.decideTelegramReviewSession({
        sessionId,
        action: "reject",
        chatId: reviewChatId,
        messageId: previewMessageId + 100,
        actorId: settingsUserId,
      });
      assert.equal(decision.decision, "reject");
      assert.equal(decision.decision_won, true);
      assert.equal(await repository.hasPendingTelegramReview(settingsChannel), false);

      assert.equal(
        await repository.acquirePipelineLease(leaseName, ownerId, 60),
        true,
      );
      assert.equal(
        await repository.renewPipelineLease(leaseName, ownerId, 60),
        true,
      );
      assert.equal(await repository.releasePipelineLease(leaseName, ownerId), true);

      const outbox = await repository.enqueueNotionAuditBackfill({
        notion_page_id: `integration-${suffix}`,
        event_type: "finalize_success",
        payload: { started_at: new Date().toISOString(), finalization: {} },
        last_error: "integration",
      });
      assert.equal(outbox.notion_page_id, `integration-${suffix}`);
      const claimedOutbox = await repository.claimNotionAuditBackfill(25);
      assert.ok(claimedOutbox.some((record) => record.id === outbox.id));
      assert.equal(await repository.completeNotionAuditBackfill(outbox.id), true);

      assert.equal(
        (await repository.finishSearchRun(searchRun.id, { resultCount: 1 })).status,
        "completed",
      );
    } finally {
      await pool
        .query("delete from public.ai_usage_events where telegram_channel_id = $1", [
          settingsChannel,
        ])
        .catch(() => {});
      await pool
        .query("delete from public.notion_audit_outbox where notion_page_id = $1", [
          `integration-${suffix}`,
        ])
        .catch(() => {});
      await pool
        .query(
          "delete from public.telegram_settings_inputs where control_chat_id = $1 and requested_by = $2",
          [reviewChatId, settingsUserId],
        )
        .catch(() => {});
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = $1",
          [settingsChannel],
        )
        .catch(() => {});
      await pool
        .query("delete from public.telegram_updates where update_id = $1", [updateId])
        .catch(() => {});
      await pool
        .query("delete from public.telegram_updates where update_id = $1", [
          publishedUpdateId,
        ])
        .catch(() => {});
      if (sessionId) {
        await pool
          .query("delete from public.telegram_review_sessions where id = $1", [
            sessionId,
          ])
          .catch(() => {});
      }
      if (article) {
        await pool
          .query("delete from public.articles where id = $1", [article.id])
          .catch(() => {});
      }
      if (searchRun) {
        await pool
          .query("delete from public.search_runs where id = $1", [searchRun.id])
          .catch(() => {});
      }
      if (source) {
        await pool
          .query("delete from public.sources where id = $1", [source.id])
          .catch(() => {});
      }
      if (discoveredSource) {
        await pool
          .query("delete from public.sources where id = $1", [discoveredSource.id])
          .catch(() => {});
      }
      await pool
        .query("delete from public.source_discovery_state where topic_key like $1", [
          `${suffix.replaceAll("-", "")}%`,
        ])
        .catch(() => {});
      await pool
        .query("delete from public.pipeline_leases where name = $1", [leaseName])
        .catch(() => {});
      await pool.end();
    }
  },
);

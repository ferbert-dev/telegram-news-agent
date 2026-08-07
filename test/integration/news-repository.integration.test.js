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

      const defaultSettings = await repository.getOrCreateNewsSettings({
        channelId: settingsChannel,
        reviewChatId,
        updatedBy: settingsUserId,
      });
      assert.equal(defaultSettings.schedule_interval_minutes, null);
      assert.equal(defaultSettings.language_code, "en");
      assert.equal(defaultSettings.approval_policy, "manual");
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

      const updatedSettings = await repository.updateNewsSettings({
        channelId: settingsChannel,
        reviewChatId,
        scheduleIntervalMinutes: 60,
        languageCode: "de",
        topicCodes: ["world", "nature"],
        customTopics: ["Ocean exploration"],
        approvalPolicy: "automatic",
        updatedBy: settingsUserId,
        expectedVersion: defaultSettings.version,
      });
      assert.equal(updatedSettings.version, defaultSettings.version + 1);
      assert.equal(updatedSettings.language_code, "de");
      assert.equal(
        await repository.updateNewsSettings({
          channelId: settingsChannel,
          reviewChatId,
          scheduleIntervalMinutes: null,
          languageCode: "uk",
          topicCodes: ["history"],
          customTopics: [],
          approvalPolicy: "manual",
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

      const draft = await repository.createReviewDraft({
        article_id: article.id,
        body: "Short grounded integration draft.",
        model: "integration-model",
        prompt_version: "integration-v1",
      });
      assert.equal(draft.status, "review");
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
      await pool
        .query("delete from public.pipeline_leases where name = $1", [leaseName])
        .catch(() => {});
      await pool.end();
    }
  },
);

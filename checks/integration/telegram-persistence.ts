import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { TelegramCheckpointsRepository } from "../../src/telegram/telegram-checkpoints-repository.js";
import { TelegramReviewSessionsRepository } from "../../src/telegram/telegram-review-sessions-repository.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Telegram persistence preserves update/review CAS, last-write-wins checkpoints, pending fallback, expiry, rebind and manual decision concurrency",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 12 });
    const database = createDrizzleDatabase(pool);
    const updates = new TelegramUpdatesRepository(pool, database);
    const checkpoints = new TelegramCheckpointsRepository(pool, database);
    const reviews = new TelegramReviewSessionsRepository(pool, database);
    const suffix = randomUUID();
    const explicitChannel = `@telegram_explicit_${suffix.replaceAll("-", "")}`;
    const fallbackChannel = `@telegram_fallback_${suffix.replaceAll("-", "")}`;
    const reviewChatId = -1_001_234_567_890;
    const actorId = 9_001;
    const updateIds = [
      Date.now(),
      Date.now() + 1,
      Date.now() + 2,
      Date.now() + 3,
    ];
    const articleIds: string[] = [];
    const draftIds: string[] = [];
    const sessionIds: string[] = [];

    const createReviewDraft = async (name: string) => {
      const article = await pool.query<{ id: string }>(
        `insert into public.articles (
           canonical_url, title, content_hash, status, metadata
         ) values ($1, $2, $3, 'drafted', '{}'::jsonb)
         returning id`,
        [
          `https://telegram-persistence.test/${suffix}/${name}`,
          `Telegram persistence ${name}`,
          `${suffix}-${name}`,
        ],
      );
      articleIds.push(article.rows[0].id);
      const draft = await pool.query<{ id: string }>(
        `insert into public.drafts (article_id, body, status)
         values ($1, $2, 'review') returning id`,
        [article.rows[0].id, `Telegram ${name} review draft.`],
      );
      draftIds.push(draft.rows[0].id);
      return draft.rows[0].id;
    };

    try {
      await pool.query(
        `insert into public.news_bot_settings (
           telegram_channel_id, review_chat_id, updated_by
         ) values ($1, $2, $3)`,
        [fallbackChannel, reviewChatId, actorId],
      );

      const concurrentClaims = await Promise.all([
        updates.claimTelegramUpdate({
          updateId: updateIds[0],
          updateKind: "callback_query",
        }),
        updates.claimTelegramUpdate({
          updateId: updateIds[0],
          updateKind: "callback_query",
        }),
      ]);
      const winningClaim = concurrentClaims.find((claim) => claim.claimed);
      const busyClaim = concurrentClaims.find((claim) => !claim.claimed);
      assert.ok(winningClaim?.claim_token);
      assert.equal(busyClaim?.claim_status, "busy");
      assert.equal(
        await updates.finishTelegramUpdate({
          updateId: updateIds[0],
          claimToken: randomUUID(),
          status: "completed",
        }),
        false,
      );
      assert.equal(
        await updates.finishTelegramUpdate({
          updateId: updateIds[0],
          claimToken: winningClaim.claim_token,
          status: "completed",
        }),
        true,
      );
      assert.deepEqual(
        await updates.claimTelegramUpdate({
          updateId: updateIds[0],
          updateKind: "callback_query",
        }),
        { claimed: false, claim_token: null, claim_status: "terminal" },
      );

      const failedClaim = await updates.claimTelegramUpdate({
        updateId: updateIds[1],
        updateKind: "message",
      });
      assert.ok(failedClaim.claim_token);
      assert.equal(
        await updates.finishTelegramUpdate({
          updateId: updateIds[1],
          claimToken: failedClaim.claim_token,
          status: "failed",
          errorCode: "integration_retry",
        }),
        true,
      );
      const retryClaim = await updates.claimTelegramUpdate({
        updateId: updateIds[1],
        updateKind: "message_retry",
      });
      assert.equal(retryClaim.claimed, true);
      assert.notEqual(retryClaim.claim_token, failedClaim.claim_token);

      const staleClaim = await updates.claimTelegramUpdate({
        updateId: updateIds[2],
        updateKind: "stale",
        staleAfterSeconds: 30,
      });
      assert.ok(staleClaim.claim_token);
      await pool.query(
        `update public.telegram_updates
         set claimed_at = now() - interval '31 seconds'
         where update_id = $1`,
        [updateIds[2]],
      );
      const reclaimed = await updates.claimTelegramUpdate({
        updateId: updateIds[2],
        updateKind: "stale_retry",
        staleAfterSeconds: 30,
      });
      assert.equal(reclaimed.claimed, true);
      assert.notEqual(reclaimed.claim_token, staleClaim.claim_token);
      assert.equal(
        await updates.finishTelegramUpdate({
          updateId: updateIds[2],
          claimToken: staleClaim.claim_token,
          status: "completed",
        }),
        false,
      );

      const checkpointClaim = await updates.claimTelegramUpdate({
        updateId: updateIds[3],
        updateKind: "checkpoint",
      });
      assert.equal(checkpointClaim.claimed, true);
      const firstCheckpoint = await checkpoints.saveTelegramNewsCheckpoint({
        update_id: updateIds[3],
        status: "no_candidates",
        draft_id: null,
        preview: null,
        window_hours: null,
        publication_message_id: null,
        settings_snapshot: { writer: "first" },
        updated_at: "2026-08-09T18:00:00.000Z",
      });
      assert.equal(firstCheckpoint.status, "no_candidates");

      const checkpointDraftId = await createReviewDraft("checkpoint");
      const staleWriterCheckpoint =
        await checkpoints.saveTelegramNewsCheckpoint({
          update_id: updateIds[3],
          status: "published",
          draft_id: checkpointDraftId,
          preview: "Legacy last writer wins",
          window_hours: 48,
          publication_message_id: 707,
          settings_snapshot: { writer: "stale-but-last" },
          updated_at: "2026-08-09T17:00:00.000Z",
        });
      assert.equal(staleWriterCheckpoint.status, "published");
      assert.equal(staleWriterCheckpoint.publication_message_id, 707);
      assert.equal(staleWriterCheckpoint.settings_snapshot.writer, "stale-but-last");
      assert.equal(staleWriterCheckpoint.updated_at, "2026-08-09T17:00:00.000Z");
      assert.equal(
        (await checkpoints.getTelegramNewsCheckpoint(updateIds[3]))?.status,
        "published",
      );

      const explicitDraftId = await createReviewDraft("explicit");
      const explicitSessionId = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
      sessionIds.push(explicitSessionId);
      await reviews.createTelegramReviewSession({
        id: explicitSessionId,
        draft_id: explicitDraftId,
        telegram_channel_id: explicitChannel,
        control_chat_id: reviewChatId - 1,
        preview_message_id: 801,
        requested_by: actorId,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      });
      assert.equal(
        await reviews.hasPendingTelegramReview(`  ${explicitChannel}  `),
        true,
      );
      const manualPublish = await reviews.decideTelegramReviewSession({
        sessionId: explicitSessionId,
        action: "publish",
        chatId: reviewChatId - 1,
        messageId: 801,
        actorId,
      });
      assert.equal(manualPublish.decision, "publish");
      assert.equal(manualPublish.decision_won, true);
      assert.equal(
        (
          await pool.query<{ status: string }>(
            "select status from public.drafts where id = $1",
            [explicitDraftId],
          )
        ).rows[0].status,
        "approved",
      );
      assert.equal(
        await reviews.hasPendingTelegramReview(explicitChannel),
        false,
      );

      const fallbackDraftId = await createReviewDraft("fallback");
      const fallbackSessionId = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
      sessionIds.push(fallbackSessionId);
      const fallbackSession = await reviews.createTelegramReviewSession({
        id: fallbackSessionId,
        draft_id: fallbackDraftId,
        telegram_channel_id: null,
        control_chat_id: reviewChatId,
        preview_message_id: 901,
        requested_by: actorId,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      });
      assert.equal(fallbackSession.telegram_channel_id, null);
      assert.equal(await reviews.hasPendingTelegramReview(fallbackChannel), true);
      await pool.query(
        `update public.telegram_review_sessions
         set created_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         where id = $1`,
        [fallbackSessionId],
      );
      assert.equal(await reviews.hasPendingTelegramReview(fallbackChannel), false);

      const futureExpiry = new Date(Date.now() + 120_000).toISOString();
      const renewed = await reviews.renewTelegramReviewSession({
        draftId: fallbackDraftId,
        expiresAt: futureExpiry,
      });
      assert.equal(renewed?.id, fallbackSessionId);
      assert.equal(await reviews.hasPendingTelegramReview(fallbackChannel), true);
      assert.equal(
        await reviews.rebindTelegramReviewSession({
          draftId: fallbackDraftId,
          controlChatId: reviewChatId,
          expectedPreviewMessageId: 999,
          previewMessageId: 902,
          expiresAt: futureExpiry,
        }),
        null,
      );
      const rebound = await reviews.rebindTelegramReviewSession({
        draftId: fallbackDraftId,
        controlChatId: reviewChatId,
        expectedPreviewMessageId: 901,
        previewMessageId: 902,
        expiresAt: futureExpiry,
      });
      assert.equal(rebound?.preview_message_id, 902);

      const decisions = await Promise.all([
        reviews.decideTelegramReviewSession({
          sessionId: fallbackSessionId,
          action: "publish",
          chatId: reviewChatId,
          messageId: 902,
          actorId,
        }),
        reviews.decideTelegramReviewSession({
          sessionId: fallbackSessionId,
          action: "reject",
          chatId: reviewChatId,
          messageId: 902,
          actorId: actorId + 1,
        }),
      ]);
      assert.equal(
        decisions.filter((decision) => decision.decision_won).length,
        1,
      );
      assert.equal(decisions[0].decision, decisions[1].decision);
      const winningDecision = decisions.find(
        (decision) => decision.decision_won,
      );
      assert.ok(winningDecision);
      const terminalState =
        winningDecision.decision === "publish" ? "approved" : "rejected";
      const draftState = await pool.query<{ status: string }>(
        "select status from public.drafts where id = $1",
        [fallbackDraftId],
      );
      const articleState = await pool.query<{ status: string }>(
        `select article.status
         from public.articles as article
         join public.drafts as draft on draft.article_id = article.id
         where draft.id = $1`,
        [fallbackDraftId],
      );
      assert.equal(draftState.rows[0].status, terminalState);
      assert.equal(articleState.rows[0].status, terminalState);
      assert.equal(await reviews.hasPendingTelegramReview(fallbackChannel), false);
      assert.equal(
        (
          await reviews.findTelegramReviewSessionByDraft(fallbackDraftId)
        )?.decision,
        winningDecision.decision,
      );
    } finally {
      if (sessionIds.length) {
        await pool
          .query(
            "delete from public.telegram_review_sessions where id = any($1::text[])",
            [sessionIds],
          )
          .catch(() => {});
      }
      await pool
        .query(
          "delete from public.telegram_news_request_checkpoints where update_id = any($1::bigint[])",
          [updateIds],
        )
        .catch(() => {});
      await pool
        .query(
          "delete from public.telegram_updates where update_id = any($1::bigint[])",
          [updateIds],
        )
        .catch(() => {});
      if (draftIds.length) {
        await pool
          .query("delete from public.drafts where id = any($1::uuid[])", [
            draftIds,
          ])
          .catch(() => {});
      }
      if (articleIds.length) {
        await pool
          .query("delete from public.articles where id = any($1::uuid[])", [
            articleIds,
          ])
          .catch(() => {});
      }
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = $1",
          [fallbackChannel],
        )
        .catch(() => {});
      await pool.end();
    }
  },
);

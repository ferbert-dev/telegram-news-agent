import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { TelegramNewsJobsRepository } from "../../src/telegram/telegram-news-jobs-repository.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

const settingsSnapshot = {
  channelId: "@placeholder",
  reviewChatId: 9,
  updatedBy: 5,
  approvalPolicy: "manual",
  languageCode: "en",
  topicCodes: ["world"],
  customTopics: [],
  excludedTopicCodes: [],
  scheduleIntervalMinutes: null,
  quietHoursEnabled: true,
  version: 1,
};

test(
  "durable Telegram news jobs preserve enqueue idempotency, one-worker claims, token fencing and phase-separated recovery",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const database = createDrizzleDatabase(pool);
    const updates = new TelegramUpdatesRepository(pool, database);
    const jobs = new TelegramNewsJobsRepository(pool, database);
    const suffix = randomUUID().replaceAll("-", "");
    const channelId = `@durable_${suffix}`;
    const retryChannelId = `@durable_retry_${suffix}`;
    const failedExecutionChannelId = `@durable_failed_execution_${suffix}`;
    const staleExecutionChannelId = `@durable_stale_execution_${suffix}`;
    const staleDeliveryChannelId = `@durable_stale_delivery_${suffix}`;
    const baseUpdateId = Date.now() * 10;
    const updateIds = [
      baseUpdateId,
      baseUpdateId + 1,
      baseUpdateId + 2,
      baseUpdateId + 3,
      baseUpdateId + 4,
      baseUpdateId + 5,
    ];

    try {
      const firstUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[0],
        updateKind: "news_command",
      });
      const secondUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[1],
        updateKind: "news_command",
      });
      assert.ok(firstUpdate.claim_token);
      assert.ok(secondUpdate.claim_token);

      const first = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[0],
        updateClaimToken: firstUpdate.claim_token,
        channelId,
        controlChatId: 9,
        requestedBy: 5,
        settingsSnapshot: { ...settingsSnapshot, channelId },
      });
      const duplicateRequest = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[1],
        updateClaimToken: secondUpdate.claim_token,
        channelId,
        controlChatId: 9,
        requestedBy: 5,
        settingsSnapshot: { ...settingsSnapshot, channelId },
      });
      assert.equal(first.enqueue_outcome, "queued");
      assert.equal(duplicateRequest.enqueue_outcome, "already_running");
      assert.equal(duplicateRequest.active_job_id, first.id);

      assert.deepEqual(
        await jobs.enqueueTelegramNewsJob({
          updateId: updateIds[0],
          updateClaimToken: firstUpdate.claim_token,
          channelId,
          controlChatId: 9,
          requestedBy: 5,
          settingsSnapshot: { ...settingsSnapshot, channelId },
        }),
        first,
      );

      const workerTokens = [randomUUID(), randomUUID()];
      const concurrentClaims = await Promise.all(
        workerTokens.map((claimToken) =>
          jobs.claimNextTelegramNewsJob({ claimToken }),
        ),
      );
      const execution = concurrentClaims.find((entry) => entry !== null);
      assert.ok(execution);
      assert.equal(concurrentClaims.filter(Boolean).length, 1);
      assert.equal(execution.id, first.id);
      assert.equal(execution.claim_phase, "execute");
      assert.equal(
        await jobs.renewTelegramNewsJobClaim({
          jobId: execution.id,
          claimToken: randomUUID(),
        }),
        false,
      );
      assert.equal(
        await jobs.recordTelegramNewsJobOutcome({
          jobId: execution.id,
          claimToken: randomUUID(),
          outcomeStatus: "no_candidates",
        }),
        null,
      );
      assert.equal(
        (
          await jobs.recordTelegramNewsJobOutcome({
            jobId: execution.id,
            claimToken: execution.claim_token,
            outcomeStatus: "no_candidates",
          })
        )?.status,
        "outcome_ready",
      );

      const delivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(delivery?.claim_phase, "deliver");
      assert.equal(delivery?.outcome_status, "no_candidates");
      assert.equal(
        await jobs.completeTelegramNewsJob({
          jobId: delivery!.id,
          claimToken: delivery!.claim_token,
        }),
        true,
      );

      const retryUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[2],
        updateKind: "news_command",
      });
      assert.ok(retryUpdate.claim_token);
      const retryJob = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[2],
        updateClaimToken: retryUpdate.claim_token,
        channelId: retryChannelId,
        controlChatId: 10,
        requestedBy: 6,
        settingsSnapshot: {
          ...settingsSnapshot,
          channelId: retryChannelId,
          reviewChatId: 10,
          updatedBy: 6,
        },
      });
      const retryExecution = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(retryExecution?.id, retryJob.id);
      assert.equal(
        (
          await jobs.retryTelegramNewsJob({
            jobId: retryJob.id,
            claimToken: retryExecution!.claim_token,
            errorCode: "rate_limited",
          })
        )?.execution_attempt_count,
        1,
      );
      await pool.query(
        `update public.telegram_news_jobs set available_at = now()
         where id = $1`,
        [retryJob.id],
      );
      const reclaimedExecution = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(reclaimedExecution?.id, retryJob.id);
      await pool.query(
        `update public.telegram_news_jobs
         set claimed_at = now() - interval '31 seconds'
         where id = $1`,
        [retryJob.id],
      );
      const staleReclaimed = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
        staleAfterSeconds: 30,
        maxExecutionAttempts: 4,
      });
      assert.equal(staleReclaimed?.id, retryJob.id);
      assert.equal(staleReclaimed?.execution_attempt_count, 2);
      assert.notEqual(
        staleReclaimed?.claim_token,
        reclaimedExecution?.claim_token,
      );
      assert.equal(
        await jobs.renewTelegramNewsJobClaim({
          jobId: retryJob.id,
          claimToken: reclaimedExecution!.claim_token,
        }),
        false,
      );
      await jobs.recordTelegramNewsJobOutcome({
        jobId: retryJob.id,
        claimToken: staleReclaimed!.claim_token,
        outcomeStatus: "no_candidates",
      });
      const retryDelivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(
        (
          await jobs.retryTelegramNewsJobDelivery({
            jobId: retryJob.id,
            claimToken: retryDelivery!.claim_token,
            errorCode: "admin_delivery_failed",
          })
        )?.delivery_attempt_count,
        1,
      );
      await pool.query(
        `update public.telegram_news_jobs set available_at = now()
         where id = $1`,
        [retryJob.id],
      );
      const finalDelivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(finalDelivery?.claim_phase, "deliver");
      assert.equal(
        await jobs.completeTelegramNewsJob({
          jobId: retryJob.id,
          claimToken: finalDelivery!.claim_token,
        }),
        true,
      );

      const failedExecutionUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[5],
        updateKind: "news_command",
      });
      assert.ok(failedExecutionUpdate.claim_token);
      const failedExecutionJob = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[5],
        updateClaimToken: failedExecutionUpdate.claim_token,
        channelId: failedExecutionChannelId,
        controlChatId: 13,
        requestedBy: 9,
        settingsSnapshot: {
          ...settingsSnapshot,
          channelId: failedExecutionChannelId,
          reviewChatId: 13,
          updatedBy: 9,
        },
      });
      const failedExecutionClaim = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(failedExecutionClaim?.id, failedExecutionJob.id);
      const failedExecutionOutcome = await jobs.retryTelegramNewsJob({
        jobId: failedExecutionJob.id,
        claimToken: failedExecutionClaim!.claim_token,
        errorCode: "news_job_failed",
        maxAttempts: 1,
      });
      assert.equal(failedExecutionOutcome?.status, "outcome_ready");
      assert.equal(failedExecutionOutcome?.outcome_status, "failed");
      assert.equal(failedExecutionOutcome?.error_code, "news_job_failed");
      const failedExecutionDelivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(failedExecutionDelivery?.id, failedExecutionJob.id);
      assert.equal(failedExecutionDelivery?.claim_phase, "deliver");
      assert.equal(failedExecutionDelivery?.outcome_status, "failed");
      assert.equal(
        await jobs.completeTelegramNewsJob({
          jobId: failedExecutionJob.id,
          claimToken: failedExecutionDelivery!.claim_token,
        }),
        true,
      );
      const completedFailure = await pool.query<{
        status: string;
        outcome_status: string;
        error_code: string;
      }>(
        `select status, outcome_status, error_code
         from public.telegram_news_jobs where id = $1`,
        [failedExecutionJob.id],
      );
      assert.deepEqual(completedFailure.rows[0], {
        status: "completed",
        outcome_status: "failed",
        error_code: "news_job_failed",
      });

      const staleExecutionUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[3],
        updateKind: "news_command",
      });
      assert.ok(staleExecutionUpdate.claim_token);
      const staleExecutionJob = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[3],
        updateClaimToken: staleExecutionUpdate.claim_token,
        channelId: staleExecutionChannelId,
        controlChatId: 11,
        requestedBy: 7,
        settingsSnapshot: {
          ...settingsSnapshot,
          channelId: staleExecutionChannelId,
          reviewChatId: 11,
          updatedBy: 7,
        },
      });
      const abandonedExecution = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(abandonedExecution?.id, staleExecutionJob.id);
      await pool.query(
        `update public.telegram_news_jobs
         set claimed_at = now() - interval '31 seconds'
         where id = $1`,
        [staleExecutionJob.id],
      );
      assert.equal(
        await jobs.claimNextTelegramNewsJob({
          claimToken: randomUUID(),
          staleAfterSeconds: 30,
          maxExecutionAttempts: 1,
        }),
        null,
      );
      const staleExecutionState = await pool.query<{
        status: string;
        execution_attempt_count: number;
        error_code: string;
      }>(
        `select status, execution_attempt_count, error_code
         from public.telegram_news_jobs where id = $1`,
        [staleExecutionJob.id],
      );
      assert.deepEqual(staleExecutionState.rows[0], {
        status: "outcome_ready",
        execution_attempt_count: 1,
        error_code: "stale_execution_claim",
      });
      const staleExecutionDelivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(staleExecutionDelivery?.id, staleExecutionJob.id);
      assert.equal(staleExecutionDelivery?.claim_phase, "deliver");
      assert.equal(staleExecutionDelivery?.outcome_status, "failed");
      assert.equal(
        await jobs.completeTelegramNewsJob({
          jobId: staleExecutionJob.id,
          claimToken: staleExecutionDelivery!.claim_token,
        }),
        true,
      );

      const staleDeliveryUpdate = await updates.claimTelegramUpdate({
        updateId: updateIds[4],
        updateKind: "news_command",
      });
      assert.ok(staleDeliveryUpdate.claim_token);
      const staleDeliveryJob = await jobs.enqueueTelegramNewsJob({
        updateId: updateIds[4],
        updateClaimToken: staleDeliveryUpdate.claim_token,
        channelId: staleDeliveryChannelId,
        controlChatId: 12,
        requestedBy: 8,
        settingsSnapshot: {
          ...settingsSnapshot,
          channelId: staleDeliveryChannelId,
          reviewChatId: 12,
          updatedBy: 8,
        },
      });
      const staleDeliveryExecution = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(staleDeliveryExecution?.id, staleDeliveryJob.id);
      await jobs.recordTelegramNewsJobOutcome({
        jobId: staleDeliveryJob.id,
        claimToken: staleDeliveryExecution!.claim_token,
        outcomeStatus: "no_candidates",
      });
      const abandonedDelivery = await jobs.claimNextTelegramNewsJob({
        claimToken: randomUUID(),
      });
      assert.equal(abandonedDelivery?.claim_phase, "deliver");
      await pool.query(
        `update public.telegram_news_jobs
         set claimed_at = now() - interval '31 seconds'
         where id = $1`,
        [staleDeliveryJob.id],
      );
      assert.equal(
        await jobs.claimNextTelegramNewsJob({
          claimToken: randomUUID(),
          staleAfterSeconds: 30,
          maxDeliveryAttempts: 1,
        }),
        null,
      );
      const staleDeliveryState = await pool.query<{
        status: string;
        delivery_attempt_count: number;
        error_code: string;
      }>(
        `select status, delivery_attempt_count, error_code
         from public.telegram_news_jobs where id = $1`,
        [staleDeliveryJob.id],
      );
      assert.deepEqual(staleDeliveryState.rows[0], {
        status: "failed",
        delivery_attempt_count: 1,
        error_code: "stale_delivery_claim",
      });

      const security = await pool.query<{
        rls_enabled: boolean;
        service_select: boolean;
        service_insert: boolean;
        service_update: boolean;
        anon_select: boolean;
      }>(`
        select
          relation.relrowsecurity as rls_enabled,
          has_table_privilege('service_role', 'public.telegram_news_jobs', 'select') as service_select,
          has_table_privilege('service_role', 'public.telegram_news_jobs', 'insert') as service_insert,
          has_table_privilege('service_role', 'public.telegram_news_jobs', 'update') as service_update,
          has_table_privilege('anon', 'public.telegram_news_jobs', 'select') as anon_select
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_namespace as namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'telegram_news_jobs'
      `);
      assert.deepEqual(security.rows[0], {
        rls_enabled: true,
        service_select: true,
        service_insert: true,
        service_update: true,
        anon_select: false,
      });
    } finally {
      await pool.query(
        `delete from public.telegram_news_jobs
         where request_update_id = any($1::bigint[])
         and status = 'suppressed'`,
        [updateIds],
      );
      await pool.query(
        `delete from public.telegram_news_jobs
         where request_update_id = any($1::bigint[])`,
        [updateIds],
      );
      await pool.query(
        `delete from public.telegram_updates where update_id = any($1::bigint[])`,
        [updateIds],
      );
      await pool.end();
    }
  },
);

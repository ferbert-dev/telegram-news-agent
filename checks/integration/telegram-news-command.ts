import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SettingsApplicationModule } from "../../src/settings/settings-application.module.js";
import { RunTelegramNewsUseCase } from "../../src/telegram/application/run-telegram-news.use-case.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";
import { TelegramPersistenceModule } from "../../src/telegram/telegram-persistence.module.js";
import type { TelegramControlRequest } from "../../src/telegram/telegram-application.contracts.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

/**
 * `/news`, from the transport-neutral request down to real PostgreSQL.
 *
 * The two halves of this path were covered and their seam was not. The use
 * case's logic is proven against fake persistence in
 * `checks/application/telegram-control-application.ts`, and the atomic enqueue
 * function is proven in `checks/integration/telegram-persistence.ts` — but
 * nothing ran the real use case against the real function, which is where a
 * mismatch in argument shape, snapshot contents or outcome handling would
 * actually live.
 *
 * It is also the command most likely to be typed at the bot first, so it is
 * the one worth having end-to-end evidence for before any cutover.
 */
test(
  "/news enqueues durably against real PostgreSQL, and a second request is suppressed rather than duplicated",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const updates = new TelegramUpdatesRepository(pool, createDrizzleDatabase(pool));
    const channelId = `@news-command-${randomUUID()}`;
    // Update ids are a global sequence in Telegram; keep this run's ids far from
    // any other check's so a shared database cannot collide.
    const baseUpdateId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

    const moduleRef = await Test.createTestingModule({
      imports: [SettingsApplicationModule, TelegramPersistenceModule],
      providers: [RunTelegramNewsUseCase],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(DRIZZLE_DB)
      .useValue(createDrizzleDatabase(pool))
      .compile();
    await moduleRef.init();

    const request = (updateId: number): TelegramControlRequest => ({
      updateId,
      updateKind: "message",
      channelId,
      actorId: 4242,
      chatId: 987_654,
      chatType: "private",
      route: { kind: "news" },
    });

    try {
      const useCase = moduleRef.get(RunTelegramNewsUseCase);

      // The enqueue function refuses an update it cannot find, so the claim is
      // a real precondition rather than fixture decoration.
      const firstClaim = await updates.claimTelegramUpdate({
        updateId: baseUpdateId,
        updateKind: "message",
      });
      const firstToken = firstClaim.claim_token;
      assert.ok(firstToken, "the update must be claimed before /news can enqueue");

      // Create the settings first and give them a non-empty excluded-topic
      // list. With the default empty list, an implementation that dropped
      // excluded topics from the snapshot would still match -- and excluded
      // topics are a safety control, not a preference, so the assertion has to
      // be able to fail.
      await pool.query("select * from public.get_or_create_news_settings($1, $2, $3)", [
        channelId,
        987_654,
        4242,
      ]);
      await pool.query(
        "update public.news_bot_settings set excluded_topic_codes = $2 where telegram_channel_id = $1",
        [channelId, ["war_conflict"]],
      );

      // First /news, against settings that already exist.
      const first = await useCase.execute(request(baseUpdateId), firstToken);
      assert.equal(first.status, "research_queued");
      assert.equal(first.enqueueOutcome, "queued");
      assert.equal(typeof first.jobId, "string");

      // The row is really there, queued, and carries the settings snapshot the
      // worker will later run from.
      const { rows: queued } = await pool.query(
        "select id, status, telegram_channel_id, settings_snapshot from public.telegram_news_jobs where id = $1",
        [first.jobId],
      );
      assert.equal(queued.length, 1);
      assert.equal(queued[0].status, "queued");
      assert.equal(queued[0].telegram_channel_id, channelId);
      // Asserted on contents, not on being an object: `{}` is an object, and a
      // job queued with an empty snapshot would run later with no channel, no
      // topics and no excluded-topic list -- the last of which is a safety
      // control, not a preference.
      const snapshot = queued[0].settings_snapshot as Record<string, unknown>;
      assert.equal(snapshot.channelId, channelId);
      assert.equal(snapshot.reviewChatId, 987_654);
      assert.equal(typeof snapshot.approvalPolicy, "string");
      assert.ok(Array.isArray(snapshot.topicCodes));
      assert.deepEqual(
        snapshot.excludedTopicCodes,
        ["war_conflict"],
        "the excluded-topic list must reach the queued job, or a blocked topic could be researched",
      );
      assert.equal(
        (snapshot.excludedTopicsProvenance as { source?: string } | undefined)?.source,
        "news_bot_settings",
        "the excluded-topic list must be traceable to the settings it came from",
      );
      assert.equal(typeof snapshot.version, "number");

      // A second /news while the first is still active. A different update, so
      // this is not update-level deduplication doing the work -- it is the
      // job-level guarantee that one channel cannot have two research runs in
      // flight, which is what stops a double spend on the AI providers.
      const secondClaim = await updates.claimTelegramUpdate({
        updateId: baseUpdateId + 1,
        updateKind: "message",
      });
      const secondToken = secondClaim.claim_token;
      assert.ok(secondToken);
      const second = await useCase.execute(request(baseUpdateId + 1), secondToken);

      assert.notEqual(
        second.status,
        "research_queued",
        `a concurrent /news must not queue a second run, got ${JSON.stringify(second)}`,
      );
      assert.notEqual(second.enqueueOutcome, "queued");

      // The real invariant, which this check got wrong on the first attempt and
      // the database corrected: a suppressed request is RECORDED, not dropped.
      // The function inserts a `suppressed` row pointing at the job that is
      // actually running, which is what lets the bot answer "already running"
      // and leaves an audit trail of duplicate requests. What must never happen
      // is a second *active* job.
      const { rows: active } = await pool.query(
        `select id, status, active_job_id from public.telegram_news_jobs
          where telegram_channel_id = $1
            and status in ('queued', 'processing', 'outcome_ready', 'delivering')`,
        [channelId],
      );
      assert.equal(active.length, 1, "a channel may have exactly one job in flight");
      assert.equal(active[0].id, first.jobId);

      const { rows: suppressed } = await pool.query(
        `select id, status, active_job_id, outcome_status from public.telegram_news_jobs
          where telegram_channel_id = $1 and status = 'suppressed'`,
        [channelId],
      );
      assert.equal(suppressed.length, 1);
      assert.equal(
        suppressed[0].active_job_id,
        first.jobId,
        "a suppressed request must point at the run that was already going",
      );
      assert.equal(suppressed[0].outcome_status, "already_running");
    } finally {
      await pool
        .query("delete from public.telegram_news_jobs where telegram_channel_id = $1", [channelId])
        .catch(() => {});
      await pool
        .query("delete from public.news_bot_settings where telegram_channel_id = $1", [channelId])
        .catch(() => {});
      await pool
        .query("delete from public.telegram_updates where update_id = any($1::bigint[])", [
          [baseUpdateId, baseUpdateId + 1],
        ])
        .catch(() => {});
      await moduleRef.close();
      await pool.end().catch(() => undefined);
    }
  },
);

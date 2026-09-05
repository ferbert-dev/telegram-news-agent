import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { withDueScheduleLock } from "./support/scheduler-lock.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SchedulerRepository } from "../../src/database/repositories/scheduler-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

type ScheduleInterval = 60 | 180 | 360 | 720 | 1440;

async function one<Row extends Record<string, unknown>>(
  database: Pool | PoolClient,
  text: string,
  values: unknown[],
): Promise<Row> {
  const result = await database.query<Row>(text, values);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function createDueSettings(
  pool: Pool,
  channelId: string,
  interval: ScheduleInterval,
  dueAt: string,
) {
  const created = await one<{ version: number }>(
    pool,
    "select * from public.get_or_create_news_settings($1, $2, $3)",
    [channelId, 700_000_000_001, 700_000_000_002],
  );
  const updated = await one<{ version: number }>(
    pool,
    "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      channelId,
      700_000_000_001,
      interval,
      "de",
      ["world", "nature"],
      ["Ocean exploration"],
      "automatic",
      false,
      700_000_000_002,
      created.version,
    ],
  );
  await pool.query(
    // excluded_topic_codes is seeded here rather than inherited: the column
    // default is now '{}', so a test asserting that a schedule snapshot
    // carries the channel's exclusions has to establish them first.
    "update public.news_bot_settings set next_run_at = $1, excluded_topic_codes = array['war_conflict']::text[] where telegram_channel_id = $2",
    [dueAt, channelId],
  );
  return updated;
}

async function createDraftFixtures(pool: Pool, suffix: string) {
  const searchRun = await one<{ id: string }>(
    pool,
    `insert into public.search_runs (query, status)
     values ($1, 'completed') returning id`,
    [`scheduler integration ${suffix}`],
  );
  const article = await one<{ id: string }>(
    pool,
    `insert into public.articles
       (search_run_id, canonical_url, title, status)
     values ($1, $2, $3, 'drafted') returning id`,
    [
      searchRun.id,
      `https://scheduler.integration.test/${suffix}`,
      "Scheduler integration article",
    ],
  );
  const draft = await one<{ id: string }>(
    pool,
    `insert into public.drafts (article_id, body, status)
     values ($1, $2, 'review') returning id`,
    [article.id, "Scheduler integration draft"],
  );
  const otherSearchRun = await one<{ id: string }>(
    pool,
    `insert into public.search_runs (query, status)
     values ($1, 'completed') returning id`,
    [`scheduler integration other ${suffix}`],
  );
  const otherArticle = await one<{ id: string }>(
    pool,
    `insert into public.articles
       (search_run_id, canonical_url, title, status)
     values ($1, $2, $3, 'drafted') returning id`,
    [
      otherSearchRun.id,
      `https://scheduler.integration.test/other-${suffix}`,
      "Other scheduler integration article",
    ],
  );
  const otherDraft = await one<{ id: string }>(
    pool,
    `insert into public.drafts (article_id, body, status)
     values ($1, $2, 'review') returning id`,
    [otherArticle.id, "Other scheduler integration draft"],
  );
  return {
    searchRunIds: [searchRun.id, otherSearchRun.id],
    articleIds: [article.id, otherArticle.id],
    draftIds: [draft.id, otherDraft.id],
    draftId: draft.id,
    otherDraftId: otherDraft.id,
  };
}

test(
  "Scheduler persistence preserves claims, checkpoints, recurrence, unresolved pause, and Madrid DST boundaries",
  { skip: !enabled || !connectionString },
  async () => {
    // Serialized against every other test that parks a row as due: the claim
    // function is global, so two such files steal each other's row.
    await withDueScheduleLock(connectionString as string, async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const repository = new SchedulerRepository(
      pool,
      createDrizzleDatabase(pool),
    );
    const suffix = randomUUID();
    const channelIds: string[] = [];
    const searchRunIds: string[] = [];
    const articleIds: string[] = [];
    const draftIds: string[] = [];
    let lockClient: PoolClient | null = null;

    try {
      const channelId = `@scheduler-${suffix}`;
      channelIds.push(channelId);
      await createDueSettings(pool, channelId, 60, "1900-01-01T00:00:00Z");
      const fixtures = await createDraftFixtures(pool, suffix);
      searchRunIds.push(...fixtures.searchRunIds);
      articleIds.push(...fixtures.articleIds);
      draftIds.push(...fixtures.draftIds);

      await assert.rejects(
        repository.claimDueNewsSchedule({
          claimToken: randomUUID(),
          staleAfterSeconds: 29,
        }),
        /Claim due news schedule failed: Schedule stale threshold must be between 30 and 3600 seconds/,
      );

      lockClient = await pool.connect();
      await lockClient.query("begin");
      await lockClient.query(
        "select telegram_channel_id from public.news_bot_settings where telegram_channel_id = $1 for update",
        [channelId],
      );
      assert.equal(
        await repository.claimDueNewsSchedule({
          claimToken: randomUUID(),
          staleAfterSeconds: 30,
        }),
        null,
        "a locked due row must be skipped rather than double-claimed",
      );
      await lockClient.query("rollback");
      lockClient.release();
      lockClient = null;

      const firstToken = randomUUID();
      const competingToken = randomUUID();
      const concurrentClaims = await Promise.all([
        repository.claimDueNewsSchedule({
          claimToken: firstToken,
          staleAfterSeconds: 30,
        }),
        repository.claimDueNewsSchedule({
          claimToken: competingToken,
          staleAfterSeconds: 30,
        }),
      ]);
      const claimed = concurrentClaims.filter((row) => row !== null);
      assert.equal(claimed.length, 1);
      const initialClaim = claimed[0];
      assert.ok(initialClaim);
      const winningToken = initialClaim.schedule_claim_token as string;
      assert.ok(new Set<string>([firstToken, competingToken]).has(winningToken));
      assert.equal(initialClaim.schedule_settings_snapshot?.languageCode, "de");
      assert.deepEqual(
        initialClaim.schedule_settings_snapshot?.excludedTopicCodes,
        ["war_conflict"],
      );
      assert.deepEqual(
        initialClaim.schedule_settings_snapshot?.excludedTopicsProvenance,
        {
          source: "news_bot_settings",
          settingsVersion: initialClaim.version,
        },
      );
      await one(
        pool,
        "select * from public.update_news_excluded_topics($1, $2, $3, $4)",
        [channelId, [], 700_000_000_002, initialClaim.version],
      );

      const draftCheckpoint = {
        channelId,
        claimToken: winningToken,
        draftId: fixtures.draftId,
        preview: "Durable scheduled preview",
        windowHours: 48,
      };
      assert.equal(
        await repository.saveNewsScheduleDraft(draftCheckpoint),
        true,
      );
      assert.equal(
        await repository.saveNewsScheduleDraft(draftCheckpoint),
        true,
        "saving the same draft checkpoint must be idempotent",
      );
      assert.equal(
        await repository.saveNewsScheduleDraft({
          ...draftCheckpoint,
          draftId: fixtures.otherDraftId,
        }),
        false,
        "a different draft must not replace the durable checkpoint",
      );

      const publicationCheckpoint = {
        channelId,
        claimToken: winningToken,
        draftId: fixtures.draftId,
        publicationMessageId: 700_000_000_004,
      };
      assert.equal(
        await repository.saveNewsSchedulePublication(publicationCheckpoint),
        true,
      );
      assert.equal(
        await repository.saveNewsSchedulePublication(publicationCheckpoint),
        true,
        "saving the same publication receipt must be idempotent",
      );
      assert.equal(
        await repository.saveNewsSchedulePublication({
          ...publicationCheckpoint,
          draftId: fixtures.otherDraftId,
        }),
        false,
      );

      await pool.query(
        `update public.news_bot_settings
         set schedule_claimed_at = now() - interval '31 seconds'
         where telegram_channel_id = $1`,
        [channelId],
      );
      const recoveryToken = randomUUID();
      const recovered = await repository.claimDueNewsSchedule({
        claimToken: recoveryToken,
        staleAfterSeconds: 30,
      });
      assert.ok(recovered);
      assert.equal(recovered.schedule_run_id, initialClaim.schedule_run_id);
      assert.equal(recovered.schedule_draft_id, fixtures.draftId);
      assert.equal(
        recovered.schedule_publication_message_id,
        publicationCheckpoint.publicationMessageId,
      );
      assert.deepEqual(
        recovered.schedule_settings_snapshot,
        initialClaim.schedule_settings_snapshot,
      );
      assert.deepEqual(recovered.excluded_topic_codes, []);
      assert.equal(
        await repository.renewNewsScheduleClaim({
          channelId,
          claimToken: winningToken,
        }),
        false,
      );
      assert.equal(
        await repository.renewNewsScheduleClaim({
          channelId,
          claimToken: recoveryToken,
        }),
        true,
      );

      const changedSettings = await one<{ version: number }>(
        pool,
        "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [
          channelId,
          700_000_000_001,
          180,
          "uk",
          ["history"],
          [],
          "automatic",
          false,
          700_000_000_002,
          recovered.version,
        ],
      );
      assert.equal(changedSettings.version, recovered.version + 1);
      const beforeFinish = await one<{ now: Date }>(
        pool,
        "select clock_timestamp() as now",
        [],
      );
      assert.equal(
        await repository.finishNewsSchedule({
          channelId,
          claimToken: winningToken,
          status: "published",
        }),
        false,
      );
      assert.equal(
        await repository.finishNewsSchedule({
          channelId,
          claimToken: recoveryToken,
          status: "published",
        }),
        true,
      );
      const finished = await one<{
        next_run_at: Date;
        schedule_claim_token: string | null;
        schedule_run_id: string | null;
        schedule_draft_id: string | null;
        schedule_publication_message_id: string | null;
      }>(
        pool,
        "select * from public.get_news_settings($1)",
        [channelId],
      );
      const recurrenceMs =
        new Date(finished.next_run_at).getTime() -
        new Date(beforeFinish.now).getTime();
      assert.ok(
        recurrenceMs >= 180 * 60_000 && recurrenceMs < 180 * 60_000 + 5_000,
        "finish must use the current 3-hour settings, not the 1-hour snapshot",
      );
      assert.equal(finished.schedule_claim_token, null);
      assert.equal(finished.schedule_run_id, null);
      assert.equal(finished.schedule_draft_id, null);
      assert.equal(finished.schedule_publication_message_id, null);

      const intervals: ScheduleInterval[] = [
        60,
        180,
        360,
        720,
        1440,
      ];
      for (const [index, interval] of intervals.entries()) {
        const intervalChannel = `@scheduler-${interval}-${suffix}`;
        channelIds.push(intervalChannel);
        await createDueSettings(
          pool,
          intervalChannel,
          interval,
          `18${index}0-01-01T00:00:00Z`,
        );
        const token = randomUUID();
        const intervalClaim = await repository.claimDueNewsSchedule({
          claimToken: token,
          staleAfterSeconds: 30,
        });
        assert.equal(intervalClaim?.telegram_channel_id, intervalChannel);
        const started = await one<{ now: Date }>(
          pool,
          "select clock_timestamp() as now",
          [],
        );
        assert.equal(
          await repository.finishNewsSchedule({
            channelId: intervalChannel,
            claimToken: token,
            status: "completed",
          }),
          true,
        );
        const intervalState = await one<{ next_run_at: Date }>(
          pool,
          "select * from public.get_news_settings($1)",
          [intervalChannel],
        );
        const intervalMs =
          new Date(intervalState.next_run_at).getTime() -
          new Date(started.now).getTime();
        assert.ok(
          intervalMs >= interval * 60_000 &&
            intervalMs < interval * 60_000 + 5_000,
          `expected ${interval}-minute recurrence`,
        );
      }

      const unresolvedChannel = `@scheduler-unresolved-${suffix}`;
      channelIds.push(unresolvedChannel);
      const unresolvedSettings = await createDueSettings(
        pool,
        unresolvedChannel,
        60,
        "1700-01-01T00:00:00Z",
      );
      const unresolvedToken = randomUUID();
      const unresolvedClaim = await repository.claimDueNewsSchedule({
        claimToken: unresolvedToken,
        staleAfterSeconds: 30,
      });
      assert.ok(unresolvedClaim);
      assert.equal(
        await repository.saveNewsScheduleDraft({
          channelId: unresolvedChannel,
          claimToken: unresolvedToken,
          draftId: fixtures.draftId,
          preview: "Unresolved durable preview",
          windowHours: 48,
        }),
        true,
      );
      assert.equal(
        await repository.pauseNewsScheduleUnresolved({
          channelId: unresolvedChannel,
          claimToken: unresolvedToken,
          errorCode: "publication_unresolved",
        }),
        true,
      );
      const paused = await one<{
        schedule_interval_minutes: number | null;
        next_run_at: Date | null;
        schedule_claim_token: string | null;
        schedule_run_id: string | null;
        schedule_draft_id: string | null;
        last_run_status: string;
        last_error_code: string;
        version: number;
      }>(pool, "select * from public.get_news_settings($1)", [unresolvedChannel]);
      assert.equal(paused.schedule_interval_minutes, null);
      assert.equal(paused.next_run_at, null);
      assert.equal(paused.schedule_claim_token, null);
      assert.equal(paused.schedule_run_id, unresolvedClaim.schedule_run_id);
      assert.equal(paused.schedule_draft_id, fixtures.draftId);
      assert.equal(paused.last_run_status, "publication_unresolved");
      assert.equal(paused.last_error_code, "publication_unresolved");
      assert.equal(paused.version, unresolvedSettings.version + 1);
      assert.equal(
        await repository.finishNewsSchedule({
          channelId: unresolvedChannel,
          claimToken: unresolvedToken,
          status: "failed",
        }),
        false,
      );

      const bounds = await one<{
        spring_next: Date;
        autumn_next: Date;
        start_is_quiet: boolean;
        end_is_quiet: boolean;
      }>(
        pool,
        `select
           public.next_allowed_news_schedule_at(
             '2026-03-29T00:30:00Z'::timestamptz, true
           ) as spring_next,
           public.next_allowed_news_schedule_at(
             '2026-10-25T00:30:00Z'::timestamptz, true
           ) as autumn_next,
           public.is_news_quiet_hours(
             '2026-08-07T20:00:00Z'::timestamptz
           ) as start_is_quiet,
           public.is_news_quiet_hours(
             '2026-08-08T06:00:00Z'::timestamptz
           ) as end_is_quiet`,
        [],
      );
      assert.equal(
        new Date(bounds.spring_next).toISOString(),
        "2026-03-29T06:00:00.000Z",
      );
      assert.equal(
        new Date(bounds.autumn_next).toISOString(),
        "2026-10-25T07:00:00.000Z",
      );
      assert.equal(bounds.start_is_quiet, true);
      assert.equal(bounds.end_is_quiet, false);

      const quietChannel = `@scheduler-quiet-${suffix}`;
      channelIds.push(quietChannel);
      await createDueSettings(
        pool,
        quietChannel,
        60,
        "1600-01-01T00:00:00Z",
      );
      const quietToken = randomUUID();
      const quietClaim = await repository.claimDueNewsSchedule({
        claimToken: quietToken,
        staleAfterSeconds: 30,
      });
      assert.ok(quietClaim);
      assert.equal(
        await repository.saveNewsScheduleDraft({
          channelId: quietChannel,
          claimToken: quietToken,
          draftId: fixtures.draftId,
          preview: "Quiet-hours durable preview",
          windowHours: 48,
        }),
        true,
      );
      await pool.query(
        "update public.news_bot_settings set quiet_hours_enabled = true where telegram_channel_id = $1",
        [quietChannel],
      );
      const quietNow = await one<{ value: boolean }>(
        pool,
        "select public.is_news_quiet_hours(now()) as value",
        [],
      );
      const deferred = await repository.deferNewsScheduleForQuietHours({
        channelId: quietChannel,
        claimToken: quietToken,
      });
      assert.equal(deferred, quietNow.value);
      if (deferred) {
        const deferredState = await one<{
          schedule_claim_token: string | null;
          schedule_run_id: string;
          schedule_draft_id: string;
        }>(pool, "select * from public.get_news_settings($1)", [quietChannel]);
        assert.equal(deferredState.schedule_claim_token, null);
        assert.equal(deferredState.schedule_run_id, quietClaim.schedule_run_id);
        assert.equal(deferredState.schedule_draft_id, fixtures.draftId);
        await pool.query(
          `update public.news_bot_settings
           set quiet_hours_enabled = false,
               next_run_at = '1500-01-01T00:00:00Z'::timestamptz
           where telegram_channel_id = $1`,
          [quietChannel],
        );
        const morningToken = randomUUID();
        const resumed = await repository.claimDueNewsSchedule({
          claimToken: morningToken,
          staleAfterSeconds: 30,
        });
        assert.equal(resumed?.schedule_run_id, quietClaim.schedule_run_id);
        assert.equal(resumed?.schedule_draft_id, fixtures.draftId);
        assert.equal(
          await repository.finishNewsSchedule({
            channelId: quietChannel,
            claimToken: morningToken,
            status: "published",
          }),
          true,
        );
      } else {
        assert.equal(
          await repository.finishNewsSchedule({
            channelId: quietChannel,
            claimToken: quietToken,
            status: "published",
          }),
          true,
        );
      }
    } finally {
      if (lockClient) {
        await lockClient.query("rollback").catch(() => {});
        lockClient.release();
      }
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = any($1::text[])",
          [channelIds],
        )
        .catch(() => {});
      await pool
        .query("delete from public.drafts where id = any($1::uuid[])", [
          draftIds,
        ])
        .catch(() => {});
      await pool
        .query("delete from public.articles where id = any($1::uuid[])", [
          articleIds,
        ])
        .catch(() => {});
      await pool
        .query("delete from public.search_runs where id = any($1::uuid[])", [
          searchRunIds,
        ])
        .catch(() => {});
      await pool.end();
    }
    });
  },
);

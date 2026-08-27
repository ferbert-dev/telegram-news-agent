import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EditorialRepository } from "../../src/database/repositories/editorial-repository.js";
import { SchedulerRepository } from "../../src/database/repositories/scheduler-repository.js";
import { NewsSchedulerWorker } from "../../src/scheduler/news-scheduler-worker.js";
import { RunScheduledNewsOnceUseCase } from "../../src/scheduler/application/run-scheduled-news-once.use-case.js";
import { SchedulerService } from "../../src/scheduler/application/scheduler.service.js";
import type {
  SchedulerNewsWorkflowInput,
  SchedulerNewsWorkflowResult,
  SchedulerRunResult,
} from "../../src/scheduler/scheduler-application.contracts.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

const REVIEW_CHAT_ID = 700_000_100_001;
const UPDATED_BY = 700_000_100_002;

async function one<Row extends Record<string, unknown>>(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<Row> {
  const result = await pool.query<Row>(text, values);
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function createDueChannel(
  pool: Pool,
  channelId: string,
  options: { quietHours: boolean; dueAt: string },
): Promise<void> {
  const created = await one<{ version: number }>(
    pool,
    "select * from public.get_or_create_news_settings($1, $2, $3)",
    [channelId, REVIEW_CHAT_ID, UPDATED_BY],
  );
  await one(
    pool,
    "select * from public.update_news_settings($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      channelId,
      REVIEW_CHAT_ID,
      60,
      "en",
      ["world"],
      [],
      "manual",
      options.quietHours,
      UPDATED_BY,
      created.version,
    ],
  );
  await pool.query(
    "update public.news_bot_settings set next_run_at = $1 where telegram_channel_id = $2",
    [options.dueAt, channelId],
  );
}

async function createDraft(pool: Pool, suffix: string): Promise<string> {
  const searchRun = await one<{ id: string }>(
    pool,
    "insert into public.search_runs (query, status) values ($1, 'completed') returning id",
    [`worker recovery ${suffix}`],
  );
  const article = await one<{ id: string }>(
    pool,
    `insert into public.articles (search_run_id, canonical_url, title, status)
     values ($1, $2, $3, 'drafted') returning id`,
    [
      searchRun.id,
      `https://worker.recovery.test/${suffix}`,
      "Worker recovery article",
    ],
  );
  const draft = await one<{ id: string }>(
    pool,
    "insert into public.drafts (article_id, body, status) values ($1, $2, 'review') returning id",
    [article.id, "Worker recovery draft"],
  );
  return draft.id;
}

/** Simulates a crashed process: the claim ages out so it can be re-claimed. */
async function expireClaim(pool: Pool, channelId: string): Promise<void> {
  await pool.query(
    `update public.news_bot_settings
        set schedule_claimed_at = now() - interval '2 hours'
      where telegram_channel_id = $1`,
    [channelId],
  );
}

function buildWorker(
  pool: Pool,
  gateways: {
    newsWorkflow: (input: SchedulerNewsWorkflowInput) => Promise<SchedulerNewsWorkflowResult>;
    deliver: () => Promise<{ status: "review_ready" }>;
    now: () => Date;
  },
) {
  const database = createDrizzleDatabase(pool);
  const scheduler = new SchedulerRepository(pool, database);
  const editorial = new EditorialRepository(pool, database);
  const results: SchedulerRunResult[] = [];

  const useCase = new RunScheduledNewsOnceUseCase(
    scheduler,
    { hasPendingTelegramReview: async () => false } as never,
    editorial as never,
    { run: gateways.newsWorkflow } as never,
    {} as never,
    {
      acquire: async () => true,
      renew: async () => true,
      release: async () => true,
    } as never,
    { deliver: gateways.deliver } as never,
    { run: async (_context: unknown, operation: () => Promise<unknown>) => operation() } as never,
    { notify: async () => {} } as never,
    { next: () => randomUUID() } as never,
    { now: gateways.now } as never,
    {
      setInterval: () => 0 as never,
      clearInterval: () => {},
    } as never,
  );

  const service = new SchedulerService(useCase);

  // start() resolves as soon as the loop is running, deliberately not when the
  // first occurrence finishes. Tests must await the occurrence itself or stop()
  // would abort it mid-flight.
  let settleFirst!: (error?: unknown) => void;
  const firstOccurrence = new Promise<void>((resolve, reject) => {
    settleFirst = (error) => (error === undefined ? resolve() : reject(error));
  });

  const worker = new NewsSchedulerWorker({
    scheduler: {
      runOnce: async (input) => {
        try {
          const result = await service.runOnce(input);
          results.push(result);
          settleFirst();
          return result;
        } catch (error) {
          settleFirst(error);
          throw error;
        }
      },
    },
    sleepImpl: async () => undefined,
    log: {},
  });
  return { worker, results, firstOccurrence };
}

test(
  "worker resumes a checkpointed draft after a crash instead of repeating research",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const suffix = randomUUID();
    const channelId = `@worker-recovery-${suffix}`;
    try {
      await createDueChannel(pool, channelId, {
        quietHours: false,
        dueAt: "1900-01-01T00:00:00Z",
      });
      const draftId = await createDraft(pool, suffix);

      let researchCalls = 0;

      // Cycle 1: research succeeds and is checkpointed, then delivery fails —
      // the exact window the durable checkpoint exists to protect.
      const first = buildWorker(pool, {
        newsWorkflow: async () => {
          researchCalls += 1;
          return {
            status: "review_ready",
            draftId,
            preview: "Worker recovery preview",
            windowHours: 6,
          };
        },
        deliver: async () => {
          throw new Error("telegram unavailable");
        },
        now: () => new Date("2026-03-10T12:00:00Z"),
      });
      const host1 = new AbortController();
      await first.worker.start(host1.signal);
      await first.firstOccurrence;
      await first.worker.stop();

      assert.equal(researchCalls, 1, "cycle 1 must perform research once");
      const checkpointed = await one<{
        schedule_draft_id: string | null;
        schedule_preview: string | null;
        schedule_window_hours: number | null;
      }>(
        pool,
        `select schedule_draft_id, schedule_preview, schedule_window_hours
           from public.news_bot_settings where telegram_channel_id = $1`,
        [channelId],
      );
      assert.equal(
        checkpointed.schedule_draft_id,
        draftId,
        "the draft must be durably checkpointed before delivery",
      );
      assert.equal(checkpointed.schedule_window_hours, 6);

      // Cycle 2: the process restarts and re-claims the aged-out occurrence.
      await expireClaim(pool, channelId);
      const second = buildWorker(pool, {
        newsWorkflow: async () => {
          researchCalls += 1;
          return { status: "no_candidates" };
        },
        deliver: async () => ({ status: "review_ready" }),
        now: () => new Date("2026-03-10T12:05:00Z"),
      });
      const host2 = new AbortController();
      await second.worker.start(host2.signal);
      await second.firstOccurrence;
      await second.worker.stop();

      assert.equal(
        researchCalls,
        1,
        "recovery must resume the checkpoint, never repeat paid research",
      );
      assert.equal(
        second.results[0]?.status,
        "awaiting_approval",
        "the resumed occurrence must reach review delivery",
      );
      assert.equal(second.results[0]?.draftId, draftId);

      // The completed occurrence must release its claim and advance recurrence,
      // so a restarted worker does not re-run the same occurrence forever.
      const settled = await one<{
        schedule_claim_token: string | null;
        schedule_draft_id: string | null;
        next_run_at: Date | null;
      }>(
        pool,
        `select schedule_claim_token, schedule_draft_id, next_run_at
           from public.news_bot_settings where telegram_channel_id = $1`,
        [channelId],
      );
      assert.equal(
        settled.schedule_claim_token,
        null,
        "a finished occurrence must release its claim token",
      );
      assert.equal(
        settled.schedule_draft_id,
        null,
        "the checkpoint must be cleared once the occurrence completes",
      );
      assert.ok(settled.next_run_at, "recurrence must be rescheduled");
      assert.ok(
        settled.next_run_at.valueOf() > Date.parse("2026-01-01T00:00:00Z"),
        "next_run_at must advance past the original 1900 due date",
      );
    } finally {
      await pool.query(
        "delete from public.news_bot_settings where telegram_channel_id = $1",
        [channelId],
      );
      await pool.end();
    }
  },
);

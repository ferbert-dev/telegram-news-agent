import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { UsageReportingRepository } from "../../src/database/repositories/usage-reporting-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Usage persistence preserves response idempotency, null IDs, and Madrid DST half-open reporting bounds",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 4 });
    const repository = new UsageReportingRepository(
      pool,
      createDrizzleDatabase(pool),
    );
    const suffix = randomUUID();
    const channelId = `@usage-${suffix}`;
    const responseId = `resp-${suffix}`;
    let searchRunId: string | null = null;
    let articleId: string | null = null;
    let draftId: string | null = null;
    let publicationId: string | null = null;

    try {
      const searchRun = await pool.query<{ id: string }>(
        `insert into public.search_runs (query, status)
         values ($1, 'completed') returning id`,
        [`usage integration ${suffix}`],
      );
      searchRunId = searchRun.rows[0].id;
      const article = await pool.query<{ id: string }>(
        `insert into public.articles
          (search_run_id, canonical_url, title, status)
         values ($1, $2, $3, 'published') returning id`,
        [
          searchRunId,
          `https://usage.integration.test/${suffix}`,
          "Usage integration article",
        ],
      );
      articleId = article.rows[0].id;
      const draft = await pool.query<{ id: string }>(
        `insert into public.drafts (article_id, body, status)
         values ($1, $2, 'published') returning id`,
        [articleId, "Usage integration draft"],
      );
      draftId = draft.rows[0].id;
      const publication = await pool.query<{ id: string }>(
        `insert into public.published_posts
          (draft_id, article_id, telegram_channel_id, telegram_message_id,
           published_at, message_text, metadata)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          draftId,
          articleId,
          channelId,
          700_000_000_001,
          "2026-03-29T00:30:00.000Z",
          "Usage integration publication",
          { editor: { name: "Mikhail Onest" } },
        ],
      );
      publicationId = publication.rows[0].id;

      const first = await repository.recordAiUsage({
        provider: "openai",
        providerResponseId: responseId,
        model: "gpt-5.4-2026-03-05",
        operation: "news_search",
        telegramChannelId: channelId,
        searchRunId,
        articleId,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        webSearchCalls: 1,
        estimatedCostUsd: "0.01052750",
        pricingSnapshot: { tier: "standard" },
      });
      const duplicate = await repository.recordAiUsage({
        provider: "openai",
        providerResponseId: responseId,
        model: "must-not-overwrite",
        operation: "duplicate_retry",
      });
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.model, first.model);
      assert.equal(duplicate.input_tokens, 100);

      const nullResponseA = await repository.recordAiUsage({
        provider: "gemini",
        model: "gemini-2.5-flash",
        operation: "draft_generation",
        telegramChannelId: channelId,
        inputTokens: 25,
      });
      const nullResponseB = await repository.recordAiUsage({
        provider: "gemini",
        model: "gemini-2.5-flash",
        operation: "draft_generation",
        telegramChannelId: channelId,
        inputTokens: 25,
      });
      assert.equal(nullResponseA.provider_response_id, null);
      assert.equal(nullResponseB.provider_response_id, null);
      assert.notEqual(nullResponseA.id, nullResponseB.id);

      await pool.query(
        `update public.ai_usage_events
         set created_at = case
           when id = $1 then '2026-03-28T23:00:00.000Z'::timestamptz
           when id = $2 then '2026-03-29T22:00:00.000Z'::timestamptz
           else '2026-03-29T12:00:00.000Z'::timestamptz
         end
         where id = any($3::uuid[])`,
        [
          first.id,
          nullResponseB.id,
          [first.id, nullResponseA.id, nullResponseB.id],
        ],
      );

      const dashboard = await repository.getDailyUsageDashboard({
        channelId,
        now: "2026-03-29T12:00:00.000Z",
        timeZone: "Europe/Madrid",
      });
      assert.equal(dashboard.summary.period_start, "2026-03-28T23:00:00.000Z");
      assert.equal(dashboard.summary.period_end, "2026-03-29T22:00:00.000Z");
      assert.equal(dashboard.summary.request_count, 2);
      assert.equal(dashboard.summary.input_tokens, 125);
      assert.equal(dashboard.summary.published_post_count, 1);
      assert.equal(dashboard.summary.estimated_cost_usd, "0.01052750");
      assert.equal(dashboard.posts.length, 1);
      assert.equal(dashboard.posts[0].telegram_message_id, 700_000_000_001);
      assert.equal(dashboard.posts[0].editor_name, "Mikhail Onest");
      assert.equal(dashboard.posts[0].usage_request_count, 1);
      assert.equal(dashboard.posts[0].estimated_cost_usd, "0.01052750");
    } finally {
      await pool
        .query("delete from public.ai_usage_events where telegram_channel_id = $1", [
          channelId,
        ])
        .catch(() => {});
      if (publicationId) {
        await pool
          .query("delete from public.published_posts where id = $1", [publicationId])
          .catch(() => {});
      }
      if (draftId) {
        await pool
          .query("delete from public.drafts where id = $1", [draftId])
          .catch(() => {});
      }
      if (articleId) {
        await pool
          .query("delete from public.articles where id = $1", [articleId])
          .catch(() => {});
      }
      if (searchRunId) {
        await pool
          .query("delete from public.search_runs where id = $1", [searchRunId])
          .catch(() => {});
      }
      await pool.end();
    }
  },
);

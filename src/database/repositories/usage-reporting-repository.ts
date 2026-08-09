import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";

import type {
  DailyUsageDashboard,
  GetDailyUsageDashboardInput,
  RecordAiUsageInput,
  UsageReportingPersistence,
} from "../../usage/usage-persistence.contracts.js";
import {
  mapAiUsageEventRow,
  mapDailyPublicationCostRow,
  mapDailyUsageSummaryRow,
  type AiUsageEventDatabaseRow,
  type DailyPublicationCostDatabaseRow,
  type DailyUsageSummaryDatabaseRow,
} from "../../usage/usage-row-mappers.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { drafts, publishedPosts } from "../schema/editorial.js";
import { aiUsageEvents, articles } from "../schema/research.js";
import { RepositorySupport, toIsoTimestamp } from "./repository-support.js";

const usageEventSelection = {
  id: aiUsageEvents.id,
  provider: aiUsageEvents.provider,
  provider_response_id: aiUsageEvents.providerResponseId,
  model: aiUsageEvents.model,
  operation: aiUsageEvents.operation,
  telegram_channel_id: aiUsageEvents.telegramChannelId,
  search_run_id: aiUsageEvents.searchRunId,
  article_id: aiUsageEvents.articleId,
  input_tokens: aiUsageEvents.inputTokens,
  cached_input_tokens: aiUsageEvents.cachedInputTokens,
  output_tokens: aiUsageEvents.outputTokens,
  reasoning_tokens: aiUsageEvents.reasoningTokens,
  web_search_calls: aiUsageEvents.webSearchCalls,
  estimated_cost_usd: aiUsageEvents.estimatedCostUsd,
  pricing_snapshot: aiUsageEvents.pricingSnapshot,
  created_at: aiUsageEvents.createdAt,
};

function safePostLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Daily usage post limit must be a positive safe integer");
  }
  return value;
}

@Injectable()
export class UsageReportingRepository
  extends RepositorySupport
  implements UsageReportingPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async recordAiUsage({
    provider,
    providerResponseId = null,
    model,
    operation,
    telegramChannelId = null,
    searchRunId = null,
    articleId = null,
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    webSearchCalls = 0,
    estimatedCostUsd = null,
    pricingSnapshot = null,
  }: RecordAiUsageInput) {
    const rows = await this.operation("Record AI usage", () =>
      this.database
        .insert(aiUsageEvents)
        .values({
          provider,
          providerResponseId,
          model,
          operation,
          telegramChannelId,
          searchRunId,
          articleId,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          reasoningTokens,
          webSearchCalls,
          estimatedCostUsd:
            estimatedCostUsd === null ? null : String(estimatedCostUsd),
          pricingSnapshot,
        })
        .onConflictDoUpdate({
          target: [aiUsageEvents.provider, aiUsageEvents.providerResponseId],
          set: { providerResponseId: sql`excluded.provider_response_id` },
        })
        .returning(usageEventSelection),
    );
    return mapAiUsageEventRow(
      this.one(rows, "Record AI usage") as AiUsageEventDatabaseRow,
    );
  }

  async getDailyUsageDashboard({
    channelId,
    now = new Date().toISOString(),
    timeZone = "Europe/Madrid",
    postLimit = 5,
  }: GetDailyUsageDashboardInput): Promise<DailyUsageDashboard> {
    const currentTime = toIsoTimestamp(now);
    const limit = safePostLimit(postLimit);
    const summaryResult = await this.operation(
      "Get daily AI usage summary",
      () =>
        this.database.execute(sql<DailyUsageSummaryDatabaseRow>`
          with bounds as (
            select
              date_trunc('day', ${currentTime}::timestamptz at time zone ${timeZone}) at time zone ${timeZone} as period_start,
              (date_trunc('day', ${currentTime}::timestamptz at time zone ${timeZone}) + interval '1 day') at time zone ${timeZone} as period_end
          ),
          usage_summary as (
            select
              bounds.period_start,
              bounds.period_end,
              count(u.id)::bigint as request_count,
              coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
              coalesce(sum(u.cached_input_tokens), 0)::bigint as cached_input_tokens,
              coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
              coalesce(sum(u.reasoning_tokens), 0)::bigint as reasoning_tokens,
              coalesce(sum(u.web_search_calls), 0)::bigint as web_search_calls,
              count(u.estimated_cost_usd)::bigint as priced_request_count,
              coalesce(sum(u.estimated_cost_usd), 0)::numeric(16, 8) as estimated_cost_usd,
              min(u.created_at) as tracking_started_at
            from bounds
            left join ${aiUsageEvents} u
              on u.telegram_channel_id = ${channelId}
             and u.created_at >= bounds.period_start
             and u.created_at < bounds.period_end
            group by bounds.period_start, bounds.period_end
          )
          select
            usage_summary.*,
            (
              select count(*)::bigint
              from ${publishedPosts} p
              where p.telegram_channel_id = ${channelId}
                and p.published_at >= usage_summary.period_start
                and p.published_at < usage_summary.period_end
            ) as published_post_count
          from usage_summary
        `),
    );
    const postsResult = await this.operation(
      "Get daily publication cost summary",
      () =>
        this.database.execute(sql<DailyPublicationCostDatabaseRow>`
          with bounds as (
            select
              date_trunc('day', ${currentTime}::timestamptz at time zone ${timeZone}) at time zone ${timeZone} as period_start,
              (date_trunc('day', ${currentTime}::timestamptz at time zone ${timeZone}) + interval '1 day') at time zone ${timeZone} as period_end
          )
          select
            p.telegram_message_id,
            p.published_at,
            coalesce(p.metadata #>> '{editor,name}', 'Unknown editor') as editor_name,
            count(u.id)::bigint as usage_request_count,
            coalesce(sum(u.estimated_cost_usd), 0)::numeric(16, 8) as estimated_cost_usd
          from bounds
          join ${publishedPosts} p
            on p.telegram_channel_id = ${channelId}
           and p.published_at >= bounds.period_start
           and p.published_at < bounds.period_end
          join ${drafts} d on d.id = p.draft_id
          join ${articles} a on a.id = d.article_id
          left join ${aiUsageEvents} u
            on u.telegram_channel_id = p.telegram_channel_id
           and (u.article_id = a.id or u.search_run_id = a.search_run_id)
          group by p.telegram_message_id, p.published_at, editor_name
          order by p.published_at desc
          limit ${limit}
        `),
    );

    return {
      summary: mapDailyUsageSummaryRow(
        this.one(
          summaryResult.rows,
          "Get daily AI usage summary",
        ) as DailyUsageSummaryDatabaseRow,
      ),
      posts: postsResult.rows.map((row) =>
        mapDailyPublicationCostRow(
          row as DailyPublicationCostDatabaseRow,
        ),
      ),
    };
  }
}

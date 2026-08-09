import type { JsonObject } from "../database/schema/common.js";

export type AiUsageEventRow = {
  id: string;
  provider: string;
  provider_response_id: string | null;
  model: string;
  operation: string;
  telegram_channel_id: string | null;
  search_run_id: string | null;
  article_id: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  web_search_calls: number;
  estimated_cost_usd: string | null;
  pricing_snapshot: JsonObject | null;
  created_at: string;
};

export type RecordAiUsageInput = {
  provider: string;
  providerResponseId?: string | null;
  model: string;
  operation: string;
  telegramChannelId?: string | null;
  searchRunId?: string | null;
  articleId?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  webSearchCalls?: number;
  estimatedCostUsd?: number | string | null;
  pricingSnapshot?: JsonObject | null;
};

export type DailyUsageSummaryRow = {
  period_start: string;
  period_end: string;
  request_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  web_search_calls: number;
  priced_request_count: number;
  estimated_cost_usd: string;
  tracking_started_at: string | null;
  published_post_count: number;
};

export type DailyPublicationCostRow = {
  telegram_message_id: number;
  published_at: string;
  editor_name: string;
  usage_request_count: number;
  estimated_cost_usd: string;
};

export type DailyUsageDashboard = {
  summary: DailyUsageSummaryRow;
  posts: DailyPublicationCostRow[];
};

export type GetDailyUsageDashboardInput = {
  channelId: string;
  now?: string | Date;
  timeZone?: string;
  postLimit?: number;
};

/**
 * Usage persistence boundary. Provider-response idempotency remains a single
 * PostgreSQL upsert. Dashboard summary and per-post reporting intentionally
 * remain two queries that share the same explicit instant and time zone.
 */
export interface UsageReportingPersistence {
  recordAiUsage(input: RecordAiUsageInput): Promise<AiUsageEventRow>;
  getDailyUsageDashboard(
    input: GetDailyUsageDashboardInput,
  ): Promise<DailyUsageDashboard>;
}

import {
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../database/repositories/repository-support.js";
import type { JsonObject } from "../database/schema/common.js";
import type {
  AiUsageEventRow,
  DailyPublicationCostRow,
  DailyUsageSummaryRow,
  ProviderUsageSummaryRow,
} from "./usage-persistence.contracts.js";

type DatabaseBigint = number | string;
type DatabaseNumeric = number | string;
type DatabaseTimestamp = Date | string;

export type AiUsageEventDatabaseRow = Omit<
  AiUsageEventRow,
  | "input_tokens"
  | "cached_input_tokens"
  | "output_tokens"
  | "reasoning_tokens"
  | "estimated_cost_usd"
  | "created_at"
> & {
  input_tokens: DatabaseBigint;
  cached_input_tokens: DatabaseBigint;
  output_tokens: DatabaseBigint;
  reasoning_tokens: DatabaseBigint;
  estimated_cost_usd: DatabaseNumeric | null;
  created_at: DatabaseTimestamp;
};

export type DailyUsageSummaryDatabaseRow = Omit<
  DailyUsageSummaryRow,
  | "period_start"
  | "period_end"
  | "request_count"
  | "input_tokens"
  | "cached_input_tokens"
  | "output_tokens"
  | "reasoning_tokens"
  | "web_search_calls"
  | "priced_request_count"
  | "estimated_cost_usd"
  | "tracking_started_at"
  | "published_post_count"
> & {
  period_start: DatabaseTimestamp;
  period_end: DatabaseTimestamp;
  request_count: DatabaseBigint;
  input_tokens: DatabaseBigint;
  cached_input_tokens: DatabaseBigint;
  output_tokens: DatabaseBigint;
  reasoning_tokens: DatabaseBigint;
  web_search_calls: DatabaseBigint;
  priced_request_count: DatabaseBigint;
  estimated_cost_usd: DatabaseNumeric;
  tracking_started_at: DatabaseTimestamp | null;
  published_post_count: DatabaseBigint;
};

export type DailyPublicationCostDatabaseRow = Omit<
  DailyPublicationCostRow,
  | "telegram_message_id"
  | "published_at"
  | "usage_request_count"
  | "estimated_cost_usd"
> & {
  telegram_message_id: DatabaseBigint;
  published_at: DatabaseTimestamp;
  usage_request_count: DatabaseBigint;
  estimated_cost_usd: DatabaseNumeric;
};

export type ProviderUsageSummaryDatabaseRow = Omit<
  ProviderUsageSummaryRow,
  "request_count" | "web_search_calls" | "last_success_at"
> & {
  request_count: DatabaseBigint;
  web_search_calls: DatabaseBigint;
  last_success_at: DatabaseTimestamp;
};

function safeBigint(value: DatabaseBigint, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid PostgreSQL bigint for ${field}`);
  }
  return parsed;
}

function decimalString(value: DatabaseNumeric, field: string): string {
  const decimal = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(decimal)) {
    throw new Error(`Invalid PostgreSQL numeric for ${field}`);
  }
  return decimal;
}

function nullableDecimalString(
  value: DatabaseNumeric | null,
  field: string,
): string | null {
  return value === null ? null : decimalString(value, field);
}

function jsonObject(value: JsonObject | null): JsonObject | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid AI usage pricing snapshot");
  }
  return value;
}

export function mapAiUsageEventRow(
  row: AiUsageEventDatabaseRow,
): AiUsageEventRow {
  return {
    id: row.id,
    provider: row.provider,
    provider_response_id: row.provider_response_id,
    model: row.model,
    operation: row.operation,
    telegram_channel_id: row.telegram_channel_id,
    search_run_id: row.search_run_id,
    article_id: row.article_id,
    input_tokens: safeBigint(row.input_tokens, "input_tokens"),
    cached_input_tokens: safeBigint(
      row.cached_input_tokens,
      "cached_input_tokens",
    ),
    output_tokens: safeBigint(row.output_tokens, "output_tokens"),
    reasoning_tokens: safeBigint(row.reasoning_tokens, "reasoning_tokens"),
    web_search_calls: row.web_search_calls,
    estimated_cost_usd: nullableDecimalString(
      row.estimated_cost_usd,
      "estimated_cost_usd",
    ),
    pricing_snapshot: jsonObject(row.pricing_snapshot),
    created_at: toIsoTimestamp(row.created_at),
  };
}

export function mapDailyUsageSummaryRow(
  row: DailyUsageSummaryDatabaseRow,
): DailyUsageSummaryRow {
  return {
    period_start: toIsoTimestamp(row.period_start),
    period_end: toIsoTimestamp(row.period_end),
    request_count: safeBigint(row.request_count, "request_count"),
    input_tokens: safeBigint(row.input_tokens, "input_tokens"),
    cached_input_tokens: safeBigint(
      row.cached_input_tokens,
      "cached_input_tokens",
    ),
    output_tokens: safeBigint(row.output_tokens, "output_tokens"),
    reasoning_tokens: safeBigint(row.reasoning_tokens, "reasoning_tokens"),
    web_search_calls: safeBigint(row.web_search_calls, "web_search_calls"),
    priced_request_count: safeBigint(
      row.priced_request_count,
      "priced_request_count",
    ),
    estimated_cost_usd: decimalString(
      row.estimated_cost_usd,
      "estimated_cost_usd",
    ),
    tracking_started_at: toNullableIsoTimestamp(row.tracking_started_at),
    published_post_count: safeBigint(
      row.published_post_count,
      "published_post_count",
    ),
  };
}

export function mapDailyPublicationCostRow(
  row: DailyPublicationCostDatabaseRow,
): DailyPublicationCostRow {
  return {
    telegram_message_id: safeBigint(
      row.telegram_message_id,
      "telegram_message_id",
    ),
    published_at: toIsoTimestamp(row.published_at),
    editor_name: row.editor_name,
    usage_request_count: safeBigint(
      row.usage_request_count,
      "usage_request_count",
    ),
    estimated_cost_usd: decimalString(
      row.estimated_cost_usd,
      "estimated_cost_usd",
    ),
  };
}

export function mapProviderUsageSummaryRow(
  row: ProviderUsageSummaryDatabaseRow,
): ProviderUsageSummaryRow {
  return {
    provider: row.provider,
    request_count: safeBigint(row.request_count, "request_count"),
    web_search_calls: safeBigint(row.web_search_calls, "web_search_calls"),
    last_success_at: toIsoTimestamp(row.last_success_at),
  };
}

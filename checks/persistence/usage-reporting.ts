import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import {
  DATABASE_LIFECYCLE,
  DRIZZLE_DB,
  PG_POOL,
} from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { UsageReportingRepository } from "../../src/database/repositories/usage-reporting-repository.js";
import type { UsageReportingPersistence } from "../../src/usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";
import {
  mapAiUsageEventRow,
  mapDailyPublicationCostRow,
  mapDailyUsageSummaryRow,
  mapProviderUsageSummaryRow,
  type AiUsageEventDatabaseRow,
  type DailyPublicationCostDatabaseRow,
  type DailyUsageSummaryDatabaseRow,
  type ProviderUsageSummaryDatabaseRow,
} from "../../src/usage/usage-row-mappers.js";

const postgresTimestamp = "2026-03-29 01:30:00+01";
const canonicalTimestamp = "2026-03-29T00:30:00.000Z";

const usageRow: AiUsageEventDatabaseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  provider: "openai",
  provider_response_id: "resp_usage_1",
  model: "gpt-5.4-2026-03-05",
  operation: "news_search",
  telegram_channel_id: "@channel",
  search_run_id: "00000000-0000-4000-8000-000000000002",
  article_id: "00000000-0000-4000-8000-000000000003",
  input_tokens: "100",
  cached_input_tokens: "10",
  output_tokens: "20",
  reasoning_tokens: "5",
  web_search_calls: 1,
  estimated_cost_usd: "0.01052750",
  pricing_snapshot: { tier: "standard" },
  created_at: postgresTimestamp,
};

const summaryRow: DailyUsageSummaryDatabaseRow = {
  period_start: "2026-03-28 23:00:00+00",
  period_end: "2026-03-29 22:00:00+00",
  request_count: "2",
  input_tokens: "150",
  cached_input_tokens: "10",
  output_tokens: "30",
  reasoning_tokens: "5",
  web_search_calls: "1",
  priced_request_count: "1",
  estimated_cost_usd: "0.01052750",
  tracking_started_at: postgresTimestamp,
  published_post_count: "1",
};

const publicationRow: DailyPublicationCostDatabaseRow = {
  telegram_message_id: "700000000001",
  published_at: postgresTimestamp,
  editor_name: "Mikhail Onest",
  usage_request_count: "1",
  estimated_cost_usd: "0.01052750",
};

const providerRow: ProviderUsageSummaryDatabaseRow = {
  provider: "exa",
  request_count: "1",
  web_search_calls: "1",
  last_success_at: postgresTimestamp,
};

test("usage row mappers preserve safe bigint numbers, money strings, nulls, and ISO timestamps", () => {
  const usage = mapAiUsageEventRow(usageRow);
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.estimated_cost_usd, "0.01052750");
  assert.equal(usage.created_at, canonicalTimestamp);

  const summary = mapDailyUsageSummaryRow(summaryRow);
  assert.equal(summary.request_count, 2);
  assert.equal(summary.period_start, "2026-03-28T23:00:00.000Z");
  assert.equal(summary.period_end, "2026-03-29T22:00:00.000Z");
  assert.equal(summary.estimated_cost_usd, "0.01052750");

  const post = mapDailyPublicationCostRow(publicationRow);
  assert.equal(post.telegram_message_id, 700_000_000_001);
  assert.equal(post.estimated_cost_usd, "0.01052750");

  const provider = mapProviderUsageSummaryRow(providerRow);
  assert.equal(provider.provider, "exa");
  assert.equal(provider.request_count, 1);
  assert.equal(provider.web_search_calls, 1);
  assert.equal(provider.last_success_at, canonicalTimestamp);

  assert.throws(
    () =>
      mapAiUsageEventRow({
        ...usageRow,
        input_tokens: "9007199254740992",
      }),
    /Invalid PostgreSQL bigint for input_tokens/,
  );
  assert.throws(
    () =>
      mapDailyUsageSummaryRow({
        ...summaryRow,
        estimated_cost_usd: "not-money",
      }),
    /Invalid PostgreSQL numeric for estimated_cost_usd/,
  );
});

type RecordedCall = { text: string; values: unknown[] };

class UsagePool extends EventEmitter {
  readonly calls: RecordedCall[] = [];
  endCalls = 0;

  async query(
    query: string | { text: string; values?: unknown[] },
    parameters: unknown[] = [],
  ): Promise<QueryResult> {
    const text = typeof query === "string" ? query : query.text;
    const values =
      typeof query === "string" ? parameters : (query.values ?? parameters);
    this.calls.push({ text, values });

    if (text.includes('insert into "ai_usage_events"')) {
      return {
        rows: [
          [
            usageRow.id,
            usageRow.provider,
            usageRow.provider_response_id,
            usageRow.model,
            usageRow.operation,
            usageRow.telegram_channel_id,
            usageRow.search_run_id,
            usageRow.article_id,
            usageRow.input_tokens,
            usageRow.cached_input_tokens,
            usageRow.output_tokens,
            usageRow.reasoning_tokens,
            usageRow.web_search_calls,
            usageRow.estimated_cost_usd,
            usageRow.pricing_snapshot,
            usageRow.created_at,
          ],
        ],
      } as unknown as QueryResult;
    }
    if (text.includes("published_post_count")) {
      return { rows: [summaryRow] } as QueryResult;
    }
    if (text.includes("usage_request_count")) {
      return { rows: [publicationRow] } as QueryResult;
    }
    if (text.includes("last_success_at")) {
      return { rows: [providerRow] } as QueryResult;
    }
    throw new Error(`Unexpected test query: ${text}`);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

test("usage repository keeps idempotent insert and three-query DST-safe dashboard contract", async () => {
  const pool = new UsagePool();
  const repository = new UsageReportingRepository(
    pool as unknown as Pool,
    createDrizzleDatabase(pool as unknown as Pool),
  );

  const usage = await repository.recordAiUsage({
    provider: "openai",
    providerResponseId: "resp_usage_1",
    model: "gpt-5.4-2026-03-05",
    operation: "news_search",
    telegramChannelId: "@channel",
    searchRunId: usageRow.search_run_id,
    articleId: usageRow.article_id,
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    webSearchCalls: 1,
    estimatedCostUsd: "0.01052750",
    pricingSnapshot: { tier: "standard" },
  });
  assert.equal(usage.provider_response_id, "resp_usage_1");
  assert.equal(usage.input_tokens, 100);

  const dashboard = await repository.getDailyUsageDashboard({
    channelId: "@channel",
    now: "2026-03-29T12:00:00.000Z",
    timeZone: "Europe/Madrid",
    postLimit: 5,
  });
  assert.equal(dashboard.summary.request_count, 2);
  assert.equal(dashboard.posts[0].telegram_message_id, 700_000_000_001);
  assert.equal(dashboard.providers[0].provider, "exa");
  assert.equal(dashboard.providers[0].last_success_at, canonicalTimestamp);

  assert.equal(pool.calls.length, 4);
  assert.match(pool.calls[0].text, /on conflict \("provider","provider_response_id"\) do update/);
  assert.deepEqual(pool.calls[0].values.slice(0, 14), [
    "openai",
    "resp_usage_1",
    "gpt-5.4-2026-03-05",
    "news_search",
    "@channel",
    usageRow.search_run_id,
    usageRow.article_id,
    100,
    10,
    20,
    5,
    1,
    "0.01052750",
    JSON.stringify({ tier: "standard" }),
  ]);
  for (const call of pool.calls.slice(1)) {
    assert.ok(call.values.includes("2026-03-29T12:00:00.000Z"));
    assert.ok(call.values.includes("Europe/Madrid"));
    assert.match(call.text, />= bounds\.period_start/);
    assert.match(call.text, /< bounds\.period_end/);
  }
  assert.ok(pool.calls[2].values.includes(5));
  assert.doesNotMatch(pool.calls[2].text, /UsageReportingRepository|EditorialRepository/);
  assert.match(pool.calls[3].text, /group by u\.provider/);
});

test("UsagePersistenceModule exports only the narrow Symbol-token contract", async () => {
  const pool = new UsagePool();
  const database = createDrizzleDatabase(pool as unknown as Pool);
  const moduleRef = await Test.createTestingModule({
    imports: [UsagePersistenceModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(database)
    .overrideProvider(DATABASE_LIFECYCLE)
    .useValue({ close: () => Promise.resolve() })
    .compile();

  try {
    const persistence = moduleRef.get<UsageReportingPersistence>(
      USAGE_REPORTING_PERSISTENCE,
    );
    assert.ok(persistence instanceof UsageReportingRepository);
    assert.equal(persistence, moduleRef.get(UsageReportingRepository));
    assert.deepEqual(Reflect.getMetadata("exports", UsagePersistenceModule), [
      USAGE_REPORTING_PERSISTENCE,
    ]);
  } finally {
    await moduleRef.close();
  }
});

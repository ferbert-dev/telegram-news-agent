import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { MODULE_METADATA } from "@nestjs/common/constants.js";

import { GetDailyUsageDashboardQuery } from "../../src/usage/application/get-daily-usage-dashboard.query.js";
import { UsageDashboardService } from "../../src/usage/application/usage-dashboard.service.js";
import type {
  DailyUsageDashboard,
  UsageReportingPersistence,
} from "../../src/usage/usage-persistence.contracts.js";
import { UsageApplicationModule } from "../../src/usage/usage-application.module.js";
import { runUsageDashboardCli } from "../../src/usage/usage-dashboard-cli.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";

const dashboard: DailyUsageDashboard = {
  summary: {
    period_start: "2026-03-28T23:00:00.000Z",
    period_end: "2026-03-29T22:00:00.000Z",
    request_count: 2,
    input_tokens: 10_000,
    cached_input_tokens: 2_000,
    output_tokens: 1_000,
    reasoning_tokens: 300,
    web_search_calls: 2,
    priced_request_count: 2,
    estimated_cost_usd: "0.05550000",
    tracking_started_at: "2026-03-29T00:30:00.000Z",
    published_post_count: 1,
  },
  posts: [
    {
      telegram_message_id: 700_000_000_001,
      published_at: "2026-03-29T00:30:00.000Z",
      editor_name: "Mikhail Onest",
      usage_request_count: 2,
      estimated_cost_usd: "0.05550000",
    },
  ],
  providers: [],
};

test("UsageDashboardService delegates the exact DST-safe read query and preserves typed DTO values", async () => {
  const calls: GetDailyUsageDashboardQuery[] = [];
  const persistence: UsageReportingPersistence = {
    async recordAiUsage() {
      throw new Error("read-only slice must not record usage");
    },
    async getDailyUsageDashboard(query) {
      calls.push(query as GetDailyUsageDashboardQuery);
      return dashboard;
    },
  };
  const service = new UsageDashboardService(persistence);
  const now = new Date("2026-03-29T12:00:00.000Z");
  const query = new GetDailyUsageDashboardQuery({
    channelId: "@channel",
    now,
    timeZone: "Europe/Madrid",
    postLimit: 7,
  });
  const result = await service.execute(query);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], query);
  assert.equal(calls[0].now, now);
  assert.equal(calls[0].timeZone, "Europe/Madrid");
  assert.equal(calls[0].postLimit, 7);
  assert.equal(result, dashboard);
  assert.equal(result.summary.estimated_cost_usd, "0.05550000");
  assert.equal(result.posts[0].telegram_message_id, 700_000_000_001);
});

test("UsageApplicationModule imports persistence and exports only the application provider", () => {
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, UsageApplicationModule),
    [UsagePersistenceModule],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, UsageApplicationModule),
    [UsageDashboardService],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.EXPORTS, UsageApplicationModule),
    [UsageDashboardService],
  );
});

test("standalone usage CLI renders legacy dashboard parity and always closes its Nest context", async () => {
  const queries: GetDailyUsageDashboardQuery[] = [];
  const output: string[] = [];
  let closeCalls = 0;

  const result = await runUsageDashboardCli({
    environment: { TELEGRAM_CHANNEL_ID: " @channel " },
    now: () => new Date("2026-03-29T12:00:00.000Z"),
    write: (text) => output.push(text),
    createApplicationContext: async () => ({
      get() {
        return {
          async execute(query: GetDailyUsageDashboardQuery) {
            queries.push(query);
            return dashboard;
          },
        } as UsageDashboardService;
      },
      async close() {
        closeCalls += 1;
      },
    }),
  });

  assert.equal(result, dashboard);
  assert.equal(closeCalls, 1);
  assert.ok(queries[0] instanceof GetDailyUsageDashboardQuery);
  assert.deepEqual({ ...queries[0] }, {
    channelId: "@channel",
    now: "2026-03-29T12:00:00.000Z",
    timeZone: "Europe/Madrid",
    postLimit: undefined,
  });
  assert.match(output[0], /^📊 AI usage today/m);
  assert.match(output[0], /Timezone: Europe\/Madrid/);
  assert.match(output[0], /Input tokens: 10,000/);
  assert.match(output[0], /Estimated list cost: \$0\.0555/);
  assert.match(output[0], /#700000000001 · 01:30 · Mikhail Onest · \$0\.0555/);
});

test("standalone usage CLI closes its Nest context when the read fails", async () => {
  let closeCalls = 0;

  await assert.rejects(
    runUsageDashboardCli({
      environment: { TELEGRAM_CHANNEL_ID: "@channel" },
      createApplicationContext: async () => ({
        get() {
          return {
            async execute() {
              throw new Error("dashboard unavailable");
            },
          } as unknown as UsageDashboardService;
        },
        async close() {
          closeCalls += 1;
        },
      }),
    }),
    /dashboard unavailable/,
  );

  assert.equal(closeCalls, 1);
});

test("standalone usage CLI fails before creating a context without a channel", async () => {
  let contextCalls = 0;

  await assert.rejects(
    runUsageDashboardCli({
      environment: {},
      createApplicationContext: async () => {
        contextCalls += 1;
        throw new Error("must not create context");
      },
    }),
    /TELEGRAM_CHANNEL_ID is required/,
  );

  assert.equal(contextCalls, 0);
});

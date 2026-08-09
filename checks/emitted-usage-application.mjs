import assert from "node:assert/strict";

const { GetDailyUsageDashboardQuery } = await import(
  "../dist/usage/application/get-daily-usage-dashboard.query.js"
);
const { UsageDashboardService } = await import(
  "../dist/usage/application/usage-dashboard.service.js"
);
const { UsageApplicationModule } = await import(
  "../dist/usage/usage-application.module.js"
);
const { runUsageDashboardCli } = await import(
  "../dist/usage/usage-dashboard-cli.js"
);

const dashboard = {
  summary: {
    period_start: "2026-03-28T23:00:00.000Z",
    period_end: "2026-03-29T22:00:00.000Z",
    request_count: 1,
    input_tokens: 100,
    cached_input_tokens: 10,
    output_tokens: 20,
    reasoning_tokens: 5,
    web_search_calls: 1,
    priced_request_count: 1,
    estimated_cost_usd: "0.01052750",
    tracking_started_at: "2026-03-29T00:30:00.000Z",
    published_post_count: 0,
  },
  posts: [],
};

const service = new UsageDashboardService({
  async getDailyUsageDashboard(query) {
    assert.ok(query instanceof GetDailyUsageDashboardQuery);
    return dashboard;
  },
});
let closeCalls = 0;
const output = [];

await runUsageDashboardCli({
  environment: { TELEGRAM_CHANNEL_ID: "@emitted" },
  now: () => new Date("2026-03-29T12:00:00.000Z"),
  write: (text) => output.push(text),
  createApplicationContext: async () => ({
    get(token) {
      assert.equal(token, UsageDashboardService);
      return service;
    },
    async close() {
      closeCalls += 1;
    },
  }),
});

assert.equal(typeof UsageApplicationModule, "function");
assert.equal(closeCalls, 1);
assert.match(output[0], /Timezone: Europe\/Madrid/);
assert.match(output[0], /Estimated list cost: \$0\.0105/);

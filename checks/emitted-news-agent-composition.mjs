import assert from "node:assert/strict";

// The composition root is the one place where a decorator-metadata or emit
// problem would surface as a runtime failure rather than a type error, so it
// gets exercised against the compiled dist/ output, not just under tsx.
const composition = await import("../dist/composition/news-agent.module.js");
const entry = await import("../dist/composition/runtime-entry.js");
const { Test } = await import("@nestjs/testing");
const { PG_POOL, DRIZZLE_DB } = await import("../dist/database/database.tokens.js");

assert.equal(typeof composition.NewsAgentModule.register, "function");
assert.equal(typeof composition.TELEGRAM_POLLING_WORKER, "symbol");
assert.equal(typeof composition.NEWS_SCHEDULER_WORKER, "symbol");
assert.equal(typeof composition.RUNTIME_HEALTH_WORKER, "symbol");
assert.equal(typeof entry.startNewsAgentRuntime, "function");
assert.equal(typeof entry.resolveRuntimeIdentity, "function");

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHANNEL_ID: "@channel",
  OPENAI_API_KEY: "test-openai-key",
  NOTION_API_KEY: "test-notion-key",
  NOTION_AGENT_RUNS_DATA_SOURCE_ID: "data-source",
  NOTION_PIPELINE_AGENT_PAGE_ID: "agent-page",
  APP_VERSION: "test",
};

const moduleRef = await Test.createTestingModule({
  imports: [
    composition.NewsAgentModule.register({
      token: "test-token",
      identity: { botUsername: "news_bot", botId: 4242, channelId: "@channel" },
      env,
    }),
  ],
})
  .overrideProvider(PG_POOL)
  .useValue({ on() {}, async query() { throw new Error("unused"); }, async end() {} })
  .overrideProvider(DRIZZLE_DB)
  .useValue({
    async execute() { throw new Error("unused"); },
    async transaction() { throw new Error("unused"); },
  })
  .compile();
await moduleRef.init();

try {
  const poller = moduleRef.get(composition.TELEGRAM_POLLING_WORKER, { strict: false });
  const scheduler = moduleRef.get(composition.NEWS_SCHEDULER_WORKER, { strict: false });
  assert.equal(poller.name, "telegram-polling");
  assert.equal(scheduler.name, "news-scheduler");
  assert.equal(typeof poller.start, "function");
  assert.equal(typeof scheduler.start, "function");

  // The health worker is what a container health check will run against, so it
  // has to resolve from the compiled output, and its readiness snapshot has to
  // name the same lease owner the emitted poller claims.
  const health = moduleRef.get(composition.RUNTIME_HEALTH_WORKER, { strict: false });
  assert.equal(health.name, "runtime-health");
  const snapshot = health.snapshot("ready");
  assert.equal(snapshot.pollerLeaseOwnerId, poller.ownerId);
  assert.equal(snapshot.pollerLeaseName, poller.leaseName);
  assert.equal(snapshot.state, "ready");
} finally {
  await moduleRef.close();
}

import assert from "node:assert/strict";

// The composition root is the one place where a decorator-metadata or emit
// problem would surface as a runtime failure rather than a type error, so it
// gets exercised against the compiled dist/ output, not just under tsx.
const composition = await import("../dist/composition/news-agent.module.js");
const entry = await import("../dist/composition/runtime-entry.js");
const { Test } = await import("@nestjs/testing");
const probe = await import("../dist/composition/health-cli.js");
const { PG_POOL, DRIZZLE_DB } = await import("../dist/database/database.tokens.js");

assert.equal(typeof composition.NewsAgentModule.register, "function");
assert.equal(typeof composition.TELEGRAM_POLLING_WORKER, "symbol");
assert.equal(typeof composition.NEWS_SCHEDULER_WORKER, "symbol");
assert.equal(typeof composition.TELEGRAM_NEWS_JOB_WORKER, "symbol");
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
  const newsJobs = moduleRef.get(composition.TELEGRAM_NEWS_JOB_WORKER, { strict: false });
  assert.equal(poller.name, "telegram-polling");
  assert.equal(scheduler.name, "news-scheduler");
  assert.equal(newsJobs.name, "telegram-news-jobs");
  assert.equal(typeof poller.start, "function");
  assert.equal(typeof scheduler.start, "function");
  assert.equal(typeof newsJobs.start, "function");

  // The invariant that was missing when `/news` was permanently dead: the
  // runtime started, reported healthy, answered "Research queued" -- and no
  // worker existed to run the job. Nothing failed, because the three places
  // that describe the runtime's workers never had to agree.
  //
  // They are three independent declarations -- RUNTIME_WORKER_TOKENS in the
  // entry point, RUNTIME_WORKER_NAMES in the module, REQUIRED_WORKERS in the
  // probe -- so comparing them is a real check rather than a constant against
  // itself. Dropping the news-job token from the entry point fails here, at
  // build time, instead of in production at the first `/news`.
  const started = entry.RUNTIME_WORKER_TOKENS.map((token) =>
    composition.RUNTIME_WORKER_NAMES.get(token),
  );
  for (const required of probe.REQUIRED_WORKERS) {
    assert.ok(
      started.includes(required),
      `the runtime must start ${required}, which the health probe requires; it starts ${started.join(", ")}`,
    );
    // A name in the list is not yet a worker. Resolve it, so a token that maps
    // to a name but not to a provider cannot satisfy the check above.
    const token = [...composition.RUNTIME_WORKER_NAMES.entries()].find(
      ([, name]) => name === required,
    )?.[0];
    const resolved = moduleRef.get(token, { strict: false });
    assert.equal(resolved.name, required);
    assert.equal(typeof resolved.start, "function");
    assert.equal(typeof resolved.stop, "function");
  }

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

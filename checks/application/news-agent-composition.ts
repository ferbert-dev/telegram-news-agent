import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";

import {
  NEWS_SCHEDULER_WORKER,
  NewsAgentModule,
  TELEGRAM_POLLING_WORKER,
} from "../../src/composition/news-agent.module.js";
import { resolveRuntimeIdentity } from "../../src/composition/runtime-entry.js";
import { NewsSchedulerWorker } from "../../src/scheduler/news-scheduler-worker.js";
import { TelegramPollingWorker } from "../../src/telegram/telegram-polling-worker.js";
import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../../src/editorial/editorial-application.tokens.js";
import { PIPELINE_LEASE_APPLICATION } from "../../src/operations/operations-application.tokens.js";
import { SCHEDULER_APPLICATION } from "../../src/scheduler/scheduler-application.tokens.js";
import { TELEGRAM_CONTROL_APPLICATION } from "../../src/telegram/telegram-application.tokens.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../../src/research/research-gateway.tokens.js";

const identity = { botUsername: "news_bot", botId: 4242, channelId: "@channel" };

/** Enough configuration for every eagerly-constructed adapter to build. */
const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHANNEL_ID: "@channel",
  OPENAI_API_KEY: "test-openai-key",
  NOTION_API_KEY: "test-notion-key",
  NOTION_AGENT_RUNS_DATA_SOURCE_ID: "data-source",
  NOTION_PIPELINE_AGENT_PAGE_ID: "agent-page",
  APP_VERSION: "test",
} as NodeJS.ProcessEnv;

const fakePool = { on() {}, async query() { throw new Error("unused pool"); }, async end() {} };
const fakeDrizzle = {
  async execute() { throw new Error("unused drizzle"); },
  async transaction() { throw new Error("unused drizzle transaction"); },
};

async function compileRuntime() {
  const moduleRef = await Test.createTestingModule({
    imports: [NewsAgentModule.register({ token: "test-token", identity, env })],
  })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(fakeDrizzle)
    .compile();
  // .compile() builds the graph; .init() runs onModuleInit, which is where the
  // late-bound ports get filled. bootstrapRuntime's context creation does both.
  await moduleRef.init();
  return moduleRef;
}

test("the whole application graph constructs with real adapters", async () => {
  // The point of the composition root: every module registers, every gateway
  // is satisfiable, and there is no missing provider anywhere in the graph.
  const moduleRef = await compileRuntime();
  try {
    assert.ok(moduleRef.get(EDITORIAL_WORKFLOW_APPLICATION, { strict: false }));
    assert.ok(moduleRef.get(PIPELINE_LEASE_APPLICATION, { strict: false }));
    assert.ok(moduleRef.get(TELEGRAM_CONTROL_APPLICATION, { strict: false }));
    assert.ok(moduleRef.get(SCHEDULER_APPLICATION, { strict: false }));
    assert.ok(moduleRef.get(RESEARCH_EXECUTION_GATEWAY, { strict: false }));
  } finally {
    await moduleRef.close();
  }
});

test("both workers resolve from their tokens as real worker instances", async () => {
  const moduleRef = await compileRuntime();
  try {
    const poller = moduleRef.get(TELEGRAM_POLLING_WORKER, { strict: false });
    const scheduler = moduleRef.get(NEWS_SCHEDULER_WORKER, { strict: false });

    assert.ok(poller instanceof TelegramPollingWorker);
    assert.ok(scheduler instanceof NewsSchedulerWorker);
    assert.equal(poller.name, "telegram-polling");
    assert.equal(scheduler.name, "news-scheduler");
  } finally {
    await moduleRef.close();
  }
});

test("neither worker implements a Nest lifecycle hook, so the coordinator stays sole owner", async () => {
  // RuntimeModule documents this rule: a token-resolved worker is a
  // container-managed provider, so app.close() would reach its hooks after the
  // coordinator already called stop().
  const moduleRef = await compileRuntime();
  try {
    for (const token of [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER]) {
      const worker = moduleRef.get(token, { strict: false }) as Record<string, unknown>;
      for (const hook of ["onModuleDestroy", "beforeApplicationShutdown", "onApplicationShutdown"]) {
        assert.equal(typeof worker[hook], "undefined", `${String(token)} must not define ${hook}`);
      }
    }
  } finally {
    await moduleRef.close();
  }
});

test("late-bound ports are filled during init, before any worker could run", async () => {
  // If binding had not happened, resolving the scheduler application and
  // touching its editorial collaborator would throw the late-bound error.
  const moduleRef = await compileRuntime();
  try {
    const scheduler = moduleRef.get(SCHEDULER_APPLICATION, { strict: false }) as {
      runOnce: unknown;
    };
    assert.equal(typeof scheduler.runOnce, "function");

    const editorial = moduleRef.get(EDITORIAL_WORKFLOW_APPLICATION, { strict: false }) as {
      generateReviewDraft: unknown;
    };
    assert.equal(typeof editorial.generateReviewDraft, "function");
  } finally {
    await moduleRef.close();
  }
});

test("registering with a search-only provider set fails loudly rather than building an unusable runtime", () => {
  // Exa can satisfy search but cannot generate structured output, so a runtime
  // configured with Exa alone would construct fine and then fail at the first
  // draft. Catch it at definition time instead.
  assert.throws(
    () =>
      NewsAgentModule.register({
        token: "t",
        identity,
        env: {
          ...env,
          OPENAI_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          EXA_ENABLED: "true",
          EXA_API_KEY: "test-exa-key",
        } as NodeJS.ProcessEnv,
      }),
    /draft model is required/,
  );
});

test("registering with no AI provider at all fails from the provider composition itself", () => {
  assert.throws(
    () =>
      NewsAgentModule.register({
        token: "t",
        identity,
        env: { ...env, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined } as NodeJS.ProcessEnv,
      }),
    /No AI provider is configured/,
  );
});

test("resolveRuntimeIdentity reads the bot identity and rejects an unusable response", async () => {
  const calls: unknown[][] = [];
  const identityResult = await resolveRuntimeIdentity(
    "token-1",
    "@channel",
    (async (...args: unknown[]) => {
      calls.push(args);
      return { id: 99, username: "news_bot" };
    }) as never,
  );

  assert.deepEqual(identityResult, { botUsername: "news_bot", botId: 99, channelId: "@channel" });
  assert.deepEqual(calls[0]?.slice(0, 2), ["token-1", "getMe"]);

  await assert.rejects(
    resolveRuntimeIdentity("token-1", "@channel", (async () => ({})) as never),
    /did not return a usable bot identity/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";

import {
  NEWS_SCHEDULER_WORKER,
  NewsAgentModule,
  startedWorkerNames,
  RUNTIME_HEALTH_WORKER,
  TELEGRAM_POLLING_WORKER,
} from "../../src/composition/news-agent.module.js";
import {
  composeRuntime,
  RUNTIME_WORKER_TOKENS,
  resolveRuntimeIdentity,
} from "../../src/composition/runtime-entry.js";
import { NewsSchedulerWorker } from "../../src/scheduler/news-scheduler-worker.js";
import {
  TELEGRAM_CONTROL_POLLER_LEASE_NAME,
  TelegramPollingWorker,
} from "../../src/telegram/telegram-polling-worker.js";
import { RuntimeHealthWorker } from "../../src/runtime/runtime-health.js";
import { checkRuntimeHealth } from "../../src/runtime/runtime-health-check.js";
import { LateBoundPortRegistry } from "../../src/composition/late-bound-port.js";
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

test("every worker resolves from its token as a real worker instance", async () => {
  const moduleRef = await compileRuntime();
  try {
    const poller = moduleRef.get(TELEGRAM_POLLING_WORKER, { strict: false });
    const scheduler = moduleRef.get(NEWS_SCHEDULER_WORKER, { strict: false });
    const health = moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false });

    assert.ok(poller instanceof TelegramPollingWorker);
    assert.ok(scheduler instanceof NewsSchedulerWorker);
    assert.ok(health instanceof RuntimeHealthWorker);
    assert.equal(poller.name, "telegram-polling");
    assert.equal(scheduler.name, "news-scheduler");
    assert.equal(health.name, "runtime-health");
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
    for (const token of [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER, RUNTIME_HEALTH_WORKER]) {
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

test("a port left unbound stops the container from finishing its boot", () => {
  // Resolving a service does not go through the proxies, so no test observed a
  // missing binding: deleting any bind() used to fail nothing at all. The
  // binder now verifies itself, so every compileRuntime() in this file
  // exercises the rule; this pins the rule's own behaviour.
  //
  // The failure it prevents is silent: the container starts, the workers start,
  // and the first call through the missed port throws deep inside a poll or a
  // scheduled run. For the persistence port it is worse than a late crash --
  // it is what the AI provider's attempt recording is built with, so usage
  // accounting and fallback-rate alerting would go dark at the first call.
  const registry = new LateBoundPortRegistry();
  const bound = registry.create<{ ok(): void }>("bound");
  bound.bind({ ok() {} });
  assert.doesNotThrow(() => registry.assertAllBound());

  // Creation lives on the registry and nowhere else, so a port cannot be added
  // to a composition without being covered. Two earlier versions of this rule
  // took a hand-maintained list and then a hand-maintained count, and both were
  // silent for a port nobody remembered to add.
  registry.create<{ ok(): void }>("forgotten");
  assert.throws(() => registry.assertAllBound(), /left late-bound ports unbound: forgotten/);
});

test("the worker names in the readiness file come from the tokens actually started", () => {
  // The failure this exists to catch is a token list built by a filter or a
  // conditional that drops the scheduler. If the names were a constant, both
  // sides of the probe's comparison would still say "news-scheduler" and the
  // runtime would report healthy while running nothing on a schedule.
  assert.deepEqual(startedWorkerNames([...RUNTIME_WORKER_TOKENS]), [
    "telegram-polling",
    "news-scheduler",
  ]);
  // Drop the scheduler token and the name disappears with it.
  assert.deepEqual(
    startedWorkerNames([TELEGRAM_POLLING_WORKER, RUNTIME_HEALTH_WORKER]),
    ["telegram-polling"],
  );
  // The health worker never lists itself: it is what publishes the file.
  assert.ok(!startedWorkerNames([...RUNTIME_WORKER_TOKENS]).includes("runtime-health"));
});

test("the readiness snapshot reports the reduced worker set it was actually given", async () => {
  // End to end through the real module, not just the helper: a runtime composed
  // without its scheduler must say so in the file it publishes.
  const moduleRef = await Test.createTestingModule({
    imports: [
      NewsAgentModule.register({
        token: "test-token",
        identity,
        env,
        updateMode: "polling",
        startedWorkers: startedWorkerNames([TELEGRAM_POLLING_WORKER, RUNTIME_HEALTH_WORKER]),
      }),
    ],
  })
    .overrideProvider(PG_POOL)
    .useValue(fakePool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(fakeDrizzle)
    .compile();
  await moduleRef.init();
  try {
    const health = moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false }) as RuntimeHealthWorker;
    const snapshot = health.snapshot("ready");
    assert.deepEqual([...snapshot.startedWorkers], ["telegram-polling"]);
    assert.equal(snapshot.updateMode, "polling");
  } finally {
    await moduleRef.close();
  }
});

test("registering with no AI provider at all fails from the provider composition", () => {
  // An Exa-only deployment is legitimate (search works; drafting falls to
  // another provider), so the composition root deliberately does NOT refuse
  // over an unresolvable draft model -- src/draft.js only reads `model` on the
  // no-aiProvider branch, which createAiProvider makes unreachable.
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

test("an Exa-only provider set still composes, rather than being refused at boot", () => {
  assert.doesNotThrow(() =>
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

test("the readiness snapshot names the same lease and owner the poller actually claims", async () => {
  // The health check is only meaningful if the owner id in the readiness file
  // is the one the lease row will carry. Both come from the composition root
  // rather than from each worker's own default, and this is the assertion that
  // keeps them from drifting apart -- a mismatch would make every check report
  // "owned by another runtime" against the runtime's own lease.
  const moduleRef = await compileRuntime();
  try {
    const poller = moduleRef.get(TELEGRAM_POLLING_WORKER, { strict: false }) as unknown as {
      ownerId: string;
      leaseName: string;
    };
    const health = moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false }) as RuntimeHealthWorker;
    const snapshot = health.snapshot("ready");

    assert.equal(typeof poller.ownerId, "string");
    assert.equal(snapshot.pollerLeaseOwnerId, poller.ownerId);
    assert.equal(snapshot.pollerLeaseName, poller.leaseName);
    assert.equal(snapshot.pollerLeaseName, TELEGRAM_CONTROL_POLLER_LEASE_NAME);
    assert.equal(snapshot.botId, identity.botId);
    assert.equal(snapshot.channelId, identity.channelId);
  } finally {
    await moduleRef.close();
  }
});

test("two registrations get distinct owner ids, so a redeploy cannot impersonate the old runtime", async () => {
  // If the owner id were derived from something stable (hostname, bot id), a
  // restarted runtime would match a lease row the previous process still holds
  // and report itself healthy while owning nothing.
  const [first, second] = await Promise.all([compileRuntime(), compileRuntime()]);
  try {
    const ownerOf = (moduleRef: typeof first) =>
      (moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false }) as RuntimeHealthWorker).snapshot(
        "ready",
      ).pollerLeaseOwnerId;
    assert.notEqual(ownerOf(first), ownerOf(second));
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("the health worker starts last, which is what makes the readiness file mean anything", () => {
  // The coordinator starts in this order and stops in reverse. If the health
  // worker moved anywhere but the end, the readiness file would be published
  // during the poller's 70-second lease-acquire wait -- a duplicate poller that
  // is about to fail would report itself ready, which is the exact failure this
  // protocol exists to catch. Every other check in this file still passes with
  // that order broken, so it is asserted directly.
  assert.deepEqual(
    [...RUNTIME_WORKER_TOKENS],
    [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER, RUNTIME_HEALTH_WORKER],
  );
  assert.equal(RUNTIME_WORKER_TOKENS.at(-1), RUNTIME_HEALTH_WORKER);
});

test("a module told nothing about its workers reports an empty set, not a plausible one", async () => {
  // Failing closed rather than defaulting. A default here would be a constant
  // asserting something nothing checked -- exactly the tautology the derived
  // list exists to avoid -- and the probe's required set would accept it.
  const moduleRef = await compileRuntime();
  try {
    const health = moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false }) as RuntimeHealthWorker;
    const snapshot = health.snapshot("ready");
    assert.deepEqual([...snapshot.startedWorkers], []);
    assert.equal(snapshot.updateMode, "unknown");

    const result = await checkRuntimeHealth({
      filePath: "ignored",
      leases: { async readPipelineLease() { throw new Error("must not be reached"); } },
      isProcessAlive: () => true,
      expect: { startedWorkers: ["telegram-polling", "news-scheduler"], updateMode: "polling" },
      readSnapshotFile: async () => JSON.stringify(snapshot),
    });
    assert.equal(result.healthy, false);
  } finally {
    await moduleRef.close();
  }
});

test("whatever token list the runtime starts, the readiness file describes that list", async () => {
  // The invariant, pinned over more than the production list: the file cannot
  // disagree with the tokens actually being started. startNewsAgentRuntime
  // itself cannot be tested -- it calls Telegram twice before composing --
  // which is why the wiring lives in composeRuntime.
  for (const tokens of [
    [...RUNTIME_WORKER_TOKENS],
    [TELEGRAM_POLLING_WORKER, RUNTIME_HEALTH_WORKER],
    [TELEGRAM_POLLING_WORKER, NEWS_SCHEDULER_WORKER],
  ]) {
    const composed = composeRuntime({ token: "test-token", identity, env, workerTokens: tokens });
    const moduleRef = await Test.createTestingModule({ imports: [composed.applicationModule] })
      .overrideProvider(PG_POOL)
      .useValue(fakePool)
      .overrideProvider(DRIZZLE_DB)
      .useValue(fakeDrizzle)
      .compile();
    await moduleRef.init();
    try {
      const health = moduleRef.get(RUNTIME_HEALTH_WORKER, { strict: false }) as RuntimeHealthWorker;
      assert.deepEqual(
        [...health.snapshot("ready").startedWorkers],
        startedWorkerNames(composed.workerTokens),
        `readiness file disagreed with the tokens for ${tokens.map(String).join(", ")}`,
      );
    } finally {
      await moduleRef.close();
    }
  }
});

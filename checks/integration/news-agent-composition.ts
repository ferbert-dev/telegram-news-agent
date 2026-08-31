import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import {
  NEWS_SCHEDULER_WORKER,
  NewsAgentModule,
  RUNTIME_HEALTH_WORKER,
  TELEGRAM_POLLING_WORKER,
} from "../../src/composition/news-agent.module.js";
import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../../src/editorial/editorial-application.tokens.js";
import { LEGACY_PERSISTENCE } from "../../src/persistence/legacy-persistence.tokens.js";
import type { LegacyPersistence } from "../../src/persistence/legacy-persistence.contracts.js";
import { PIPELINE_LEASE_APPLICATION } from "../../src/operations/operations-application.tokens.js";
import type { PipelineLeaseApplicationPort } from "../../src/operations/operations-application.contracts.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../../src/research/research-gateway.tokens.js";
import { SCHEDULER_APPLICATION } from "../../src/scheduler/scheduler-application.tokens.js";
import { TELEGRAM_CONTROL_APPLICATION } from "../../src/telegram/telegram-application.tokens.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

const identity = { botUsername: "integration_bot", botId: 4242, channelId: "@integration" };

/** Configuration only -- nothing here reaches a network at construction time. */
const env = {
  TELEGRAM_BOT_TOKEN: "integration-token",
  TELEGRAM_CHANNEL_ID: "@integration",
  OPENAI_API_KEY: "integration-openai-key",
  NOTION_API_KEY: "integration-notion-key",
  NOTION_AGENT_RUNS_DATA_SOURCE_ID: "data-source",
  NOTION_PIPELINE_AGENT_PAGE_ID: "agent-page",
  APP_VERSION: "integration",
} as NodeJS.ProcessEnv;

/**
 * The composition root against a real PostgreSQL.
 *
 * The unit check overrides the pool and the Drizzle client with fakes, so it
 * proves the graph has no missing provider -- but every repository in it has
 * only ever been resolved, never used. This boots the same module the runtime
 * entry point boots, against the real schema, and drives a use case through to
 * a real atomic PostgreSQL function.
 *
 * Workers are resolved but deliberately not started: the poller would call
 * Telegram, which is not this check's business.
 */
test(
  "the composition root boots against a real database and reaches PostgreSQL through its ports",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 4 });
    const moduleRef = await Test.createTestingModule({
      imports: [NewsAgentModule.register({ token: "integration-token", identity, env })],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(DRIZZLE_DB)
      .useValue(createDrizzleDatabase(pool))
      .compile();
    await moduleRef.init();

    const leaseName = `composition-check-${randomUUID()}`;
    const ownerId = randomUUID();
    try {
      // Every application port the runtime depends on resolves for real.
      for (const token of [
        EDITORIAL_WORKFLOW_APPLICATION,
        PIPELINE_LEASE_APPLICATION,
        TELEGRAM_CONTROL_APPLICATION,
        SCHEDULER_APPLICATION,
        RESEARCH_EXECUTION_GATEWAY,
        TELEGRAM_POLLING_WORKER,
        NEWS_SCHEDULER_WORKER,
        RUNTIME_HEALTH_WORKER,
      ]) {
        assert.ok(moduleRef.get(token, { strict: false }), `${String(token)} did not resolve`);
      }

      // A real round trip: the lease application through the persistence module
      // to the atomic PostgreSQL function, not a fake returning true.
      const leaseApplication = moduleRef.get<PipelineLeaseApplicationPort>(
        PIPELINE_LEASE_APPLICATION,
        { strict: false },
      );
      assert.equal(await leaseApplication.acquire({ name: leaseName, ownerId }), true);
      assert.equal(
        await leaseApplication.acquire({ name: leaseName, ownerId: randomUUID() }),
        false,
        "a second owner must not be able to take a held lease",
      );
      assert.equal(await leaseApplication.renew({ name: leaseName, ownerId }), true);
      assert.equal(await leaseApplication.release({ name: leaseName, ownerId }), true);

      // The late-bound persistence facade is bound and reaches the database --
      // the AI provider's attempt recording depends on this being real, and a
      // proxy that was never bound would throw here rather than return.
      const persistence = moduleRef.get<LegacyPersistence>(LEGACY_PERSISTENCE, { strict: false });
      // A read, not a create: this check must not leave settings rows behind.
      // null is the correct answer for an unconfigured channel -- what is being
      // proven is that the call reaches PostgreSQL through a bound proxy rather
      // than throwing "used before the container finished wiring it".
      const settings = await persistence.getNewsSettings("@integration");
      assert.equal(settings, null);
    } finally {
      await pool
        .query("delete from public.pipeline_leases where name = $1", [leaseName])
        .catch(() => {});
      await moduleRef.close();
      await pool.end().catch(() => undefined);
    }
  },
);

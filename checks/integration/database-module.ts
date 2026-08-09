import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool, type PoolClient } from "pg";

import { DatabaseModule } from "../../src/database/database.module.js";
import {
  DRIZZLE_DB,
  PG_POOL,
} from "../../src/database/database.tokens.js";
import type { DrizzleDatabase } from "../../src/database/drizzle-client.js";
import {
  postgresScalar,
  RepositorySupport,
} from "../../src/database/repositories/repository-support.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

const claimSourceDiscovery = postgresScalar<boolean>(
  "public.claim_source_discovery",
  1,
);

@Injectable()
class TransactionProbe extends RepositorySupport {
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  claimThenRollback(topicKey: string): Promise<void> {
    return this.transaction("Rollback source discovery claim", async (tx) => {
      assert.equal(
        await this.functionScalar(
          "Transactional source discovery claim",
          claimSourceDiscovery,
          [topicKey],
          tx,
        ),
        true,
      );
      throw new Error("integration rollback");
    });
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [SourcesRepository, TransactionProbe],
})
class DatabaseIntegrationFixtureModule {}

test(
  "DatabaseModule resolves repositories, rolls back function calls, and drains checked-out clients",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseIntegrationFixtureModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    let checkedOutClient: PoolClient | null = null;
    let closePromise: Promise<void> | null = null;

    try {
      await moduleRef.init();
      const repository = moduleRef.get(SourcesRepository);
      assert.ok(Array.isArray(await repository.listSourceHealth()));

      const topicKey = randomUUID().replaceAll("-", "").padEnd(64, "0");
      await assert.rejects(
        moduleRef.get(TransactionProbe).claimThenRollback(topicKey),
        /Rollback source discovery claim failed: integration rollback/,
      );
      const rollbackCheck = await pool.query<{ count: string }>(
        "select count(*)::text as count from public.source_discovery_state where topic_key = $1",
        [topicKey],
      );
      assert.equal(rollbackCheck.rows[0].count, "0");

      const client = await pool.connect();
      checkedOutClient = client;
      let closed = false;
      closePromise = moduleRef.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(closed, false);

      client.release();
      checkedOutClient = null;
      await closePromise;
    } finally {
      checkedOutClient?.release();
      if (closePromise === null) {
        await moduleRef.close().catch(() => {});
      } else {
        await closePromise.catch(() => {});
      }
    }
  },
);

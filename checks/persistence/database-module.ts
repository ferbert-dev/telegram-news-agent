import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { DatabaseLifecycle } from "../../src/database/database-lifecycle.js";
import { DatabaseModule } from "../../src/database/database.module.js";
import {
  DATABASE_LIFECYCLE,
  DRIZZLE_DB,
  PG_POOL,
} from "../../src/database/database.tokens.js";
import type { DrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const CONSUMER_A = Symbol("CONSUMER_A");
const CONSUMER_B = Symbol("CONSUMER_B");

type DatabaseConsumer = {
  pool: Pool;
  database: DrizzleDatabase;
};

const consumerProvider = (provide: symbol) => ({
  provide,
  inject: [PG_POOL, DRIZZLE_DB],
  useFactory: (pool: Pool, database: DrizzleDatabase): DatabaseConsumer => ({
    pool,
    database,
  }),
});

@Module({
  imports: [DatabaseModule],
  providers: [
    SourcesRepository,
    consumerProvider(CONSUMER_A),
    consumerProvider(CONSUMER_B),
  ],
})
class PersistenceFixtureModule {}

class FakePool extends EventEmitter {
  endCalls = 0;
  readonly endPromise: Promise<void>;
  private resolveEnd!: () => void;

  constructor(autoResolve = false) {
    super();
    this.endPromise = new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
    });
    if (autoResolve) {
      this.resolveEnd();
    }
  }

  query(): Promise<QueryResult> {
    throw new Error("The identity test must not query PostgreSQL");
  }

  end(): Promise<void> {
    this.endCalls += 1;
    return this.endPromise;
  }

  finishEnd(): void {
    this.resolveEnd();
  }
}

async function testingContext(pool: FakePool) {
  const moduleRef = await Test.createTestingModule({
    imports: [PersistenceFixtureModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .compile();
  await moduleRef.init();
  return moduleRef;
}

test("DatabaseModule shares one Pool and one Drizzle instance across consumers", async () => {
  const pool = new FakePool();
  const moduleRef = await testingContext(pool);
  const consumerA = moduleRef.get<DatabaseConsumer>(CONSUMER_A);
  const consumerB = moduleRef.get<DatabaseConsumer>(CONSUMER_B);
  const repository = moduleRef.get(SourcesRepository);

  assert.equal(consumerA.pool, pool);
  assert.equal(consumerB.pool, pool);
  assert.equal(consumerA.database, consumerB.database);
  assert.equal(repository.database, consumerA.database);

  const lifecycle = moduleRef.get<DatabaseLifecycle>(DATABASE_LIFECYCLE);
  const firstClose = lifecycle.close();
  const secondClose = lifecycle.close();
  assert.equal(firstClose, pool.endPromise);
  assert.equal(secondClose, firstClose);
  assert.equal(pool.endCalls, 1);

  pool.finishEnd();
  await firstClose;
  await moduleRef.close();
  assert.equal(pool.endCalls, 1);
});

test("SourcesRepository resolves in a standalone Nest application context", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL =
    "postgresql://standalone:unused@127.0.0.1:1/standalone";
  const application = await NestFactory.createApplicationContext(
    PersistenceFixtureModule,
    { logger: false },
  );

  try {
    assert.ok(application.get(SourcesRepository) instanceof SourcesRepository);
    assert.equal(application.get(PG_POOL), application.get(PG_POOL));
    assert.equal(application.get(DRIZZLE_DB), application.get(DRIZZLE_DB));
  } finally {
    await application.close();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("DatabaseModule can start and close repeatedly without reusing a closed Pool", async () => {
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const pool = new FakePool(true);
    const moduleRef = await testingContext(pool);
    await moduleRef.close();
    await moduleRef.close();
    assert.equal(pool.endCalls, 1);
  }
});

test("idle Pool errors expose only a sanitized event and code", () => {
  const pool = new FakePool(true);
  const reports: string[] = [];
  new DatabaseLifecycle(pool as unknown as Pool, (message) => {
    reports.push(message);
  });
  const secret = "postgresql://admin:super-secret@private-db/news";
  const idleError = Object.assign(new Error(secret), {
    code: "ECONNRESET",
    stack: `Error: ${secret}\n at private-host`,
  });

  pool.emit("error", idleError);

  assert.deepEqual(reports, [
    "PostgreSQL idle client error (ECONNRESET)",
  ]);
  assert.equal(reports[0].includes("super-secret"), false);
  assert.equal(reports[0].includes("private-host"), false);
});

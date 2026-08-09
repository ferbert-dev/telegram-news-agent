import assert from "node:assert/strict";
import test from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import type { DrizzleDatabase } from "../../src/database/drizzle-client.js";
import {
  postgresScalar,
  RepositorySupport,
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "../../src/database/repositories/repository-support.js";

const claimSourceDiscovery = postgresScalar<boolean>(
  "public.claim_source_discovery",
  1,
);

type RenderedQuery = {
  sql: string;
  params: unknown[];
};

function fakeDatabase(renderedQueries: RenderedQuery[]): DrizzleDatabase {
  const dialect = new PgDialect();
  const transactionExecutor = {
    async execute(query: SQL) {
      renderedQueries.push(dialect.sqlToQuery(query));
      return { rows: [{ value: true }] };
    },
  };
  return {
    ...transactionExecutor,
    async transaction<T>(
      task: (executor: typeof transactionExecutor) => Promise<T>,
    ) {
      return task(transactionExecutor);
    },
  } as unknown as DrizzleDatabase;
}

class RepositoryProbe extends RepositorySupport {
  constructor(pool: Pool, database: DrizzleDatabase) {
    super(pool, database);
  }

  async claim(value: string): Promise<boolean> {
    return this.functionScalar(
      "Claim source discovery",
      claimSourceDiscovery,
      [value],
    );
  }

  async claimInsideRolledBackTransaction(value: string): Promise<void> {
    return this.transaction("Rollback probe", async (transaction) => {
      await this.functionScalar(
        "Transactional source discovery claim",
        claimSourceDiscovery,
        [value],
        transaction,
      );
      throw new Error("force rollback");
    });
  }
}

const fakePool = { query() {} } as unknown as Pool;

test("function wrappers validate identifiers and keep values parameterized", async () => {
  assert.throws(
    () =>
      postgresScalar(
        "public.safe_function;drop_table" as `public.${string}`,
        1,
      ),
    /Invalid PostgreSQL function identifier/,
  );
  assert.throws(
    () =>
      postgresScalar(
        "private.safe_function" as `public.${string}`,
        1,
      ),
    /Invalid PostgreSQL function identifier/,
  );

  const renderedQueries: RenderedQuery[] = [];
  const repository = new RepositoryProbe(
    fakePool,
    fakeDatabase(renderedQueries),
  );
  const untrustedValue = "topic'); drop table public.sources; --";

  assert.equal(await repository.claim(untrustedValue), true);
  assert.deepEqual(renderedQueries, [
    {
      sql: 'select "public"."claim_source_discovery"($1) as value',
      params: [untrustedValue],
      typings: ["none"],
    },
  ]);
});

test("retained functions use the transaction-scoped executor and preserve errors", async () => {
  const renderedQueries: RenderedQuery[] = [];
  const repository = new RepositoryProbe(
    fakePool,
    fakeDatabase(renderedQueries),
  );

  await assert.rejects(
    repository.claimInsideRolledBackTransaction("transaction-topic"),
    /Rollback probe failed: force rollback/,
  );
  assert.equal(renderedQueries.length, 1);
  assert.deepEqual(renderedQueries[0].params, ["transaction-topic"]);
});

test("timestamp adapters preserve strings and explicitly normalize Date values", () => {
  const timestamp = "2026-08-09T10:11:12.345Z";
  assert.equal(toIsoTimestamp(timestamp), timestamp);
  assert.equal(toIsoTimestamp(new Date(timestamp)), timestamp);
  assert.equal(toNullableIsoTimestamp(null), null);
  assert.equal(toNullableIsoTimestamp(new Date(timestamp)), timestamp);
  assert.throws(
    () => toIsoTimestamp(new Date(Number.NaN)),
    /Invalid PostgreSQL timestamp/,
  );
});

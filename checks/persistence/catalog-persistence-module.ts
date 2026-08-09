import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import type { CatalogPersistence } from "../../src/catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../../src/catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";
import { PG_POOL } from "../../src/database/database.tokens.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const catalogMethods = [
  "listEnabledSources",
  "listEnabledArticleTags",
  "listSourceHealth",
  "upsertSource",
  "setSourceEnabled",
  "markSourceChecked",
  "markSourceFetchSuccess",
  "markSourceFetchFailure",
  "claimSourceDiscovery",
  "completeSourceDiscovery",
  "upsertDiscoveredSource",
] as const satisfies readonly (keyof CatalogPersistence)[];

@Injectable()
class CatalogConsumer {
  constructor(
    @Inject(CATALOG_PERSISTENCE)
    readonly persistence: CatalogPersistence,
  ) {}
}

@Module({
  imports: [CatalogPersistenceModule],
  providers: [CatalogConsumer],
})
class CatalogConsumerModule {}

class FakePool extends EventEmitter {
  endCalls = 0;

  query(): Promise<QueryResult> {
    throw new Error("Catalog module identity test must not query PostgreSQL");
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

test("CatalogPersistenceModule exports one narrow Symbol alias for eleven methods", async () => {
  const pool = new FakePool();
  const moduleRef = await Test.createTestingModule({
    imports: [CatalogConsumerModule],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool as unknown as Pool)
    .compile();

  try {
    await moduleRef.init();
    const consumer = moduleRef.get(CatalogConsumer);
    const repository = moduleRef.get(SourcesRepository);

    assert.equal(typeof CATALOG_PERSISTENCE, "symbol");
    assert.equal(consumer.persistence, repository);
    assert.ok(consumer.persistence instanceof SourcesRepository);
    assert.deepEqual(
      catalogMethods.filter(
        (method) => typeof consumer.persistence[method] !== "function",
      ),
      [],
    );
    assert.deepEqual(
      Reflect.getMetadata("exports", CatalogPersistenceModule),
      [CATALOG_PERSISTENCE],
    );
  } finally {
    await moduleRef.close();
  }

  assert.equal(pool.endCalls, 1);
});

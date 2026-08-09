import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import {
  MODULE_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants.js";

import { CatalogService } from "../../src/catalog/application/catalog.service.js";
import { CatalogApplicationModule } from "../../src/catalog/catalog-application.module.js";
import type {
  CatalogPersistence,
  CompleteSourceDiscoveryInput,
  SourceRow,
  SourceWithTopics,
  UpsertDiscoveredSourceInput,
  UpsertSourceInput,
} from "../../src/catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../../src/catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";

const SOURCE: SourceRow = {
  id: "source-1",
  name: "Example",
  homepage_url: "https://example.test/",
  feed_url: "https://example.test/feed.xml",
  source_type: "rss",
  reliability_score: 80,
  enabled: true,
  last_checked_at: null,
  created_at: "2026-08-09T08:00:00.000Z",
  updated_at: "2026-08-09T08:00:00.000Z",
  is_primary: true,
  last_success_at: null,
  last_failed_at: null,
  consecutive_failures: 0,
  last_error_code: null,
  disabled_until: null,
  discovered_by: "seed",
  discovery_metadata: {},
};
const SOURCE_WITH_TOPICS: SourceWithTopics = {
  ...SOURCE,
  topic_codes: ["science"],
};

test("CatalogService delegates all 11 catalogue, health, quarantine, and discovery methods without changing DTOs", async () => {
  const calls: unknown[] = [];
  const upsert: UpsertSourceInput = {
    name: "Example",
    feed_url: "https://example.test/feed.xml",
    source_type: "rss",
  };
  const complete: CompleteSourceDiscoveryInput = {
    topicKey: "topic-key",
    provider: "openai",
    model: "model",
    resultCount: 1,
    errorCode: null,
  };
  const discovered: UpsertDiscoveredSourceInput = {
    name: "Discovered",
    homepageUrl: "https://discovered.test/",
    feedUrl: "https://discovered.test/feed.xml",
    topicCodes: ["science"],
    discoveredBy: "openai",
    discoveryMetadata: { source: "search" },
  };
  const persistence: CatalogPersistence = {
    async listEnabledSources() {
      calls.push(["listEnabledSources"]);
      return [SOURCE_WITH_TOPICS];
    },
    async listEnabledArticleTags(languageCode) {
      calls.push(["listEnabledArticleTags", languageCode]);
      return [{
        topic_id: "topic-1",
        code: "science",
        description: null,
        language_code: languageCode,
        label: "Science",
        hashtag: "#Science",
      }];
    },
    async listSourceHealth() {
      calls.push(["listSourceHealth"]);
      return [SOURCE_WITH_TOPICS];
    },
    async upsertSource(input) {
      calls.push(["upsertSource", input]);
      return SOURCE;
    },
    async setSourceEnabled(id, enabled) {
      calls.push(["setSourceEnabled", id, enabled]);
      return SOURCE;
    },
    async markSourceChecked(id) {
      calls.push(["markSourceChecked", id]);
      return SOURCE;
    },
    async markSourceFetchSuccess(id) {
      calls.push(["markSourceFetchSuccess", id]);
      return SOURCE;
    },
    async markSourceFetchFailure(id, errorCode) {
      calls.push(["markSourceFetchFailure", id, errorCode]);
      return SOURCE;
    },
    async claimSourceDiscovery(topicKey) {
      calls.push(["claimSourceDiscovery", topicKey]);
      return false;
    },
    async completeSourceDiscovery(input) {
      calls.push(["completeSourceDiscovery", input]);
      return true;
    },
    async upsertDiscoveredSource(input) {
      calls.push(["upsertDiscoveredSource", input]);
      return SOURCE;
    },
  };
  const service = new CatalogService(persistence);

  assert.equal((await service.listEnabledSources())[0], SOURCE_WITH_TOPICS);
  assert.equal((await service.listEnabledArticleTags("de"))[0].language_code, "de");
  assert.equal((await service.listSourceHealth())[0], SOURCE_WITH_TOPICS);
  assert.equal(await service.upsertSource(upsert), SOURCE);
  assert.equal(await service.setSourceEnabled("source-1", false), SOURCE);
  assert.equal(await service.markSourceChecked("source-1"), SOURCE);
  assert.equal(await service.markSourceFetchSuccess("source-1"), SOURCE);
  assert.equal(
    await service.markSourceFetchFailure("source-1", "http_503"),
    SOURCE,
  );
  assert.equal(await service.claimSourceDiscovery("topic-key"), false);
  assert.equal(await service.completeSourceDiscovery(complete), true);
  assert.equal(await service.upsertDiscoveredSource(discovered), SOURCE);

  assert.equal((calls[3] as unknown[])[1], upsert);
  assert.deepEqual(calls[4], ["setSourceEnabled", "source-1", false]);
  assert.deepEqual(calls[7], [
    "markSourceFetchFailure",
    "source-1",
    "http_503",
  ]);
  assert.equal((calls[9] as unknown[])[1], complete);
  assert.equal((calls[10] as unknown[])[1], discovered);
});

test("CatalogService preserves repository error identity", async () => {
  const failure = new Error("catalog unavailable");
  const persistence = new Proxy(
    {},
    {
      get() {
        return async () => {
          throw failure;
        };
      },
    },
  ) as CatalogPersistence;
  const service = new CatalogService(persistence);

  await assert.rejects(
    service.markSourceFetchFailure("source-1", "timeout"),
    (error) => error === failure,
  );
});

test("Catalog application composition injects only the narrow Symbol and exports only CatalogService", () => {
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, CatalogService),
    [{ index: 0, param: CATALOG_PERSISTENCE }],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.IMPORTS, CatalogApplicationModule),
    [CatalogPersistenceModule],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.PROVIDERS, CatalogApplicationModule),
    [CatalogService],
  );
  assert.deepEqual(
    Reflect.getMetadata(MODULE_METADATA.EXPORTS, CatalogApplicationModule),
    [CatalogService],
  );
});

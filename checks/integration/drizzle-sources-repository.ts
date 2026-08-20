import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Drizzle SourcesRepository preserves the current source contract",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 2 });
    const repository = new SourcesRepository(
      pool,
      createDrizzleDatabase(pool),
    );
    const suffix = randomUUID();
    const topicKey = suffix.replaceAll("-", "").padEnd(64, "0");
    let sourceId: string | null = null;
    let discoveredSourceId: string | null = null;

    try {
      const source = await repository.upsertSource({
        name: `Drizzle Integration ${suffix}`,
        homepage_url: "https://integration.test",
        feed_url: `https://integration.test/${suffix}.xml`,
        source_type: "rss",
        reliability_score: 90,
        enabled: true,
        is_primary: true,
      });
      sourceId = source.id;

      const germanTags = await repository.listEnabledArticleTags(" DE ");
      assert.ok(
        germanTags.some(
          (tag) =>
            tag.code === "science" &&
            tag.language_code === "de" &&
            tag.hashtag === "#Wissenschaft",
        ),
      );

      assert.ok(
        (await repository.listEnabledSources()).some(
          (candidate) => candidate.id === source.id,
        ),
      );
      assert.equal(
        (await repository.setSourceEnabled(source.id, false)).enabled,
        false,
      );
      assert.equal(
        (await repository.setSourceEnabled(source.id, true)).enabled,
        true,
      );
      assert.ok((await repository.markSourceChecked(source.id)).last_checked_at);

      await repository.markSourceFetchFailure(source.id, "http_503");
      await repository.markSourceFetchFailure(source.id, "http_503");
      const quarantined = await repository.markSourceFetchFailure(
        source.id,
        "http_503",
      );
      assert.equal(quarantined.consecutive_failures, 3);
      assert.ok(quarantined.disabled_until);
      assert.equal(
        (await repository.listEnabledSources()).some(
          (candidate) => candidate.id === source.id,
        ),
        false,
      );

      const healthy = await repository.markSourceFetchSuccess(source.id);
      assert.equal(healthy.consecutive_failures, 0);
      assert.equal(healthy.disabled_until, null);

      assert.equal(await repository.claimSourceDiscovery(topicKey), true);
      assert.equal(await repository.claimSourceDiscovery(topicKey), false);
      const discovered = await repository.upsertDiscoveredSource({
        name: `Drizzle Discovered ${suffix}`,
        homepageUrl: "https://discovered.integration.test",
        feedUrl: `https://discovered.integration.test/${suffix}.xml`,
        reliabilityScore: 65,
        topicCodes: ["science"],
        discoveredBy: "exa",
        discoveryMetadata: { integration: true },
      });
      discoveredSourceId = discovered.id;
      assert.equal(discovered.discovered_by, "exa");

      const discoveredWithTopics = (await repository.listEnabledSources()).find(
        (candidate) => candidate.id === discovered.id,
      );
      assert.deepEqual(discoveredWithTopics?.topic_codes, ["science"]);
      assert.ok(
        (await repository.listSourceHealth()).some(
          (candidate) => candidate.id === source.id,
        ),
      );
      assert.equal(
        await repository.completeSourceDiscovery({
          topicKey,
          provider: "exa",
          model: "exa-search:auto",
          resultCount: 1,
        }),
        true,
      );
    } finally {
      if (discoveredSourceId) {
        await pool
          .query("delete from public.sources where id = $1", [discoveredSourceId])
          .catch(() => {});
      }
      if (sourceId) {
        await pool
          .query("delete from public.sources where id = $1", [sourceId])
          .catch(() => {});
      }
      await pool
        .query("delete from public.source_discovery_state where topic_key = $1", [
          topicKey,
        ])
        .catch(() => {});
      await pool.end();
    }
  },
);

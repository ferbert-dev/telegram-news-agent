import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { CatalogService } from "../../src/catalog/application/catalog.service.js";
import { CatalogApplicationModule } from "../../src/catalog/catalog-application.module.js";
import { PG_POOL } from "../../src/database/database.tokens.js";
import { ResearchService } from "../../src/research/application/research.service.js";
import {
  ResearchApplicationModule,
  type ResearchApplicationGateways,
} from "../../src/research/research-application.module.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Catalog and Research application services preserve PostgreSQL health, idempotency, resume, and recovery behavior",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const suffix = randomUUID();
    const discoveryKey = suffix.replaceAll("-", "").padEnd(64, "0");
    const responseId = `catalog-research-${suffix}`;
    const canonicalUrl = `https://catalog-research.test/articles/${suffix}`;
    const skippedUrl = `${canonicalUrl}/already-extracted`;
    const expectedFailure = new Error("research execution failed");
    const sourceIds: string[] = [];
    const searchRunIds: string[] = [];
    const articleIds: string[] = [];

    const gateways: ResearchApplicationGateways = {
      ai: {
        async generate() {
          return { output: {}, usageEvents: [] };
        },
      },
      search: {
        async search() {
          return { items: [], usageEvents: [] };
        },
      },
      fetch: {
        async fetch(request) {
          return {
            finalUrl: request.url,
            content: "unused",
            contentType: "text",
            contentHash: `unused-${suffix}`,
          };
        },
      },
      execution: {
        async execute(request, signal) {
          if (signal) assert.equal(signal.aborted, false);
          if (request.input.query.includes("failure")) throw expectedFailure;
          return {
            candidates: [
              {
                article: {
                  source_id: request.input.sourceId ?? null,
                  search_run_id: request.searchRun.id,
                  canonical_url: canonicalUrl,
                  title: "Application research candidate",
                  author: "Codex",
                  published_at: "2026-08-09T08:00:00.000Z",
                  content_hash: `article-${suffix}`,
                  metadata: { integration: true },
                },
                rawContents: [
                  {
                    content: "Grounded application evidence",
                    content_type: "text",
                    language_code: "en",
                    extractor: "application-integration",
                    content_hash: `raw-${suffix}`,
                    metadata: { grounded: true },
                  },
                ],
              },
              {
                article: {
                  source_id: request.input.sourceId ?? null,
                  search_run_id: request.searchRun.id,
                  canonical_url: skippedUrl,
                  title: "Must not resume an extracted article",
                  author: null,
                  published_at: null,
                  content_hash: `skipped-${suffix}`,
                  metadata: { must_not_resume: true },
                },
                rawContents: [
                  {
                    content: "Must not be written",
                    content_hash: `skipped-raw-${suffix}`,
                  },
                ],
              },
            ],
            usageEvents: [
              {
                provider: "openai",
                providerResponseId: responseId,
                model: "integration-model",
                operation: "research",
                searchRunId: request.searchRun.id,
                inputTokens: 30,
                outputTokens: 10,
                estimatedCostUsd: "0.00100000",
              },
              {
                provider: "openai",
                providerResponseId: responseId,
                model: "must-not-overwrite",
                operation: "research-retry",
                searchRunId: request.searchRun.id,
              },
            ],
            finish: { metadata: { grounded: true } },
          };
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogApplicationModule,
        ResearchApplicationModule.register(gateways),
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    await moduleRef.init();

    const catalog = moduleRef.get(CatalogService);
    const research = moduleRef.get(ResearchService);

    try {
      const source = await catalog.upsertSource({
        name: `Catalog Research ${suffix}`,
        homepage_url: "https://catalog-research.test",
        feed_url: `https://catalog-research.test/${suffix}.xml`,
        source_type: "rss",
        reliability_score: 90,
        enabled: true,
        is_primary: true,
      });
      sourceIds.push(source.id);

      await catalog.markSourceFetchFailure(source.id, "http_503");
      await catalog.markSourceFetchFailure(source.id, "http_503");
      const quarantined = await catalog.markSourceFetchFailure(
        source.id,
        "http_503",
      );
      assert.equal(quarantined.consecutive_failures, 3);
      assert.ok(quarantined.disabled_until);
      assert.equal(
        (await catalog.listEnabledSources()).some((row) => row.id === source.id),
        false,
      );
      const restored = await catalog.markSourceFetchSuccess(source.id);
      assert.equal(restored.consecutive_failures, 0);
      assert.equal(restored.disabled_until, null);

      assert.equal(await catalog.claimSourceDiscovery(discoveryKey), true);
      assert.equal(await catalog.claimSourceDiscovery(discoveryKey), false);
      const discovered = await catalog.upsertDiscoveredSource({
        name: `Discovered Catalog Research ${suffix}`,
        homepageUrl: "https://discovered.catalog-research.test",
        feedUrl: `https://discovered.catalog-research.test/${suffix}.xml`,
        reliabilityScore: 70,
        topicCodes: ["science"],
        discoveredBy: "openai",
        discoveryMetadata: { integration: true },
      });
      sourceIds.push(discovered.id);
      assert.equal(
        await catalog.completeSourceDiscovery({
          topicKey: discoveryKey,
          provider: "openai",
          model: "integration-model",
          resultCount: 1,
        }),
        true,
      );

      const extractedArticle = await pool.query<{ id: string }>(
        `insert into public.articles
          (source_id, canonical_url, title, status, content_hash)
         values ($1, $2, $3, 'extracted', $4)
         returning id`,
        [source.id, skippedUrl, "Existing extracted article", `existing-${suffix}`],
      );
      articleIds.push(extractedArticle.rows[0].id);

      const controller = new AbortController();
      const result = await research.runResearch(
        {
          query: `catalog research success ${suffix}`,
          sourceId: source.id,
          metadata: { integration: true },
        },
        controller.signal,
      );
      searchRunIds.push(result.run.id);
      articleIds.push(...result.candidates.map(({ article }) => article.id));
      assert.equal(result.completedRun.status, "completed");
      assert.equal(result.completedRun.result_count, 1);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].rawContents.length, 1);
      assert.equal(result.usageEvents.length, 2);
      assert.equal(result.usageEvents[0].id, result.usageEvents[1].id);
      assert.equal(result.usageEvents[1].model, "integration-model");

      const usageCount = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from public.ai_usage_events
         where provider = 'openai' and provider_response_id = $1`,
        [responseId],
      );
      assert.equal(usageCount.rows[0].count, "1");
      const skippedRawCount = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from public.raw_contents
         where article_id = $1`,
        [extractedArticle.rows[0].id],
      );
      assert.equal(skippedRawCount.rows[0].count, "0");

      await assert.rejects(
        research.runResearch({ query: `catalog research failure ${suffix}` }),
        (error) => error === expectedFailure,
      );
      const failedRun = await pool.query<{
        id: string;
        status: string;
        error: string;
      }>(
        `select id, status, error
         from public.search_runs
         where query = $1`,
        [`catalog research failure ${suffix}`],
      );
      assert.equal(failedRun.rows.length, 1);
      assert.equal(failedRun.rows[0].status, "failed");
      assert.equal(failedRun.rows[0].error, expectedFailure.message);
      searchRunIds.push(failedRun.rows[0].id);
    } finally {
      await pool
        .query(
          "delete from public.ai_usage_events where provider_response_id = $1",
          [responseId],
        )
        .catch(() => {});
      if (articleIds.length) {
        await pool
          .query("delete from public.articles where id = any($1::uuid[])", [
            articleIds,
          ])
          .catch(() => {});
      }
      if (searchRunIds.length) {
        await pool
          .query("delete from public.search_runs where id = any($1::uuid[])", [
            searchRunIds,
          ])
          .catch(() => {});
      }
      if (sourceIds.length) {
        await pool
          .query("delete from public.sources where id = any($1::uuid[])", [
            sourceIds,
          ])
          .catch(() => {});
      }
      await pool
        .query(
          "delete from public.source_discovery_state where topic_key = $1",
          [discoveryKey],
        )
        .catch(() => {});
      await moduleRef.close().catch(() => {});
    }
  },
);

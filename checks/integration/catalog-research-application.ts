import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { CatalogService } from "../../src/catalog/application/catalog.service.js";
import { CatalogApplicationModule } from "../../src/catalog/catalog-application.module.js";
import type { CatalogPersistence } from "../../src/catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../../src/catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";
import { PG_POOL } from "../../src/database/database.tokens.js";
import { ResearchService } from "../../src/research/application/research.service.js";
import { RunResearchUseCase } from "../../src/research/application/run-research.use-case.js";
import type {
  ResearchExecutionGateway,
  ResearchExecutionRequest,
  RunResearchResult,
} from "../../src/research/research-gateway.contracts.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../../src/research/research-gateway.tokens.js";
import type { ResearchIngestionPersistence } from "../../src/research/research-persistence.contracts.js";
import { ResearchPersistenceModule } from "../../src/research/research-persistence.module.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../../src/research/research-persistence.tokens.js";
import type { UsageReportingPersistence } from "../../src/usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Catalog ports plus a research execution gateway preserve PostgreSQL health, idempotency, resume, and failure behavior",
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
    let activeSourceId = "";

    /**
     * Test-local stand-in for RESEARCH_EXECUTION_GATEWAY. It runs the same
     * repository sequence the deleted LegacyResearchExecutionGateway used to
     * hand to the legacy `runResearch` algorithm (start a run, look up the
     * enabled source, record usage twice under the same provider response id,
     * create-or-resume two article candidates, save raw content, finish or
     * fail the run) but calls the typed persistence ports directly instead of
     * routing through that adapter.
     */
    class InstrumentedResearchExecutionGateway
      implements ResearchExecutionGateway
    {
      constructor(
        private readonly catalog: Pick<
          CatalogPersistence,
          "listEnabledSources"
        >,
        private readonly research: Pick<
          ResearchIngestionPersistence,
          | "startSearchRun"
          | "finishSearchRun"
          | "failSearchRun"
          | "createOrResumeArticleCandidate"
          | "saveRawContent"
        >,
        private readonly usage: Pick<
          UsageReportingPersistence,
          "recordAiUsage"
        >,
      ) {}

      async execute(
        request: ResearchExecutionRequest,
      ): Promise<RunResearchResult> {
        const input = request.input;
        const run = await this.research.startSearchRun({
          query: input.query,
          metadata: {
            keywords: input.keywords ?? [],
            window_hours: input.windowHours ?? 48,
            news_settings: input.newsSettings ?? null,
          },
        });
        try {
          if (input.query.includes("failure")) throw expectedFailure;

          const sources = await this.catalog.listEnabledSources();
          const source = sources.find((row) => row.id === activeSourceId);
          assert.ok(source);
          await this.usage.recordAiUsage({
            provider: "openai",
            providerResponseId: responseId,
            model: "integration-model",
            operation: "research",
            searchRunId: run.id,
            inputTokens: 30,
            outputTokens: 10,
            estimatedCostUsd: "0.00100000",
          });
          await this.usage.recordAiUsage({
            provider: "openai",
            providerResponseId: responseId,
            model: "must-not-overwrite",
            operation: "research-retry",
            searchRunId: run.id,
          });

          const article = await this.research.createOrResumeArticleCandidate({
            source_id: source.id,
            search_run_id: run.id,
            canonical_url: canonicalUrl,
            title: "Application research candidate",
            author: "Codex",
            published_at: "2026-08-09T08:00:00.000Z",
            content_hash: `article-${suffix}`,
            metadata: { integration: true },
          });
          assert.ok(article);
          await this.research.saveRawContent({
            article_id: article.id,
            content: "Grounded application evidence",
            content_type: "text",
            language_code: "en",
            extractor: "application-integration",
            content_hash: `raw-${suffix}`,
            metadata: { grounded: true },
          });

          const skipped = await this.research.createOrResumeArticleCandidate({
            source_id: source.id,
            search_run_id: run.id,
            canonical_url: skippedUrl,
            title: "Must not resume an extracted article",
            author: null,
            published_at: null,
            content_hash: `skipped-${suffix}`,
            metadata: { must_not_resume: true },
          });
          assert.equal(skipped, null);

          await this.research.finishSearchRun(run.id, {
            resultCount: 1,
            metadata: {
              selected_article_id: article.id,
              grounded: true,
            },
          });
          const selected = {
            article,
            source,
            canonicalUrl,
            title: article.title,
            summary: "Grounded application evidence",
            author: article.author,
            publishedAt: article.published_at,
            contentHash: article.content_hash ?? "",
            score: 100,
            evidenceText: "Grounded application evidence",
          };
          return {
            runId: run.id,
            selected,
            candidates: [selected],
            feedErrors: [],
            extractionErrors: [],
          };
        } catch (error) {
          await this.research.failSearchRun(run.id, error);
          throw error;
        }
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogApplicationModule,
        CatalogPersistenceModule,
        ResearchPersistenceModule,
        UsagePersistenceModule,
      ],
      providers: [
        {
          provide: RESEARCH_EXECUTION_GATEWAY,
          useFactory: (
            catalog: CatalogPersistence,
            research: ResearchIngestionPersistence,
            usage: UsageReportingPersistence,
          ) =>
            new InstrumentedResearchExecutionGateway(catalog, research, usage),
          inject: [
            CATALOG_PERSISTENCE,
            RESEARCH_INGESTION_PERSISTENCE,
            USAGE_REPORTING_PERSISTENCE,
          ],
        },
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    await moduleRef.init();

    const catalog = moduleRef.get(CatalogService);
    const gateway = moduleRef.get<ResearchExecutionGateway>(
      RESEARCH_EXECUTION_GATEWAY,
    );
    const research = new ResearchService(
      moduleRef.get<ResearchIngestionPersistence>(
        RESEARCH_INGESTION_PERSISTENCE,
      ),
      moduleRef.get<UsageReportingPersistence>(USAGE_REPORTING_PERSISTENCE),
      new RunResearchUseCase(gateway),
    );

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
      activeSourceId = source.id;
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
      await catalog.markSourceFetchSuccess(source.id);

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

      const result = await research.runResearch({
        query: `catalog research success ${suffix}`,
        keywords: ["science"],
        windowHours: 48,
        newsSettings: { topicCodes: ["science"] },
      });
      searchRunIds.push(result.runId);
      articleIds.push(...result.candidates.map(({ article }) => article.id));
      assert.equal(result.selected.article.id, result.candidates[0].article.id);

      const completedRun = await pool.query<{
        status: string;
        result_count: number;
      }>(
        "select status, result_count from public.search_runs where id = $1",
        [result.runId],
      );
      assert.equal(completedRun.rows[0].status, "completed");
      assert.equal(completedRun.rows[0].result_count, 1);

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
        `select id, status, error from public.search_runs where query = $1`,
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

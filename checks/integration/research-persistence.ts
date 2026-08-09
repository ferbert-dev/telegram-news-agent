import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Research persistence preserves deduplication, recovery, CAS, extraction, and concurrent topic replacement",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const database = createDrizzleDatabase(pool);
    const sourceRepository = new SourcesRepository(pool, database);
    const repository = new ResearchIngestionRepository(pool, database);
    const suffix = randomUUID();
    let sourceId: string | null = null;
    const searchRunIds: string[] = [];
    const articleIds: string[] = [];

    try {
      const source = await sourceRepository.upsertSource({
        name: `Research Persistence ${suffix}`,
        homepage_url: "https://research-persistence.test",
        feed_url: `https://research-persistence.test/${suffix}.xml`,
        source_type: "rss",
        reliability_score: 90,
        enabled: true,
        is_primary: true,
      });
      sourceId = source.id;

      const run = await repository.startSearchRun({
        query: `research persistence ${suffix}`,
        sourceId,
        metadata: { integration: true },
      });
      searchRunIds.push(run.id);
      assert.equal(run.status, "running");
      assert.equal(new Date(run.started_at).toISOString(), run.started_at);

      const canonicalUrl = `https://research-persistence.test/articles/${suffix}`;
      const candidateInput = {
        source_id: sourceId,
        search_run_id: run.id,
        canonical_url: canonicalUrl,
        title: "Research persistence candidate",
        author: "Codex",
        published_at: new Date().toISOString(),
        content_hash: `candidate-${suffix}`,
        metadata: { initial: true },
      };
      const candidates = await Promise.all([
        repository.createOrResumeArticleCandidate(candidateInput),
        repository.createOrResumeArticleCandidate({
          ...candidateInput,
          title: "Research persistence candidate resumed",
          metadata: { resumed: true },
        }),
      ]);
      assert.ok(candidates[0]);
      assert.ok(candidates[1]);
      const articleId = candidates[0].id;
      articleIds.push(articleId);
      assert.equal(candidates[1].id, articleId);

      const deduplicated = await pool.query<{
        id: string;
        count: string;
        metadata: Record<string, unknown>;
      }>(
        `select min(id::text) as id, count(*)::text as count,
                (array_agg(metadata order by updated_at desc))[1] as metadata
         from public.articles
         where canonical_url = $1
         group by canonical_url`,
        [canonicalUrl],
      );
      assert.equal(deduplicated.rows[0].count, "1");
      assert.equal(deduplicated.rows[0].id, articleId);
      assert.equal(deduplicated.rows[0].metadata.initial, true);
      assert.equal(deduplicated.rows[0].metadata.resumed, true);

      const rawInput = {
        article_id: articleId,
        content: "Initial extracted evidence",
        content_type: "text" as const,
        language_code: "en",
        extractor: "integration-initial",
        content_hash: `raw-${suffix}`,
        metadata: { extraction: "initial" },
      };
      const firstRaw = await repository.saveRawContent(rawInput);
      const updatedRaw = await repository.saveRawContent({
        ...rawInput,
        content: "Recovered extracted evidence",
        extractor: "integration-recovery",
        metadata: { extraction: "recovered" },
      });
      assert.equal(updatedRaw.id, firstRaw.id);
      assert.equal(updatedRaw.content, "Recovered extracted evidence");
      assert.equal(updatedRaw.extractor, "integration-recovery");
      assert.equal(
        new Date(updatedRaw.fetched_at).toISOString(),
        updatedRaw.fetched_at,
      );
      const rawCount = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from public.raw_contents
         where article_id = $1 and content_hash = $2`,
        [articleId, rawInput.content_hash],
      );
      assert.equal(rawCount.rows[0].count, "1");

      const extracted = await repository.transitionArticle(
        articleId,
        "discovered",
        "extracted",
        { metadata: { extracted: true } },
      );
      assert.equal(extracted.status, "extracted");
      assert.equal(
        new Date(extracted.updated_at).toISOString(),
        extracted.updated_at,
      );
      await assert.rejects(
        repository.transitionArticle(
          articleId,
          "discovered",
          "extracted",
        ),
        /Transition article discovered -> extracted failed: expected one row, received 0/,
      );
      assert.equal(
        await repository.createOrResumeArticleCandidate({
          ...candidateInput,
          title: "Must not overwrite extracted article",
          metadata: { forbidden_resume: true },
        }),
        null,
      );

      const assigned = await repository.replaceArticleTopics({
        articleId,
        assignments: [
          { code: "science", confidence: 0.95 },
          { code: "nature", confidence: 0.8 },
        ],
        assignedModel: "integration-tagger",
      });
      assert.equal(assigned.length, 2);
      assert.ok(
        assigned.every(
          (row) =>
            typeof row.relevance_score === "string" &&
            row.assignment_source === "ai" &&
            row.assigned_model === "integration-tagger",
        ),
      );
      await assert.rejects(
        repository.replaceArticleTopics({
          articleId,
          assignments: [
            { code: "ai", confidence: 0.9 },
            { code: "world", confidence: 0.8 },
            { code: "science", confidence: 0.7 },
            { code: "nature", confidence: 0.6 },
          ],
        }),
        /At most 3 article topics may be assigned/,
      );
      await assert.rejects(
        repository.replaceArticleTopics({
          articleId,
          assignments: [
            { code: "not-in-the-catalog", confidence: 0.9 },
          ],
        }),
        /Assignments must reference enabled topic codes/,
      );

      await Promise.all([
        repository.replaceArticleTopics({
          articleId,
          assignments: [{ code: "science", confidence: 0.91 }],
          assignmentSource: "rule",
        }),
        repository.replaceArticleTopics({
          articleId,
          assignments: [
            { code: "nature", confidence: 0.88 },
            { code: "animals", confidence: 0.77 },
          ],
          assignmentSource: "manual",
        }),
      ]);
      const finalTopics = await pool.query<{ code: string }>(
        `select topic.name as code
         from public.article_topics as article_topic
         join public.topics as topic on topic.id = article_topic.topic_id
         where article_topic.article_id = $1
         order by topic.name`,
        [articleId],
      );
      const finalCodes = finalTopics.rows.map((row) => row.code);
      assert.ok(
        JSON.stringify(finalCodes) === JSON.stringify(["science"]) ||
          JSON.stringify(finalCodes) === JSON.stringify(["animals", "nature"]),
        `concurrent replacement must leave one complete assignment set, received ${JSON.stringify(finalCodes)}`,
      );

      const completed = await repository.finishSearchRun(run.id, {
        resultCount: 1,
        metadata: { selected_article_id: articleId },
      });
      assert.equal(completed.status, "completed");
      assert.equal(completed.result_count, 1);
      assert.ok(completed.finished_at);
      await assert.rejects(
        repository.finishSearchRun(run.id, { resultCount: 1 }),
        /Complete search run failed: expected one row, received 0/,
      );

      const failedRun = await repository.startSearchRun({
        query: `research failure ${suffix}`,
      });
      searchRunIds.push(failedRun.id);
      const failed = await repository.failSearchRun(
        failedRun.id,
        new Error("provider unavailable"),
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, "provider unavailable");
      assert.ok(failed.finished_at);
      await assert.rejects(
        repository.failSearchRun(failedRun.id, "late failure"),
        /Fail search run failed: expected one row, received 0/,
      );
    } finally {
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
      if (sourceId) {
        await pool
          .query("delete from public.sources where id = $1", [sourceId])
          .catch(() => {});
      }
      await pool.end();
    }
  },
);

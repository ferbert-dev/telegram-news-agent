import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EditorialRepository } from "../../src/database/repositories/editorial-repository.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Editorial persistence preserves rollback, one-active-draft, approval CAS, publication idempotency, receipts, and recovery",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 12 });
    const database = createDrizzleDatabase(pool);
    const sourcesRepository = new SourcesRepository(pool, database);
    const researchRepository = new ResearchIngestionRepository(pool, database);
    const repository = new EditorialRepository(pool, database);
    const suffix = randomUUID();
    const articleIds: string[] = [];
    const searchRunIds: string[] = [];
    let sourceId: string | null = null;
    let messageId = 91_000;

    const createCandidate = async (name: string) => {
      const run = await researchRepository.startSearchRun({
        query: `editorial ${name} ${suffix}`,
        sourceId,
        metadata: { integration: true },
      });
      searchRunIds.push(run.id);
      const article = await researchRepository.createOrResumeArticleCandidate({
        source_id: sourceId,
        search_run_id: run.id,
        canonical_url: `https://editorial-persistence.test/${suffix}/${name}`,
        title: `Editorial ${name}`,
        author: null,
        published_at: null,
        content_hash: `${suffix}-${name}`,
        metadata: { integration: true },
      });
      assert.ok(article);
      articleIds.push(article.id);
      return article;
    };

    try {
      const source = await sourcesRepository.upsertSource({
        name: `Editorial Persistence ${suffix}`,
        homepage_url: "https://editorial-persistence.test",
        feed_url: `https://editorial-persistence.test/${suffix}.xml`,
        source_type: "rss",
        reliability_score: 90,
        enabled: true,
        is_primary: true,
      });
      sourceId = source.id;

      const publishArticle = await createCandidate("publish");
      await assert.rejects(
        repository.createReviewDraft({
          article_id: publishArticle.id,
          body: "This transaction must roll back with invalid topics.",
          model: "integration-model",
          topic_assignments: [
            { code: "not-in-the-catalog", confidence: 0.9 },
          ],
          topic_assigned_model: "integration-tagger",
        }),
        /Assignments must reference enabled topic codes/,
      );
      const rolledBack = await pool.query<{
        status: string;
        draft_count: number;
      }>(
        `select article.status,
                (select count(*)::integer from public.drafts
                 where article_id = article.id) as draft_count
         from public.articles as article
         where article.id = $1`,
        [publishArticle.id],
      );
      assert.equal(rolledBack.rows[0].status, "discovered");
      assert.equal(rolledBack.rows[0].draft_count, 0);

      const concurrentDrafts = await Promise.allSettled([
        repository.createReviewDraft({
          article_id: publishArticle.id,
          body: "First concurrent grounded draft.",
          model: "integration-model",
          topic_assignments: [{ code: "science", confidence: 0.99 }],
          topic_assigned_model: "integration-tagger",
        }),
        repository.createReviewDraft({
          article_id: publishArticle.id,
          body: "Second concurrent grounded draft.",
          model: "integration-model",
          topic_assignments: [{ code: "nature", confidence: 0.98 }],
          topic_assigned_model: "integration-tagger",
        }),
      ]);
      const draftSuccesses = concurrentDrafts.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.createReviewDraft>>> =>
          result.status === "fulfilled",
      );
      const draftFailures = concurrentDrafts.filter(
        (result) => result.status === "rejected",
      );
      assert.equal(draftSuccesses.length, 1);
      assert.equal(draftFailures.length, 1);
      const publishDraft = draftSuccesses[0].value;
      assert.ok(publishDraft);
      assert.equal(publishDraft.status, "review");

      const persistedDraftCount = await pool.query<{ count: string }>(
        "select count(*)::text as count from public.drafts where article_id = $1",
        [publishArticle.id],
      );
      assert.equal(persistedDraftCount.rows[0].count, "1");
      assert.equal(
        (await repository.getDraft(publishDraft.id)).articles.id,
        publishArticle.id,
      );
      assert.ok(
        (await repository.listDrafts("review")).some(
          (draft) => draft.id === publishDraft.id,
        ),
      );

      const approved = await repository.approveDraft(publishDraft.id);
      assert.equal(approved?.status, "approved");
      await assert.rejects(
        repository.approveDraft(publishDraft.id),
        /Draft is not in review state/,
      );

      const concurrentClaims = await Promise.allSettled([
        repository.claimDraftForPublication(publishDraft.id),
        repository.claimDraftForPublication(publishDraft.id),
      ]);
      assert.equal(
        concurrentClaims.filter((result) => result.status === "fulfilled")
          .length,
        1,
      );
      assert.equal(
        concurrentClaims.filter((result) => result.status === "rejected")
          .length,
        1,
      );

      messageId += 1;
      const receipt = await repository.finalizeDraftPublication({
        draftId: publishDraft.id,
        channelId: `@editorial_${suffix.replaceAll("-", "")}`,
        messageId,
        messageText: "Published editorial integration message.",
        metadata: { telegram_delivery: "confirmed" },
      });
      assert.ok(receipt);
      assert.equal(receipt.telegram_message_id, messageId);
      assert.equal(receipt.metadata.telegram_delivery, "confirmed");
      assert.equal(
        (await repository.findPublicationByDraft(publishDraft.id))?.id,
        receipt.id,
      );
      await assert.rejects(
        repository.claimDraftForPublication(publishDraft.id),
        /Draft is already published/,
      );

      const recoveryArticle = await createCandidate("recovery");
      const recoveryDraft = await repository.createReviewDraft({
        article_id: recoveryArticle.id,
        body: "Recovery workflow draft.",
        model: "integration-model",
      });
      assert.ok(recoveryDraft);
      await repository.approveDraft(recoveryDraft.id);
      await repository.claimDraftForPublication(recoveryDraft.id);
      assert.equal(
        (await repository.releaseRejectedDraftPublication(recoveryDraft.id))
          ?.status,
        "approved",
      );
      await repository.claimDraftForPublication(recoveryDraft.id);
      await assert.rejects(
        repository.resetDraftPublication(recoveryDraft.id, "NOT_SENT"),
        /Exact TELEGRAM_NOT_SENT confirmation is required/,
      );
      assert.equal(
        (
          await repository.resetDraftPublication(
            recoveryDraft.id,
            "TELEGRAM_NOT_SENT",
          )
        )?.status,
        "approved",
      );
      const rejected = await repository.rejectDraft(
        recoveryDraft.id,
        "Editorial policy rejection",
      );
      assert.equal(rejected?.status, "rejected");
      assert.equal(rejected?.reviewer_notes, "Editorial policy rejection");

      const typedArticle = await createCandidate("typed-cas");
      const typedDraft = await repository.createDraft({
        article_id: typedArticle.id,
        body: "Typed compatibility draft.",
        status: null,
        model: null,
      });
      assert.equal(typedDraft.status, "draft");
      assert.equal(typedDraft.model, null);
      await assert.rejects(
        repository.createDraft({
          article_id: typedArticle.id,
          body: "Must violate one active draft.",
        }),
        /duplicate key value violates unique constraint "drafts_one_active_article_idx"/,
      );
      const transitionResults = await Promise.allSettled([
        repository.transitionDraft(typedDraft.id, "draft", "review"),
        repository.transitionDraft(typedDraft.id, "draft", "review"),
      ]);
      assert.equal(
        transitionResults.filter((result) => result.status === "fulfilled")
          .length,
        1,
      );
      assert.equal(
        transitionResults.filter((result) => result.status === "rejected")
          .length,
        1,
      );

      const recordArticle = await createCandidate("record-publication");
      const recordDraft = await repository.createDraft({
        article_id: recordArticle.id,
        body: "Compatibility publication draft.",
        status: "approved",
      });
      messageId += 1;
      const recorded = await repository.recordPublication({
        draft_id: recordDraft.id,
        article_id: recordArticle.id,
        telegram_channel_id: `@editorial_${suffix.replaceAll("-", "")}`,
        telegram_message_id: messageId,
        message_text: "Compatibility receipt.",
        metadata: { compatibility: true },
      });
      assert.equal(recorded.telegram_message_id, messageId);
      await assert.rejects(
        repository.recordPublication({
          draft_id: recordDraft.id,
          article_id: recordArticle.id,
          telegram_channel_id: `@editorial_${suffix.replaceAll("-", "")}`,
          telegram_message_id: messageId + 1,
          message_text: "Duplicate draft receipt.",
        }),
        /published_posts_draft_id_unique/,
      );
    } finally {
      if (articleIds.length) {
        await pool
          .query(
            "delete from public.published_posts where article_id = any($1::uuid[])",
            [articleIds],
          )
          .catch(() => {});
        await pool
          .query("delete from public.articles where id = any($1::uuid[])", [
            articleIds,
          ])
          .catch(() => {});
      }
      if (searchRunIds.length) {
        await pool
          .query(
            "delete from public.search_runs where id = any($1::uuid[])",
            [searchRunIds],
          )
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

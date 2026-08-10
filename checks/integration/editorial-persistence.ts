import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { EditorialRepository } from "../../src/database/repositories/editorial-repository.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import { SourcesRepository } from "../../src/database/repositories/sources-repository.js";
import { StoryDeduplicationRepository } from "../../src/database/repositories/story-deduplication-repository.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

function postgresDetail(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const record = current as { detail?: unknown; cause?: unknown };
    if (typeof record.detail === "string") return record.detail;
    current = record.cause;
  }
  return null;
}

test(
  "Editorial persistence preserves rollback, one-active-draft, approval CAS, publication idempotency, receipts, and recovery",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 12 });
    const database = createDrizzleDatabase(pool);
    const sourcesRepository = new SourcesRepository(pool, database);
    const researchRepository = new ResearchIngestionRepository(pool, database);
    const storyRepository = new StoryDeduplicationRepository(pool, database);
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
      const publicationChannel = `@editorial_${suffix.replaceAll("-", "")}`;
      await storyRepository.recordStoryDedupDecision({
        articleId: publishArticle.id,
        storyFingerprint: `published-story-${suffix}`,
        relation: "distinct",
        confidence: 1,
        reason: "Integration primary story",
        decisionSource: "deterministic",
      });
      await assert.rejects(
        repository.approveDraft(publishDraft.id),
        /Draft is not in review state/,
      );

      await pool.query(
        `insert into public.telegram_review_sessions (
           id, draft_id, telegram_channel_id, control_chat_id,
           preview_message_id, requested_by, expires_at
         ) values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
        [
          `legacy-${suffix.replaceAll("-", "")}`,
          publishDraft.id,
          publicationChannel,
          91_001,
          91_002,
          91_003,
        ],
      );
      const legacyClaim = await pool.query<{ status: string }>(
        "select status from public.claim_draft_for_publication($1)",
        [publishDraft.id],
      );
      assert.equal(legacyClaim.rows[0].status, "publishing");
      await repository.releaseRejectedDraftPublication(publishDraft.id);
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "select count(*)::text as count from public.story_publication_claims where draft_id = $1",
            [publishDraft.id],
          )
        ).rows[0].count,
        "0",
      );
      await pool.query(
        "delete from public.telegram_review_sessions where draft_id = $1",
        [publishDraft.id],
      );

      const concurrentClaims = await Promise.allSettled([
        repository.claimDraftForPublication(
          publishDraft.id,
          publicationChannel,
        ),
        repository.claimDraftForPublication(
          publishDraft.id,
          publicationChannel,
        ),
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

      await assert.rejects(
        repository.finalizeDraftPublication({
          draftId: publishDraft.id,
          channelId: `${publicationChannel}_wrong`,
          messageId: messageId + 1,
          messageText: "Wrong-channel receipt must roll back.",
        }),
        /story_publication_channel_mismatch/,
      );
      const claimAfterWrongChannel = await pool.query<{
        telegram_channel_id: string;
        status: string;
      }>(
        "select telegram_channel_id, status from public.story_publication_claims where draft_id = $1",
        [publishDraft.id],
      );
      assert.deepEqual(claimAfterWrongChannel.rows[0], {
        telegram_channel_id: publicationChannel,
        status: "publishing",
      });
      assert.equal(
        (await repository.getDraft(publishDraft.id)).status,
        "publishing",
      );

      messageId += 1;
      const receipt = await repository.finalizeDraftPublication({
        draftId: publishDraft.id,
        channelId: publicationChannel,
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
      const storyHistory = await storyRepository.listRecentPublishedStories({
        channelId: publicationChannel,
        since: "2026-01-01T00:00:00.000Z",
        limit: 20,
      });
      assert.equal(
        storyHistory.find((story) => story.article_id === publishArticle.id)
          ?.story_fingerprint,
        `published-story-${suffix}`,
      );
      assert.deepEqual(
        (
          await pool.query<{ status: string }>(
            "select status from public.story_publication_claims where draft_id = $1",
            [publishDraft.id],
          )
        ).rows[0],
        { status: "published" },
      );
      await assert.rejects(
        repository.claimDraftForPublication(publishDraft.id, publicationChannel),
        /Draft is already published/,
      );

      await pool.query(
        "update public.story_publication_claims set updated_at = now() - interval '15 days' where draft_id = $1",
        [publishDraft.id],
      );
      const recurringArticle = await createCandidate("recurring-after-window");
      const recurringDraft = await repository.createReviewDraft({
        article_id: recurringArticle.id,
        body: "The same normalized event text recurred after the policy window.",
        model: "integration-model",
      });
      assert.ok(recurringDraft);
      await repository.approveDraft(recurringDraft.id);
      await storyRepository.recordStoryDedupDecision({
        articleId: recurringArticle.id,
        storyFingerprint: `published-story-${suffix}`,
        relation: "distinct",
        confidence: 1,
        reason: "Recurrence outside the 14-day window",
        decisionSource: "deterministic",
      });
      assert.equal(
        (
          await repository.claimDraftForPublication(
            recurringDraft.id,
            publicationChannel,
          )
        )?.status,
        "publishing",
      );
      await repository.releaseRejectedDraftPublication(recurringDraft.id);
      await repository.rejectDraft(
        recurringDraft.id,
        "Recurring story fixture cleanup",
      );

      const racingArticles = await Promise.all([
        createCandidate("story-race-a"),
        createCandidate("story-race-b"),
      ]);
      const racingDrafts = await Promise.all(
        racingArticles.map(async (article, index) => {
          const draft = await repository.createReviewDraft({
            article_id: article.id,
            body: `Race-safe story draft ${index}`,
            model: "integration-model",
          });
          assert.ok(draft);
          await repository.approveDraft(draft.id);
          await storyRepository.recordStoryDedupDecision({
            articleId: article.id,
            storyFingerprint: `same-concurrent-story-${suffix}`,
            relation: "distinct",
            confidence: 0.99,
            reason: "Concurrent fingerprint fixture",
            decisionSource: "deterministic",
          });
          return draft;
        }),
      );
      const racingClaims = await Promise.allSettled(
        racingDrafts.map((draft) =>
          repository.claimDraftForPublication(draft.id, publicationChannel),
        ),
      );
      assert.equal(
        racingClaims.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        racingClaims.filter(
          (result) =>
            result.status === "rejected" &&
            /duplicate_story_publication/.test(String(result.reason)),
        ).length,
        1,
      );
      const claimedDraft = racingDrafts.find(
        (_draft, index) => racingClaims[index].status === "fulfilled",
      );
      assert.ok(claimedDraft);
      await repository.releaseRejectedDraftPublication(claimedDraft.id);
      await Promise.all(
        racingDrafts.map((draft) =>
          repository.rejectDraft(draft.id, "Race fixture cleanup"),
        ),
      );

      const duplicateArticle = await createCandidate("semantic-duplicate");
      const duplicateDraft = await repository.createReviewDraft({
        article_id: duplicateArticle.id,
        body: "Same event through another publisher.",
        model: "integration-model",
      });
      assert.ok(duplicateDraft);
      await repository.approveDraft(duplicateDraft.id);
      await storyRepository.recordStoryDedupDecision({
        articleId: duplicateArticle.id,
        storyFingerprint: `different-words-${suffix}`,
        relation: "duplicate",
        duplicateOfArticleId: publishArticle.id,
        confidence: 0.96,
        reason: "Same underlying event",
        decisionSource: "ai",
      });
      await assert.rejects(
        repository.claimDraftForPublication(
          duplicateDraft.id,
          publicationChannel,
        ),
        (error: unknown) =>
          /duplicate_story_publication/.test(String(error)) &&
          postgresDetail(error) === publishArticle.id,
      );
      assert.equal(
        (await repository.getDraft(duplicateDraft.id)).status,
        "approved",
      );
      await repository.rejectDraft(duplicateDraft.id, "Duplicate fixture");

      const uncertainArticle = await createCandidate("uncertain-story");
      const uncertainDraft = await repository.createReviewDraft({
        article_id: uncertainArticle.id,
        body: "A similar story that could not be classified safely.",
        model: "integration-model",
      });
      assert.ok(uncertainDraft);
      await repository.approveDraft(uncertainDraft.id);
      await storyRepository.recordStoryDedupDecision({
        articleId: uncertainArticle.id,
        storyFingerprint: `uncertain-${suffix}`,
        relation: "uncertain",
        confidence: 0.31,
        reason: "Classifier unavailable",
        decisionSource: "fallback",
      });
      await assert.rejects(
        repository.claimDraftForPublication(
          uncertainDraft.id,
          publicationChannel,
        ),
        /uncertain_story_publication/,
      );
      assert.equal(
        (await repository.getDraft(uncertainDraft.id)).status,
        "approved",
      );
      await repository.rejectDraft(uncertainDraft.id, "Uncertain fixture");

      const followUpArticle = await createCandidate("meaningful-follow-up");
      const followUpDraft = await repository.createReviewDraft({
        article_id: followUpArticle.id,
        body: "A material later outcome.",
        model: "integration-model",
      });
      assert.ok(followUpDraft);
      await repository.approveDraft(followUpDraft.id);
      await storyRepository.recordStoryDedupDecision({
        articleId: followUpArticle.id,
        storyFingerprint: `follow-up-${suffix}`,
        relation: "follow_up",
        duplicateOfArticleId: publishArticle.id,
        confidence: 0.93,
        reason: "Material later outcome",
        decisionSource: "ai",
      });
      assert.equal(
        (
          await repository.claimDraftForPublication(
            followUpDraft.id,
            publicationChannel,
          )
        )?.status,
        "publishing",
      );
      await repository.releaseRejectedDraftPublication(followUpDraft.id);
      await repository.rejectDraft(followUpDraft.id, "Follow-up fixture cleanup");

      const recoveryArticle = await createCandidate("recovery");
      const recoveryDraft = await repository.createReviewDraft({
        article_id: recoveryArticle.id,
        body: "Recovery workflow draft.",
        model: "integration-model",
      });
      assert.ok(recoveryDraft);
      await repository.approveDraft(recoveryDraft.id);
      await repository.claimDraftForPublication(
        recoveryDraft.id,
        publicationChannel,
      );
      assert.equal(
        (await repository.releaseRejectedDraftPublication(recoveryDraft.id))
          ?.status,
        "approved",
      );
      await repository.claimDraftForPublication(
        recoveryDraft.id,
        publicationChannel,
      );
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
            "delete from public.story_publication_claims where article_id = any($1::uuid[])",
            [articleIds],
          )
          .catch(() => {});
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

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

test(
  "final publication policy atomics preserve application-role grants, settings CAS, exact hashes, replay, and one claim winner",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const suffix = randomUUID();
    const channelId = `@policy_${suffix.replaceAll("-", "")}`;
    const bodies = {
      blocked: `Blocked exact outbound ${suffix}`,
      claimed: `Concurrent exact outbound ${suffix}`,
      direct: `Direct exact outbound ${suffix}`,
      stale: `Stale exact outbound ${suffix}`,
    };
    const articleIds: string[] = [];

    const createApprovedDraft = async (name: string, body: string) => {
      const article = await pool.query<{ id: string }>(
        `insert into public.articles (canonical_url, title, status)
         values ($1, $2, 'approved') returning id`,
        [`https://publication-policy.test/${suffix}/${name}`, `Policy ${name}`],
      );
      articleIds.push(article.rows[0].id);
      const draft = await pool.query<{ id: string }>(
        `insert into public.drafts
           (article_id, body, status, approved_at)
         values ($1, $2, 'approved', now()) returning id`,
        [article.rows[0].id, body],
      );
      return draft.rows[0].id;
    };

    const asApplicationRole = async <T extends Record<string, unknown>>(
      statement: string,
      values: unknown[],
    ) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role telegram_news_app");
        const result = await client.query<T>(statement, values);
        await client.query("commit");
        return result.rows;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };

    try {
      await pool.query(
        `insert into public.news_bot_settings
           (telegram_channel_id, review_chat_id, updated_by,
            excluded_topic_codes)
         values ($1, 1, 1, array['war_conflict']::text[])`,
        [channelId],
      );
      const blockedDraftId = await createApprovedDraft(
        "blocked",
        bodies.blocked,
      );
      const claimedDraftId = await createApprovedDraft(
        "claimed",
        bodies.claimed,
      );
      const staleDraftId = await createApprovedDraft("stale", bodies.stale);

      const block = async () =>
        asApplicationRole<{
          outcome: string;
          draft_status: string;
          reason_code: string;
        }>(
          `select outcome, draft_status, reason_code
           from public.block_draft_publication(
             $1, $2, 'final_publication', 'manual_review',
             'war_conflict', 'uncertain', 1, $3,
             sha256(convert_to($3, 'UTF8')), 'openai', 'configured-model',
             'excluded-topics-v1', 'excluded_topic_uncertain'
           )`,
          [blockedDraftId, channelId, bodies.blocked],
        );
      assert.equal((await block())[0].outcome, "blocked");
      assert.equal((await block())[0].outcome, "already_blocked");
      assert.equal(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count
             from public.publication_policy_blocks where draft_id = $1`,
            [blockedDraftId],
          )
        ).rows[0].count,
        "1",
      );

      const stale = await asApplicationRole<{ outcome: string }>(
        `select outcome
         from public.claim_draft_for_publication_with_policy(
           $1, $2, 2, sha256(convert_to($3, 'UTF8'))
         )`,
        [staleDraftId, channelId, bodies.stale],
      );
      assert.equal(stale[0].outcome, "stale_settings");
      const changed = await asApplicationRole<{ outcome: string }>(
        `select outcome
         from public.claim_draft_for_publication_with_policy(
           $1, $2, 1, sha256(convert_to('different', 'UTF8'))
         )`,
        [staleDraftId, channelId],
      );
      assert.equal(changed[0].outcome, "outbound_changed");

      const directBlock = async (settingsVersion = 1) =>
        asApplicationRole<{
          id: string;
          idempotency_key: string;
          outbound_hash: string;
        }>(
          `select id, idempotency_key,
                  encode(outbound_text_sha256, 'hex') as outbound_hash
           from public.record_direct_publication_policy_block(
             $1, $2, 'direct', 'war_conflict', 'main_subject', $3,
             $4, sha256(convert_to($4, 'UTF8')), 'openai',
             'configured-model', 'excluded-topics-v1',
             'excluded_topic_main_subject'
           )`,
          [channelId, articleIds[2], settingsVersion, bodies.direct],
        );
      const firstDirectBlock = (await directBlock())[0];
      const replayedDirectBlock = (await directBlock())[0];
      assert.equal(replayedDirectBlock.id, firstDirectBlock.id);
      assert.equal(
        replayedDirectBlock.idempotency_key,
        firstDirectBlock.idempotency_key,
      );
      assert.match(firstDirectBlock.idempotency_key, /^[a-f0-9]{64}$/);
      assert.equal(firstDirectBlock.outbound_hash.length, 64);
      assert.equal(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count
             from public.publication_policy_blocks
             where idempotency_key = $1`,
            [firstDirectBlock.idempotency_key],
          )
        ).rows[0].count,
        "1",
      );
      await assert.rejects(directBlock(2), /stale_publication_policy_settings/);

      const claimSql = `select outcome, id, body
        from public.claim_draft_for_publication_with_policy(
          $1, $2, 1, sha256(convert_to($3, 'UTF8'))
        )`;
      const claims = await Promise.all([
        asApplicationRole<{ outcome: string; id: string | null; body: string | null }>(claimSql, [
          claimedDraftId,
          channelId,
          bodies.claimed,
        ]),
        asApplicationRole<{ outcome: string; id: string | null; body: string | null }>(claimSql, [
          claimedDraftId,
          channelId,
          bodies.claimed,
        ]),
      ]);
      assert.deepEqual(
        claims.map((rows) => rows[0].outcome).sort(),
        ["claimed", "not_publishable"],
      );
      const winningClaim = claims
        .flat()
        .find(({ outcome }) => outcome === "claimed");
      assert.equal(winningClaim?.id, claimedDraftId);
      assert.equal(winningClaim?.body, bodies.claimed);

      const privileges = await pool.query<{
        one_arg: boolean;
        two_arg: boolean;
        rls_enabled: boolean;
        service_claim_execute: boolean;
        service_block_execute: boolean;
        service_direct_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        public_execute: boolean;
        service_select: boolean;
        service_insert: boolean;
        service_update: boolean;
        anon_select: boolean;
        authenticated_select: boolean;
        public_table_access: boolean;
      }>(
        `select
           to_regprocedure('public.claim_draft_for_publication(uuid)')
             is not null as one_arg,
           to_regprocedure('public.claim_draft_for_publication(uuid,text)')
             is not null as two_arg,
           (select relrowsecurity from pg_catalog.pg_class
            where oid = 'public.publication_policy_blocks'::regclass)
             as rls_enabled,
           has_function_privilege(
             'service_role',
             'public.claim_draft_for_publication_with_policy(uuid,text,integer,bytea)',
             'EXECUTE'
           ) as service_claim_execute,
           has_function_privilege(
             'service_role',
             'public.block_draft_publication(uuid,text,text,text,text,text,integer,text,bytea,text,text,text,text)',
             'EXECUTE'
           ) as service_block_execute,
           has_function_privilege(
             'service_role',
             'public.record_direct_publication_policy_block(text,uuid,text,text,text,integer,text,bytea,text,text,text,text)',
             'EXECUTE'
           ) as service_direct_execute,
           has_function_privilege(
             'anon',
             'public.block_draft_publication(uuid,text,text,text,text,text,integer,text,bytea,text,text,text,text)',
             'EXECUTE'
           ) as anon_execute,
           has_function_privilege(
             'authenticated',
             'public.block_draft_publication(uuid,text,text,text,text,text,integer,text,bytea,text,text,text,text)',
             'EXECUTE'
           ) as authenticated_execute,
           exists (
             select 1
             from pg_catalog.pg_proc as function_value
             cross join lateral aclexplode(
               coalesce(function_value.proacl, acldefault('f', function_value.proowner))
             ) as grant_value
             where function_value.oid in (
               'public.claim_draft_for_publication_with_policy(uuid,text,integer,bytea)'::regprocedure,
               'public.block_draft_publication(uuid,text,text,text,text,text,integer,text,bytea,text,text,text,text)'::regprocedure,
               'public.record_direct_publication_policy_block(text,uuid,text,text,text,integer,text,bytea,text,text,text,text)'::regprocedure
             )
               and grant_value.grantee = 0
               and grant_value.privilege_type = 'EXECUTE'
           ) as public_execute,
           has_table_privilege(
             'service_role', 'public.publication_policy_blocks', 'SELECT'
           ) as service_select,
           has_table_privilege(
             'service_role', 'public.publication_policy_blocks', 'INSERT'
           ) as service_insert,
           has_table_privilege(
             'service_role', 'public.publication_policy_blocks', 'UPDATE'
           ) as service_update,
           has_table_privilege(
             'anon', 'public.publication_policy_blocks', 'SELECT'
           ) as anon_select,
           has_table_privilege(
             'authenticated', 'public.publication_policy_blocks', 'SELECT'
           ) as authenticated_select,
           exists (
             select 1
             from pg_catalog.pg_class as relation
             cross join lateral aclexplode(
               coalesce(relation.relacl, acldefault('r', relation.relowner))
             ) as grant_value
             where relation.oid = 'public.publication_policy_blocks'::regclass
               and grant_value.grantee = 0
               and grant_value.privilege_type in ('SELECT', 'INSERT', 'UPDATE')
           ) as public_table_access`,
      );
      assert.deepEqual(privileges.rows[0], {
        one_arg: true,
        two_arg: true,
        rls_enabled: true,
        service_claim_execute: true,
        service_block_execute: true,
        service_direct_execute: true,
        anon_execute: false,
        authenticated_execute: false,
        public_execute: false,
        service_select: true,
        service_insert: true,
        service_update: false,
        anon_select: false,
        authenticated_select: false,
        public_table_access: false,
      });

      const columns = await pool.query<{ column_name: string }>(
        `select column_name
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'publication_policy_blocks'`,
      );
      const names = new Set(columns.rows.map(({ column_name }) => column_name));
      for (const forbidden of [
        "content",
        "body",
        "prompt",
        "provider_output",
        "error",
        "url",
      ]) {
        assert.equal(names.has(forbidden), false, forbidden);
      }
    } finally {
      await pool
        .query(
          "delete from public.publication_policy_blocks where telegram_channel_id = $1",
          [channelId],
        )
        .catch(() => {});
      await pool
        .query(
          "delete from public.story_publication_claims where article_id = any($1::uuid[])",
          [articleIds],
        )
        .catch(() => {});
      await pool
        .query("delete from public.articles where id = any($1::uuid[])", [
          articleIds,
        ])
        .catch(() => {});
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = $1",
          [channelId],
        )
        .catch(() => {});
      await pool.end();
    }
  },
);

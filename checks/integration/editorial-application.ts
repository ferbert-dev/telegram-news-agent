import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { PG_POOL } from "../../src/database/database.tokens.js";
import { ResearchIngestionRepository } from "../../src/database/repositories/research-ingestion-repository.js";
import type { EditorialWorkflowApplicationPort } from "../../src/editorial/editorial-application.contracts.js";
import { EditorialApplicationModule } from "../../src/editorial/editorial-application.module.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../../src/editorial/editorial-application.tokens.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

test(
  "Editorial application preserves atomic review creation, policy rejection, claim concurrency, exactly-once receipt, and reconciliation on PostgreSQL 17",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const database = createDrizzleDatabase(pool);
    const research = new ResearchIngestionRepository(pool, database);
    const suffix = randomUUID();
    const channelId = `@editorial_application_${suffix.replaceAll("-", "")}`;
    const reviewChatId = 810_000_000_001;
    const updatedBy = 810_000_000_002;
    const searchRunIds: string[] = [];
    const articleIds: string[] = [];
    const responseIds: string[] = [];
    const deliveryCalls: string[] = [];
    const blockedIds = new Set<string>();
    let deliveryStartedResolve: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      deliveryStartedResolve = resolve;
    });
    let releaseFirstDelivery: (() => void) | undefined;
    const firstDeliveryReleased = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let holdFirstDelivery = true;

    const createArticle = async (name: string) => {
      const run = await research.startSearchRun({
        query: `editorial application ${name} ${suffix}`,
      });
      searchRunIds.push(run.id);
      const article = await research.createOrResumeArticleCandidate({
        source_id: null,
        search_run_id: run.id,
        canonical_url: `https://editorial-application.test/${suffix}/${name}`,
        title: `Editorial application ${name}`,
        author: null,
        published_at: null,
        content_hash: `${suffix}-${name}`,
        metadata: { integration: true },
      });
      assert.ok(article);
      articleIds.push(article.id);
      return article;
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        EditorialApplicationModule.register({
          draft: {
            async generate(input, signal) {
              signal?.throwIfAborted();
              const responseId = `editorial-${input.article.id}`;
              responseIds.push(responseId);
              return {
                draft: {
                  article_id: input.article.id,
                  body: `Grounded application draft for ${input.article.title}`,
                  model: "configured-editor-model",
                  prompt_version: "telegram-grounded-v2",
                  reviewer_notes: JSON.stringify({
                    evidence_urls: input.evidence.map(({ url }) => url),
                  }),
                },
                usageEvents: [
                  {
                    provider: "openai",
                    providerResponseId: responseId,
                    model: "configured-editor-model",
                    operation: "editorial",
                    telegramChannelId: input.channelId ?? null,
                    searchRunId: input.article.search_run_id,
                    articleId: input.article.id,
                    inputTokens: 20,
                    outputTokens: 10,
                  },
                ],
              };
            },
          },
          excludedTopics: {
            async evaluate(input) {
              return blockedIds.has(input.draftId)
                ? { decision: "block", reasonCode: "excluded_topic" }
                : { decision: "allow" };
            },
          },
          publication: {
            async publish(request) {
              deliveryCalls.push(request.text);
              if (holdFirstDelivery) {
                holdFirstDelivery = false;
                deliveryStartedResolve?.();
                await firstDeliveryReleased;
              }
              return { messageId: 82_001 + deliveryCalls.length };
            },
          },
        }),
      ],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    await moduleRef.init();
    const workflow = moduleRef.get<EditorialWorkflowApplicationPort>(
      EDITORIAL_WORKFLOW_APPLICATION,
    );

    try {
      await pool.query(
        "select * from public.get_or_create_news_settings($1, $2, $3)",
        [channelId, reviewChatId, updatedBy],
      );
      await pool.query(
        "update public.news_bot_settings set excluded_topic_codes = array['war_conflict']::text[] where telegram_channel_id = $1",
        [channelId],
      );

      const publishArticle = await createArticle("publish");
      const evidenceText = "Complete checked first-party evidence.";
      const generated = await workflow.generateReviewDraft({
        article: publishArticle,
        evidence: [
          {
            url: publishArticle.canonical_url,
            text: evidenceText,
            primary: true,
          },
        ],
        languageCode: "en",
        channelId,
      });
      assert.equal(generated.draft.status, "review");
      assert.equal(generated.draft.model, "configured-editor-model");
      assert.equal(generated.usageEvents.length, 1);

      const usage = await pool.query<{ count: string }>(
        "select count(*)::text as count from public.ai_usage_events where provider_response_id = $1",
        [responseIds[0]],
      );
      assert.equal(usage.rows[0].count, "1");
      const approved = await pool.query<{ status: string }>(
        "select status from public.approve_draft($1)",
        [generated.draft.id],
      );
      assert.equal(approved.rows[0].status, "approved");

      const firstPublication = workflow.publishApprovedDraft({
        draftId: generated.draft.id,
        channelId,
      });
      await deliveryStarted;
      const secondPublication = workflow.publishApprovedDraft({
        draftId: generated.draft.id,
        channelId,
      });
      const secondResult = await Promise.allSettled([secondPublication]);
      releaseFirstDelivery?.();
      const firstResult = await Promise.allSettled([firstPublication]);
      const concurrent = [...firstResult, ...secondResult];
      assert.equal(
        concurrent.filter(({ status }) => status === "fulfilled").length,
        1,
      );
      assert.equal(
        concurrent.filter(({ status }) => status === "rejected").length,
        1,
      );
      assert.equal(deliveryCalls.length, 1);
      const published = concurrent.find(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<EditorialWorkflowApplicationPort["publishApprovedDraft"]>>> =>
          result.status === "fulfilled",
      );
      assert.equal(published?.value.status, "published");
      const existing = await workflow.publishApprovedDraft({
        draftId: generated.draft.id,
        channelId,
      });
      assert.equal(existing.status, "already_published");
      assert.equal(deliveryCalls.length, 1);

      const blockedArticle = await createArticle("blocked");
      const blocked = await workflow.generateReviewDraft({
        article: blockedArticle,
        evidence: [
          {
            url: blockedArticle.canonical_url,
            text: evidenceText,
            primary: true,
          },
        ],
        languageCode: "en",
        channelId,
      });
      await pool.query("select status from public.approve_draft($1)", [
        blocked.draft.id,
      ]);
      blockedIds.add(blocked.draft.id);
      const blockedResult = await workflow.publishApprovedDraft({
        draftId: blocked.draft.id,
        channelId,
      });
      assert.equal(blockedResult.status, "blocked");
      assert.equal(blockedResult.draft.status, "rejected");
      assert.equal(deliveryCalls.length, 1);
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "select count(*)::text as count from public.story_publication_claims where draft_id = $1",
            [blocked.draft.id],
          )
        ).rows[0].count,
        "0",
      );

      const recoveryArticle = await createArticle("recovery");
      const recovery = await workflow.generateReviewDraft({
        article: recoveryArticle,
        evidence: [
          {
            url: recoveryArticle.canonical_url,
            text: evidenceText,
            primary: true,
          },
        ],
        languageCode: "en",
        channelId,
      });
      await pool.query("select status from public.approve_draft($1)", [
        recovery.draft.id,
      ]);
      await pool.query(
        "select status from public.claim_draft_for_publication($1, $2)",
        [recovery.draft.id, channelId],
      );
      const reset = await workflow.reconcilePublication({
        draftId: recovery.draft.id,
        outcome: "not-sent",
      });
      assert.equal(reset.draft?.status, "approved");
      await pool.query(
        "select status from public.claim_draft_for_publication($1, $2)",
        [recovery.draft.id, channelId],
      );
      const reconciled = await workflow.reconcilePublication({
        draftId: recovery.draft.id,
        outcome: "sent",
        channelId,
        messageId: 89_001,
      });
      assert.equal(reconciled.publication?.telegram_message_id, 89_001);
    } finally {
      await pool
        .query(
          "delete from public.news_bot_settings where telegram_channel_id = $1",
          [channelId],
        )
        .catch(() => {});
      if (responseIds.length) {
        await pool
          .query(
            "delete from public.ai_usage_events where provider_response_id = any($1::text[])",
            [responseIds],
          )
          .catch(() => {});
      }
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
      await moduleRef.close().catch(() => {});
    }
  },
);

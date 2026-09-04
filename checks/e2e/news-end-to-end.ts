import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../src/database/drizzle-client.js";
import { SOURCE_ACQUISITION_TRANSPORT, SOURCE_ACQUISITION_DNS } from "../../src/research/source-acquisition.tokens.js";
import { TypedResearchExecutionGatewayModule } from "../../src/research/typed-research-execution.module.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../../src/research/research-gateway.tokens.js";
import { EditorialApplicationModule } from "../../src/editorial/editorial-application.module.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../../src/editorial/editorial-application.tokens.js";
import { EDITORIAL_PERSISTENCE } from "../../src/editorial/editorial-persistence.tokens.js";
import { LegacyEditorialDraftGateway } from "../../src/editorial/legacy-editorial-draft.gateway.js";
import { LegacyEditorialPublicationGateway } from "../../src/editorial/legacy-editorial-publication.gateway.js";
import { LegacyEditorialPublicationPolicyGateway } from "../../src/editorial/legacy-editorial-publication-policy.gateway.js";
import { OperationsApplicationModule } from "../../src/operations/operations-application.module.js";
import { PIPELINE_LEASE_APPLICATION } from "../../src/operations/operations-application.tokens.js";
import { PersistenceFacadeModule } from "../../src/persistence/persistence-facade.module.js";
import { SettingsApplicationModule } from "../../src/settings/settings-application.module.js";
import { LateBoundPortRegistry } from "../../src/composition/late-bound-port.js";
import { getNewsEditor } from "../../src/editor.js";
import { LEGACY_PERSISTENCE } from "../../src/persistence/legacy-persistence.tokens.js";
import { TelegramPersistenceModule } from "../../src/telegram/telegram-persistence.module.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_NEWS_JOBS_PERSISTENCE,
} from "../../src/telegram/telegram-persistence.tokens.js";
import { TelegramUpdatesRepository } from "../../src/telegram/telegram-updates-repository.js";
import { RunTelegramNewsUseCase } from "../../src/telegram/application/run-telegram-news.use-case.js";
import { TelegramNewsJobWorker } from "../../src/telegram/telegram-news-job-worker.js";
import { TypedNewsJobWorkflowAdapter } from "../../src/telegram/typed-news-job-workflow.adapter.js";
import { TypedNewsJobDeliveryAdapter } from "../../src/telegram/typed-news-job-delivery.adapter.js";
import type { TelegramControlRequest } from "../../src/telegram/telegram-application.contracts.js";

/**
 * `/news` end to end, against real PostgreSQL, with every paid or networked
 * dependency replaced by a fake.
 *
 * This exists because the flow was only ever exercised in two halves. The
 * enqueue had a real-database check, the worker had a fakes check, and nothing
 * ran the whole path -- so the failures that actually mattered were all found
 * by typing /news at a live bot and paying for it: a queue with no consumer, a
 * circuit breaker that was never wired in, a classification loop that made
 * 1,182 sequential AI calls, and a job that failed after drafting for a reason
 * still unidentified. Every one of those is a code path this test covers.
 *
 * What is real: PostgreSQL, all the atomic SQL functions, the job queue, the
 * worker, the workflow and delivery adapters, the research gateway, the
 * editorial services, the checkpoint and lease semantics.
 *
 * What is faked, and only these: the HTTP transport that fetches feeds, the AI
 * provider, and the Telegram send. Those are the three things that cost money
 * or reach the network. Nothing else is stubbed, because everything else is
 * what this is meant to prove.
 */

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";
const connectionString = process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

/** The article the whole run is steered towards, so evidence and citations agree. */
const ARTICLE_URL = "https://feed.example.test/hubble-measurement";

/** A minimal, valid RSS feed. Two items, both recent, both plausible news. */
function feedXml(now: Date): string {
  const pubDate = new Date(now.getTime() - 60 * 60 * 1000).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Research Wire</title>
  <link>https://feed.example.test/</link>
  <item>
    <title>Observatory confirms a new measurement of the Hubble constant</title>
    <link>${ARTICLE_URL}</link>
    <pubDate>${pubDate}</pubDate>
    <description>Researchers published a peer-reviewed measurement narrowing the uncertainty on the expansion rate.</description>
  </item>
  <item>
    <title>Laboratory reports a reproducible superconductivity result</title>
    <link>https://feed.example.test/superconductivity</link>
    <pubDate>${pubDate}</pubDate>
    <description>An independent group reproduced the result at ambient pressure under review conditions.</description>
  </item>
</channel></rss>`;
}

/**
 * Answers every structured-generation request with something schema-valid.
 *
 * Keyed on the schema name rather than returning one shape for everything: the
 * pipeline asks for different things at each stage, and a fake that ignored
 * that would pass while proving nothing about the stages it skipped.
 */
function fakeAiProvider(counters: Record<string, number>) {
  const answer = (request: Record<string, unknown>): unknown => {
    const schema = String(request.schemaName ?? "");
    counters[schema] = (counters[schema] ?? 0) + 1;

    // Substring, not equality: the policy runs twice under two schema names --
    // "excluded_topic_classification" during research and
    // "final_publication_excluded_topic_classification" immediately before the
    // send. An exact match answered only the first, and the second fell through
    // to an unrecognised response, which the policy correctly treats as
    // uncertain and blocks. That fail-closed behaviour is right; the fake was
    // what was wrong.
    if (schema.includes("excluded_topic_classification")) {
      const topics = (request.input as { excludedTopics?: Array<{ code: string }> })
        ?.excludedTopics ?? [];
      // Nothing is excluded, so the pipeline proceeds to drafting. The blocking
      // path has its own unit coverage; here the point is to reach the end.
      return { assessments: topics.map(({ code }) => ({ topicCode: code, relation: "unrelated" })) };
    }
    if (schema.includes("feed_candidate") || schema.includes("curation")) {
      return {
        selections: [{ index: 0, reason: "Most significant verified result in the window." }],
      };
    }
    if (schema.includes("draft") || schema.includes("Draft")) {
      // Built FROM the request, not from a constant.
      //
      // The grounding validator requires every claim to cite a URL that was
      // actually supplied as evidence for THIS article. A fixed fixture only
      // validates when the pipeline happens to select the article it was
      // written for -- and which of the feed's items wins depends on ranking
      // and on what deduplication has seen before, so a constant made this test
      // fail as soon as the rig had state from a previous run. Echoing the
      // request makes it hold for whichever article is chosen.
      const requestInput = request.input as {
        article?: { title?: string; url?: string };
        evidence?: Array<{ url?: string }>;
      };
      const url = requestInput.evidence?.[0]?.url ?? requestInput.article?.url ?? "";
      const headline = String(requestInput.article?.title ?? "Untitled");
      const claim = "An independent group reported the result under review conditions.";
      return {
        headline,
        telegramText: [
          headline,
          "",
          claim,
          "",
          "Why it matters: it narrows which explanations remain viable.",
          "",
          "Caveat: the result awaits independent replication.",
          "",
          "Source:",
          url,
        ].join("\n"),
        claims: [
          { text: headline, sourceUrl: url },
          { text: claim, sourceUrl: url },
        ],
        sourceUrls: [url],
        caveat: "The result awaits independent replication.",
        topicTags: [],
      };
    }
    return {};
  };

  const call = async (request: Record<string, unknown>) => ({
    value: answer(request),
    usageEvents: [],
    provider: "fake",
    model: "fake-model",
  });

  return {
    names: ["fake"],
    generateStructured: call,
    generateStructuredOnce: call,
    searchNews: call,
    searchFeeds: call,
    searchFact: call,
    async testConnection() {
      return { value: {}, usageEvents: [] };
    },
    async testExaConnection() {
      return { value: {}, usageEvents: [] };
    },
  };
}

test(
  "/news runs end to end against real PostgreSQL without a network call or a paid request",
  { skip: !enabled || !connectionString },
  async () => {
    const pool = new Pool({ connectionString, max: 8 });
    const drizzle = createDrizzleDatabase(pool);
    const channelId = `@e2e-${randomUUID()}`;
    const updateId = 2_100_000_000 + Math.floor(Math.random() * 50_000_000);
    const now = new Date();

    const schemaCounters: Record<string, number> = {};
    const aiProvider = fakeAiProvider(schemaCounters);

    // The only network seam in the research path. Serving canned XML here means
    // the whole feed pipeline -- fetch, parse, canonicalise, hash, dedupe --
    // runs for real against content this test controls.
    let feedRequests = 0;
    const transport = {
      async fetchPinned(url: URL) {
        feedRequests += 1;
        return new Response(feedXml(now), {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        });
      },
    };
    const dns = {
      async lookup() {
        // A routable public address, and deliberately not a documentation
        // range. The gateway's SSRF guard blocks 203.0.113.0/24, 192.0.2.0/24
        // and 198.51.100.0/24 along with every private range -- so the obvious
        // choice for a fake makes every fetch throw before it reaches the
        // transport, which reads as "research found nothing" rather than as a
        // rejected address. Nothing is dialled: the transport is faked too.
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
    };

    // The publication gateway, faked. This is the ONLY thing standing between
    // this test and a real post in a real channel, so it records rather than
    // sends -- and the recording is what the publish assertions read.
    const published: Array<Record<string, unknown>> = [];
    const publicationGateway = {
      async publish(request: Record<string, unknown>) {
        published.push({ channelId: request.channelId, text: request.text });
        return { messageId: 9001, messageDate: 1_757_000_000 };
      },
    };

    const sentToTelegram: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const callTelegram = async (
      _token: string,
      method: string,
      payload: Record<string, unknown>,
    ) => {
      sentToTelegram.push({ method, payload });
      return { ok: true, result: { message_id: 4242, chat: { id: 987_654 } } };
    };

    // The draft gateway needs the persistence facade, which only exists once
    // the container is built -- the same circularity the composition root
    // solves, solved the same way, so this test wires the product the way the
    // product is wired rather than inventing a shortcut.
    const ports = new LateBoundPortRegistry();
    const legacyPersistence = ports.create<object>("legacy-persistence");

    const moduleRef = await Test.createTestingModule({
      imports: [
        SettingsApplicationModule,
        PersistenceFacadeModule,
        TelegramPersistenceModule,
        OperationsApplicationModule.register({
          notionAudit: { finish: async () => undefined, start: async () => ({}) } as never,
        }),
        TypedResearchExecutionGatewayModule.register({ aiProvider: aiProvider as never }),
        EditorialApplicationModule.register({
          draft: new LegacyEditorialDraftGateway({
            aiProvider: aiProvider as never,
            model: "fake-model",
            repository: legacyPersistence.port as never,
            editor: getNewsEditor({}) as never,
          }) as never,
          publication: publicationGateway as never,
          excludedTopics: new LegacyEditorialPublicationPolicyGateway({
            aiProvider: aiProvider as never,
          }) as never,
        }),
      ],
      providers: [RunTelegramNewsUseCase],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(DRIZZLE_DB)
      .useValue(drizzle)
      .overrideProvider(SOURCE_ACQUISITION_TRANSPORT)
      .useValue(transport)
      .overrideProvider(SOURCE_ACQUISITION_DNS)
      .useValue(dns)
      .compile();
    await moduleRef.init();
    legacyPersistence.bind(moduleRef.get(LEGACY_PERSISTENCE, { strict: false }) as object);
    ports.assertAllBound();

    try {
      const updates = new TelegramUpdatesRepository(pool, drizzle);
      const jobs = moduleRef.get(TELEGRAM_NEWS_JOBS_PERSISTENCE, { strict: false });
      const checkpoints = moduleRef.get(TELEGRAM_CHECKPOINTS_PERSISTENCE, { strict: false });
      const editorial = moduleRef.get(EDITORIAL_WORKFLOW_APPLICATION, { strict: false });
      const editorialPersistence = moduleRef.get(EDITORIAL_PERSISTENCE, { strict: false });
      const leases = moduleRef.get(PIPELINE_LEASE_APPLICATION, { strict: false });
      const research = moduleRef.get(RESEARCH_EXECUTION_GATEWAY, { strict: false });
      const useCase = moduleRef.get(RunTelegramNewsUseCase);

      await pool.query("select * from public.get_or_create_news_settings($1, $2, $3)", [
        channelId,
        987_654,
        4242,
      ]);
      // A source with a feed, so research has something to fetch. Everything
      // downstream of this is the real pipeline.
      await pool.query(
        `insert into public.sources (name, homepage_url, feed_url, source_type, reliability_score, enabled, discovered_by)
         values ($1, $2, $3, 'rss', 90, true, 'seed')
         on conflict do nothing`,
        ["Example Research Wire", "https://feed.example.test/", "https://feed.example.test/rss"],
      );

      const claim = await updates.claimTelegramUpdate({ updateId, updateKind: "message" });
      assert.ok(claim.claim_token);

      const request: TelegramControlRequest = {
        updateId,
        updateKind: "message",
        channelId,
        actorId: 4242,
        chatId: 987_654,
        chatType: "private",
        route: { kind: "news" },
      };
      const queued = await useCase.execute(request, claim.claim_token);
      assert.equal(queued.status, "research_queued", "the command must accept and return");

      // Research reports "no candidates" for a dozen different reasons and the
      // workflow adapter deliberately swallows that distinction. For a test
      // whose whole job is to find out WHY, the reason has to be captured.
      const researchErrors: string[] = [];
      const wrappedResearch = {
        async execute(input: unknown, signal?: AbortSignal) {
          try {
            return await (research as { execute: (i: unknown, s?: AbortSignal) => Promise<unknown> })
              .execute(input, signal);
          } catch (error) {
            researchErrors.push(
              `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`,
            );
            throw error;
          }
        },
      };

      const deliveries: Array<Record<string, unknown>> = [];
      const worker = new TelegramNewsJobWorker({
        jobs: jobs as never,
        workflow: new TypedNewsJobWorkflowAdapter({
          research: wrappedResearch as never,
          editorial: editorial as never,
          editorialPersistence: editorialPersistence as never,
          checkpoints: checkpoints as never,
          pipelineLease: leases as never,
          ownerId: randomUUID(),
        }) as never,
        delivery: new TypedNewsJobDeliveryAdapter({
          checkpoints: checkpoints as never,
          reviewDelivery: {
            async execute(input: Record<string, unknown>) {
              deliveries.push(input);
              return { status: "review_ready" };
            },
          } as never,
          adminMessages: {
            async notify(input: { chatId: number; text: string }) {
              sentToTelegram.push({ method: "sendMessage", payload: input as never });
            },
          },
        }) as never,
        newClaimToken: () => randomUUID(),
        maxExecutionAttempts: 1,
        log: { info() {}, error() {} },
      });

      // Execute phase, then delivery phase. Two claims, exactly as the running
      // worker does it.
      // The worker classifies any error into an error_code and moves on, which
      // is right for production and useless here. Capture the real one.
      const workflowErrors: string[] = [];
      const inner = (worker as unknown as { options: { workflow: { run: Function } } }).options.workflow;
      const originalRun = inner.run.bind(inner);
      inner.run = async (...args: unknown[]) => {
        try {
          return await originalRun(...args);
        } catch (error) {
          workflowErrors.push(
            `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? String(error)}`,
          );
          throw error;
        }
      };

      const executed = await worker.runOnce();
      assert.equal(executed, "advanced", "the research phase must advance the job");

      const { rows: afterExecute } = await pool.query(
        "select status, outcome_status, error_code, draft_id from public.telegram_news_jobs where request_update_id = $1",
        [updateId],
      );
      assert.equal(
        afterExecute[0]?.error_code,
        null,
        [
          `the run failed with ${afterExecute[0]?.error_code}`,
          `workflow errors: ${workflowErrors.length ? workflowErrors.join(" | ") : "none"}`,
          `research errors: ${researchErrors.length ? researchErrors.join(" | ") : "none"}`,
          `AI schemas: ${JSON.stringify(schemaCounters)}`,
        ].join("\n  "),
      );
      assert.equal(
        afterExecute[0]?.outcome_status,
        "review_ready",
        [
          `outcome was ${afterExecute[0]?.outcome_status}`,
          `research errors: ${researchErrors.length ? researchErrors.join(" | ") : "none"}`,
          `AI schemas: ${JSON.stringify(schemaCounters)}`,
          `feed requests: ${feedRequests}`,
        ].join("\n  "),
      );
      assert.ok(afterExecute[0]?.draft_id, "a draft must exist after the research phase");

      const checkpoint = await checkpoints.getTelegramNewsCheckpoint(updateId);
      assert.equal(checkpoint?.status, "review_ready");
      assert.ok(checkpoint?.preview, "the checkpoint must carry the preview the review card renders");

      const delivered = await worker.runOnce();
      assert.equal(delivered, "advanced", "the delivery phase must advance the job");

      const { rows: afterDeliver } = await pool.query(
        "select status from public.telegram_news_jobs where request_update_id = $1",
        [updateId],
      );
      assert.equal(afterDeliver[0]?.status, "completed");
      assert.equal(deliveries.length, 1, "exactly one review card");
      assert.equal(deliveries[0]?.draftId, afterExecute[0]?.draft_id);

      // --- the publish half -------------------------------------------------
      //
      // Everything above proved a draft reaches a reviewer. This proves the
      // half that cannot be undone: approve, publish, and exactly one post.
      const draftId = String(afterExecute[0]?.draft_id);

      // A draft must be `approved` before the publication claim will take it --
      // `claim_draft_for_publication_with_policy` accepts nothing else. This is
      // the human tapping Approve.
      await editorialPersistence.approveDraft(draftId);

      const firstPublish = await editorial.publishApprovedDraft({
        draftId,
        channelId,
        publicationPath: "manual_review",
      });
      assert.equal(
        firstPublish.status,
        "published",
        `the draft must publish; got ${JSON.stringify(firstPublish)}`,
      );
      assert.equal(published.length, 1, "exactly one post reaches the channel");
      assert.equal(published[0]?.channelId, channelId);

      const { rows: publications } = await pool.query(
        "select telegram_message_id, telegram_channel_id from public.published_posts where draft_id = $1",
        [draftId],
      );
      assert.equal(publications.length, 1, "exactly one publication row");
      assert.equal(Number(publications[0]?.telegram_message_id), 9001);

      // Idempotency, against the real SQL functions rather than a fake: a second
      // publish of the same draft must return the existing publication and send
      // nothing. A divergence here is a duplicate post in a real channel, which
      // is the single worst outcome this system can produce.
      const secondPublish = await editorial.publishApprovedDraft({
        draftId,
        channelId,
        publicationPath: "manual_review",
      });
      assert.equal(secondPublish.status, "already_published");
      assert.equal(
        published.length,
        1,
        "a second publish must not reach the channel again",
      );
      const { rows: afterSecond } = await pool.query(
        "select count(*)::int as n from public.published_posts where draft_id = $1",
        [draftId],
      );
      assert.equal(afterSecond[0]?.n, 1, "still exactly one publication row");

      // The point of the whole exercise: this cost nothing.
      assert.ok(feedRequests > 0, "the feed transport must actually have been used");
      assert.ok(
        Object.keys(schemaCounters).length > 0,
        "the AI provider must actually have been asked for something",
      );
    } finally {
      // Hermetic teardown, and it must actually succeed.
      //
      // Twelve tables reference articles or drafts. An earlier version deleted
      // articles directly and swallowed the failure, so a foreign key from
      // publication_policy_blocks kept them alive -- and the NEXT run found no
      // new articles, failing for a reason that had nothing to do with the
      // code. Deleting dependants first, in one transaction, and letting a
      // failure surface is what makes the rig reusable.
      const fixtureArticles =
        "select id from public.articles where canonical_url like 'https://feed.example.test/%'";
      const fixtureDrafts = `select id from public.drafts where article_id in (${fixtureArticles})`;
      try {
        await pool.query("begin");
        for (const statement of [
          `delete from public.published_posts where article_id in (${fixtureArticles})`,
          `delete from public.publication_policy_blocks where article_id in (${fixtureArticles})`,
          `delete from public.story_publication_claims where article_id in (${fixtureArticles})`,
          `delete from public.telegram_news_request_checkpoints where draft_id in (${fixtureDrafts})`,
          `delete from public.telegram_review_sessions where draft_id in (${fixtureDrafts})`,
          `delete from public.telegram_news_jobs where telegram_channel_id = '${channelId}'`,
          `delete from public.article_story_decisions where article_id in (${fixtureArticles})`,
          `delete from public.article_topics where article_id in (${fixtureArticles})`,
          `delete from public.ai_usage_events where article_id in (${fixtureArticles})`,
          `delete from public.raw_contents where article_id in (${fixtureArticles})`,
          `delete from public.drafts where article_id in (${fixtureArticles})`,
          `delete from public.articles where canonical_url like 'https://feed.example.test/%'`,
          `delete from public.news_bot_settings where telegram_channel_id = '${channelId}'`,
          `delete from public.telegram_updates where update_id = ${updateId}`,
        ]) {
          await pool.query(statement);
        }
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback").catch(() => {});
        throw new Error(
          `teardown failed, so the next run would start from dirty state: ${
            (error as Error).message
          }`,
          { cause: error },
        );
      }

      await moduleRef.close();
      await pool.end().catch(() => undefined);
    }
  },
);

import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";

import { EditorialArticlePublishedEventPublisher } from "../../src/editorial/application/article-published-event.publisher.js";
import { ARTICLE_PUBLISHED_EVENT_PUBLISHER } from "../../src/editorial/editorial-application.tokens.js";
import { EditorialIntegrationEventsModule } from "../../src/editorial/editorial-integration-events.module.js";
import { NEWS_FEATURE_FLAGS_REPOSITORY, NEWS_SETTINGS_REPOSITORY } from "../../src/settings/settings.tokens.js";
import { PublicationMilestonesService } from "../../src/publication-milestones/application/publication-milestones.service.js";
import { PublicationMilestonesModule } from "../../src/publication-milestones/publication-milestones.module.js";
import {
  PUBLICATION_MILESTONE_FEATURE_KEY,
  PublicationMilestoneDeliveryError,
} from "../../src/publication-milestones/publication-milestones.contracts.js";
import {
  PUBLICATION_MILESTONE_DELIVERY_GATEWAY,
  PUBLICATION_MILESTONES_OPTIONS,
  PUBLICATION_MILESTONES_REPOSITORY,
} from "../../src/publication-milestones/publication-milestones.tokens.js";

const publication = {
  id: "publication-50",
  draft_id: "draft-50",
  article_id: "article-50",
  telegram_channel_id: "@channel",
  telegram_message_id: 50,
  published_at: "2026-08-21T10:00:00.000Z",
  message_text: "Article body",
  metadata: {},
  created_at: "2026-08-21T10:00:00.000Z",
};

const eventBus = {
  subscribe() { return () => {}; },
  async publish() {},
};

test("PublicationMilestonesService sends one deterministic thank-you on an enabled milestone ordinal", async () => {
  const calls: unknown[] = [];
  const service = new PublicationMilestonesService(
    {
      async claim() {
        calls.push("claim");
        return {
          id: "milestone-1",
          telegram_channel_id: "@channel",
          ordinal: 50,
          published_post_id: publication.id,
          language_code: "en",
          editor_name: "Mikhail",
          state: "sending",
          claim_token: "00000000-0000-4000-8000-000000000001",
          telegram_message_id: null,
          attempt_count: 1,
          last_error: null,
          created_at: publication.created_at,
          updated_at: publication.created_at,
          claimed_at: publication.created_at,
          sent_at: null,
          failed_at: null,
          uncertain_at: null,
        };
      },
      async retry() { return null; },
      async markSent(input: { milestoneId: string; claimToken: string; telegramMessageId: number }) {
        calls.push(["sent", input]);
        return {} as never;
      },
      async markFailed() {
        calls.push("failed");
        return null;
      },
      async markUncertain() { return null; },
      async reconcileSent() { return null; },
      async reconcileNotSent() { return null; },
    },
    {
      async getNewsSettings() {
        return { language_code: "en" } as never;
      },
    } as never,
    {
      async getNewsFeatureFlags() {
        return [
          {
            feature_key: PUBLICATION_MILESTONE_FEATURE_KEY,
            state: "enabled",
          },
        ] as never;
      },
    } as never,
    {
      async send(input) {
        calls.push(["send", input]);
        return { messageId: 9001 };
      },
    },
    {
      editorName: "Mikhail",
      deliveryGateway: { async send() { return { messageId: 1 }; } },
    },
    eventBus,
  );

  await service.handle({
    draftId: publication.draft_id,
    articleId: publication.article_id,
    publicationPath: "automatic",
    publication,
  });

  assert.deepEqual(calls, [
    "claim",
    [
      "send",
      {
        channelId: "@channel",
        text: "This is our 50th post. Mikhail is grateful to everyone reading and will keep sharing strong stories here.",
      },
    ],
    ["sent", {
      milestoneId: "milestone-1",
      claimToken: "00000000-0000-4000-8000-000000000001",
      telegramMessageId: 9001,
    }],
  ]);
});

test("PublicationMilestonesService is a no-op when the feature is off", async () => {
  const calls: unknown[] = [];
  const service = new PublicationMilestonesService(
    {
      async claim() {
        calls.push("claim");
        return null;
      },
      async retry() { return null; },
      async markSent() {
        calls.push("sent");
        return null;
      },
      async markFailed() {
        calls.push("failed");
        return null;
      },
      async markUncertain() { calls.push("uncertain"); return null; },
      async reconcileSent() { return null; },
      async reconcileNotSent() { return null; },
    },
    {
      async getNewsSettings() {
        return { language_code: "de" } as never;
      },
    } as never,
    {
      async getNewsFeatureFlags() {
        return [
          {
            feature_key: PUBLICATION_MILESTONE_FEATURE_KEY,
            state: "off",
          },
        ] as never;
      },
    } as never,
    {
      async send() {
        calls.push("send");
        return { messageId: 9001 };
      },
    },
    {
      editorName: "Mikhail",
      deliveryGateway: { async send() { return { messageId: 1 }; } },
    },
    eventBus,
  );

  await service.handle({
    draftId: publication.draft_id,
    articleId: publication.article_id,
    publicationPath: "automatic",
    publication,
  });

  assert.deepEqual(calls, []);
});

test("PublicationMilestonesService retries only a definitively rejected delivery", async () => {
  let attempts = 0;
  const calls: unknown[] = [];
  const service = new PublicationMilestonesService(
    {
      async claim() {
        attempts += 1;
        return {
          id: "milestone-1",
          telegram_channel_id: "@channel",
          ordinal: 100,
          published_post_id: publication.id,
          language_code: "uk",
          editor_name: "Mikhail",
          state: "sending",
          claim_token: attempts === 1
            ? "00000000-0000-4000-8000-000000000001"
            : "00000000-0000-4000-8000-000000000002",
          telegram_message_id: null,
          attempt_count: attempts,
          last_error: null,
          created_at: publication.created_at,
          updated_at: publication.created_at,
          claimed_at: publication.created_at,
          sent_at: null,
          failed_at: null,
          uncertain_at: null,
        };
      },
      async retry() { return null; },
      async markSent(input: { claimToken: string; telegramMessageId: number }) {
        calls.push(["sent", input.claimToken, input.telegramMessageId]);
        return {} as never;
      },
      async markFailed(input: { claimToken: string; errorMessage: string }) {
        calls.push(["failed", input.claimToken, input.errorMessage]);
        return null;
      },
      async markUncertain() { return null; },
      async reconcileSent() { return null; },
      async reconcileNotSent() { return null; },
    },
    {
      async getNewsSettings() {
        return { language_code: "uk" } as never;
      },
    } as never,
    {
      async getNewsFeatureFlags() {
        return [
          {
            feature_key: PUBLICATION_MILESTONE_FEATURE_KEY,
            state: "enabled",
          },
        ] as never;
      },
    } as never,
    {
      async send() {
        if (attempts === 1) {
          throw new PublicationMilestoneDeliveryError(
            "rejected",
            "rejected",
          );
        }
        return { messageId: 9002 };
      },
    },
    {
      editorName: "Mikhail",
      deliveryGateway: { async send() { return { messageId: 1 }; } },
    },
    eventBus,
  );

  await assert.rejects(
    service.handle({
      draftId: publication.draft_id,
      articleId: publication.article_id,
      publicationPath: "automatic",
      publication,
    }),
    /rejected/,
  );
  await service.handle({
    draftId: publication.draft_id,
    articleId: publication.article_id,
    publicationPath: "automatic",
    publication,
  });

  assert.deepEqual(calls, [
    ["failed", "00000000-0000-4000-8000-000000000001", "rejected"],
    ["sent", "00000000-0000-4000-8000-000000000002", 9002],
  ]);
});

test("PublicationMilestonesService fences ambiguous delivery and does not auto-retry", async () => {
  let claims = 0;
  let sends = 0;
  const calls: unknown[] = [];
  const service = new PublicationMilestonesService(
    {
      async claim() {
        claims += 1;
        if (claims > 1) return null;
        return {
          id: "milestone-uncertain",
          telegram_channel_id: "@channel",
          ordinal: 150,
          published_post_id: publication.id,
          language_code: "en",
          editor_name: "Mikhail",
          state: "sending",
          claim_token: "00000000-0000-4000-8000-000000000003",
          telegram_message_id: null,
          attempt_count: 1,
          last_error: null,
          created_at: publication.created_at,
          updated_at: publication.created_at,
          claimed_at: publication.created_at,
          sent_at: null,
          failed_at: null,
          uncertain_at: null,
        };
      },
      async retry() { return null; },
      async markSent() { return null; },
      async markFailed() { return null; },
      async markUncertain(input) { calls.push(input); return null; },
      async reconcileSent() { return null; },
      async reconcileNotSent() { return null; },
    },
    { async getNewsSettings() { return { language_code: "en" } as never; } } as never,
    { async getNewsFeatureFlags() { return [{ feature_key: PUBLICATION_MILESTONE_FEATURE_KEY, state: "enabled" }] as never; } } as never,
    { async send() { sends += 1; throw new Error("timeout"); } },
    { editorName: "Mikhail", deliveryGateway: { async send() { return { messageId: 1 }; } } },
    eventBus,
  );
  const event = {
    draftId: publication.draft_id,
    articleId: publication.article_id,
    publicationPath: "automatic" as const,
    publication,
  };

  await assert.rejects(service.handle(event), /timeout/);
  await service.handle(event);

  assert.equal(sends, 1);
  assert.deepEqual(calls, [{
    milestoneId: "milestone-uncertain",
    claimToken: "00000000-0000-4000-8000-000000000003",
    errorMessage: "timeout",
  }]);
});

test("article-published event fan-out supports independent subscribers", async () => {
  const publisher = new EditorialArticlePublishedEventPublisher();
  const calls: string[] = [];
  publisher.subscribe({ async handle() { calls.push("first"); throw new Error("failed"); } });
  const unsubscribe = publisher.subscribe({ async handle() { calls.push("second"); } });

  await assert.rejects(
    publisher.publish({
      draftId: publication.draft_id,
      articleId: publication.article_id,
      publicationPath: "automatic",
      publication,
    }),
    AggregateError,
  );
  assert.deepEqual(calls, ["first", "second"]);
  unsubscribe();
});

test("PublicationMilestonesModule registers as an optional integration-event module", () => {
  const module = PublicationMilestonesModule.register({
    editorName: "Mikhail",
    deliveryGateway: { async send() { throw new Error("unused"); } },
  });

  assert.equal(module.global, undefined);
  assert.ok(module.imports?.includes(EditorialIntegrationEventsModule));
  assert.deepEqual(
    Reflect.getMetadata(
      SELF_DECLARED_DEPS_METADATA,
      PublicationMilestonesService,
    ),
    [
      { index: 5, param: ARTICLE_PUBLISHED_EVENT_PUBLISHER },
      { index: 4, param: PUBLICATION_MILESTONES_OPTIONS },
      { index: 3, param: PUBLICATION_MILESTONE_DELIVERY_GATEWAY },
      { index: 2, param: NEWS_FEATURE_FLAGS_REPOSITORY },
      { index: 1, param: NEWS_SETTINGS_REPOSITORY },
      { index: 0, param: PUBLICATION_MILESTONES_REPOSITORY },
    ],
  );
});

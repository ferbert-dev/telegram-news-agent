import "reflect-metadata";

import assert from "node:assert/strict";
import test from "node:test";

import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";

import { EditorialWorkflowService } from "../../src/editorial/application/editorial-workflow.service.js";
import { GenerateReviewDraftUseCase } from "../../src/editorial/application/generate-review-draft.use-case.js";
import { PublishApprovedDraftUseCase } from "../../src/editorial/application/publish-approved-draft.use-case.js";
import { ReconcilePublicationUseCase } from "../../src/editorial/application/reconcile-publication.use-case.js";
import type {
  EditorialDraftGateway,
  EditorialPublicationGateway,
  ExcludedTopicPublicationPolicy,
  ReconcilePublicationInput,
} from "../../src/editorial/editorial-application.contracts.js";
import { PublicationDeliveryError } from "../../src/editorial/editorial-application.contracts.js";
import { EditorialApplicationModule } from "../../src/editorial/editorial-application.module.js";
import { EditorialIntegrationEventsModule } from "../../src/editorial/editorial-integration-events.module.js";
import {
  ARTICLE_PUBLISHED_EVENT_PUBLISHER,
  EDITORIAL_DRAFT_GATEWAY,
  EDITORIAL_PUBLICATION_GATEWAY,
  EDITORIAL_WORKFLOW_APPLICATION,
  EXCLUDED_TOPIC_PUBLICATION_POLICY,
} from "../../src/editorial/editorial-application.tokens.js";
import type {
  DraftRow,
  EditorialPersistence,
  PublishedPostRow,
} from "../../src/editorial/editorial-persistence.contracts.js";
import { EditorialPersistenceModule } from "../../src/editorial/editorial-persistence.module.js";
import { EDITORIAL_PERSISTENCE } from "../../src/editorial/editorial-persistence.tokens.js";
import type { ArticleRow } from "../../src/research/research-persistence.contracts.js";
import { SettingsPersistenceModule } from "../../src/settings/settings-persistence.module.js";
import { NEWS_SETTINGS_REPOSITORY } from "../../src/settings/settings.tokens.js";
import type {
  AiUsageEventRow,
  UsageReportingPersistence,
} from "../../src/usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../../src/usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";

const ARTICLE: ArticleRow = {
  id: "article-1",
  source_id: "source-1",
  search_run_id: "run-1",
  canonical_url: "https://example.test/article",
  title: "Grounded article",
  author: null,
  published_at: null,
  discovered_at: "2026-08-12T09:00:00.000Z",
  content_hash: "hash",
  status: "extracted",
  metadata: {},
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T09:00:00.000Z",
};

const DRAFT: DraftRow = {
  id: "draft-1",
  article_id: ARTICLE.id,
  body: "Exact approved outbound article",
  status: "publishing",
  model: "configured-editor-model",
  prompt_version: "telegram-grounded-v2",
  reviewer_notes: JSON.stringify({ editor: { name: "Editor" } }),
  approved_at: "2026-08-12T10:00:00.000Z",
  created_at: "2026-08-12T09:00:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
};

const PUBLICATION: PublishedPostRow = {
  id: "publication-1",
  draft_id: DRAFT.id,
  article_id: ARTICLE.id,
  telegram_channel_id: "@channel",
  telegram_message_id: 42,
  published_at: "2026-08-12T10:01:00.000Z",
  message_text: DRAFT.body,
  metadata: {},
  created_at: "2026-08-12T10:01:00.000Z",
};

const USAGE: AiUsageEventRow = {
  id: "usage-1",
  provider: "openai",
  provider_response_id: "response-1",
  model: "configured-editor-model",
  operation: "editorial",
  telegram_channel_id: "@channel",
  search_run_id: ARTICLE.search_run_id,
  article_id: ARTICLE.id,
  input_tokens: 10,
  cached_input_tokens: 0,
  output_tokens: 5,
  reasoning_tokens: 0,
  web_search_calls: 0,
  estimated_cost_usd: "0.00100000",
  pricing_snapshot: null,
  created_at: "2026-08-12T10:00:00.000Z",
};

function asEditorial(value: object): EditorialPersistence {
  return value as unknown as EditorialPersistence;
}

function asPolicyEditorial(value: Record<string, unknown>): EditorialPersistence {
  const implementation = value as {
    claimDraftForPublication?: (id: string, channelId: string) => Promise<DraftRow | undefined>;
  };
  return asEditorial({
    async findPublicationPolicyBlockByDraft() { return null; },
    async getDraft() { return { ...DRAFT, status: "approved", articles: ARTICLE }; },
    async claimDraftForPublicationWithPolicy(input: { draftId: string; channelId: string }) {
      const draft = implementation.claimDraftForPublication
        ? await implementation.claimDraftForPublication(input.draftId, input.channelId)
        : DRAFT;
      return { outcome: draft ? "claimed" : "not_publishable", draft: draft ?? null };
    },
    async blockDraftPublication(input: { draftId: string; reasonCode: string }) {
      return {
        outcome: "blocked",
        blockId: "block-1",
        draftId: input.draftId,
        articleId: DRAFT.article_id,
        draftStatus: "rejected",
        reasonCode: input.reasonCode,
        createdAt: "2026-08-12T10:00:00.000Z",
      };
    },
    ...value,
  });
}

function asUsage(value: object): UsageReportingPersistence {
  return value as unknown as UsageReportingPersistence;
}

test("GenerateReviewDraftUseCase passes grounded evidence and cancellation to the configured gateway, records usage best effort, and persists the exact atomic plan", async () => {
  const calls: unknown[] = [];
  const signal = new AbortController().signal;
  const usageInput = {
    provider: "openai",
    providerResponseId: "response-1",
    model: "configured-editor-model",
    operation: "editorial",
    articleId: ARTICLE.id,
  };
  const plan = {
    article_id: ARTICLE.id,
    body: "Grounded review draft",
    model: "configured-editor-model",
    prompt_version: "telegram-grounded-v2",
    reviewer_notes: "{}",
    lease_name: "daily",
    lease_owner_id: "owner-1",
  };
  const input = {
    article: ARTICLE,
    evidence: [
      {
        url: ARTICLE.canonical_url,
        text: "Full verified source text",
        primary: true,
      },
    ],
    languageCode: "en" as const,
    channelId: "@channel",
  };
  const gateway: EditorialDraftGateway = {
    async generate(received, receivedSignal) {
      calls.push(["generate", received, receivedSignal]);
      return { draft: plan, usageEvents: [usageInput, { ...usageInput, providerResponseId: "failed" }] };
    },
  };
  const editorial = asEditorial({
    async createReviewDraft(received: unknown) {
      calls.push(["persist", received]);
      return { ...DRAFT, body: plan.body, status: "review" };
    },
  });
  const usage = asUsage({
    async recordAiUsage(received: typeof usageInput) {
      calls.push(["usage", received]);
      if (received.providerResponseId === "failed") throw new Error("ledger unavailable");
      return USAGE;
    },
  });

  const result = await new GenerateReviewDraftUseCase(
    editorial,
    usage,
    gateway,
  ).execute(input, signal);

  assert.equal((calls[0] as unknown[])[1], input);
  assert.equal((calls[0] as unknown[])[2], signal);
  assert.equal((calls[3] as unknown[])[1], plan);
  assert.equal(result.generation.draft, plan);
  assert.deepEqual(result.usageEvents, [USAGE]);
  assert.equal(result.draft.status, "review");
});

test("GenerateReviewDraftUseCase preserves gateway failure identity and rejects cross-article plans before persistence", async () => {
  const failure = new Error("grounded generator failed");
  await assert.rejects(
    new GenerateReviewDraftUseCase(
      asEditorial({}),
      asUsage({}),
      { async generate() { throw failure; } },
    ).execute({
      article: ARTICLE,
      evidence: [],
      languageCode: "en",
    }),
    (error) => error === failure,
  );

  let persisted = false;
  let malformedUsageRecorded = 0;
  await assert.rejects(
    new GenerateReviewDraftUseCase(
      asEditorial({ async createReviewDraft() { persisted = true; } }),
      asUsage({
        async recordAiUsage() {
          malformedUsageRecorded += 1;
          return USAGE;
        },
      }),
      {
        async generate() {
          return {
            draft: { article_id: "other-article", body: "Wrong" },
            usageEvents: [
              {
                provider: "openai",
                model: "configured-editor-model",
                operation: "editorial",
              },
            ],
          };
        },
      },
    ).execute({ article: ARTICLE, evidence: [], languageCode: "en" }),
    /does not match the requested article/,
  );
  assert.equal(persisted, false);
  assert.equal(
    malformedUsageRecorded,
    1,
    "legacy parity meters a completed provider call before rejecting its malformed plan",
  );
});

test("GenerateReviewDraftUseCase honors cancellation after generation without creating a draft", async () => {
  const controller = new AbortController();
  const reason = new Error("shutdown");
  let persisted = false;
  const gateway: EditorialDraftGateway = {
    async generate() {
      controller.abort(reason);
      return {
        draft: { article_id: ARTICLE.id, body: "Generated before abort" },
        usageEvents: [],
      };
    },
  };
  await assert.rejects(
    new GenerateReviewDraftUseCase(
      asEditorial({ async createReviewDraft() { persisted = true; } }),
      asUsage({}),
      gateway,
    ).execute(
      { article: ARTICLE, evidence: [], languageCode: "en" },
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(persisted, false);
});

test("PublishApprovedDraftUseCase classifies before claim and atomically rejects a blocked final policy decision", async () => {
  const calls: unknown[] = [];
  const draft = DRAFT;
  const editorial = {
    async findPublicationByDraft() {
      calls.push(["find"]);
      return null;
    },
    async findPublicationPolicyBlockByDraft() {
      calls.push(["find-block"]);
      return null;
    },
    async getDraft() {
      calls.push(["draft"]);
      return { ...draft, status: "approved", articles: ARTICLE };
    },
    async blockDraftPublication(input: { reasonCode: string }) {
      calls.push(["block", input]);
      return {
        outcome: "blocked",
        blockId: "block-1",
        draftId: draft.id,
        articleId: draft.article_id,
        draftStatus: "rejected",
        reasonCode: input.reasonCode,
        createdAt: "2026-08-12T10:00:00.000Z",
      };
    },
  };
  const settings = {
    async getNewsSettings(channelId: string) {
      calls.push(["settings", channelId]);
      return { excluded_topic_codes: ["war_conflict"], version: 7 };
    },
  };
  const policy: ExcludedTopicPublicationPolicy = {
    async evaluate(input) {
      calls.push(["policy", input]);
      return { decision: "block", reasonCode: "excluded_topic" };
    },
  };
  const delivery: EditorialPublicationGateway = {
    async publish() {
      throw new Error("blocked content must not reach the gateway");
    },
  };

  const result = await new PublishApprovedDraftUseCase(
    editorial as never,
    settings as never,
    asUsage({}),
    policy,
    delivery,
  ).execute({ draftId: draft.id, channelId: "@channel" });

  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "excluded_topic_main_subject");
  assert.equal(result.publication, null);
  assert.equal(result.draft.id, draft.id);
  assert.equal(result.draft.status, "rejected");
  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), [
    "find",
    "find-block",
    "draft",
    "settings",
    "policy",
    "block",
  ]);
});

test("PublishApprovedDraftUseCase evaluates the current settings and exact claimed content immediately before delivery, then finalizes the receipt", async () => {
  const calls: unknown[] = [];
  const editorial = asPolicyEditorial({
    async findPublicationByDraft() { calls.push(["find"]); return null; },
    async claimDraftForPublication() { calls.push(["claim"]); return DRAFT; },
    async finalizeDraftPublication(input: unknown) {
      calls.push(["finalize", input]);
      return PUBLICATION;
    },
  });
  const policy: ExcludedTopicPublicationPolicy = {
    async evaluate(input, signal) {
      calls.push(["policy", input, signal]);
      return { decision: "allow" };
    },
  };
  const gateway: EditorialPublicationGateway = {
    async publish(input, signal) {
      calls.push(["gateway", input, signal]);
      return { messageId: 42, messageDate: 123 };
    },
  };
  const signal = new AbortController().signal;
  const result = await new PublishApprovedDraftUseCase(
    editorial,
    {
      async getNewsSettings(channelId: string) {
        calls.push(["settings", channelId]);
        return { version: 9, excluded_topic_codes: ["war_conflict"] } as never;
      },
    } as never,
    asUsage({}),
    policy,
    gateway,
    { async publish(event, eventSignal) { calls.push(["event", event, eventSignal]); } },
  ).execute({ draftId: DRAFT.id, channelId: "@channel", signal });

  assert.deepEqual(calls.map((call) => (call as unknown[])[0]), [
    "find", "settings", "policy", "claim", "gateway", "finalize", "event",
  ]);
  assert.deepEqual((calls[2] as unknown[])[1], {
    draftId: DRAFT.id,
    articleId: DRAFT.article_id,
    channelId: "@channel",
    content: { text: DRAFT.body },
    settings: { version: 9, excludedTopicCodes: ["war_conflict"] },
  });
  assert.equal((calls[2] as unknown[])[2], signal);
  assert.deepEqual((calls[4] as unknown[])[1], {
    channelId: "@channel",
    text: DRAFT.body,
    disableNotification: false,
  });
  assert.deepEqual((calls[5] as unknown[])[1], {
    draftId: DRAFT.id,
    channelId: "@channel",
    messageId: 42,
    messageText: DRAFT.body,
    metadata: {
      bot_message_date: 123,
      approval: "database_approved",
      editor: { name: "Editor" },
    },
  });
  assert.deepEqual((calls[6] as unknown[])[1], {
    draftId: DRAFT.id,
    articleId: ARTICLE.id,
    publicationPath: "automatic",
    publication: PUBLICATION,
  });
  assert.equal((calls[6] as unknown[])[2], signal);
  assert.deepEqual(result, {
    status: "published",
    publication: PUBLICATION,
    alreadyPublished: false,
  });
});

test("PublishApprovedDraftUseCase preserves publication success when a post-finalize subscriber fails", async () => {
  const result = await new PublishApprovedDraftUseCase(
    asPolicyEditorial({
      async findPublicationByDraft() { return null; },
      async finalizeDraftPublication() { return PUBLICATION; },
    }),
    {
      async getNewsSettings() {
        return { version: 1, excluded_topic_codes: [] } as never;
      },
    } as never,
    asUsage({}),
    { async evaluate() { return { decision: "allow" }; } },
    { async publish() { return { messageId: 42 }; } },
    { async publish() { throw new Error("subscriber offline"); } },
  ).execute({ draftId: DRAFT.id, channelId: "@channel" });

  assert.equal(result.status, "published");
  assert.equal(result.publication.id, PUBLICATION.id);
});

test("PublishApprovedDraftUseCase records completed policy usage before honoring a post-response abort", async () => {
  const controller = new AbortController();
  const abortReason = new Error("shutdown after policy response");
  const calls: unknown[] = [];
  const usageEvent = {
    provider: "openai",
    providerResponseId: "policy-response-after-abort",
    model: "configured-policy-model",
    operation: "excluded_topic_classification",
    inputTokens: 12,
    outputTokens: 3,
  };
  const useCase = new PublishApprovedDraftUseCase(
    asPolicyEditorial({
      async findPublicationByDraft() { return null; },
      async claimDraftForPublicationWithPolicy() {
        calls.push("claim");
        return { outcome: "claimed", draft: DRAFT };
      },
    }),
    {
      async getNewsSettings() {
        return { version: 4, excluded_topic_codes: ["war_conflict"] } as never;
      },
    } as never,
    asUsage({
      async recordAiUsage(input: Record<string, unknown>) {
        calls.push(["usage", input]);
        return USAGE;
      },
    }),
    {
      async evaluate() {
        controller.abort(abortReason);
        return { decision: "allow", usageEvents: [usageEvent] };
      },
    },
    {
      async publish() {
        calls.push("publish");
        return { messageId: 42 };
      },
    },
  );

  await assert.rejects(
    useCase.execute({
      draftId: DRAFT.id,
      channelId: "@channel",
      signal: controller.signal,
    }),
    (error) => error === abortReason,
  );
  assert.deepEqual(calls, [
    [
      "usage",
      {
        ...usageEvent,
        telegramChannelId: "@channel",
        articleId: DRAFT.article_id,
      },
    ],
  ]);
});

test("PublishApprovedDraftUseCase is idempotent before claim and gateway", async () => {
  let touched = false;
  const result = await new PublishApprovedDraftUseCase(
    asPolicyEditorial({ async findPublicationByDraft() { return PUBLICATION; } }),
    { async getNewsSettings() { touched = true; } } as never,
    asUsage({}),
    { async evaluate() { touched = true; return { decision: "allow" }; } },
    { async publish() { touched = true; return { messageId: 42 }; } },
  ).execute({ draftId: DRAFT.id, channelId: "@channel" });
  assert.equal(touched, false);
  assert.deepEqual(result, {
    status: "already_published",
    publication: PUBLICATION,
    alreadyPublished: true,
  });
});

test("PublishApprovedDraftUseCase atomically blocks uncertain, explicit-error, invalid, and failed policy evaluations without claiming", async (t) => {
  for (const fixture of ["uncertain", "explicit-error", "invalid", "error", "missing-settings", "cancel"] as const) {
    await t.test(fixture, async () => {
      const controller = new AbortController();
      const abortReason = new Error("cancel policy");
      let blocked = 0;
      let delivered = 0;
      const policy: ExcludedTopicPublicationPolicy = {
        async evaluate() {
          if (fixture === "error") throw new Error("classifier offline");
          if (fixture === "cancel") controller.abort(abortReason);
          if (fixture === "explicit-error") {
            return { decision: "error", reasonCode: "classifier_unavailable" };
          }
          if (fixture === "invalid") return { decision: "allow_without_contract" } as never;
          return { decision: "uncertain", reasonCode: "insufficient_evidence" };
        },
      };
      const useCase = new PublishApprovedDraftUseCase(
        asPolicyEditorial({
          async findPublicationByDraft() { return null; },
          async blockDraftPublication(input: { reasonCode: string }) {
            blocked += 1;
            return {
              outcome: "blocked",
              blockId: "block-1",
              draftId: DRAFT.id,
              articleId: DRAFT.article_id,
              draftStatus: "rejected",
              reasonCode: input.reasonCode,
              createdAt: DRAFT.updated_at,
            };
          },
        }),
        {
          async getNewsSettings() {
            return fixture === "missing-settings"
              ? null
              : ({ version: 2, excluded_topic_codes: ["war_conflict"] } as never);
          },
        } as never,
        asUsage({}),
        policy,
        { async publish() { delivered += 1; return { messageId: 42 }; } },
      );

      if (fixture === "cancel") {
        await assert.rejects(
          useCase.execute({
            draftId: DRAFT.id,
            channelId: "@channel",
            signal: controller.signal,
          }),
          (error) => error === abortReason,
        );
      } else {
        if (fixture === "missing-settings") {
          await assert.rejects(
            useCase.execute({ draftId: DRAFT.id, channelId: "@channel" }),
            /settings are unavailable/,
          );
        } else {
          const result = await useCase.execute({
            draftId: DRAFT.id,
            channelId: "@channel",
          });
          assert.equal(result.status, "blocked");
        }
      }
      assert.equal(
        blocked,
        fixture === "missing-settings" || fixture === "cancel" ? 0 : 1,
      );
      assert.equal(delivered, 0);
    });
  }
});

test("PublishApprovedDraftUseCase releases definitive delivery rejection but preserves ambiguous outcomes for reconciliation", async () => {
  const run = async (error: Error) => {
    let releases = 0;
    const useCase = new PublishApprovedDraftUseCase(
      asPolicyEditorial({
        async findPublicationByDraft() { return null; },
        async claimDraftForPublication() { return DRAFT; },
        async releaseRejectedDraftPublication() { releases += 1; return DRAFT; },
      }),
      { async getNewsSettings() { return { version: 1, excluded_topic_codes: [] } as never; } } as never,
      asUsage({}),
      { async evaluate() { return { decision: "allow" }; } },
      { async publish() { throw error; } },
    );
    await assert.rejects(useCase.execute({ draftId: DRAFT.id, channelId: "@channel" }));
    return releases;
  };
  assert.equal(
    await run(new PublicationDeliveryError("rejected", "rejected")),
    1,
  );
  assert.equal(await run(new Error("connection reset")), 0);
});

test("concurrent publication attempts preserve the PostgreSQL claim as the single-send authority", async () => {
  let claimed = false;
  let sends = 0;
  const editorial = asPolicyEditorial({
    async findPublicationByDraft() { return null; },
    async claimDraftForPublication() {
      if (claimed) throw new Error("Draft is not approved or is already being published");
      claimed = true;
      return DRAFT;
    },
    async finalizeDraftPublication() { return PUBLICATION; },
  });
  const useCase = new PublishApprovedDraftUseCase(
    editorial,
    { async getNewsSettings() { return { version: 1, excluded_topic_codes: [] } as never; } } as never,
    asUsage({}),
    { async evaluate() { return { decision: "allow" }; } },
    { async publish() { sends += 1; return { messageId: 42 }; } },
  );
  const results = await Promise.allSettled([
    useCase.execute({ draftId: DRAFT.id, channelId: "@channel" }),
    useCase.execute({ draftId: DRAFT.id, channelId: "@channel" }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(sends, 1);
});

test("ReconcilePublicationUseCase preserves operator-confirmed sent and exact not-sent recovery without calling a gateway", async () => {
  const calls: unknown[] = [];
  const useCase = new ReconcilePublicationUseCase(asEditorial({
    async getDraft(id: string) { calls.push(["get", id]); return { ...DRAFT, articles: ARTICLE }; },
    async finalizeDraftPublication(input: unknown) { calls.push(["finalize", input]); return PUBLICATION; },
    async resetDraftPublication(id: string, confirmation: string) {
      calls.push(["reset", id, confirmation]);
      return { ...DRAFT, status: "approved" };
    },
  }));
  assert.equal(
    (await useCase.execute({ draftId: DRAFT.id, outcome: "sent", channelId: "@channel", messageId: 42 })).publication,
    PUBLICATION,
  );
  assert.deepEqual((calls[1] as unknown[])[1], {
    draftId: DRAFT.id,
    channelId: "@channel",
    messageId: 42,
    messageText: DRAFT.body,
    metadata: { approval: "database_approved", reconciliation: "operator_confirmed_sent" },
  });
  assert.equal(
    (await useCase.execute({ draftId: DRAFT.id, outcome: "not-sent" })).draft?.status,
    "approved",
  );
  assert.deepEqual(calls[2], ["reset", DRAFT.id, "TELEGRAM_NOT_SENT"]);
  await assert.rejects(
    useCase.execute({ draftId: DRAFT.id, outcome: "sent", channelId: "@channel", messageId: 0 }),
    (error) =>
      error instanceof Error &&
      error.message === "A positive Telegram message ID is required",
  );
  assert.equal(calls.length, 3);
});

test("ReconcilePublicationUseCase rejects invalid boundary outcomes before any persistence call", async () => {
  const calls: string[] = [];
  const useCase = new ReconcilePublicationUseCase(asEditorial({
    async getDraft() { calls.push("get"); return DRAFT; },
    async finalizeDraftPublication() { calls.push("finalize"); return PUBLICATION; },
    async resetDraftPublication() { calls.push("reset"); return DRAFT; },
  }));
  const invalidInputs: unknown[] = [
    { draftId: DRAFT.id, outcome: "invalid" },
    { draftId: DRAFT.id },
    { draftId: DRAFT.id, outcome: null },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      useCase.execute(input as ReconcilePublicationInput),
      (error) =>
        error instanceof Error &&
        error.message === "Reconciliation outcome must be sent or not-sent",
    );
  }

  assert.deepEqual(calls, []);
});

test("Editorial application providers use Symbol injection and export only the workflow port", () => {
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, GenerateReviewDraftUseCase),
    [
      { index: 2, param: EDITORIAL_DRAFT_GATEWAY },
      { index: 1, param: USAGE_REPORTING_PERSISTENCE },
      { index: 0, param: EDITORIAL_PERSISTENCE },
    ],
  );
  assert.deepEqual(
    Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PublishApprovedDraftUseCase),
    [
      { index: 5, param: ARTICLE_PUBLISHED_EVENT_PUBLISHER },
      { index: 4, param: EDITORIAL_PUBLICATION_GATEWAY },
      { index: 3, param: EXCLUDED_TOPIC_PUBLICATION_POLICY },
      { index: 2, param: USAGE_REPORTING_PERSISTENCE },
      { index: 1, param: NEWS_SETTINGS_REPOSITORY },
      { index: 0, param: EDITORIAL_PERSISTENCE },
    ],
  );
  const gateways = {
    draft: { async generate() { throw new Error("unused"); } },
    publication: { async publish() { throw new Error("unused"); } },
    excludedTopics: { async evaluate() { return { decision: "allow" as const }; } },
  };
  const module = EditorialApplicationModule.register(gateways);
  assert.deepEqual(module.imports, [
    EditorialPersistenceModule,
    UsagePersistenceModule,
    SettingsPersistenceModule,
    EditorialIntegrationEventsModule,
  ]);
  assert.deepEqual(module.exports, [EDITORIAL_WORKFLOW_APPLICATION]);
  assert.ok((module.providers ?? []).some(
    (provider) =>
      typeof provider === "object" &&
      provider !== null &&
      "provide" in provider &&
      provider.provide === EDITORIAL_WORKFLOW_APPLICATION &&
      "useExisting" in provider &&
      provider.useExisting === EditorialWorkflowService,
  ));
});

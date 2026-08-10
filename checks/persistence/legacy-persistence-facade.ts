import "reflect-metadata";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { Test } from "@nestjs/testing";
import type { Pool, QueryResult } from "pg";

import { CATALOG_PERSISTENCE } from "../../src/catalog/catalog-persistence.tokens.js";
import { PG_POOL } from "../../src/database/database.tokens.js";
import { EDITORIAL_PERSISTENCE } from "../../src/editorial/editorial-persistence.tokens.js";
import {
  NOTION_AUDIT_OUTBOX_REPOSITORY,
  PIPELINE_LEASES_REPOSITORY,
} from "../../src/operations/operations.tokens.js";
import {
  LEGACY_PERSISTENCE_METHOD_OWNERS,
  type LegacyPersistenceMethod,
} from "../../src/persistence/legacy-persistence.contracts.js";
import { LegacyPersistenceFacade } from "../../src/persistence/legacy-persistence.facade.js";
import { PersistenceFacadeModule } from "../../src/persistence/persistence-facade.module.js";
import { LEGACY_PERSISTENCE } from "../../src/persistence/legacy-persistence.tokens.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../../src/research/research-persistence.tokens.js";
import { SCHEDULER_PERSISTENCE } from "../../src/scheduler/scheduler-persistence.tokens.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../../src/story-deduplication/story-deduplication.tokens.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
  TELEGRAM_SETTINGS_INPUT_REPOSITORY,
} from "../../src/settings/settings.tokens.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
  TELEGRAM_UPDATES_PERSISTENCE,
} from "../../src/telegram/telegram-persistence.tokens.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../src/usage/usage-persistence.tokens.js";
import { NewsRepository } from "../../src/news-repository.js";

type Owner = (typeof LEGACY_PERSISTENCE_METHOD_OWNERS)[LegacyPersistenceMethod];
type Call = { owner: Owner; method: string; args: unknown[] };
type DynamicPort = Record<string, (...args: unknown[]) => Promise<unknown>>;

class NoQueryPool extends EventEmitter {
  query(): Promise<QueryResult> {
    throw new Error("Facade identity test must not query PostgreSQL");
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

const infrastructureMethods = new Set([
  "constructor",
  "query",
  "one",
  "scalar",
  "insertRow",
  "upsertRow",
  "updateState",
  "functionRows",
  "functionScalar",
]);

const samples = {
  listEnabledSources: [],
  listEnabledArticleTags: ["de"],
  listSourceHealth: [],
  upsertSource: [{ name: "Source", feed_url: "https://example.com/feed", source_type: "rss" }],
  setSourceEnabled: ["source-id", true],
  markSourceChecked: ["source-id"],
  markSourceFetchSuccess: ["source-id"],
  markSourceFetchFailure: ["source-id", "timeout"],
  claimSourceDiscovery: ["science"],
  completeSourceDiscovery: [{ topicKey: "science", resultCount: 2 }],
  upsertDiscoveredSource: [{ name: "Source", homepageUrl: null, feedUrl: "https://example.com/feed", discoveredBy: "openai" }],
  startSearchRun: [{ query: "science" }],
  finishSearchRun: ["run-id", { resultCount: 3 }],
  failSearchRun: ["run-id", new Error("failed")],
  createOrResumeArticleCandidate: [{ source_id: null, search_run_id: null, canonical_url: "https://example.com/a", title: "A", author: null, published_at: null, content_hash: null }],
  saveRawContent: [{ article_id: "article-id", content: "body", content_hash: "hash" }],
  transitionArticle: ["article-id", "discovered", "extracted", {}],
  replaceArticleTopics: [{ articleId: "article-id", assignments: [] }],
  listRecentPublishedStories: [{ channelId: "@channel", since: "2026-08-01T00:00:00.000Z", limit: 100 }],
  recordStoryDedupDecision: [{ articleId: "article-id", storyFingerprint: "fingerprint", relation: "distinct", decisionSource: "deterministic" }],
  createDraft: [{ article_id: "article-id", body: "body" }],
  createReviewDraft: [{ article_id: "article-id", body: "body" }],
  getDraft: ["draft-id"],
  listDrafts: [],
  transitionDraft: ["draft-id", "draft", "review", {}],
  approveDraft: ["draft-id"],
  rejectDraft: ["draft-id"],
  claimDraftForPublication: ["draft-id", "@channel"],
  finalizeDraftPublication: [{ draftId: "draft-id", channelId: "@channel", messageId: 7, messageText: "post" }],
  findPublicationByDraft: ["draft-id"],
  resetDraftPublication: ["draft-id", "RESET"],
  releaseRejectedDraftPublication: ["draft-id"],
  recordPublication: [{ draft_id: "draft-id", article_id: "article-id", telegram_channel_id: "@channel", telegram_message_id: 7, message_text: "post" }],
  recordAiUsage: [{ provider: "openai", model: "gpt", operation: "draft" }],
  getDailyUsageDashboard: [{ channelId: "@channel" }],
  acquirePipelineLease: ["pipeline", "owner"],
  renewPipelineLease: ["pipeline", "owner"],
  releasePipelineLease: ["pipeline", "owner"],
  enqueueNotionAuditBackfill: [{ notion_page_id: "page", event_type: "sync", payload: {}, last_error: "error" }],
  claimNotionAuditBackfill: [],
  completeNotionAuditBackfill: ["outbox-id"],
  retryNotionAuditBackfill: ["outbox-id", new Error("retry")],
  getOrCreateNewsSettings: [{ channelId: "@channel", reviewChatId: 1, updatedBy: 2 }],
  getNewsSettings: ["@channel"],
  updateNewsSettings: [{ channelId: "@channel", reviewChatId: 1, scheduleIntervalMinutes: 180, languageCode: "de", topicCodes: [], customTopics: [], approvalPolicy: "manual", quietHoursEnabled: true, updatedBy: 2, expectedVersion: 1 }],
  getOrCreateNewsFeatureFlags: [{ channelId: "@channel", updatedBy: 2 }],
  getNewsFeatureFlags: ["@channel"],
  updateNewsFeatureFlag: [{ channelId: "@channel", featureKey: "article_tags", state: "enabled", updatedBy: 2, expectedVersion: 1 }],
  beginTelegramSettingsInput: [{ controlChatId: 1, requestedBy: 2, promptMessageId: 3, expiresAt: "2026-08-09T12:00:00.000Z" }],
  consumeTelegramSettingsInput: [{ controlChatId: 1, requestedBy: 2, promptMessageId: 3 }],
  claimDueNewsSchedule: [{ claimToken: "claim" }],
  saveNewsScheduleDraft: [{ channelId: "@channel", claimToken: "claim", draftId: "draft-id", preview: "preview", windowHours: 24 }],
  saveNewsSchedulePublication: [{ channelId: "@channel", claimToken: "claim", draftId: "draft-id", publicationMessageId: 7 }],
  renewNewsScheduleClaim: [{ channelId: "@channel", claimToken: "claim" }],
  deferNewsScheduleForQuietHours: [{ channelId: "@channel", claimToken: "claim" }],
  pauseNewsScheduleUnresolved: [{ channelId: "@channel", claimToken: "claim", errorCode: "unknown" }],
  finishNewsSchedule: [{ channelId: "@channel", claimToken: "claim", status: "completed" }],
  claimTelegramUpdate: [101, "callback_query"],
  finishTelegramUpdate: [101, "claim", "completed"],
  getTelegramNewsCheckpoint: [101],
  saveTelegramNewsCheckpoint: [{ update_id: 101, status: "no_candidates" }],
  hasPendingTelegramReview: ["@channel"],
  createTelegramReviewSession: [{ id: "session", draft_id: "draft-id", control_chat_id: 1, preview_message_id: 2, requested_by: 3, expires_at: "2026-08-09T12:00:00.000Z" }],
  findTelegramReviewSessionByDraft: ["draft-id"],
  renewTelegramReviewSession: [{ draftId: "draft-id", expiresAt: "2026-08-09T12:00:00.000Z" }],
  rebindTelegramReviewSession: [{ draftId: "draft-id", controlChatId: 1, expectedPreviewMessageId: 2, previewMessageId: 3, expiresAt: "2026-08-09T12:00:00.000Z" }],
  decideTelegramReviewSession: [{ sessionId: "session", action: "publish", chatId: 1, messageId: 2, actorId: 3 }],
} as const satisfies Record<LegacyPersistenceMethod, readonly unknown[]>;

function port(owner: Owner, calls: Call[]): DynamicPort {
  return new Proxy(
    {},
    {
      get: (_target, method) => {
        if (method === "then") {
          return undefined;
        }
        return async (...args: unknown[]) => {
          calls.push({ owner, method: String(method), args });
          return { owner, method, args };
        };
      },
    },
  ) as DynamicPort;
}

function fixture(calls: Call[] = []) {
  const ports = {
    catalog: port("catalog", calls),
    research: port("research", calls),
    storyDeduplication: port("storyDeduplication", calls),
    editorial: port("editorial", calls),
    usage: port("usage", calls),
    pipelineLeases: port("pipelineLeases", calls),
    notionAudit: port("notionAudit", calls),
    settings: port("settings", calls),
    featureFlags: port("featureFlags", calls),
    settingsInput: port("settingsInput", calls),
    scheduler: port("scheduler", calls),
    telegramUpdates: port("telegramUpdates", calls),
    telegramCheckpoints: port("telegramCheckpoints", calls),
    telegramReviewSessions: port("telegramReviewSessions", calls),
  };
  const facade = new LegacyPersistenceFacade(
    ports.catalog as never,
    ports.research as never,
    ports.storyDeduplication as never,
    ports.editorial as never,
    ports.usage as never,
    ports.pipelineLeases as never,
    ports.notionAudit as never,
    ports.settings as never,
    ports.featureFlags as never,
    ports.settingsInput as never,
    ports.scheduler as never,
    ports.telegramUpdates as never,
    ports.telegramCheckpoints as never,
    ports.telegramReviewSessions as never,
  );
  return { facade, ports };
}

test("facade and owner manifest cover exactly all 67 live NewsRepository domain methods", () => {
  const legacyMethods = Object.getOwnPropertyNames(NewsRepository.prototype)
    .filter((method) => !infrastructureMethods.has(method))
    .sort();
  const facadeMethods = Object.getOwnPropertyNames(LegacyPersistenceFacade.prototype)
    .filter((method) => method !== "constructor")
    .sort();
  const manifestMethods = Object.keys(LEGACY_PERSISTENCE_METHOD_OWNERS).sort();

  assert.equal(legacyMethods.length, 67);
  assert.deepEqual(facadeMethods, legacyMethods);
  assert.deepEqual(manifestMethods, legacyMethods);
  assert.equal(Object.values(LEGACY_PERSISTENCE_METHOD_OWNERS).includes("fallback" as Owner), false);
});

test("all 67 methods delegate once to their declared owner and preserve legacy arguments", async () => {
  const calls: Call[] = [];
  const { facade } = fixture(calls);
  const dynamicFacade = facade as unknown as DynamicPort;

  for (const [method, args] of Object.entries(samples)) {
    calls.length = 0;
    await dynamicFacade[method](...args);
    assert.equal(calls.length, 1, method);
    assert.equal(calls[0]?.owner, LEGACY_PERSISTENCE_METHOD_OWNERS[method as LegacyPersistenceMethod], method);
    assert.equal(calls[0]?.method, method, method);

    if (method === "claimTelegramUpdate") {
      assert.deepEqual(calls[0]?.args, [{ updateId: 101, updateKind: "callback_query", staleAfterSeconds: 120 }]);
    } else if (method === "finishTelegramUpdate") {
      assert.deepEqual(calls[0]?.args, [{ updateId: 101, claimToken: "claim", status: "completed", errorCode: null }]);
    } else {
      assert.deepEqual(calls[0]?.args, args, method);
    }
  }
});

test("Nest module exports the Symbol token as the same useExisting facade instance", async () => {
  const calls: Call[] = [];
  const { ports } = fixture(calls);
  const tokenPorts = [
    [CATALOG_PERSISTENCE, ports.catalog],
    [RESEARCH_INGESTION_PERSISTENCE, ports.research],
    [STORY_DEDUPLICATION_PERSISTENCE, ports.storyDeduplication],
    [EDITORIAL_PERSISTENCE, ports.editorial],
    [USAGE_REPORTING_PERSISTENCE, ports.usage],
    [PIPELINE_LEASES_REPOSITORY, ports.pipelineLeases],
    [NOTION_AUDIT_OUTBOX_REPOSITORY, ports.notionAudit],
    [NEWS_SETTINGS_REPOSITORY, ports.settings],
    [NEWS_FEATURE_FLAGS_REPOSITORY, ports.featureFlags],
    [TELEGRAM_SETTINGS_INPUT_REPOSITORY, ports.settingsInput],
    [SCHEDULER_PERSISTENCE, ports.scheduler],
    [TELEGRAM_UPDATES_PERSISTENCE, ports.telegramUpdates],
    [TELEGRAM_CHECKPOINTS_PERSISTENCE, ports.telegramCheckpoints],
    [TELEGRAM_REVIEW_SESSIONS_PERSISTENCE, ports.telegramReviewSessions],
  ] as const;

  let builder = Test.createTestingModule({ imports: [PersistenceFacadeModule] });
  builder = builder
    .overrideProvider(PG_POOL)
    .useValue(new NoQueryPool() as unknown as Pool);
  for (const [token, value] of tokenPorts) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const module = await builder.compile();
  const facade = module.get(LegacyPersistenceFacade);
  assert.strictEqual(module.get(LEGACY_PERSISTENCE), facade);
});

import { Inject, Injectable } from "@nestjs/common";

import type { CatalogPersistence } from "../catalog/catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "../catalog/catalog-persistence.tokens.js";
import type { EditorialPersistence } from "../editorial/editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../editorial/editorial-persistence.tokens.js";
import type {
  NotionAuditOutboxRepositoryPort,
  PipelineLeasesRepositoryPort,
} from "../operations/operations.interfaces.js";
import {
  NOTION_AUDIT_OUTBOX_REPOSITORY,
  PIPELINE_LEASES_REPOSITORY,
} from "../operations/operations.tokens.js";
import type { ResearchIngestionPersistence } from "../research/research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "../research/research-persistence.tokens.js";
import type { StoryDeduplicationPersistence } from "../story-deduplication/story-deduplication.contracts.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../story-deduplication/story-deduplication.tokens.js";
import type { SchedulerPersistence } from "../scheduler/scheduler-persistence.contracts.js";
import { SCHEDULER_PERSISTENCE } from "../scheduler/scheduler-persistence.tokens.js";
import type {
  NewsFeatureFlagsPersistence,
  NewsSettingsPersistence,
  TelegramSettingsInputPersistence,
} from "../settings/settings.contracts.js";
import {
  NEWS_FEATURE_FLAGS_REPOSITORY,
  NEWS_SETTINGS_REPOSITORY,
  TELEGRAM_SETTINGS_INPUT_REPOSITORY,
} from "../settings/settings.tokens.js";
import type {
  TelegramCheckpointsPersistence,
  TelegramReviewSessionsPersistence,
  TelegramUpdatesPersistence,
  TelegramUpdateTerminalStatus,
} from "../telegram/telegram-persistence.contracts.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
  TELEGRAM_UPDATES_PERSISTENCE,
} from "../telegram/telegram-persistence.tokens.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../usage/usage-persistence.tokens.js";
import type { LegacyPersistence } from "./legacy-persistence.contracts.js";

@Injectable()
export class LegacyPersistenceFacade implements LegacyPersistence {
  constructor(
    @Inject(CATALOG_PERSISTENCE)
    private readonly catalog: CatalogPersistence,
    @Inject(RESEARCH_INGESTION_PERSISTENCE)
    private readonly research: ResearchIngestionPersistence,
    @Inject(STORY_DEDUPLICATION_PERSISTENCE)
    private readonly storyDeduplication: StoryDeduplicationPersistence,
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorial: EditorialPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usage: UsageReportingPersistence,
    @Inject(PIPELINE_LEASES_REPOSITORY)
    private readonly pipelineLeases: PipelineLeasesRepositoryPort,
    @Inject(NOTION_AUDIT_OUTBOX_REPOSITORY)
    private readonly notionAudit: NotionAuditOutboxRepositoryPort,
    @Inject(NEWS_SETTINGS_REPOSITORY)
    private readonly settings: NewsSettingsPersistence,
    @Inject(NEWS_FEATURE_FLAGS_REPOSITORY)
    private readonly featureFlags: NewsFeatureFlagsPersistence,
    @Inject(TELEGRAM_SETTINGS_INPUT_REPOSITORY)
    private readonly settingsInput: TelegramSettingsInputPersistence,
    @Inject(SCHEDULER_PERSISTENCE)
    private readonly scheduler: SchedulerPersistence,
    @Inject(TELEGRAM_UPDATES_PERSISTENCE)
    private readonly telegramUpdates: TelegramUpdatesPersistence,
    @Inject(TELEGRAM_CHECKPOINTS_PERSISTENCE)
    private readonly telegramCheckpoints: TelegramCheckpointsPersistence,
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    private readonly telegramReviewSessions: TelegramReviewSessionsPersistence,
  ) {}

  listEnabledSources(...args: Parameters<CatalogPersistence["listEnabledSources"]>) {
    return this.catalog.listEnabledSources(...args);
  }
  listEnabledArticleTags(...args: Parameters<CatalogPersistence["listEnabledArticleTags"]>) {
    return this.catalog.listEnabledArticleTags(...args);
  }
  listSourceHealth(...args: Parameters<CatalogPersistence["listSourceHealth"]>) {
    return this.catalog.listSourceHealth(...args);
  }
  upsertSource(...args: Parameters<CatalogPersistence["upsertSource"]>) {
    return this.catalog.upsertSource(...args);
  }
  setSourceEnabled(...args: Parameters<CatalogPersistence["setSourceEnabled"]>) {
    return this.catalog.setSourceEnabled(...args);
  }
  markSourceChecked(...args: Parameters<CatalogPersistence["markSourceChecked"]>) {
    return this.catalog.markSourceChecked(...args);
  }
  markSourceFetchSuccess(...args: Parameters<CatalogPersistence["markSourceFetchSuccess"]>) {
    return this.catalog.markSourceFetchSuccess(...args);
  }
  markSourceFetchFailure(...args: Parameters<CatalogPersistence["markSourceFetchFailure"]>) {
    return this.catalog.markSourceFetchFailure(...args);
  }
  claimSourceDiscovery(...args: Parameters<CatalogPersistence["claimSourceDiscovery"]>) {
    return this.catalog.claimSourceDiscovery(...args);
  }
  completeSourceDiscovery(...args: Parameters<CatalogPersistence["completeSourceDiscovery"]>) {
    return this.catalog.completeSourceDiscovery(...args);
  }
  upsertDiscoveredSource(...args: Parameters<CatalogPersistence["upsertDiscoveredSource"]>) {
    return this.catalog.upsertDiscoveredSource(...args);
  }

  startSearchRun(...args: Parameters<ResearchIngestionPersistence["startSearchRun"]>) {
    return this.research.startSearchRun(...args);
  }
  finishSearchRun(...args: Parameters<ResearchIngestionPersistence["finishSearchRun"]>) {
    return this.research.finishSearchRun(...args);
  }
  failSearchRun(...args: Parameters<ResearchIngestionPersistence["failSearchRun"]>) {
    return this.research.failSearchRun(...args);
  }
  createOrResumeArticleCandidate(...args: Parameters<ResearchIngestionPersistence["createOrResumeArticleCandidate"]>) {
    return this.research.createOrResumeArticleCandidate(...args);
  }
  saveRawContent(...args: Parameters<ResearchIngestionPersistence["saveRawContent"]>) {
    return this.research.saveRawContent(...args);
  }
  transitionArticle(...args: Parameters<ResearchIngestionPersistence["transitionArticle"]>) {
    return this.research.transitionArticle(...args);
  }
  replaceArticleTopics(...args: Parameters<ResearchIngestionPersistence["replaceArticleTopics"]>) {
    return this.research.replaceArticleTopics(...args);
  }
  listRecentPublishedStories(...args: Parameters<StoryDeduplicationPersistence["listRecentPublishedStories"]>) {
    return this.storyDeduplication.listRecentPublishedStories(...args);
  }
  recordStoryDedupDecision(...args: Parameters<StoryDeduplicationPersistence["recordStoryDedupDecision"]>) {
    return this.storyDeduplication.recordStoryDedupDecision(...args);
  }

  createDraft(...args: Parameters<EditorialPersistence["createDraft"]>) {
    return this.editorial.createDraft(...args);
  }
  createReviewDraft(...args: Parameters<EditorialPersistence["createReviewDraft"]>) {
    return this.editorial.createReviewDraft(...args);
  }
  getDraft(...args: Parameters<EditorialPersistence["getDraft"]>) {
    return this.editorial.getDraft(...args);
  }
  listDrafts(...args: Parameters<EditorialPersistence["listDrafts"]>) {
    return this.editorial.listDrafts(...args);
  }
  transitionDraft(...args: Parameters<EditorialPersistence["transitionDraft"]>) {
    return this.editorial.transitionDraft(...args);
  }
  approveDraft(...args: Parameters<EditorialPersistence["approveDraft"]>) {
    return this.editorial.approveDraft(...args);
  }
  rejectDraft(...args: Parameters<EditorialPersistence["rejectDraft"]>) {
    return this.editorial.rejectDraft(...args);
  }
  claimDraftForPublication(...args: Parameters<EditorialPersistence["claimDraftForPublication"]>) {
    return this.editorial.claimDraftForPublication(...args);
  }
  finalizeDraftPublication(...args: Parameters<EditorialPersistence["finalizeDraftPublication"]>) {
    return this.editorial.finalizeDraftPublication(...args);
  }
  findPublicationByDraft(...args: Parameters<EditorialPersistence["findPublicationByDraft"]>) {
    return this.editorial.findPublicationByDraft(...args);
  }
  resetDraftPublication(...args: Parameters<EditorialPersistence["resetDraftPublication"]>) {
    return this.editorial.resetDraftPublication(...args);
  }
  releaseRejectedDraftPublication(...args: Parameters<EditorialPersistence["releaseRejectedDraftPublication"]>) {
    return this.editorial.releaseRejectedDraftPublication(...args);
  }
  recordPublication(...args: Parameters<EditorialPersistence["recordPublication"]>) {
    return this.editorial.recordPublication(...args);
  }

  recordAiUsage(...args: Parameters<UsageReportingPersistence["recordAiUsage"]>) {
    return this.usage.recordAiUsage(...args);
  }
  getDailyUsageDashboard(...args: Parameters<UsageReportingPersistence["getDailyUsageDashboard"]>) {
    return this.usage.getDailyUsageDashboard(...args);
  }

  acquirePipelineLease(...args: Parameters<PipelineLeasesRepositoryPort["acquirePipelineLease"]>) {
    return this.pipelineLeases.acquirePipelineLease(...args);
  }
  renewPipelineLease(...args: Parameters<PipelineLeasesRepositoryPort["renewPipelineLease"]>) {
    return this.pipelineLeases.renewPipelineLease(...args);
  }
  releasePipelineLease(...args: Parameters<PipelineLeasesRepositoryPort["releasePipelineLease"]>) {
    return this.pipelineLeases.releasePipelineLease(...args);
  }
  enqueueNotionAuditBackfill(...args: Parameters<NotionAuditOutboxRepositoryPort["enqueueNotionAuditBackfill"]>) {
    return this.notionAudit.enqueueNotionAuditBackfill(...args);
  }
  claimNotionAuditBackfill(...args: Parameters<NotionAuditOutboxRepositoryPort["claimNotionAuditBackfill"]>) {
    return this.notionAudit.claimNotionAuditBackfill(...args);
  }
  completeNotionAuditBackfill(...args: Parameters<NotionAuditOutboxRepositoryPort["completeNotionAuditBackfill"]>) {
    return this.notionAudit.completeNotionAuditBackfill(...args);
  }
  retryNotionAuditBackfill(...args: Parameters<NotionAuditOutboxRepositoryPort["retryNotionAuditBackfill"]>) {
    return this.notionAudit.retryNotionAuditBackfill(...args);
  }

  getOrCreateNewsSettings(...args: Parameters<NewsSettingsPersistence["getOrCreateNewsSettings"]>) {
    return this.settings.getOrCreateNewsSettings(...args);
  }
  getNewsSettings(...args: Parameters<NewsSettingsPersistence["getNewsSettings"]>) {
    return this.settings.getNewsSettings(...args);
  }
  updateNewsSettings(...args: Parameters<NewsSettingsPersistence["updateNewsSettings"]>) {
    return this.settings.updateNewsSettings(...args);
  }
  getOrCreateNewsFeatureFlags(...args: Parameters<NewsFeatureFlagsPersistence["getOrCreateNewsFeatureFlags"]>) {
    return this.featureFlags.getOrCreateNewsFeatureFlags(...args);
  }
  getNewsFeatureFlags(...args: Parameters<NewsFeatureFlagsPersistence["getNewsFeatureFlags"]>) {
    return this.featureFlags.getNewsFeatureFlags(...args);
  }
  updateNewsFeatureFlag(...args: Parameters<NewsFeatureFlagsPersistence["updateNewsFeatureFlag"]>) {
    return this.featureFlags.updateNewsFeatureFlag(...args);
  }
  beginTelegramSettingsInput(...args: Parameters<TelegramSettingsInputPersistence["beginTelegramSettingsInput"]>) {
    return this.settingsInput.beginTelegramSettingsInput(...args);
  }
  consumeTelegramSettingsInput(...args: Parameters<TelegramSettingsInputPersistence["consumeTelegramSettingsInput"]>) {
    return this.settingsInput.consumeTelegramSettingsInput(...args);
  }

  claimDueNewsSchedule(...args: Parameters<SchedulerPersistence["claimDueNewsSchedule"]>) {
    return this.scheduler.claimDueNewsSchedule(...args);
  }
  saveNewsScheduleDraft(...args: Parameters<SchedulerPersistence["saveNewsScheduleDraft"]>) {
    return this.scheduler.saveNewsScheduleDraft(...args);
  }
  saveNewsSchedulePublication(...args: Parameters<SchedulerPersistence["saveNewsSchedulePublication"]>) {
    return this.scheduler.saveNewsSchedulePublication(...args);
  }
  renewNewsScheduleClaim(...args: Parameters<SchedulerPersistence["renewNewsScheduleClaim"]>) {
    return this.scheduler.renewNewsScheduleClaim(...args);
  }
  deferNewsScheduleForQuietHours(...args: Parameters<SchedulerPersistence["deferNewsScheduleForQuietHours"]>) {
    return this.scheduler.deferNewsScheduleForQuietHours(...args);
  }
  pauseNewsScheduleUnresolved(...args: Parameters<SchedulerPersistence["pauseNewsScheduleUnresolved"]>) {
    return this.scheduler.pauseNewsScheduleUnresolved(...args);
  }
  finishNewsSchedule(...args: Parameters<SchedulerPersistence["finishNewsSchedule"]>) {
    return this.scheduler.finishNewsSchedule(...args);
  }

  claimTelegramUpdate(
    updateId: number,
    updateKind: string,
    staleAfterSeconds = 120,
  ) {
    return this.telegramUpdates.claimTelegramUpdate({
      updateId,
      updateKind,
      staleAfterSeconds,
    });
  }
  finishTelegramUpdate(
    updateId: number,
    claimToken: string,
    status: TelegramUpdateTerminalStatus,
    errorCode: string | null = null,
  ) {
    return this.telegramUpdates.finishTelegramUpdate({
      updateId,
      claimToken,
      status,
      errorCode,
    });
  }
  recordTelegramUpdateFailure(
    updateId: number,
    updateKind: string,
    errorCode: string,
    maxAttempts = 3,
    terminal = false,
    claimToken: string | null = null,
  ) {
    return this.telegramUpdates.recordTelegramUpdateFailure({
      updateId,
      updateKind,
      errorCode,
      maxAttempts,
      terminal,
      claimToken,
    });
  }
  getTelegramNewsCheckpoint(...args: Parameters<TelegramCheckpointsPersistence["getTelegramNewsCheckpoint"]>) {
    return this.telegramCheckpoints.getTelegramNewsCheckpoint(...args);
  }
  saveTelegramNewsCheckpoint(...args: Parameters<TelegramCheckpointsPersistence["saveTelegramNewsCheckpoint"]>) {
    return this.telegramCheckpoints.saveTelegramNewsCheckpoint(...args);
  }
  hasPendingTelegramReview(...args: Parameters<TelegramReviewSessionsPersistence["hasPendingTelegramReview"]>) {
    return this.telegramReviewSessions.hasPendingTelegramReview(...args);
  }
  createTelegramReviewSession(...args: Parameters<TelegramReviewSessionsPersistence["createTelegramReviewSession"]>) {
    return this.telegramReviewSessions.createTelegramReviewSession(...args);
  }
  findTelegramReviewSessionByDraft(...args: Parameters<TelegramReviewSessionsPersistence["findTelegramReviewSessionByDraft"]>) {
    return this.telegramReviewSessions.findTelegramReviewSessionByDraft(...args);
  }
  renewTelegramReviewSession(...args: Parameters<TelegramReviewSessionsPersistence["renewTelegramReviewSession"]>) {
    return this.telegramReviewSessions.renewTelegramReviewSession(...args);
  }
  rebindTelegramReviewSession(...args: Parameters<TelegramReviewSessionsPersistence["rebindTelegramReviewSession"]>) {
    return this.telegramReviewSessions.rebindTelegramReviewSession(...args);
  }
  decideTelegramReviewSession(...args: Parameters<TelegramReviewSessionsPersistence["decideTelegramReviewSession"]>) {
    return this.telegramReviewSessions.decideTelegramReviewSession(...args);
  }
}

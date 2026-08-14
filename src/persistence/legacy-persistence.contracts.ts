import type { CatalogPersistence } from "../catalog/catalog-persistence.js";
import type { EditorialPersistence } from "../editorial/editorial-persistence.contracts.js";
import type {
  NotionAuditOutboxRepositoryPort,
  PipelineLeasesRepositoryPort,
} from "../operations/operations.interfaces.js";
import type { ResearchIngestionPersistence } from "../research/research-persistence.contracts.js";
import type { SchedulerPersistence } from "../scheduler/scheduler-persistence.contracts.js";
import type { StoryDeduplicationPersistence } from "../story-deduplication/story-deduplication.contracts.js";
import type {
  NewsFeatureFlagsPersistence,
  NewsSettingsPersistence,
  TelegramSettingsInputPersistence,
} from "../settings/settings.contracts.js";
import type {
  TelegramCheckpointsPersistence,
  TelegramNewsJobsPersistence,
  TelegramReviewSessionsPersistence,
  TelegramUpdateClaimRow,
  TelegramUpdateFailureRow,
  TelegramUpdateTerminalStatus,
} from "../telegram/telegram-persistence.contracts.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";

/**
 * Typed compatibility boundary for the 79 domain methods on NewsRepository.
 *
 * It intentionally keeps the two historical positional Telegram update
 * signatures. Every other method already has the same external shape as its
 * owning narrow persistence port.
 */
export interface LegacyPersistence
  extends
    CatalogPersistence,
    ResearchIngestionPersistence,
    StoryDeduplicationPersistence,
    EditorialPersistence,
    UsageReportingPersistence,
    PipelineLeasesRepositoryPort,
    NotionAuditOutboxRepositoryPort,
    NewsSettingsPersistence,
    NewsFeatureFlagsPersistence,
    TelegramSettingsInputPersistence,
    SchedulerPersistence,
    TelegramCheckpointsPersistence,
    TelegramNewsJobsPersistence,
    TelegramReviewSessionsPersistence {
  claimTelegramUpdate(
    updateId: number,
    updateKind: string,
    staleAfterSeconds?: number,
  ): Promise<TelegramUpdateClaimRow>;
  finishTelegramUpdate(
    updateId: number,
    claimToken: string,
    status: TelegramUpdateTerminalStatus,
    errorCode?: string | null,
  ): Promise<boolean>;
  recordTelegramUpdateFailure(
    updateId: number,
    updateKind: string,
    errorCode: string,
    maxAttempts?: number,
    terminal?: boolean,
    claimToken?: string | null,
  ): Promise<TelegramUpdateFailureRow>;
}

export const LEGACY_PERSISTENCE_METHOD_OWNERS = {
  listEnabledSources: "catalog",
  listEnabledArticleTags: "catalog",
  listSourceHealth: "catalog",
  upsertSource: "catalog",
  setSourceEnabled: "catalog",
  markSourceChecked: "catalog",
  markSourceFetchSuccess: "catalog",
  markSourceFetchFailure: "catalog",
  claimSourceDiscovery: "catalog",
  completeSourceDiscovery: "catalog",
  upsertDiscoveredSource: "catalog",

  startSearchRun: "research",
  finishSearchRun: "research",
  failSearchRun: "research",
  createOrResumeArticleCandidate: "research",
  saveRawContent: "research",
  transitionArticle: "research",
  replaceArticleTopics: "research",
  listRecentPublishedStories: "storyDeduplication",
  recordStoryDedupDecision: "storyDeduplication",

  createDraft: "editorial",
  createReviewDraft: "editorial",
  getDraft: "editorial",
  listDrafts: "editorial",
  transitionDraft: "editorial",
  approveDraft: "editorial",
  rejectDraft: "editorial",
  claimDraftForPublication: "editorial",
  claimDraftForPublicationWithPolicy: "editorial",
  blockDraftPublication: "editorial",
  findPublicationPolicyBlockByDraft: "editorial",
  finalizeDraftPublication: "editorial",
  findPublicationByDraft: "editorial",
  resetDraftPublication: "editorial",
  releaseRejectedDraftPublication: "editorial",
  recordPublication: "editorial",

  recordAiUsage: "usage",
  getDailyUsageDashboard: "usage",

  acquirePipelineLease: "pipelineLeases",
  renewPipelineLease: "pipelineLeases",
  releasePipelineLease: "pipelineLeases",
  enqueueNotionAuditBackfill: "notionAudit",
  claimNotionAuditBackfill: "notionAudit",
  completeNotionAuditBackfill: "notionAudit",
  retryNotionAuditBackfill: "notionAudit",

  getOrCreateNewsSettings: "settings",
  getNewsSettings: "settings",
  updateNewsSettings: "settings",
  updateNewsExcludedTopics: "settings",
  getOrCreateNewsFeatureFlags: "featureFlags",
  getNewsFeatureFlags: "featureFlags",
  updateNewsFeatureFlag: "featureFlags",
  beginTelegramSettingsInput: "settingsInput",
  consumeTelegramSettingsInput: "settingsInput",

  claimDueNewsSchedule: "scheduler",
  saveNewsScheduleDraft: "scheduler",
  saveNewsSchedulePublication: "scheduler",
  renewNewsScheduleClaim: "scheduler",
  deferNewsScheduleForQuietHours: "scheduler",
  pauseNewsScheduleUnresolved: "scheduler",
  finishNewsSchedule: "scheduler",

  claimTelegramUpdate: "telegramUpdates",
  finishTelegramUpdate: "telegramUpdates",
  recordTelegramUpdateFailure: "telegramUpdates",
  enqueueTelegramNewsJob: "telegramNewsJobs",
  claimNextTelegramNewsJob: "telegramNewsJobs",
  renewTelegramNewsJobClaim: "telegramNewsJobs",
  recordTelegramNewsJobOutcome: "telegramNewsJobs",
  retryTelegramNewsJob: "telegramNewsJobs",
  retryTelegramNewsJobDelivery: "telegramNewsJobs",
  completeTelegramNewsJob: "telegramNewsJobs",
  getTelegramNewsCheckpoint: "telegramCheckpoints",
  saveTelegramNewsCheckpoint: "telegramCheckpoints",
  hasPendingTelegramReview: "telegramReviewSessions",
  createTelegramReviewSession: "telegramReviewSessions",
  findTelegramReviewSessionByDraft: "telegramReviewSessions",
  renewTelegramReviewSession: "telegramReviewSessions",
  rebindTelegramReviewSession: "telegramReviewSessions",
  decideTelegramReviewSession: "telegramReviewSessions",
} as const satisfies Record<keyof LegacyPersistence, string>;

export type LegacyPersistenceMethod =
  keyof typeof LEGACY_PERSISTENCE_METHOD_OWNERS;

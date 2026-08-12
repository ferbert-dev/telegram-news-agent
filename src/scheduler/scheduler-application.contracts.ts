export type SchedulerSettingsSnapshot = {
  channelId: string;
  reviewChatId: number;
  scheduleIntervalMinutes: 60 | 180 | 360 | 720 | 1440;
  languageCode: "en" | "uk" | "de";
  topicCodes: string[];
  customTopics: string[];
  excludedTopicCodes: string[];
  excludedTopicsProvenance: {
    source: "news_bot_settings";
    settingsVersion: number;
  };
  approvalPolicy: "manual" | "automatic";
  quietHoursEnabled: boolean;
  nextRunAt: string | null;
  version: number;
  updatedBy: number;
};

export type SchedulerLeaseIdentity = {
  name: string;
  ownerId: string;
};

export type SchedulerNewsWorkflowInput = {
  /**
   * This is the durable claim snapshot with manual draft creation forced for
   * both publication policies. A later adapter composes ResearchService and
   * EditorialWorkflowService behind this seam after selection/evidence parity.
   */
  settingsSnapshot: SchedulerSettingsSnapshot;
  lease: SchedulerLeaseIdentity;
  signal?: AbortSignal;
};

export type SchedulerNewsWorkflowResult =
  | { status: "no_candidates" }
  | {
      status: "review_ready";
      draftId: string;
      preview: string;
      windowHours: number;
    };

export interface SchedulerNewsWorkflowApplicationPort {
  run(input: SchedulerNewsWorkflowInput): Promise<SchedulerNewsWorkflowResult>;
}

export type SchedulerReviewDeliveryInput = {
  channelId: string;
  chatId: number;
  requestedBy: number;
  draftId: string;
  preview: string;
  signal?: AbortSignal;
};

export type SchedulerReviewDeliveryResult =
  | { status: "review_ready"; resumed?: boolean }
  | {
      status: "review_unavailable";
      decision?: "publish" | "reject" | null;
      resumed?: boolean;
    };

export interface SchedulerReviewDeliveryApplicationPort {
  deliver(
    input: SchedulerReviewDeliveryInput,
  ): Promise<SchedulerReviewDeliveryResult>;
}

export type SchedulerAuditContext = {
  channelId: string;
  scheduleRunId: string;
  settingsVersion: number;
};

export interface SchedulerAuditApplicationPort {
  run<T extends SchedulerRunResult>(
    context: SchedulerAuditContext,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface SchedulerNotificationApplicationPort {
  notify(input: {
    chatId: number;
    text: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface SchedulerIdGenerator {
  next(): string;
}

export interface SchedulerClock {
  now(): Date;
}

export type SchedulerTimerHandle = unknown;

export interface SchedulerTimer {
  setInterval(
    callback: () => void | Promise<void>,
    intervalMs: number,
  ): SchedulerTimerHandle;
  clearInterval(handle: SchedulerTimerHandle): void;
}

export type RunScheduledNewsOnceInput = {
  signal?: AbortSignal;
  claimToken?: string;
  leaseOwnerId?: string;
  staleAfterSeconds?: number;
  scheduleHeartbeatIntervalMs?: number;
  pipelineLeaseName?: string;
  pipelineLeaseTtlSeconds?: number;
  pipelineHeartbeatIntervalMs?: number;
};

export type SchedulerRunResult = {
  status:
    | "idle"
    | "quiet_hours_deferred"
    | "skipped_pending_review"
    | "no_candidates"
    | "awaiting_approval"
    | "review_already_resolved"
    | "published"
    | "blocked_by_policy"
    | "failed";
  errorCode?: string;
  reasonCode?: string;
  draftId?: string;
  windowHours?: number;
  publicationMessageId?: number | null;
  settings?: SchedulerSettingsSnapshot;
};

export interface SchedulerApplicationPort {
  runOnce(input?: RunScheduledNewsOnceInput): Promise<SchedulerRunResult>;
}

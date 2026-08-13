import { Inject, Injectable } from "@nestjs/common";

import type { EditorialWorkflowApplicationPort } from "../../editorial/editorial-application.contracts.js";
import type { EditorialPersistence } from "../../editorial/editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../../editorial/editorial-persistence.tokens.js";
import type { PipelineLeaseApplicationPort } from "../../operations/operations-application.contracts.js";
import { newsSettingsSnapshot, normalizeNewsSettings } from "../../news-settings.js";
import { shouldDeferScheduledNews } from "../../quiet-hours.js";
import type { TelegramReviewSessionsPersistence } from "../../telegram/telegram-persistence.contracts.js";
import { TELEGRAM_REVIEW_SESSIONS_PERSISTENCE } from "../../telegram/telegram-persistence.tokens.js";
import type {
  RunScheduledNewsOnceInput,
  SchedulerAuditApplicationPort,
  SchedulerClock,
  SchedulerIdGenerator,
  SchedulerNewsWorkflowApplicationPort,
  SchedulerNewsWorkflowResult,
  SchedulerNotificationApplicationPort,
  SchedulerReviewDeliveryApplicationPort,
  SchedulerReviewDeliveryResult,
  SchedulerRunResult,
  SchedulerSettingsSnapshot,
  SchedulerTimer,
  SchedulerTimerHandle,
} from "../scheduler-application.contracts.js";
import {
  SCHEDULER_AUDIT_APPLICATION,
  SCHEDULER_CLOCK,
  SCHEDULER_EDITORIAL_WORKFLOW_APPLICATION,
  SCHEDULER_ID_GENERATOR,
  SCHEDULER_NEWS_WORKFLOW_APPLICATION,
  SCHEDULER_NOTIFICATION_APPLICATION,
  SCHEDULER_PIPELINE_LEASE_APPLICATION,
  SCHEDULER_REVIEW_DELIVERY_APPLICATION,
  SCHEDULER_TIMER,
} from "../scheduler-application.tokens.js";
import type { SchedulerPersistence } from "../scheduler-persistence.contracts.js";
import { SCHEDULER_PERSISTENCE } from "../scheduler-persistence.tokens.js";

const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;
const DEFAULT_PIPELINE_LEASE_TTL_SECONDS = 15 * 60;
const DEFAULT_PIPELINE_LEASE_NAME = "daily-news-pipeline";

type ScheduleClaim = NonNullable<
  Awaited<ReturnType<SchedulerPersistence["claimDueNewsSchedule"]>>
>;

type DraftCheckpoint = {
  id: string;
  preview: string;
  windowHours: number;
};

function errorCode(error: unknown): string {
  const errors =
    error instanceof AggregateError ? [error, ...error.errors] : [error];
  const message = errors
    .map((item) => (item instanceof Error ? item.message : String(item ?? "")))
    .join(" ");
  if (/already running/i.test(message)) return "pipeline_busy";
  if (/claim.*lost|ownership was lost/i.test(message)) return "claim_lost";
  if (/scheduled review delivery/i.test(message)) {
    return "review_delivery_failed";
  }
  if (/unresolved|already being published/i.test(message)) {
    return "publication_unresolved";
  }
  return "scheduled_run_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return (
    isNonblankString(value) && !Number.isNaN(new Date(value).valueOf())
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isNonblankString(item))
  );
}

function isScheduleInterval(
  value: unknown,
): value is 60 | 180 | 360 | 720 | 1440 {
  return (
    typeof value === "number" &&
    [60, 180, 360, 720, 1440].includes(value)
  );
}

const REQUIRED_SNAPSHOT_KEYS = [
  "channelId",
  "reviewChatId",
  "scheduleIntervalMinutes",
  "languageCode",
  "topicCodes",
  "customTopics",
  "excludedTopicCodes",
  "excludedTopicsProvenance",
  "approvalPolicy",
  "quietHoursEnabled",
  "nextRunAt",
  "version",
  "updatedBy",
] as const;

function validateClaimIdentity(claim: ScheduleClaim): void {
  if (
    !isNonblankString(claim.telegram_channel_id) ||
    !isPositiveSafeInteger(claim.review_chat_id) ||
    !isPositiveSafeInteger(claim.version) ||
    !isPositiveSafeInteger(claim.updated_by) ||
    !isNonblankString(claim.schedule_claim_token) ||
    !isValidTimestamp(claim.schedule_claimed_at) ||
    !isNonblankString(claim.schedule_run_id) ||
    !isValidTimestamp(claim.schedule_run_due_at) ||
    !isScheduleInterval(claim.schedule_interval_minutes) ||
    (claim.schedule_publication_message_id !== null &&
      !isPositiveSafeInteger(claim.schedule_publication_message_id))
  ) {
    throw new Error("Claimed schedule identity is incomplete");
  }
}

function settingsForClaim(claim: ScheduleClaim): SchedulerSettingsSnapshot {
  validateClaimIdentity(claim);
  const persisted = claim.schedule_settings_snapshot;
  if (
    !isRecord(persisted) ||
    REQUIRED_SNAPSHOT_KEYS.some((key) => !hasOwn(persisted, key))
  ) {
    throw new Error("Claimed settings snapshot is incomplete");
  }
  const provenance = persisted.excludedTopicsProvenance;
  if (
    !isNonblankString(persisted.channelId) ||
    persisted.channelId !== claim.telegram_channel_id ||
    !isPositiveSafeInteger(persisted.reviewChatId) ||
    !isPositiveSafeInteger(persisted.version) ||
    !isPositiveSafeInteger(persisted.updatedBy) ||
    !isScheduleInterval(persisted.scheduleIntervalMinutes) ||
    (persisted.languageCode !== "en" &&
      persisted.languageCode !== "uk" &&
      persisted.languageCode !== "de") ||
    (persisted.approvalPolicy !== "manual" &&
      persisted.approvalPolicy !== "automatic") ||
    typeof persisted.quietHoursEnabled !== "boolean" ||
    !isStringArray(persisted.topicCodes) ||
    !isStringArray(persisted.customTopics) ||
    !isStringArray(persisted.excludedTopicCodes) ||
    (persisted.nextRunAt !== null &&
      !isValidTimestamp(persisted.nextRunAt)) ||
    !isRecord(provenance) ||
    Object.keys(provenance).length !== 2 ||
    provenance.source !== "news_bot_settings" ||
    provenance.settingsVersion !== persisted.version
  ) {
    throw new Error("Claimed settings snapshot is invalid");
  }

  const normalized = normalizeNewsSettings(persisted);
  const snapshot = newsSettingsSnapshot(normalized);
  if (
    snapshot.scheduleIntervalMinutes === null ||
    ![60, 180, 360, 720, 1440].includes(snapshot.scheduleIntervalMinutes)
  ) {
    throw new Error("Unsupported schedule interval in claimed settings snapshot");
  }
  if (
    !isNonblankString(snapshot.channelId) ||
    !isPositiveSafeInteger(snapshot.reviewChatId) ||
    !isPositiveSafeInteger(snapshot.updatedBy) ||
    snapshot.excludedTopicsProvenance.source !== "news_bot_settings" ||
    snapshot.excludedTopicsProvenance.settingsVersion !== snapshot.version
  ) {
    throw new Error("Claimed settings snapshot is incomplete");
  }
  return snapshot as SchedulerSettingsSnapshot;
}

function workflowResult(
  value: unknown,
): SchedulerNewsWorkflowResult {
  if (!isRecord(value)) {
    throw new Error("Scheduler news workflow returned an invalid result");
  }
  if (value.status === "no_candidates") {
    return { status: "no_candidates" };
  }
  if (
    value.status !== "review_ready" ||
    !isNonblankString(value.draftId) ||
    !isNonblankString(value.preview) ||
    !isPositiveSafeInteger(value.windowHours)
  ) {
    throw new Error("Scheduler news workflow returned an invalid checkpoint");
  }
  return {
    status: "review_ready",
    draftId: value.draftId,
    preview: value.preview,
    windowHours: value.windowHours,
  };
}

function reviewDeliveryResult(
  value: unknown,
): SchedulerReviewDeliveryResult {
  if (!isRecord(value)) {
    throw new Error("Invalid review gateway result");
  }
  if (value.status === "review_ready") {
    if (value.resumed !== undefined && typeof value.resumed !== "boolean") {
      throw new Error("Invalid review gateway result");
    }
    return {
      status: "review_ready",
      ...(value.resumed === undefined ? {} : { resumed: value.resumed }),
    };
  }
  if (value.status === "review_unavailable") {
    if (
      value.resumed !== undefined &&
      typeof value.resumed !== "boolean"
    ) {
      throw new Error("Invalid review gateway result");
    }
    if (
      value.decision !== undefined &&
      value.decision !== null &&
      value.decision !== "publish" &&
      value.decision !== "reject"
    ) {
      throw new Error("Invalid review gateway result");
    }
    return {
      status: "review_unavailable",
      ...(value.decision === undefined ? {} : { decision: value.decision }),
      ...(value.resumed === undefined ? {} : { resumed: value.resumed }),
    };
  }
  throw new Error("Invalid review gateway result");
}

function checkpointForClaim(claim: ScheduleClaim): DraftCheckpoint | null {
  if (!claim.schedule_draft_id) return null;
  const windowHours = Number(claim.schedule_window_hours);
  if (
    typeof claim.schedule_preview !== "string" ||
    claim.schedule_preview.length === 0 ||
    !Number.isSafeInteger(windowHours) ||
    windowHours <= 0
  ) {
    throw new Error("Scheduled draft checkpoint is incomplete");
  }
  return {
    id: claim.schedule_draft_id,
    preview: claim.schedule_preview,
    windowHours,
  };
}

class OwnershipHeartbeat {
  private lostError: Error | null = null;
  private renewal: Promise<void> | null = null;
  private stopped = false;
  private readonly handle: SchedulerTimerHandle;

  constructor(
    private readonly renewOperation: () => Promise<boolean>,
    private readonly timer: SchedulerTimer,
    intervalMs: number,
    private readonly lostMessage: string,
    private readonly failedMessage: string,
  ) {
    this.handle = timer.setInterval(() => {
      void this.renew().catch(() => undefined);
    }, intervalMs);
  }

  async renew(): Promise<void> {
    this.assertOwned();
    if (this.renewal) return this.renewal;
    this.renewal = (async () => {
      try {
        if (!(await this.renewOperation())) {
          this.lostError = new Error(this.lostMessage);
          throw this.lostError;
        }
      } catch (error) {
        this.lostError ??= new Error(this.failedMessage, { cause: error });
        throw this.lostError;
      } finally {
        this.renewal = null;
      }
    })();
    return this.renewal;
  }

  assertOwned(): void {
    if (this.lostError) throw this.lostError;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.timer.clearInterval(this.handle);
    }
    await this.renewal;
    this.assertOwned();
  }
}

@Injectable()
export class RunScheduledNewsOnceUseCase {
  constructor(
    @Inject(SCHEDULER_PERSISTENCE)
    private readonly scheduler: SchedulerPersistence,
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    private readonly reviews: TelegramReviewSessionsPersistence,
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorialPersistence: EditorialPersistence,
    @Inject(SCHEDULER_NEWS_WORKFLOW_APPLICATION)
    private readonly newsWorkflow: SchedulerNewsWorkflowApplicationPort,
    @Inject(SCHEDULER_EDITORIAL_WORKFLOW_APPLICATION)
    private readonly editorial: EditorialWorkflowApplicationPort,
    @Inject(SCHEDULER_PIPELINE_LEASE_APPLICATION)
    private readonly pipelineLease: PipelineLeaseApplicationPort,
    @Inject(SCHEDULER_REVIEW_DELIVERY_APPLICATION)
    private readonly reviewDelivery: SchedulerReviewDeliveryApplicationPort,
    @Inject(SCHEDULER_AUDIT_APPLICATION)
    private readonly audit: SchedulerAuditApplicationPort,
    @Inject(SCHEDULER_NOTIFICATION_APPLICATION)
    private readonly notification: SchedulerNotificationApplicationPort,
    @Inject(SCHEDULER_ID_GENERATOR)
    private readonly ids: SchedulerIdGenerator,
    @Inject(SCHEDULER_CLOCK)
    private readonly clock: SchedulerClock,
    @Inject(SCHEDULER_TIMER)
    private readonly timer: SchedulerTimer,
  ) {}

  async execute(
    input: RunScheduledNewsOnceInput = {},
  ): Promise<SchedulerRunResult> {
    const {
      signal,
      claimToken = this.ids.next(),
      leaseOwnerId = this.ids.next(),
      staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
      scheduleHeartbeatIntervalMs = Math.max(
        1_000,
        Math.floor((staleAfterSeconds * 1_000) / 3),
      ),
      pipelineLeaseName = DEFAULT_PIPELINE_LEASE_NAME,
      pipelineLeaseTtlSeconds = DEFAULT_PIPELINE_LEASE_TTL_SECONDS,
      pipelineHeartbeatIntervalMs = Math.max(
        1_000,
        Math.floor((pipelineLeaseTtlSeconds * 1_000) / 3),
      ),
    } = input;
    signal?.throwIfAborted();
    const claim = await this.scheduler.claimDueNewsSchedule({
      claimToken,
      staleAfterSeconds,
    });
    if (!claim) return { status: "idle" };

    const scheduleHeartbeat = new OwnershipHeartbeat(
      () =>
        this.scheduler.renewNewsScheduleClaim({
          channelId: claim.telegram_channel_id,
          claimToken: claim.schedule_claim_token as string,
        }),
      this.timer,
      scheduleHeartbeatIntervalMs,
      "Scheduled news claim ownership was lost",
      "Scheduled news claim could not be renewed",
    );
    let settings: SchedulerSettingsSnapshot | undefined;
    try {
      signal?.throwIfAborted();
      settings = settingsForClaim(claim);
      return await this.audit.run(
        {
          channelId: settings.channelId,
          scheduleRunId: claim.schedule_run_id as string,
          settingsVersion: settings.version,
        },
        () =>
          this.executeClaim({
            claim,
            settings: settings as SchedulerSettingsSnapshot,
            signal,
            scheduleHeartbeat,
            lease: {
              name: pipelineLeaseName,
              ownerId: leaseOwnerId,
              ttlSeconds: pipelineLeaseTtlSeconds,
              heartbeatIntervalMs: pipelineHeartbeatIntervalMs,
            },
          }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        await scheduleHeartbeat.stop().catch(() => undefined);
        signal.throwIfAborted();
      }
      let code = errorCode(error);
      try {
        await scheduleHeartbeat.stop();
      } catch {
        code = "claim_lost";
      }
      if (code === "publication_unresolved") {
        try {
          const paused = await this.scheduler.pauseNewsScheduleUnresolved({
            channelId: claim.telegram_channel_id,
            claimToken: claim.schedule_claim_token as string,
            errorCode: code,
          });
          if (!paused) {
            code = "claim_lost";
          } else {
            await this.notification
              .notify({
                chatId: settings?.reviewChatId ?? claim.review_chat_id,
                text: "Automatic publication has an unresolved Telegram outcome. The schedule was paused; reconcile the draft before enabling it again.",
                signal,
              })
              .catch(() => undefined);
          }
        } catch {
          code = "schedule_pause_failed";
        }
      } else if (!new Set(["claim_lost", "review_delivery_failed"]).has(code)) {
        try {
          await this.finish(claim, "failed", code);
        } catch {
          code = "claim_lost";
        }
      }
      return { status: "failed", errorCode: code, settings };
    }
  }

  private async executeClaim(input: {
    claim: ScheduleClaim;
    settings: SchedulerSettingsSnapshot;
    signal?: AbortSignal;
    scheduleHeartbeat: OwnershipHeartbeat;
    lease: {
      name: string;
      ownerId: string;
      ttlSeconds: number;
      heartbeatIntervalMs: number;
    };
  }): Promise<SchedulerRunResult> {
    const { claim, settings, signal, scheduleHeartbeat, lease } = input;
    signal?.throwIfAborted();
    const earlyDeferral = await this.deferIfQuiet(
      claim,
      settings,
      scheduleHeartbeat,
    );
    if (earlyDeferral) return earlyDeferral;

    let checkpoint = checkpointForClaim(claim);
    if (
      settings.approvalPolicy === "manual" &&
      (await this.reviews.hasPendingTelegramReview(settings.channelId))
    ) {
      await this.finishWithHeartbeat(
        claim,
        "skipped_pending_review",
        null,
        scheduleHeartbeat,
      );
      return { status: "skipped_pending_review", settings };
    }

    if (!checkpoint) {
      const acquired = await this.pipelineLease.acquire({
        name: lease.name,
        ownerId: lease.ownerId,
        ttlSeconds: lease.ttlSeconds,
      });
      if (!acquired) {
        throw new Error(`Pipeline "${lease.name}" is already running`);
      }
      const pipelineHeartbeat = new OwnershipHeartbeat(
        () =>
          this.pipelineLease.renew({
            name: lease.name,
            ownerId: lease.ownerId,
            ttlSeconds: lease.ttlSeconds,
          }),
        this.timer,
        lease.heartbeatIntervalMs,
        `Pipeline lease "${lease.name}" ownership was lost`,
        `Pipeline lease "${lease.name}" could not be renewed`,
      );
      let noCandidates = false;
      try {
        signal?.throwIfAborted();
        const workflow = workflowResult(
          await this.newsWorkflow.run({
            settingsSnapshot: {
              ...settings,
              approvalPolicy: "manual",
            },
            lease: { name: lease.name, ownerId: lease.ownerId },
            signal,
          }),
        );
        pipelineHeartbeat.assertOwned();
        if (workflow.status === "no_candidates") {
          noCandidates = true;
        } else {
          checkpoint = {
            id: workflow.draftId,
            preview: workflow.preview,
            windowHours: workflow.windowHours,
          };
        }
        if (
          checkpoint &&
          !(await this.scheduler.saveNewsScheduleDraft({
            channelId: claim.telegram_channel_id,
            claimToken: claim.schedule_claim_token as string,
            draftId: checkpoint.id,
            preview: checkpoint.preview,
            windowHours: checkpoint.windowHours,
          }))
        ) {
          throw new Error("Scheduled news claim was lost before checkpointing");
        }
      } finally {
        let heartbeatError: unknown;
        try {
          await pipelineHeartbeat.stop();
        } catch (error) {
          heartbeatError = error;
        }
        await this.pipelineLease.release({
          name: lease.name,
          ownerId: lease.ownerId,
        });
        if (heartbeatError) throw heartbeatError;
      }
      if (noCandidates) {
        await this.finishWithHeartbeat(
          claim,
          "no_candidates",
          null,
          scheduleHeartbeat,
        );
        signal?.throwIfAborted();
        return { status: "no_candidates", settings };
      }
    }
    if (!checkpoint) {
      throw new Error("Scheduled news workflow did not produce a checkpoint");
    }

    signal?.throwIfAborted();
    const deliveryDeferral = await this.deferIfQuiet(
      claim,
      settings,
      scheduleHeartbeat,
    );
    if (deliveryDeferral) {
      return {
        ...deliveryDeferral,
        draftId: checkpoint.id,
        windowHours: checkpoint.windowHours,
      };
    }

    if (settings.approvalPolicy === "manual") {
      await scheduleHeartbeat.renew();
      signal?.throwIfAborted();
      const renewedDeferral = await this.deferIfQuiet(
        claim,
        settings,
        scheduleHeartbeat,
      );
      if (renewedDeferral) {
        return {
          ...renewedDeferral,
          draftId: checkpoint.id,
          windowHours: checkpoint.windowHours,
        };
      }
      let deliveredValue: unknown;
      try {
        deliveredValue = await this.reviewDelivery.deliver({
          channelId: settings.channelId,
          chatId: settings.reviewChatId,
          requestedBy: settings.updatedBy,
          draftId: checkpoint.id,
          preview: checkpoint.preview,
          signal,
        });
      } catch (error) {
        throw new Error("Scheduled review delivery could not be completed", {
          cause: error,
        });
      }
      const delivered = reviewDeliveryResult(deliveredValue);
      const status =
        delivered.status === "review_unavailable"
          ? "review_already_resolved"
          : "awaiting_approval";
      await this.finishWithHeartbeat(claim, status, null, scheduleHeartbeat);
      return {
        status,
        draftId: checkpoint.id,
        windowHours: checkpoint.windowHours,
        settings,
      };
    }

    let publicationMessageId = claim.schedule_publication_message_id;
    if (!publicationMessageId) {
      await scheduleHeartbeat.renew();
      signal?.throwIfAborted();
      const renewedDeferral = await this.deferIfQuiet(
        claim,
        settings,
        scheduleHeartbeat,
      );
      if (renewedDeferral) {
        return {
          ...renewedDeferral,
          draftId: checkpoint.id,
          windowHours: checkpoint.windowHours,
        };
      }
      const draft = await this.editorialPersistence.getDraft(checkpoint.id);
      if (draft.status === "review") {
        await this.editorialPersistence.approveDraft(checkpoint.id);
      } else if (
        !new Set(["approved", "publishing", "published", "rejected"]).has(
          draft.status,
        )
      ) {
        throw new Error(`Scheduled draft ${checkpoint.id} is not publishable`);
      }
      signal?.throwIfAborted();
      const published = await this.editorial.publishApprovedDraft({
        draftId: checkpoint.id,
        channelId: settings.channelId,
        publicationPath: "scheduler",
        signal,
      });
      if (
        published.status === "blocked" ||
        published.status === "already_blocked"
      ) {
        await this.finishWithHeartbeat(
          claim,
          "blocked_by_policy",
          published.reasonCode ?? "excluded_topic_policy",
          scheduleHeartbeat,
        );
        return {
          status: "blocked_by_policy",
          reasonCode: published.reasonCode,
          draftId: checkpoint.id,
          publicationMessageId: null,
          windowHours: checkpoint.windowHours,
          settings,
        };
      }
      if (!published.publication) {
        throw new Error("Published outcome has no publication receipt");
      }
      publicationMessageId = published.publication.telegram_message_id;
      if (
        !(await this.scheduler.saveNewsSchedulePublication({
          channelId: claim.telegram_channel_id,
          claimToken: claim.schedule_claim_token as string,
          draftId: checkpoint.id,
          publicationMessageId,
        }))
      ) {
        throw new Error("Scheduled news claim was lost before checkpointing");
      }
    }

    await this.finishWithHeartbeat(
      claim,
      "published",
      null,
      scheduleHeartbeat,
    );
    await this.notification
      .notify({
        chatId: settings.reviewChatId,
        text: `Scheduled article published as Telegram message ${publicationMessageId}.`,
        signal,
      })
      .catch(() => undefined);
    return {
      status: "published",
      draftId: checkpoint.id,
      publicationMessageId,
      windowHours: checkpoint.windowHours,
      settings,
    };
  }

  private async deferIfQuiet(
    claim: ScheduleClaim,
    settings: SchedulerSettingsSnapshot,
    heartbeat: OwnershipHeartbeat,
  ): Promise<SchedulerRunResult | null> {
    if (!shouldDeferScheduledNews(settings, this.clock.now())) return null;
    await heartbeat.stop();
    if (
      !(await this.scheduler.deferNewsScheduleForQuietHours({
        channelId: claim.telegram_channel_id,
        claimToken: claim.schedule_claim_token as string,
      }))
    ) {
      throw new Error("Scheduled news claim was lost before quiet-hours deferral");
    }
    return { status: "quiet_hours_deferred", settings };
  }

  private async finishWithHeartbeat(
    claim: ScheduleClaim,
    status: string,
    failureCode: string | null,
    heartbeat: OwnershipHeartbeat,
  ): Promise<void> {
    await heartbeat.stop();
    await this.finish(claim, status, failureCode);
  }

  private async finish(
    claim: ScheduleClaim,
    status: string,
    failureCode: string | null,
  ): Promise<void> {
    if (
      !(await this.scheduler.finishNewsSchedule({
        channelId: claim.telegram_channel_id,
        claimToken: claim.schedule_claim_token as string,
        status,
        errorCode: failureCode,
      }))
    ) {
      throw new Error("Scheduled news claim was lost before completion");
    }
  }
}

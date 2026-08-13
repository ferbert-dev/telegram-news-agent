import { Inject, Injectable } from "@nestjs/common";

import type { EditorialWorkflowApplicationPort } from "../../editorial/editorial-application.contracts.js";
import type { EditorialPersistence } from "../../editorial/editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../../editorial/editorial-persistence.tokens.js";
import { SettingsService } from "../../settings/application/settings.service.js";
import type { NewsSettingsRow } from "../../settings/settings.contracts.js";
import type {
  TelegramControlClock,
  TelegramControlIdGenerator,
  TelegramControlOutcome,
  TelegramControlRequest,
  TelegramNewsApplicationPort,
  TelegramNewsWorkflowGateway,
  TelegramReviewPresentationGateway,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import {
  TELEGRAM_CONTROL_CLOCK,
  TELEGRAM_CONTROL_ID_GENERATOR,
  TELEGRAM_EDITORIAL_WORKFLOW,
  TELEGRAM_NEWS_WORKFLOW,
  TELEGRAM_REVIEW_PRESENTATION,
} from "../telegram-application.tokens.js";
import type {
  TelegramCheckpointsPersistence,
  TelegramNewsCheckpointRow,
  TelegramReviewSessionsPersistence,
} from "../telegram-persistence.contracts.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_REVIEW_SESSIONS_PERSISTENCE,
} from "../telegram-persistence.tokens.js";
import { DeliverTelegramReviewUseCase } from "./deliver-telegram-review.use-case.js";

function snapshot(settings: NewsSettingsRow): Record<string, unknown> {
  return {
    channelId: settings.telegram_channel_id,
    reviewChatId: settings.review_chat_id,
    scheduleIntervalMinutes: settings.schedule_interval_minutes,
    languageCode: settings.language_code,
    topicCodes: [...settings.topic_codes],
    customTopics: [...settings.custom_topics],
    excludedTopicCodes: [...settings.excluded_topic_codes],
    excludedTopicsProvenance: {
      source: "news_bot_settings",
      settingsVersion: settings.version,
    },
    approvalPolicy: settings.approval_policy,
    quietHoursEnabled: settings.quiet_hours_enabled,
    nextRunAt: settings.next_run_at,
    version: settings.version,
    updatedBy: settings.updated_by,
  };
}

function snapshotApprovalPolicy(
  checkpoint: TelegramNewsCheckpointRow,
  fallback?: NewsSettingsRow,
): "manual" | "automatic" {
  const value =
    checkpoint.settings_snapshot.approvalPolicy ??
    checkpoint.settings_snapshot.approval_policy;
  return value === "automatic" || value === "manual"
    ? value
    : fallback?.approval_policy ?? "manual";
}

@Injectable()
export class RunTelegramNewsUseCase implements TelegramNewsApplicationPort {
  private readonly reviewDelivery: DeliverTelegramReviewUseCase;

  constructor(
    @Inject(TELEGRAM_CHECKPOINTS_PERSISTENCE)
    private readonly checkpoints: TelegramCheckpointsPersistence,
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    reviews: TelegramReviewSessionsPersistence,
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorialPersistence: EditorialPersistence,
    @Inject(SettingsService)
    private readonly settings: SettingsService,
    @Inject(TELEGRAM_EDITORIAL_WORKFLOW)
    private readonly editorial: EditorialWorkflowApplicationPort,
    @Inject(TELEGRAM_NEWS_WORKFLOW)
    private readonly news: TelegramNewsWorkflowGateway,
    @Inject(TELEGRAM_REVIEW_PRESENTATION)
    presentation: TelegramReviewPresentationGateway,
    @Inject(TELEGRAM_CONTROL_ID_GENERATOR)
    ids: TelegramControlIdGenerator,
    @Inject(TELEGRAM_CONTROL_CLOCK)
    private readonly clock: TelegramControlClock,
  ) {
    this.reviewDelivery = new DeliverTelegramReviewUseCase(
      reviews,
      editorialPersistence,
      presentation,
      ids,
      this.clock,
    );
  }

  async execute(request: TelegramControlRequest): Promise<TelegramControlOutcome> {
    if (request.route.kind !== "news") {
      throw new TelegramControlError("malformed_command", "News route required");
    }
    const existing = await this.checkpoints.getTelegramNewsCheckpoint(request.updateId);
    if (existing) {
      if (
        existing.status === "review_ready" &&
        snapshotApprovalPolicy(existing) === "automatic"
      ) {
        return this.publishCheckpoint(existing, request, undefined, true);
      }
      if (existing.status === "review_ready" && existing.draft_id && existing.preview) {
        return this.reviewDelivery.execute({
          draftId: existing.draft_id,
          channelId: request.channelId,
          chatId: request.chatId,
          actorId: request.actorId,
          preview: existing.preview,
        });
      }
      return {
        status: existing.status,
        draftId: existing.draft_id,
        preview: existing.preview,
        windowHours: existing.window_hours,
        publicationMessageId: existing.publication_message_id,
        ...(existing.status === "blocked_by_policy"
          ? { publicationPath: "automatic_news" }
          : {}),
        resumed: true,
      };
    }

    const settings = await this.settings.getOrCreateNewsSettings({
      channelId: request.channelId,
      reviewChatId: request.chatId,
      updatedBy: request.actorId,
    });
    if (!settings) throw new Error("News settings are unavailable");
    const manualSettings: NewsSettingsRow = {
      ...settings,
      approval_policy: "manual",
    };
    const result = await this.news.run({
      updateId: request.updateId,
      actorId: request.actorId,
      chatId: request.chatId,
      channelId: request.channelId,
      settings: manualSettings,
    });
    if (result.status === "no_candidates") {
      const saved = await this.checkpoints.saveTelegramNewsCheckpoint({
        update_id: request.updateId,
        status: "no_candidates",
        draft_id: null,
        preview: null,
        window_hours: null,
        publication_message_id: null,
        settings_snapshot: snapshot(settings),
        updated_at: this.clock.now().toISOString(),
      });
      return {
        status: saved.status,
        draftId: null,
        preview: null,
        windowHours: null,
        publicationMessageId: null,
        resumed: false,
      };
    }
    const checkpoint = await this.checkpoints.saveTelegramNewsCheckpoint({
      update_id: request.updateId,
      status: "review_ready",
      draft_id: result.draftId,
      preview: result.preview,
      window_hours: result.windowHours,
      publication_message_id: null,
      settings_snapshot: snapshot(settings),
      updated_at: this.clock.now().toISOString(),
    });
    if (settings.approval_policy === "automatic") {
      return this.publishCheckpoint(checkpoint, request, settings, false);
    }
    return this.reviewDelivery.execute({
      draftId: result.draftId,
      channelId: request.channelId,
      chatId: request.chatId,
      actorId: request.actorId,
      preview: result.preview,
    });
  }

  private async publishCheckpoint(
    checkpoint: TelegramNewsCheckpointRow,
    request: TelegramControlRequest,
    settings: NewsSettingsRow | undefined,
    resumed: boolean,
  ): Promise<TelegramControlOutcome> {
    if (!checkpoint.draft_id) throw new Error("Review checkpoint has no draft");
    const draft = await this.editorialPersistence.getDraft(checkpoint.draft_id);
    if (draft.status === "review") {
      await this.editorialPersistence.approveDraft(checkpoint.draft_id);
    } else if (!new Set(["approved", "publishing", "published"]).has(draft.status)) {
      throw new Error(`Draft ${checkpoint.draft_id} is not publishable`);
    }
    const result = await this.editorial.publishApprovedDraft({
      draftId: checkpoint.draft_id,
      channelId: request.channelId,
      publicationPath: "automatic_news",
    });
    if (result.status === "blocked" || result.status === "already_blocked") {
      const saved = await this.checkpoints.saveTelegramNewsCheckpoint({
        update_id: checkpoint.update_id,
        status: "blocked_by_policy",
        draft_id: checkpoint.draft_id,
        preview: checkpoint.preview,
        window_hours: checkpoint.window_hours,
        publication_message_id: null,
        settings_snapshot: settings ? snapshot(settings) : checkpoint.settings_snapshot,
        updated_at: this.clock.now().toISOString(),
      });
      return {
        status: saved.status,
        draftId: saved.draft_id,
        preview: saved.preview,
        windowHours: saved.window_hours,
        publicationMessageId: null,
        publicationPath: "automatic_news",
        reasonCode: result.reasonCode,
        resumed,
      };
    }
    if (!result.publication) {
      throw new Error("Published outcome has no publication receipt");
    }
    const messageId = result.publication.telegram_message_id;
    const saved = await this.checkpoints.saveTelegramNewsCheckpoint({
      update_id: checkpoint.update_id,
      status: "published",
      draft_id: checkpoint.draft_id,
      preview: checkpoint.preview,
      window_hours: checkpoint.window_hours,
      publication_message_id: messageId,
      settings_snapshot: settings ? snapshot(settings) : checkpoint.settings_snapshot,
      updated_at: this.clock.now().toISOString(),
    });
    return {
      status: "published",
      draftId: saved.draft_id,
      preview: saved.preview,
      windowHours: saved.window_hours,
      publication: result.publication,
      publicationMessageId: saved.publication_message_id ?? messageId,
      resumed,
    };
  }
}

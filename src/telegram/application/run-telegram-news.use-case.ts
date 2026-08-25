import { Inject, Injectable } from "@nestjs/common";

import { SettingsService } from "../../settings/application/settings.service.js";
import type { NewsSettingsRow } from "../../settings/settings.contracts.js";
import type {
  TelegramControlOutcome,
  TelegramControlRequest,
  TelegramNewsApplicationPort,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import type { TelegramNewsJobsPersistence } from "../telegram-persistence.contracts.js";
import { TELEGRAM_NEWS_JOBS_PERSISTENCE } from "../telegram-persistence.tokens.js";

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

/**
 * Durable NestJS /news acceptance boundary. It never performs research or
 * publication inline with Telegram update processing.
 */
@Injectable()
export class RunTelegramNewsUseCase implements TelegramNewsApplicationPort {
  constructor(
    @Inject(TELEGRAM_NEWS_JOBS_PERSISTENCE)
    private readonly jobs: TelegramNewsJobsPersistence,
    @Inject(SettingsService)
    private readonly settings: SettingsService,
  ) {}

  async execute(
    request: TelegramControlRequest,
    updateClaimToken: string,
    signal?: AbortSignal,
  ): Promise<TelegramControlOutcome> {
    signal?.throwIfAborted();
    if (request.route.kind !== "news") {
      throw new TelegramControlError("malformed_command", "News route required");
    }
    if (typeof updateClaimToken !== "string" || !updateClaimToken.trim()) {
      throw new Error("Telegram update claim token is required for durable enqueue");
    }
    const settings = await this.settings.getOrCreateNewsSettings({
      channelId: request.channelId,
      reviewChatId: request.chatId,
      updatedBy: request.actorId,
    });
    signal?.throwIfAborted();
    if (!settings) throw new Error("News settings are unavailable");

    const job = await this.jobs.enqueueTelegramNewsJob({
      updateId: request.updateId,
      updateClaimToken,
      channelId: request.channelId,
      controlChatId: request.chatId,
      requestedBy: request.actorId,
      settingsSnapshot: snapshot(settings),
    });
    if (!job || typeof job.id !== "string" || !job.id) {
      throw new Error("Durable Telegram news enqueue returned an invalid job");
    }
    if (job.enqueue_outcome === "queued" && job.job_status === "queued") {
      return {
        status: "research_queued",
        jobId: job.id,
        enqueueOutcome: "queued",
      };
    }
    if (
      job.enqueue_outcome === "already_running" &&
      job.job_status === "suppressed" &&
      typeof job.active_job_id === "string" &&
      job.active_job_id
    ) {
      return {
        status: "already_running",
        jobId: job.id,
        activeJobId: job.active_job_id,
        enqueueOutcome: "already_running",
      };
    }
    throw new Error("Durable Telegram news enqueue outcome is invalid");
  }
}

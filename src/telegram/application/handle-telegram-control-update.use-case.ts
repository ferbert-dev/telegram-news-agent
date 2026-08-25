import { Inject, Injectable } from "@nestjs/common";

import type {
  TelegramAdminAuthorizationGateway,
  TelegramControlAuditGateway,
  TelegramControlFeatureGateway,
  TelegramControlOutcome,
  TelegramControlRequest,
  TelegramNewsApplicationPort,
  TelegramReviewDecisionApplicationPort,
} from "../telegram-application.contracts.js";
import {
  isTerminalTelegramControlError,
  TelegramControlError,
} from "../telegram-application.contracts.js";
import {
  TELEGRAM_ADMIN_AUTHORIZATION,
  TELEGRAM_CONTROL_AUDIT,
} from "../telegram-application.tokens.js";
import type { TelegramUpdatesPersistence } from "../telegram-persistence.contracts.js";
import { TELEGRAM_UPDATES_PERSISTENCE } from "../telegram-persistence.tokens.js";
import { DecideTelegramReviewUseCase } from "./decide-telegram-review.use-case.js";
import { GetTelegramStatsUseCase } from "./get-telegram-stats.use-case.js";
import { HandleTelegramLabsUseCase } from "./handle-telegram-labs.use-case.js";
import { HandleTelegramSettingsUseCase } from "./handle-telegram-settings.use-case.js";
import { HandleTelegramStatusUseCase } from "./handle-telegram-status.use-case.js";
import { RunTelegramNewsUseCase } from "./run-telegram-news.use-case.js";

@Injectable()
export class HandleTelegramControlUpdateUseCase
{
  constructor(
    @Inject(TELEGRAM_UPDATES_PERSISTENCE)
    private readonly updates: TelegramUpdatesPersistence,
    @Inject(TELEGRAM_ADMIN_AUTHORIZATION)
    private readonly authorization: TelegramAdminAuthorizationGateway,
    @Inject(TELEGRAM_CONTROL_AUDIT)
    private readonly audit: TelegramControlAuditGateway,
    @Inject(RunTelegramNewsUseCase)
    private readonly news: TelegramNewsApplicationPort,
    @Inject(DecideTelegramReviewUseCase)
    private readonly review: TelegramReviewDecisionApplicationPort,
    @Inject(HandleTelegramSettingsUseCase)
    private readonly settings: TelegramControlFeatureGateway,
    @Inject(HandleTelegramLabsUseCase)
    private readonly labs: TelegramControlFeatureGateway,
    @Inject(GetTelegramStatsUseCase)
    private readonly stats: TelegramControlFeatureGateway,
    @Inject(HandleTelegramStatusUseCase)
    private readonly status: TelegramControlFeatureGateway,
  ) {}

  async execute(
    request: TelegramControlRequest,
    present: (outcome: TelegramControlOutcome) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<TelegramControlOutcome> {
    this.throwIfAborted(signal);
    this.validateClaimEnvelope(request);
    return this.audit.run(
      {
        updateId: request.updateId,
        updateKind: request.updateKind,
        routeKind: request.route.kind,
      },
      async () => {
        const claim = await this.updates.claimTelegramUpdate({
          updateId: request.updateId,
          updateKind: request.updateKind,
        });
        if (!claim.claimed) {
          if (claim.claim_status === "busy") {
            throw new TelegramControlError(
              "update_in_progress",
              "Telegram update is still being processed",
            );
          }
          return { status: "duplicate", updateId: request.updateId };
        }
        if (!claim.claim_token) throw new Error("Claimed update has no claim token");

        try {
          this.throwIfAborted(signal);
          this.validateRequest(request);
          await this.requireAdmin(request, signal);
          this.throwIfAborted(signal);
          const outcome = await this.route(request, claim.claim_token, signal);
          this.throwIfAborted(signal);
          await present(outcome);
          this.throwIfAborted(signal);
          const finished = await this.updates.finishTelegramUpdate({
            updateId: request.updateId,
            claimToken: claim.claim_token,
            status: "completed",
          });
          if (!finished) {
            throw new TelegramControlError("update_claim_lost", "Update claim was lost");
          }
          return outcome;
        } catch (error) {
          const code = error instanceof TelegramControlError
            ? error.code
            : "internal_error";
          const finished = await this.updates.finishTelegramUpdate({
            updateId: request.updateId,
            claimToken: claim.claim_token,
            status: isTerminalTelegramControlError(error) ? "completed" : "failed",
            errorCode: code,
          }).catch(() => false);
          if (!finished) {
            throw new TelegramControlError(
              "update_claim_lost",
              "Update claim could not be finished",
              { cause: error },
            );
          }
          throw error;
        }
      },
    );
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new TelegramControlError("update_claim_lost", "Telegram update was cancelled");
    }
  }

  private validateClaimEnvelope(request: TelegramControlRequest): void {
    if (
      !request ||
      typeof request !== "object" ||
      !Number.isSafeInteger(request.updateId) ||
      request.updateId <= 0 ||
      !request.route ||
      typeof request.route.kind !== "string"
    ) {
      throw new TelegramControlError("malformed_update", "Invalid Telegram update id");
    }
  }

  private validateRequest(request: TelegramControlRequest): void {
    if (
      request.chatType !== "private" ||
      !Number.isSafeInteger(request.chatId) ||
      request.chatId <= 0
    ) {
      throw new TelegramControlError("private_chat_required", "Private chat required");
    }
    if (!Number.isSafeInteger(request.actorId) || request.actorId <= 0) {
      throw new TelegramControlError("missing_sender", "Telegram sender is missing");
    }
    if (typeof request.channelId !== "string" || !request.channelId.trim()) {
      throw new TelegramControlError("malformed_update", "Telegram channel is missing");
    }
    if (request.route.kind === "malformed") {
      throw new TelegramControlError(request.route.errorCode, "Malformed callback");
    }
    if ("malformed" in request.route && request.route.malformed) {
      throw new TelegramControlError("malformed_command", "Malformed command");
    }
    if (
      request.route.kind === "review" &&
      (typeof request.route.sessionId !== "string" ||
        !/^[a-f0-9]{32,64}$/.test(request.route.sessionId) ||
        !Number.isSafeInteger(request.route.messageId) ||
        request.route.messageId <= 0 ||
        typeof request.route.callbackId !== "string" ||
        !request.route.callbackId.trim())
    ) {
      throw new TelegramControlError("malformed_callback", "Invalid review callback");
    }
    if (
      (request.route.kind === "settings" ||
        request.route.kind === "labs" ||
        request.route.kind === "status") &&
      request.route.action === "callback"
    ) {
      const payload = request.route.payload as {
        callbackId?: unknown;
        messageId?: unknown;
        action?: unknown;
      } | undefined;
      if (
        typeof payload?.callbackId !== "string" ||
        !payload.callbackId.trim() ||
        !Number.isSafeInteger(payload.messageId) ||
        (payload.messageId as number) <= 0 ||
        !payload.action ||
        typeof payload.action !== "object"
      ) {
        throw new TelegramControlError("malformed_callback", "Invalid feature callback");
      }
    }
  }

  private async requireAdmin(request: TelegramControlRequest, signal?: AbortSignal): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.authorization.isChannelAdmin(
        request.channelId,
        request.actorId,
        signal,
      );
    } catch (error) {
      this.throwIfAborted(signal);
      throw new TelegramControlError(
        "authorization_unavailable",
        "Authorization failed",
        { cause: error },
      );
    }
    if (!allowed) {
      throw new TelegramControlError("forbidden", "Administrator access required");
    }
  }

  private route(
    request: TelegramControlRequest,
    updateClaimToken: string,
    signal?: AbortSignal,
  ): Promise<TelegramControlOutcome> {
    switch (request.route.kind) {
      case "news":
        return this.news.execute(request, updateClaimToken, signal);
      case "review":
        return this.review.execute(request, signal);
      case "settings":
        return this.settings.execute(request, signal);
      case "labs":
        return this.labs.execute(request, signal);
      case "stats":
        return this.stats.execute(request, signal);
      case "status":
        return this.status.execute(request, signal);
      case "malformed":
        throw new TelegramControlError(request.route.errorCode, "Malformed callback");
    }
  }
}

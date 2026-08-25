import { Inject, Injectable } from "@nestjs/common";

import type { EditorialWorkflowApplicationPort } from "../../editorial/editorial-application.contracts.js";
import type {
  TelegramControlOutcome,
  TelegramControlRequest,
  TelegramReviewDecisionApplicationPort,
  TelegramReviewPresentationGateway,
} from "../telegram-application.contracts.js";
import { TelegramControlError } from "../telegram-application.contracts.js";
import {
  TELEGRAM_EDITORIAL_WORKFLOW,
  TELEGRAM_REVIEW_PRESENTATION,
} from "../telegram-application.tokens.js";
import type { TelegramReviewSessionsPersistence } from "../telegram-persistence.contracts.js";
import { TELEGRAM_REVIEW_SESSIONS_PERSISTENCE } from "../telegram-persistence.tokens.js";

@Injectable()
export class DecideTelegramReviewUseCase
  implements TelegramReviewDecisionApplicationPort
{
  constructor(
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    private readonly reviews: TelegramReviewSessionsPersistence,
    @Inject(TELEGRAM_EDITORIAL_WORKFLOW)
    private readonly editorial: EditorialWorkflowApplicationPort,
    @Inject(TELEGRAM_REVIEW_PRESENTATION)
    private readonly presentation: TelegramReviewPresentationGateway,
  ) {}

  async execute(request: TelegramControlRequest, signal?: AbortSignal): Promise<TelegramControlOutcome> {
    signal?.throwIfAborted();
    if (request.route.kind !== "review") {
      throw new TelegramControlError("malformed_callback", "Review route required");
    }
    signal?.throwIfAborted();
    const route = request.route;
    let decision;
    try {
      decision = await this.reviews.decideTelegramReviewSession({
        sessionId: route.sessionId,
        action: route.action,
        chatId: request.chatId,
        messageId: route.messageId,
        actorId: request.actorId,
      });
    } catch (error) {
      if (/not found|expired|binding mismatch|not actionable/i.test(
        error instanceof Error ? error.message : "",
      )) {
        throw new TelegramControlError(
          "invalid_review_session",
          "Review session is unavailable",
          { cause: error },
        );
      }
      throw error;
    }

    if (!decision.decision_won && decision.decision !== "publish") {
      await this.answer(
        route.callbackId,
        "This draft was already rejected.",
        true,
      );
      return {
        status: "already_decided",
        decision: decision.decision,
        draftId: decision.draft_id,
        callbackId: route.callbackId,
      };
    }
    if (decision.decision_won) {
      await this.presentation.disableControls({
        chatId: request.chatId,
        messageId: route.messageId,
        signal,
      }).catch(() => undefined);
    }
    if (decision.decision === "reject") {
      await this.answer(route.callbackId, "Draft rejected. Nothing was published.", false, signal);
      return {
        status: "rejected",
        draftId: decision.draft_id,
        decisionWon: decision.decision_won,
        callbackId: route.callbackId,
      };
    }

    await this.answer(
      route.callbackId,
      decision.decision_won ? "Publishing..." : "Resuming publication...",
      false,
      signal,
    );

    let publication;
    try {
      signal?.throwIfAborted();
      publication = await this.editorial.publishApprovedDraft({
        draftId: decision.draft_id,
        channelId: request.channelId,
        publicationPath: "manual_review",
        signal,
      });
    } catch (error) {
      if (/unresolved/i.test(error instanceof Error ? error.message : "")) {
        throw new TelegramControlError(
          "publication_unresolved",
          "Telegram publication outcome is unresolved",
          { cause: error },
        );
      }
      throw error;
    }
    if (publication.status === "blocked" || publication.status === "already_blocked") {
      return {
        status: "blocked_by_policy",
        publicationPath: "manual_review",
        draftId: decision.draft_id,
        reasonCode: publication.reasonCode,
        decisionWon: decision.decision_won,
        callbackId: route.callbackId,
      };
    }
    return {
      status: "published",
      draftId: decision.draft_id,
      publication: publication.publication,
      alreadyPublished: publication.status === "already_published",
      decisionWon: decision.decision_won,
      callbackId: route.callbackId,
    };
  }

  private async answer(
    callbackId: string,
    text: string,
    showAlert = false,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    await this.presentation.answerCallback({ callbackId, text, showAlert, signal })
      .catch(() => undefined);
  }
}

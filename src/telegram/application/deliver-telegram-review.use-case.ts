import { Inject, Injectable } from "@nestjs/common";

import type { EditorialPersistence } from "../../editorial/editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../../editorial/editorial-persistence.tokens.js";
import type {
  TelegramControlClock,
  TelegramControlIdGenerator,
  TelegramControlOutcome,
  TelegramReviewPresentationGateway,
} from "../telegram-application.contracts.js";
import {
  TELEGRAM_CONTROL_CLOCK,
  TELEGRAM_CONTROL_ID_GENERATOR,
  TELEGRAM_REVIEW_PRESENTATION,
} from "../telegram-application.tokens.js";
import type { TelegramReviewSessionsPersistence } from "../telegram-persistence.contracts.js";
import { TELEGRAM_REVIEW_SESSIONS_PERSISTENCE } from "../telegram-persistence.tokens.js";

const REVIEW_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type DeliverTelegramReviewInput = {
  draftId: string;
  channelId: string;
  chatId: number;
  actorId: number;
  preview: string;
  signal?: AbortSignal;
};

@Injectable()
export class DeliverTelegramReviewUseCase {
  constructor(
    @Inject(TELEGRAM_REVIEW_SESSIONS_PERSISTENCE)
    private readonly reviews: TelegramReviewSessionsPersistence,
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorial: EditorialPersistence,
    @Inject(TELEGRAM_REVIEW_PRESENTATION)
    private readonly presentation: TelegramReviewPresentationGateway,
    @Inject(TELEGRAM_CONTROL_ID_GENERATOR)
    private readonly ids: TelegramControlIdGenerator,
    @Inject(TELEGRAM_CONTROL_CLOCK)
    private readonly clock: TelegramControlClock,
  ) {}

  async execute(input: DeliverTelegramReviewInput): Promise<TelegramControlOutcome> {
    input.signal?.throwIfAborted();
    const now = this.clock.now();
    const expiresAt = new Date(now.valueOf() + REVIEW_SESSION_TTL_MS).toISOString();
    const existing = await this.reviews.findTelegramReviewSessionByDraft(input.draftId);

    if (existing) {
      if (existing.decision !== null) {
        return {
          status: "review_unavailable",
          draftId: input.draftId,
          sessionId: existing.id,
          previewMessageId: existing.preview_message_id,
          decision: existing.decision,
          resumed: true,
        };
      }
      const restored = await this.presentation.restoreControls({
        chatId: existing.control_chat_id,
        messageId: existing.preview_message_id,
        sessionId: existing.id,
        signal: input.signal,
      });
      if (restored === "available") {
        let reusable = existing;
        if (new Date(existing.expires_at).valueOf() <= now.valueOf()) {
          reusable =
            (await this.reviews.renewTelegramReviewSession({
              draftId: input.draftId,
              expiresAt,
            })) ?? existing;
          if (new Date(reusable.expires_at).valueOf() <= now.valueOf()) {
            await this.presentation.disableControls({
              chatId: existing.control_chat_id,
              messageId: existing.preview_message_id,
            }).catch(() => undefined);
            return {
              status: "review_unavailable",
              draftId: input.draftId,
              sessionId: existing.id,
              previewMessageId: existing.preview_message_id,
              resumed: true,
            };
          }
        }
        return {
          status: "review_ready",
          draftId: input.draftId,
          sessionId: reusable.id,
          previewMessageId: reusable.preview_message_id,
          resumed: true,
        };
      }

      const draft = await this.editorial.getDraft(input.draftId);
      const replacement = await this.presentation.sendReview({
        chatId: existing.control_chat_id,
        sessionId: existing.id,
        preview: input.preview,
        draft,
        signal: input.signal,
      });
      let rebound;
      try {
        rebound = await this.reviews.rebindTelegramReviewSession({
          draftId: input.draftId,
          controlChatId: existing.control_chat_id,
          expectedPreviewMessageId: existing.preview_message_id,
          previewMessageId: replacement.messageId,
          expiresAt,
        });
      } catch (error) {
        const recovered = await this.reviews.findTelegramReviewSessionByDraft(input.draftId);
        if (
          recovered?.decision === null &&
          recovered.preview_message_id === replacement.messageId
        ) {
          rebound = recovered;
        } else {
          throw error;
        }
      }
      if (!rebound) {
        await this.presentation.disableControls({
          chatId: existing.control_chat_id,
          messageId: replacement.messageId,
        }).catch(() => undefined);
        return {
          status: "review_unavailable",
          draftId: input.draftId,
          sessionId: existing.id,
          previewMessageId: replacement.messageId,
          resumed: true,
        };
      }
      return {
        status: "review_ready",
        draftId: input.draftId,
        sessionId: rebound.id,
        previewMessageId: rebound.preview_message_id,
        resumed: true,
        rebound: true,
      };
    }

    const sessionId = this.ids.next();
    const draft = await this.editorial.getDraft(input.draftId);
    const sent = await this.presentation.sendReview({
      chatId: input.chatId,
      sessionId,
      preview: input.preview,
      draft,
      signal: input.signal,
    });
    const created = await this.reviews.createTelegramReviewSession({
      id: sessionId,
      draft_id: input.draftId,
      telegram_channel_id: input.channelId,
      control_chat_id: input.chatId,
      preview_message_id: sent.messageId,
      requested_by: input.actorId,
      expires_at: expiresAt,
    });
    return {
      status: "review_ready",
      draftId: input.draftId,
      sessionId: created.id,
      previewMessageId: created.preview_message_id,
      resumed: false,
    };
  }
}

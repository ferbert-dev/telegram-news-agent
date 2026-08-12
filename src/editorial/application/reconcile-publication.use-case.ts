import { Inject, Injectable } from "@nestjs/common";

import type { EditorialPersistence } from "../editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../editorial-persistence.tokens.js";
import type {
  ReconcilePublicationInput,
  ReconcilePublicationResult,
} from "../editorial-application.contracts.js";

@Injectable()
export class ReconcilePublicationUseCase {
  constructor(
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorial: EditorialPersistence,
  ) {}

  async execute(
    input: ReconcilePublicationInput,
  ): Promise<ReconcilePublicationResult> {
    if (input.outcome === "sent") {
      if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
        throw new Error("A positive Telegram message ID is required");
      }
      const draft = await this.editorial.getDraft(input.draftId);
      const publication = await this.editorial.finalizeDraftPublication({
        draftId: input.draftId,
        channelId: input.channelId,
        messageId: input.messageId,
        messageText: draft.body,
        metadata: {
          approval: "database_approved",
          reconciliation: "operator_confirmed_sent",
        },
      });
      return { outcome: "sent", publication, draft: null };
    }

    if (input.outcome === "not-sent") {
      const draft = await this.editorial.resetDraftPublication(
        input.draftId,
        "TELEGRAM_NOT_SENT",
      );
      return { outcome: "not-sent", publication: null, draft };
    }

    throw new Error("Reconciliation outcome must be sent or not-sent");
  }
}

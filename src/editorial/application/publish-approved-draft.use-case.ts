import { Inject, Injectable } from "@nestjs/common";

import type {
  DraftRow,
  EditorialPersistence,
} from "../editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../editorial-persistence.tokens.js";
import type { NewsSettingsPersistence } from "../../settings/settings.contracts.js";
import { NEWS_SETTINGS_REPOSITORY } from "../../settings/settings.tokens.js";
import type {
  EditorialPublicationGateway,
  ExcludedTopicPolicyDecision,
  ExcludedTopicPublicationPolicy,
  PublishApprovedDraftInput,
  PublishApprovedDraftResult,
} from "../editorial-application.contracts.js";
import { PublicationDeliveryError } from "../editorial-application.contracts.js";
import {
  EDITORIAL_PUBLICATION_GATEWAY,
  EXCLUDED_TOPIC_PUBLICATION_POLICY,
} from "../editorial-application.tokens.js";

function editorFromDraft(draft: DraftRow): unknown {
  try {
    const notes = JSON.parse(draft.reviewer_notes ?? "{}") as {
      editor?: unknown;
    };
    return notes.editor ?? null;
  } catch {
    return null;
  }
}

function deniedDecision(
  decision: ExcludedTopicPolicyDecision,
): decision is Exclude<ExcludedTopicPolicyDecision, { decision: "allow" }> {
  return (
    decision.decision === "block" ||
    decision.decision === "uncertain" ||
    decision.decision === "error"
  );
}

function validatePolicyDecision(
  value: ExcludedTopicPolicyDecision,
): ExcludedTopicPolicyDecision {
  if (value?.decision === "allow") return value;
  if (
    (value?.decision === "block" ||
      value?.decision === "uncertain" ||
      value?.decision === "error") &&
    typeof value.reasonCode === "string" &&
    value.reasonCode.trim().length > 0
  ) {
    return value;
  }
  throw new Error("Excluded-topic policy returned an invalid decision");
}

@Injectable()
export class PublishApprovedDraftUseCase {
  constructor(
    @Inject(EDITORIAL_PERSISTENCE)
    private readonly editorial: EditorialPersistence,
    @Inject(NEWS_SETTINGS_REPOSITORY)
    private readonly settings: NewsSettingsPersistence,
    @Inject(EXCLUDED_TOPIC_PUBLICATION_POLICY)
    private readonly policy: ExcludedTopicPublicationPolicy,
    @Inject(EDITORIAL_PUBLICATION_GATEWAY)
    private readonly gateway: EditorialPublicationGateway,
  ) {}

  private async releaseClaim(draftId: string): Promise<DraftRow> {
    const released =
      await this.editorial.releaseRejectedDraftPublication(draftId);
    if (released === undefined) {
      throw new Error(
        "Publication claim release returned no draft; publication remains unresolved",
      );
    }
    return released;
  }

  async execute(
    input: PublishApprovedDraftInput,
  ): Promise<PublishApprovedDraftResult> {
    const { draftId, channelId, signal } = input;
    signal?.throwIfAborted();
    const existing = await this.editorial.findPublicationByDraft(draftId);
    if (existing) {
      return {
        status: "already_published",
        publication: existing,
        alreadyPublished: true,
      };
    }

    const draft = await this.editorial.claimDraftForPublication(
      draftId,
      channelId,
    );
    if (draft === undefined) {
      throw new Error(
        "Draft is not publishable or was blocked as a duplicate story",
      );
    }

    let decision: ExcludedTopicPolicyDecision;
    try {
      signal?.throwIfAborted();
      const currentSettings = await this.settings.getNewsSettings(channelId);
      if (currentSettings === null) {
        throw new Error("Current publication settings are unavailable");
      }
      decision = validatePolicyDecision(
        await this.policy.evaluate(
          {
            draftId,
            articleId: draft.article_id,
            channelId,
            content: { text: draft.body },
            settings: {
              version: currentSettings.version,
              excludedTopicCodes: [...currentSettings.excluded_topic_codes],
            },
          },
          signal,
        ),
      );
      signal?.throwIfAborted();
    } catch (error) {
      const released = await this.releaseClaim(draftId);
      if (signal?.aborted) signal.throwIfAborted();
      return {
        status: "policy_error",
        reasonCode: "policy_error",
        publication: null,
        draft: released,
      };
    }

    if (deniedDecision(decision)) {
      const released = await this.releaseClaim(draftId);
      return {
        status:
          decision.decision === "block"
            ? "blocked"
            : decision.decision === "uncertain"
              ? "uncertain"
              : "policy_error",
        reasonCode: decision.reasonCode,
        publication: null,
        draft: released,
      };
    }

    let receipt;
    try {
      receipt = await this.gateway.publish(
        {
          channelId,
          text: draft.body,
          disableNotification: false,
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof PublicationDeliveryError &&
        error.outcome === "rejected"
      ) {
        await this.releaseClaim(draftId);
        throw new Error(
          "Publication was rejected; draft was released for retry",
          { cause: error },
        );
      }
      throw new Error(
        "Publication outcome is unresolved; draft remains in publishing state for manual reconciliation",
        { cause: error },
      );
    }

    if (!Number.isSafeInteger(receipt.messageId) || receipt.messageId <= 0) {
      throw new Error(
        "Publication outcome is unresolved; gateway returned an invalid receipt and the draft remains in publishing state for manual reconciliation",
      );
    }

    try {
      const publication = await this.editorial.finalizeDraftPublication({
        draftId,
        channelId,
        messageId: receipt.messageId,
        messageText: draft.body,
        metadata: {
          bot_message_date: receipt.messageDate ?? null,
          approval: "database_approved",
          editor: editorFromDraft(draft),
        },
      });
      if (publication === undefined) {
        throw new Error("Publication receipt was not persisted");
      }
      return {
        status: "published",
        publication,
        alreadyPublished: false,
      };
    } catch (error) {
      throw new Error(
        "Publication outcome is unresolved after the message was accepted; draft remains in publishing state for manual reconciliation",
        { cause: error },
      );
    }
  }
}

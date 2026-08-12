import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type {
  DraftRow,
  EditorialPersistence,
  PublicationPath,
  PublicationPolicyClassification,
} from "../editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "../editorial-persistence.tokens.js";
import type { NewsSettingsPersistence } from "../../settings/settings.contracts.js";
import { NEWS_SETTINGS_REPOSITORY } from "../../settings/settings.tokens.js";
import type { UsageReportingPersistence } from "../../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../../usage/usage-persistence.tokens.js";
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

const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/-]{1,100}$/;

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

function safeIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return SAFE_IDENTIFIER.test(normalized) ? normalized : null;
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
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usage: UsageReportingPersistence,
    @Inject(EXCLUDED_TOPIC_PUBLICATION_POLICY)
    private readonly policy: ExcludedTopicPublicationPolicy,
    @Inject(EDITORIAL_PUBLICATION_GATEWAY)
    private readonly gateway: EditorialPublicationGateway,
  ) {}

  private async recordUsage(
    decision: ExcludedTopicPolicyDecision,
    draft: DraftRow,
    channelId: string,
  ): Promise<void> {
    for (const event of decision.usageEvents ?? []) {
      try {
        await this.usage.recordAiUsage({
          ...event,
          telegramChannelId: channelId,
          articleId: draft.article_id,
        });
      } catch {
        // Usage accounting is best effort and must not change delivery state.
      }
    }
  }

  async execute(
    input: PublishApprovedDraftInput,
  ): Promise<PublishApprovedDraftResult> {
    const {
      draftId,
      channelId,
      signal,
      publicationPath = "automatic",
    } = input;
    signal?.throwIfAborted();
    const existing = await this.editorial.findPublicationByDraft(draftId);
    if (existing) {
      return {
        status: "already_published",
        publication: existing,
        alreadyPublished: true,
      };
    }

    const existingBlock =
      await this.editorial.findPublicationPolicyBlockByDraft(
        draftId,
        channelId,
      );
    if (existingBlock) {
      const draft = await this.editorial.getDraft(draftId);
      return {
        status: "already_blocked",
        reasonCode: existingBlock.reason_code,
        publication: null,
        draft,
      };
    }

    let draft = await this.editorial.getDraft(draftId);
    let claimed: DraftRow | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      const currentSettings = await this.settings.getNewsSettings(channelId);
      if (currentSettings === null) {
        throw new Error("Current publication settings are unavailable");
      }
      const outboundTextSha256 = createHash("sha256")
        .update(draft.body, "utf8")
        .digest("hex");

      let decision: ExcludedTopicPolicyDecision = { decision: "allow" };
      if (currentSettings.excluded_topic_codes.length > 0) {
        try {
          decision = validatePolicyDecision(
            await this.policy.evaluate(
              {
                draftId,
                articleId: draft.article_id,
                channelId,
                content: { text: draft.body },
                settings: {
                  version: currentSettings.version,
                  excludedTopicCodes: [
                    ...currentSettings.excluded_topic_codes,
                  ],
                },
              },
              signal,
            ),
          );
        } catch {
          if (signal?.aborted) signal.throwIfAborted();
          decision = {
            decision: "error",
            reasonCode: "excluded_topic_classifier_error",
          };
        }
        await this.recordUsage(decision, draft, channelId);
        signal?.throwIfAborted();
      }

      if (decision.decision !== "allow") {
        const classification: PublicationPolicyClassification =
          decision.decision === "block"
            ? "main_subject"
            : decision.decision === "uncertain"
              ? "uncertain"
              : "classifier_error";
        const reasonCode =
          classification === "main_subject"
            ? "excluded_topic_main_subject"
            : classification === "uncertain"
              ? "excluded_topic_uncertain"
              : "excluded_topic_classifier_error";
        const blocked = await this.editorial.blockDraftPublication({
          draftId,
          channelId,
          stage: "final_publication",
          publicationPath: publicationPath as PublicationPath,
          topicCode:
            decision.topicCode ?? currentSettings.excluded_topic_codes[0],
          classification,
          settingsVersion: currentSettings.version,
          outboundText: draft.body,
          outboundTextSha256,
          provider: safeIdentifier(decision.provider),
          model: safeIdentifier(decision.model),
          promptVersion: safeIdentifier(decision.promptVersion),
          reasonCode,
        });
        if (blocked.outcome === "stale_settings" && attempt === 0) {
          draft = await this.editorial.getDraft(draftId);
          continue;
        }
        if (
          blocked.outcome === "blocked" ||
          blocked.outcome === "already_blocked"
        ) {
          return {
            status:
              blocked.outcome === "blocked" ? "blocked" : "already_blocked",
            reasonCode: blocked.reasonCode ?? reasonCode,
            publication: null,
            draft: { ...draft, status: "rejected" },
          };
        }
        if (blocked.outcome === "already_published") {
          const publication =
            await this.editorial.findPublicationByDraft(draftId);
          if (publication) {
            return {
              status: "already_published",
              publication,
              alreadyPublished: true,
            };
          }
        }
        throw new Error(`Publication policy block failed: ${blocked.outcome}`);
      }

      const claim =
        await this.editorial.claimDraftForPublicationWithPolicy({
          draftId,
          channelId,
          settingsVersion: currentSettings.version,
          outboundTextSha256,
        });
      if (claim.outcome === "stale_settings" && attempt === 0) {
        draft = await this.editorial.getDraft(draftId);
        continue;
      }
      if (claim.outcome === "already_blocked") {
        const block = await this.editorial.findPublicationPolicyBlockByDraft(
          draftId,
          channelId,
        );
        return {
          status: "already_blocked",
          reasonCode: block?.reason_code ?? "excluded_topic_uncertain",
          publication: null,
          draft: { ...draft, status: "rejected" },
        };
      }
      if (claim.outcome === "already_published") {
        const publication =
          await this.editorial.findPublicationByDraft(draftId);
        if (publication) {
          return {
            status: "already_published",
            publication,
            alreadyPublished: true,
          };
        }
      }
      if (claim.outcome !== "claimed" || claim.draft === null) {
        throw new Error(`Draft is not publishable: ${claim.outcome}`);
      }
      const claimedHash = createHash("sha256")
        .update(claim.draft.body, "utf8")
        .digest("hex");
      if (claimedHash !== outboundTextSha256) {
        throw new Error(
          "Publication claim returned content different from the classified outbound text",
        );
      }
      claimed = claim.draft;
      break;
    }

    if (claimed === null) {
      throw new Error("Publication settings changed during the bounded retry");
    }

    let receipt;
    try {
      receipt = await this.gateway.publish(
        {
          channelId,
          text: claimed.body,
          disableNotification: false,
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof PublicationDeliveryError &&
        error.outcome === "rejected"
      ) {
        await this.editorial.releaseRejectedDraftPublication(draftId);
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
        messageText: claimed.body,
        metadata: {
          bot_message_date: receipt.messageDate ?? null,
          approval: "database_approved",
          editor: editorFromDraft(claimed),
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

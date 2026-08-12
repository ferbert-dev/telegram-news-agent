import { createHash } from "node:crypto";

import { evaluateFinalPublicationPolicy } from "./publication-policy.js";
import { sendTelegramMessage, TelegramError } from "./telegram.js";

function editorFromDraft(draft) {
  try {
    return JSON.parse(draft.reviewer_notes ?? "{}")?.editor ?? null;
  } catch {
    return null;
  }
}

export async function publishApprovedDraft({
  repository,
  aiProvider,
  createAiProvider,
  token,
  channelId,
  draftId,
  publicationPath = "automatic",
  sendMessage = sendTelegramMessage,
}) {
  const existing = await repository.findPublicationByDraft(draftId);
  if (existing) {
    return {
      status: "already_published",
      publication: existing,
      alreadyPublished: true,
    };
  }

  const existingBlock = await repository.findPublicationPolicyBlockByDraft(
    draftId,
    channelId,
  );
  if (existingBlock) {
    return {
      status: "already_blocked",
      publication: null,
      block: existingBlock,
      reasonCode: existingBlock.reason_code,
      alreadyPublished: false,
    };
  }

  let draft = await repository.getDraft(draftId);
  let claimedDraft;
  let activeAiProvider = aiProvider;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const settings = await repository.getNewsSettings(channelId);
    if (!settings) {
      throw new Error("Current publication settings are unavailable");
    }
    const outboundTextSha256 = createHash("sha256")
      .update(draft.body, "utf8")
      .digest("hex");
    if (
      settings.excluded_topic_codes.length > 0 &&
      !activeAiProvider &&
      typeof createAiProvider === "function"
    ) {
      activeAiProvider = createAiProvider();
    }
    const policy = await evaluateFinalPublicationPolicy({
      repository,
      aiProvider: activeAiProvider,
      draft,
      channelId,
      excludedTopicCodes: settings.excluded_topic_codes,
    });

    if (policy.decision === "block") {
      const blocked = await repository.blockDraftPublication({
        draftId,
        channelId,
        stage: "final_publication",
        publicationPath,
        topicCode: policy.topicCode,
        classification: policy.classification,
        settingsVersion: settings.version,
        outboundText: draft.body,
        outboundTextSha256,
        provider: policy.provider,
        model: policy.model,
        promptVersion: policy.promptVersion,
        reasonCode: policy.reasonCode,
      });
      if (blocked.outcome === "stale_settings" && attempt === 0) {
        draft = await repository.getDraft(draftId);
        continue;
      }
      if (
        blocked.outcome === "blocked" ||
        blocked.outcome === "already_blocked"
      ) {
        return {
          status:
            blocked.outcome === "blocked" ? "blocked" : "already_blocked",
          publication: null,
          block: blocked,
          draft: { ...draft, status: "rejected" },
          reasonCode: blocked.reasonCode ?? policy.reasonCode,
          alreadyPublished: false,
        };
      }
      if (blocked.outcome === "already_published") {
        const publication = await repository.findPublicationByDraft(draftId);
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

    const claim = await repository.claimDraftForPublicationWithPolicy({
      draftId,
      channelId,
      settingsVersion: settings.version,
      outboundTextSha256,
    });
    if (claim.outcome === "stale_settings" && attempt === 0) {
      draft = await repository.getDraft(draftId);
      continue;
    }
    if (claim.outcome === "already_blocked") {
      const block = await repository.findPublicationPolicyBlockByDraft(
        draftId,
        channelId,
      );
      return {
        status: "already_blocked",
        publication: null,
        block,
        reasonCode: block?.reason_code ?? "excluded_topic_uncertain",
        alreadyPublished: false,
      };
    }
    if (claim.outcome === "already_published") {
      const publication = await repository.findPublicationByDraft(draftId);
      if (publication) {
        return {
          status: "already_published",
          publication,
          alreadyPublished: true,
        };
      }
    }
    if (claim.outcome !== "claimed" || !claim.draft) {
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
    claimedDraft = claim.draft;
    break;
  }

  if (!claimedDraft) {
    throw new Error("Publication settings changed during the bounded retry");
  }

  let sent;
  try {
    sent = await sendMessage({
      token,
      channelId,
      text: claimedDraft.body,
      disableNotification: false,
    });
  } catch (error) {
    if (error instanceof TelegramError) {
      await repository.releaseRejectedDraftPublication(draftId);
      throw new Error(
        "Telegram rejected the publication; draft was released for retry",
        { cause: error },
      );
    }
    throw new Error(
      "Telegram publication outcome is unresolved; draft remains in publishing state for manual reconciliation",
      { cause: error },
    );
  }

  let publication;
  try {
    publication = await repository.finalizeDraftPublication({
      draftId,
      channelId,
      messageId: sent.message_id,
      messageText: claimedDraft.body,
      metadata: {
        bot_message_date: sent.date ?? null,
        approval: "database_approved",
        editor: editorFromDraft(claimedDraft),
      },
    });
  } catch (error) {
    throw new Error(
      "Telegram publication outcome is unresolved after the message was accepted; draft remains in publishing state for manual reconciliation",
      { cause: error },
    );
  }

  return { status: "published", publication, alreadyPublished: false };
}

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
  token,
  channelId,
  draftId,
  sendMessage = sendTelegramMessage,
}) {
  const existing = await repository.findPublicationByDraft(draftId);
  if (existing) {
    return { publication: existing, alreadyPublished: true };
  }

  const draft = await repository.claimDraftForPublication(draftId);

  let sent;
  try {
    sent = await sendMessage({
      token,
      channelId,
      text: draft.body,
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
      messageText: draft.body,
      metadata: {
        bot_message_date: sent.date ?? null,
        approval: "database_approved",
        editor: editorFromDraft(draft),
      },
    });
  } catch (error) {
    throw new Error(
      "Telegram publication outcome is unresolved after the message was accepted; draft remains in publishing state for manual reconciliation",
      { cause: error },
    );
  }

  return { publication, alreadyPublished: false };
}

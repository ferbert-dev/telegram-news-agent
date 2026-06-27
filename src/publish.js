import { sendTelegramMessage } from "./telegram.js";

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
    throw new Error(
      "Telegram publication outcome is unresolved; draft remains in publishing state for manual reconciliation",
      { cause: error },
    );
  }

  const publication = await repository.finalizeDraftPublication({
    draftId,
    channelId,
    messageId: sent.message_id,
    messageText: draft.body,
    metadata: {
      bot_message_date: sent.date ?? null,
      approval: "database_approved",
    },
  });

  return { publication, alreadyPublished: false };
}

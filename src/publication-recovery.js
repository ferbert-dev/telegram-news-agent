export async function reconcilePublication({
  repository,
  draftId,
  outcome,
  channelId,
  messageId,
}) {
  if (outcome === "sent") {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error("A positive Telegram message ID is required");
    }
    const draft = await repository.getDraft(draftId);
    const publication = await repository.finalizeDraftPublication({
      draftId,
      channelId,
      messageId,
      messageText: draft.body,
      metadata: {
        approval: "database_approved",
        reconciliation: "operator_confirmed_sent",
      },
    });
    return { outcome, publication, draft: null };
  }

  if (outcome === "not-sent") {
    const draft = await repository.resetDraftPublication(
      draftId,
      "TELEGRAM_NOT_SENT",
    );
    return { outcome, publication: null, draft };
  }

  throw new Error("Reconciliation outcome must be sent or not-sent");
}

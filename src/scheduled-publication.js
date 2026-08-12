import { publishApprovedDraft } from "./publish.js";

export async function publishScheduledDraft({
  repository,
  aiProvider,
  token,
  channelId,
  draftId,
  publishDraft = publishApprovedDraft,
}) {
  const draft = await repository.getDraft(draftId);
  if (draft.status === "review") {
    await repository.approveDraft(draftId);
  } else if (
    !["approved", "publishing", "published", "rejected"].includes(
      draft.status,
    )
  ) {
    throw new Error(`Scheduled draft ${draftId} is not publishable`);
  }
  return publishDraft({
    repository,
    aiProvider,
    token,
    channelId,
    draftId,
    publicationPath: "scheduler",
  });
}

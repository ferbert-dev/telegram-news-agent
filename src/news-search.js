import { NoResearchCandidatesError } from "./research.js";
import { publishApprovedDraft } from "./publish.js";
import {
  buildSearchPlan,
  newsSettingsSnapshot,
  normalizeNewsSettings,
} from "./news-settings.js";

export async function runTieredNewsSearch({
  runWorkflow,
  repository,
  aiProvider,
  aiClient,
  model,
  settings,
  telegram,
  sendMessage,
  editor,
}) {
  let lastEmptyResult;
  const normalizedSettings = normalizeNewsSettings(settings);
  const settingsSnapshot = newsSettingsSnapshot(normalizedSettings);

  for (const tier of buildSearchPlan(normalizedSettings)) {
    try {
      const result = await runWorkflow({
        approvalPolicy: normalizedSettings.approvalPolicy,
        repository,
        aiProvider,
        aiClient,
        model,
        telegram,
        sendMessage,
        query: tier.query,
        keywords: tier.keywords,
        windowHours: tier.windowHours,
        newsSettings: settingsSnapshot,
        editor,
      });
      return { result, tier };
    } catch (error) {
      if (!(error instanceof NoResearchCandidatesError)) {
        throw error;
      }
      lastEmptyResult = error;
    }
  }

  throw lastEmptyResult;
}

export async function runCheckpointedNewsSearch({
  updateId,
  repository,
  aiProvider,
  aiClient,
  model,
  runWorkflow,
  settings,
  telegram,
  sendMessage,
  publishDraft = publishApprovedDraft,
  editor,
}) {
  const existing = await repository.getTelegramNewsCheckpoint(updateId);
  if (existing) {
    const existingSettings = normalizeNewsSettings(
      existing.settings_snapshot ?? settings,
    );
    if (
      existing.status === "review_ready" &&
      existingSettings.approvalPolicy === "automatic"
    ) {
      return publishCheckpointedDraft({
        checkpoint: existing,
        settings: existingSettings,
        repository,
        telegram,
        sendMessage,
        publishDraft,
        aiProvider,
        resumed: true,
      });
    }
    return {
      status: existing.status,
      draftId: existing.draft_id,
      preview: existing.preview,
      windowHours: existing.window_hours,
      publicationMessageId: existing.publication_message_id ?? null,
      resumed: true,
    };
  }

  const normalizedSettings = normalizeNewsSettings(settings);
  const settingsSnapshot = newsSettingsSnapshot(normalizedSettings);
  try {
    const pipelineSettings =
      normalizedSettings.approvalPolicy === "automatic"
        ? { ...settingsSnapshot, approvalPolicy: "manual" }
        : normalizedSettings;
    const { result, tier } = await runTieredNewsSearch({
      runWorkflow,
      repository,
      aiProvider,
      aiClient,
      model,
      settings: pipelineSettings,
      telegram,
      sendMessage,
      editor,
    });
    const checkpoint = await repository.saveTelegramNewsCheckpoint({
      update_id: updateId,
      status: "review_ready",
      draft_id: result.draft.id,
      preview: result.preview,
      window_hours: tier.windowHours,
      publication_message_id: null,
      settings_snapshot: settingsSnapshot,
      updated_at: new Date().toISOString(),
    });
    if (normalizedSettings.approvalPolicy === "automatic") {
      return publishCheckpointedDraft({
        checkpoint,
        settings: normalizedSettings,
        repository,
        telegram,
        sendMessage,
        publishDraft,
        aiProvider,
        resumed: false,
      });
    }
    return {
      status: checkpoint.status,
      draftId: checkpoint.draft_id,
      preview: checkpoint.preview,
      windowHours: checkpoint.window_hours,
      publicationMessageId: null,
      resumed: false,
    };
  } catch (error) {
    if (!(error instanceof NoResearchCandidatesError)) {
      throw error;
    }
    const checkpoint = await repository.saveTelegramNewsCheckpoint({
      update_id: updateId,
      status: "no_candidates",
      draft_id: null,
      preview: null,
      window_hours: null,
      publication_message_id: null,
      settings_snapshot: settingsSnapshot,
      updated_at: new Date().toISOString(),
    });
    return {
      status: checkpoint.status,
      draftId: null,
      preview: null,
      windowHours: null,
      publicationMessageId: null,
      resumed: false,
    };
  }
}

async function publishCheckpointedDraft({
  checkpoint,
  settings,
  repository,
  telegram,
  sendMessage,
  publishDraft,
  aiProvider,
  resumed,
}) {
  if (!telegram?.token || !telegram?.channelId) {
    throw new Error("Automatic approval requires Telegram configuration");
  }
  const draft = await repository.getDraft(checkpoint.draft_id);
  if (draft.status === "review") {
    await repository.approveDraft(checkpoint.draft_id);
  } else if (!["approved", "publishing", "published"].includes(draft.status)) {
    throw new Error(`Draft ${checkpoint.draft_id} is not publishable`);
  }
  const published = await publishDraft({
    repository,
    aiProvider,
    token: telegram.token,
    channelId: telegram.channelId,
    draftId: checkpoint.draft_id,
    publicationPath: "automatic_news",
    sendMessage,
  });
  if (
    published.status === "blocked" ||
    published.status === "already_blocked"
  ) {
    const saved = await repository.saveTelegramNewsCheckpoint({
      update_id: checkpoint.update_id,
      status: "blocked_by_policy",
      draft_id: checkpoint.draft_id,
      preview: checkpoint.preview,
      window_hours: checkpoint.window_hours,
      publication_message_id: null,
      settings_snapshot: newsSettingsSnapshot(settings),
      updated_at: new Date().toISOString(),
    });
    return {
      status: saved.status,
      draftId: saved.draft_id,
      preview: saved.preview,
      windowHours: saved.window_hours,
      publication: null,
      publicationMessageId: null,
      reasonCode: published.reasonCode,
      resumed,
    };
  }
  const publicationMessageId = published.publication.telegram_message_id;
  const saved = await repository.saveTelegramNewsCheckpoint({
    update_id: checkpoint.update_id,
    status: "published",
    draft_id: checkpoint.draft_id,
    preview: checkpoint.preview,
    window_hours: checkpoint.window_hours,
    publication_message_id: publicationMessageId,
    settings_snapshot: newsSettingsSnapshot(settings),
    updated_at: new Date().toISOString(),
  });
  return {
    status: saved.status,
    draftId: saved.draft_id,
    preview: saved.preview,
    windowHours: saved.window_hours,
    publication: published.publication,
    publicationMessageId:
      saved.publication_message_id ?? publicationMessageId,
    resumed,
  };
}

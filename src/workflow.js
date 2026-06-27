import { runPipeline } from "./pipeline.js";
import { publishApprovedDraft } from "./publish.js";

export function getApprovalPolicy(env = process.env) {
  const policy = (env.APPROVAL_POLICY || "manual").trim().toLowerCase();
  if (!["manual", "automatic"].includes(policy)) {
    throw new Error("APPROVAL_POLICY must be manual or automatic");
  }
  return policy;
}

export async function runWorkflow({
  approvalPolicy,
  repository,
  sendMessage,
  telegram,
  ...pipelineOptions
}) {
  const pipeline = await runPipeline({
    repository,
    ...pipelineOptions,
  });

  if (approvalPolicy === "manual") {
    return {
      status: "awaiting_approval",
      ...pipeline,
      publication: null,
    };
  }

  if (approvalPolicy !== "automatic") {
    throw new Error(`Unsupported approval policy: ${approvalPolicy}`);
  }
  if (!telegram?.token || !telegram?.channelId) {
    throw new Error("Automatic approval requires Telegram configuration");
  }

  await repository.approveDraft(pipeline.draft.id);
  const published = await publishApprovedDraft({
    repository,
    token: telegram.token,
    channelId: telegram.channelId,
    draftId: pipeline.draft.id,
    sendMessage,
  });

  return {
    status: "published",
    ...pipeline,
    publication: published.publication,
  };
}

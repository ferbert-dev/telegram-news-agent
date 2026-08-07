import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";
import { createAiProvider } from "./ai-provider.js";
import {
  backfillNotionAudits,
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";
import { getTelegramConfig } from "./telegram.js";
import { getApprovalPolicy, runWorkflow } from "./workflow.js";
import { getNewsEditor } from "./editor.js";

function value(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
const windowHours = Number(value(args, "--window-hours", "48"));
if (!Number.isFinite(windowHours) || windowHours <= 0) {
  throw new Error("--window-hours must be a positive number");
}

const keywords = value(args, "--keywords", "AI,model,research,agent")
  .split(",")
  .map((keyword) => keyword.trim())
  .filter(Boolean);
const query = value(args, "--query", "important AI developments");
const approvalPolicy = getApprovalPolicy();
const auditLogger = new NotionAuditLogger(getNotionAuditConfig());
const repository = new NewsRepository(createDatabaseClient());
const editor = getNewsEditor();
await backfillNotionAudits(auditLogger, repository);
const result = await withNotionAudit(
  auditLogger,
  {
    name: `AI news pipeline: ${query}`,
    objective: `Research the last ${windowHours} hours, persist primary-source evidence, and create a review-ready Telegram draft.`,
    onFinalizationFailure: (record) =>
      repository.enqueueNotionAuditBackfill(record),
  },
  async (auditRun) => {
    const aiProvider = createAiProvider();
    const workflowResult = await runWorkflow({
      approvalPolicy,
      repository,
      aiProvider,
      query,
      keywords,
      windowHours,
      editor,
      telegram:
        approvalPolicy === "automatic" ? getTelegramConfig() : undefined,
    });

    return {
      value: workflowResult,
      auditResult:
        workflowResult.status === "published"
          ? `Published draft ${workflowResult.draft.id} as Telegram message ${workflowResult.publication.telegram_message_id}.`
          : `Created review draft ${workflowResult.draft.id} from article ${workflowResult.article.id}; manual approval is required.`,
      auditLinks: [
        auditRun.pageUrl,
        workflowResult.article.canonical_url,
      ].join("\n"),
    };
  },
);

console.log(
  JSON.stringify(
    {
      event:
        result.status === "published"
          ? "pipeline_published"
          : "pipeline_review_ready",
      run_id: result.runId,
      article_id: result.article.id,
      draft_id: result.draft.id,
      approval_policy: approvalPolicy,
      telegram_message_id:
        result.publication?.telegram_message_id ?? null,
      feed_errors: result.feedErrors,
      ai_provider: result.provider,
      ai_model: result.model,
    },
    null,
    2,
  ),
);
console.log("\n--- PREVIEW ---\n");
console.log(result.preview);

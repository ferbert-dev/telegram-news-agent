import { pathToFileURL } from "node:url";

import { createAiProvider } from "./ai-provider.js";
import { createDatabaseClient } from "./database.js";
import { getNewsEditor } from "./editor.js";
import { NewsRepository } from "./news-repository.js";
import {
  backfillNotionAudits,
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";
import { getTelegramConfig } from "./telegram.js";
import { getApprovalPolicy, runWorkflow } from "./workflow.js";

function value(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

export function formatPipelineOutcome(result, approvalPolicy) {
  const status = result.status;
  const event =
    status === "published"
      ? "pipeline_published"
      : status === "blocked_by_policy"
        ? "pipeline_blocked_by_policy"
        : "pipeline_review_ready";
  const auditResult =
    status === "published"
      ? `Published draft ${result.draft.id} as Telegram message ${result.publication.telegram_message_id}.`
      : status === "blocked_by_policy"
        ? `Draft ${result.draft.id} was blocked by the excluded-topic policy; no Telegram message was sent.`
        : `Created review draft ${result.draft.id} from article ${result.article.id}; manual approval is required.`;
  return {
    auditResult,
    output: {
      event,
      run_id: result.runId,
      article_id: result.article.id,
      draft_id: result.draft.id,
      approval_policy: approvalPolicy,
      telegram_message_id: result.publication?.telegram_message_id ?? null,
      feed_errors: result.feedErrors,
      ai_provider: result.provider,
      ai_model: result.model,
    },
  };
}

export async function runPipelineCli({
  args = process.argv.slice(2),
  log = console.log,
} = {}) {
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
      const formatted = formatPipelineOutcome(
        workflowResult,
        approvalPolicy,
      );
      return {
        value: workflowResult,
        auditResult: formatted.auditResult,
        auditLinks: [
          auditRun.pageUrl,
          workflowResult.article.canonical_url,
        ].join("\n"),
      };
    },
  );
  const formatted = formatPipelineOutcome(result, approvalPolicy);
  log(JSON.stringify(formatted.output, null, 2));
  log("\n--- PREVIEW ---\n");
  log(result.preview);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPipelineCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
  withNotionAudit,
} from "./notion-audit.js";
import { publishApprovedDraft } from "./publish.js";
import { reconcilePublication } from "./publication-recovery.js";
import { getTelegramConfig } from "./telegram.js";

function argument(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const logger = new NotionAuditLogger(getNotionAuditConfig());
  return withNotionAudit(
    logger,
    {
      name: `Draft operation: ${command || "invalid"}`,
      objective: `Execute the ${command || "requested"} draft workflow command.`,
    },
    async (auditRun) => {
      const result = await execute(command, args);
      return {
        value: result,
        auditResult: result.auditResult,
        auditLinks: [auditRun.pageUrl, result.auditLinks]
          .filter(Boolean)
          .join("\n"),
      };
    },
  );
}

async function execute(command, args) {
  const repository = new NewsRepository(createDatabaseClient());

  if (command === "list") {
    const status = args.includes("--status")
      ? argument(args, "--status")
      : "review";
    const drafts = await repository.listDrafts(status);
    for (const draft of drafts) {
      console.log(`${draft.id}\t${draft.status}\t${draft.articles?.title ?? ""}`);
    }
    return {
      auditResult: `Listed ${drafts.length} drafts with status ${status}.`,
    };
  }

  const id = argument(args, "--id");

  if (command === "preview") {
    const draft = await repository.getDraft(id);
    console.log(`[${draft.status}] ${draft.articles?.title ?? ""}`);
    console.log("---");
    console.log(draft.body);
    console.log("---");
    return {
      auditResult: `Previewed draft ${draft.id} in status ${draft.status}.`,
      auditLinks: draft.articles?.canonical_url,
    };
  }

  if (command === "approve") {
    const draft = await repository.approveDraft(id);
    console.log(`Approved draft ${draft.id}.`);
    return { auditResult: `Approved draft ${draft.id}.` };
  }

  if (command === "reject") {
    const reason = args.includes("--reason")
      ? argument(args, "--reason")
      : null;
    const draft = await repository.rejectDraft(id, reason);
    console.log(`Rejected draft ${draft.id}.`);
    return { auditResult: `Rejected draft ${draft.id}.` };
  }

  if (command === "publish") {
    const { token, channelId } = getTelegramConfig();
    const result = await publishApprovedDraft({
      repository,
      token,
      channelId,
      draftId: id,
    });
    console.log(
      result.alreadyPublished
        ? `Draft was already published as message ${result.publication.telegram_message_id}.`
        : `Published Telegram message ${result.publication.telegram_message_id}.`,
    );
    return {
      auditResult: result.alreadyPublished
        ? `Draft ${id} was already published as Telegram message ${result.publication.telegram_message_id}.`
        : `Published draft ${id} as Telegram message ${result.publication.telegram_message_id}.`,
      auditLinks: result.publication.metadata?.telegram_url,
    };
  }

  if (command === "reconcile-sent") {
    const messageId = Number(argument(args, "--message-id"));
    const { channelId } = getTelegramConfig();
    const result = await reconcilePublication({
      repository,
      draftId: id,
      outcome: "sent",
      channelId,
      messageId,
    });
    console.log(
      `Recorded confirmed Telegram message ${result.publication.telegram_message_id}.`,
    );
    return {
      auditResult: `Reconciled draft ${id} as sent in Telegram message ${result.publication.telegram_message_id}.`,
    };
  }

  if (command === "reconcile-not-sent") {
    const confirmation = argument(args, "--confirm");
    if (confirmation !== "TELEGRAM_NOT_SENT") {
      throw new Error("--confirm must be exactly TELEGRAM_NOT_SENT");
    }
    const result = await reconcilePublication({
      repository,
      draftId: id,
      outcome: "not-sent",
    });
    console.log(`Released draft ${result.draft.id} for a controlled retry.`);
    return {
      auditResult: `Reconciled draft ${id} as not sent and returned it to approved.`,
    };
  }

  throw new Error(
    "Usage: drafts <list|preview|approve|reject|publish|reconcile-sent|reconcile-not-sent> [--id UUID] [--status STATUS] [--reason TEXT] [--message-id ID] [--confirm TELEGRAM_NOT_SENT]",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

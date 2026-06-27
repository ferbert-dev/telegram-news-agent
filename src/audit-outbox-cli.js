import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";
import {
  getNotionAuditConfig,
  NotionAuditLogger,
} from "./notion-audit.js";

const repository = new NewsRepository(createDatabaseClient());
const logger = new NotionAuditLogger(getNotionAuditConfig());
const entries = await repository.listPendingNotionAuditFinalizations();
let delivered = 0;

for (const entry of entries) {
  try {
    const { run, details } = entry.payload;
    await logger.finish(
      { ...run, startedAt: new Date(run.startedAt) },
      { ...details, finishedAt: new Date(details.finishedAt) },
    );
    await repository.completeNotionAuditFinalization(entry.id);
    delivered += 1;
  } catch (error) {
    await repository.deferNotionAuditFinalization(
      entry.id,
      entry.attempts + 1,
      error instanceof Error ? error.message : "Audit retry failed",
    );
  }
}

console.log(
  JSON.stringify({
    event: "notion_audit_outbox_processed",
    attempted: entries.length,
    delivered,
  }),
);

import { createDatabaseClient } from "./database.js";
import { NewsRepository } from "./news-repository.js";
import {
  backfillNotionAudits,
  getNotionAuditConfig,
  NotionAuditLogger,
} from "./notion-audit.js";

const repository = new NewsRepository(createDatabaseClient());
const logger = new NotionAuditLogger(getNotionAuditConfig());
const result = await backfillNotionAudits(logger, repository);

console.log(
  JSON.stringify({
    event: "notion_audit_outbox_processed",
    ...result,
  }),
);

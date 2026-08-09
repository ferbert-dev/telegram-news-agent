import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { NotionAuditOutboxRepository } from "../database/repositories/notion-audit-outbox-repository.js";
import { PipelineLeasesRepository } from "../database/repositories/pipeline-leases-repository.js";
import {
  NOTION_AUDIT_OUTBOX_REPOSITORY,
  PIPELINE_LEASES_REPOSITORY,
} from "./operations.tokens.js";

@Module({
  imports: [DatabaseModule],
  providers: [
    PipelineLeasesRepository,
    NotionAuditOutboxRepository,
    {
      provide: PIPELINE_LEASES_REPOSITORY,
      useExisting: PipelineLeasesRepository,
    },
    {
      provide: NOTION_AUDIT_OUTBOX_REPOSITORY,
      useExisting: NotionAuditOutboxRepository,
    },
  ],
  exports: [
    PIPELINE_LEASES_REPOSITORY,
    NOTION_AUDIT_OUTBOX_REPOSITORY,
  ],
})
export class OperationsPersistenceModule {}

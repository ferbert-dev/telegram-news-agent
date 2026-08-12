import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";

import { NotionAuditDeliveryService } from "./application/notion-audit-delivery.service.js";
import { PipelineLeaseService } from "./application/pipeline-lease.service.js";
import type { NotionAuditGateway } from "./operations-application.contracts.js";
import {
  NOTION_AUDIT_DELIVERY_APPLICATION,
  NOTION_AUDIT_GATEWAY,
  PIPELINE_LEASE_APPLICATION,
} from "./operations-application.tokens.js";
import { OperationsPersistenceModule } from "./operations-persistence.module.js";

export type OperationsApplicationGateways = {
  notionAudit: NotionAuditGateway;
};

/**
 * Explicit composition boundary for finite operations use cases. The concrete
 * Notion transport remains outside this module and no worker loop is started.
 */
@Module({})
export class OperationsApplicationModule {
  static register(
    gateways: OperationsApplicationGateways,
  ): DynamicModule {
    return {
      module: OperationsApplicationModule,
      imports: [OperationsPersistenceModule],
      providers: [
        { provide: NOTION_AUDIT_GATEWAY, useValue: gateways.notionAudit },
        PipelineLeaseService,
        NotionAuditDeliveryService,
        {
          provide: PIPELINE_LEASE_APPLICATION,
          useExisting: PipelineLeaseService,
        },
        {
          provide: NOTION_AUDIT_DELIVERY_APPLICATION,
          useExisting: NotionAuditDeliveryService,
        },
      ],
      exports: [
        PIPELINE_LEASE_APPLICATION,
        NOTION_AUDIT_DELIVERY_APPLICATION,
      ],
    };
  }
}

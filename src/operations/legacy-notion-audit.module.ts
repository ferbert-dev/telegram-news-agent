import { Module, type DynamicModule } from "@nestjs/common";

import { NOTION_AUDIT_GATEWAY } from "./operations-application.tokens.js";
import {
  LegacyNotionAuditGateway,
  type LegacyNotionAuditFinalizer,
} from "./legacy-notion-audit.gateway.js";

@Module({})
export class LegacyNotionAuditModule {
  static register(
    finalizer: LegacyNotionAuditFinalizer,
    provideGateway: symbol = NOTION_AUDIT_GATEWAY,
  ): DynamicModule {
    const gatewayToken = provideGateway ?? NOTION_AUDIT_GATEWAY;
    return {
      module: LegacyNotionAuditModule,
      providers: [
        {
          provide: gatewayToken,
          useValue: new LegacyNotionAuditGateway(finalizer),
        },
      ],
      exports: [gatewayToken],
    };
  }
}

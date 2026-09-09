import { Module, type DynamicModule } from "@nestjs/common";

import { EvidenceCorroborationModule } from "./corroboration/evidence-corroboration.module.js";
import type { EvidenceCorroborationService } from "./corroboration/evidence-corroboration.service.js";
import { EVIDENCE_CORROBORATION } from "./corroboration/evidence-corroboration.tokens.js";
import { EDITORIAL_DRAFT_GATEWAY } from "./editorial-application.tokens.js";
import {
  LegacyEditorialDraftGateway,
  type LegacyEditorialDraftGatewayDependencies,
} from "./legacy-editorial-draft.gateway.js";

/**
 * Everything the draft gateway needs that a composition root actually owns.
 *
 * `corroboration` is not on this list: the service depends on nothing but its
 * own options, so there is no reason for a caller to build one. It comes from
 * `EvidenceCorroborationModule` through `EVIDENCE_CORROBORATION`, which is the
 * only place its budget and thresholds are decided.
 */
export type LegacyEditorialDraftGatewayModuleOptions = Omit<
  LegacyEditorialDraftGatewayDependencies,
  "corroboration"
>;

@Module({})
export class LegacyEditorialDraftGatewayModule {
  static register(
    dependencies: LegacyEditorialDraftGatewayModuleOptions,
    provide?: typeof EDITORIAL_DRAFT_GATEWAY,
  ): DynamicModule {
    const token = provide ?? EDITORIAL_DRAFT_GATEWAY;
    return {
      module: LegacyEditorialDraftGatewayModule,
      imports: [EvidenceCorroborationModule.register()],
      providers: [
        {
          provide: token,
          inject: [EVIDENCE_CORROBORATION],
          useFactory: (corroboration: EvidenceCorroborationService) =>
            new LegacyEditorialDraftGateway({ ...dependencies, corroboration }),
        },
      ],
      exports: [token],
    };
  }
}

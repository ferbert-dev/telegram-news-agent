import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";

import {
  DEFAULT_CORROBORATION_OPTIONS,
  EvidenceCorroborationService,
  type EvidenceCorroborationOptions,
} from "./evidence-corroboration.service.js";
import {
  EVIDENCE_CORROBORATION,
  EVIDENCE_CORROBORATION_OPTIONS,
} from "./evidence-corroboration.tokens.js";

@Module({})
export class EvidenceCorroborationModule {
  static register(
    options: Partial<EvidenceCorroborationOptions> = {},
  ): DynamicModule {
    return {
      module: EvidenceCorroborationModule,
      providers: [
        {
          provide: EVIDENCE_CORROBORATION_OPTIONS,
          useValue: { ...DEFAULT_CORROBORATION_OPTIONS, ...options },
        },
        EvidenceCorroborationService,
        {
          provide: EVIDENCE_CORROBORATION,
          useExisting: EvidenceCorroborationService,
        },
      ],
      exports: [EVIDENCE_CORROBORATION],
    };
  }
}

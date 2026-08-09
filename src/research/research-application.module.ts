import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";

import { CatalogPersistenceModule } from "../catalog/catalog-persistence.module.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import { ResearchService } from "./application/research.service.js";
import { RunResearchUseCase } from "./application/run-research.use-case.js";
import type {
  ResearchAiGateway,
  ResearchExecutionGateway,
  ResearchFetchGateway,
  ResearchSearchGateway,
} from "./research-gateway.contracts.js";
import {
  RESEARCH_AI_GATEWAY,
  RESEARCH_EXECUTION_GATEWAY,
  RESEARCH_FETCH_GATEWAY,
  RESEARCH_SEARCH_GATEWAY,
} from "./research-gateway.tokens.js";
import { ResearchPersistenceModule } from "./research-persistence.module.js";

export type ResearchApplicationGateways = {
  ai: ResearchAiGateway;
  search: ResearchSearchGateway;
  fetch: ResearchFetchGateway;
  execution: ResearchExecutionGateway;
};

/**
 * Explicit composition root for outbound research ports. No legacy or concrete
 * provider is selected until a later runtime-wiring ticket.
 */
@Module({})
export class ResearchApplicationModule {
  static register(gateways: ResearchApplicationGateways): DynamicModule {
    return {
      module: ResearchApplicationModule,
      imports: [
        CatalogPersistenceModule,
        ResearchPersistenceModule,
        UsagePersistenceModule,
      ],
      providers: [
        { provide: RESEARCH_AI_GATEWAY, useValue: gateways.ai },
        { provide: RESEARCH_SEARCH_GATEWAY, useValue: gateways.search },
        { provide: RESEARCH_FETCH_GATEWAY, useValue: gateways.fetch },
        { provide: RESEARCH_EXECUTION_GATEWAY, useValue: gateways.execution },
        RunResearchUseCase,
        ResearchService,
      ],
      exports: [
        RESEARCH_AI_GATEWAY,
        RESEARCH_SEARCH_GATEWAY,
        RESEARCH_FETCH_GATEWAY,
        RESEARCH_EXECUTION_GATEWAY,
        RunResearchUseCase,
        ResearchService,
      ],
    };
  }
}

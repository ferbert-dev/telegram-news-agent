import { Module, type DynamicModule, type Provider } from "@nestjs/common";

import type { CatalogPersistence } from "../catalog/catalog-persistence.js";
import { CatalogPersistenceModule } from "../catalog/catalog-persistence.module.js";
import { CATALOG_PERSISTENCE } from "../catalog/catalog-persistence.tokens.js";
import type { StoryDeduplicationPersistence } from "../story-deduplication/story-deduplication.contracts.js";
import { StoryDeduplicationPersistenceModule } from "../story-deduplication/story-deduplication-persistence.module.js";
import { STORY_DEDUPLICATION_PERSISTENCE } from "../story-deduplication/story-deduplication.tokens.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import { USAGE_REPORTING_PERSISTENCE } from "../usage/usage-persistence.tokens.js";
import type { ResearchIngestionPersistence } from "./research-persistence.contracts.js";
import { ResearchPersistenceModule } from "./research-persistence.module.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "./research-persistence.tokens.js";
import { RESEARCH_EXECUTION_GATEWAY } from "./research-gateway.tokens.js";
import {
  LegacyResearchExecutionGateway,
  type LegacyResearchExecutionDependencies,
} from "./legacy-research-execution.gateway.js";

@Module({})
export class LegacyResearchExecutionGatewayModule {
  static register(
    dependencies: LegacyResearchExecutionDependencies,
  ): DynamicModule {
    const gatewayProvider: Provider = {
      provide: RESEARCH_EXECUTION_GATEWAY,
      useFactory: (
        catalog: CatalogPersistence,
        research: ResearchIngestionPersistence,
        storyDeduplication: StoryDeduplicationPersistence,
        usage: UsageReportingPersistence,
      ) =>
        new LegacyResearchExecutionGateway(
          catalog,
          research,
          storyDeduplication,
          usage,
          dependencies,
        ),
      inject: [
        CATALOG_PERSISTENCE,
        RESEARCH_INGESTION_PERSISTENCE,
        STORY_DEDUPLICATION_PERSISTENCE,
        USAGE_REPORTING_PERSISTENCE,
      ],
    };

    return {
      module: LegacyResearchExecutionGatewayModule,
      imports: [
        CatalogPersistenceModule,
        ResearchPersistenceModule,
        StoryDeduplicationPersistenceModule,
        UsagePersistenceModule,
      ],
      providers: [gatewayProvider],
      exports: [RESEARCH_EXECUTION_GATEWAY],
    };
  }
}

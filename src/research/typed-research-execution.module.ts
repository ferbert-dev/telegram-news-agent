import { Module, type DynamicModule, type Provider } from "@nestjs/common";

import { CatalogPersistenceModule } from "../catalog/catalog-persistence.module.js";
import { AI_PROVIDER } from "../ai/ai-provider.tokens.js";
import type { FallbackAiProvider } from "../ai/ai-provider-composition.js";
import { StoryDeduplicationPersistenceModule } from "../story-deduplication/story-deduplication-persistence.module.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import { ResearchPersistenceModule } from "./research-persistence.module.js";
import { RESEARCH_EXECUTION_GATEWAY } from "./research-gateway.tokens.js";
import { SourceAcquisitionModule } from "./source-acquisition.module.js";
import { EvidenceCurationModule } from "./curation/evidence-curation.module.js";
import { FallbackSourceDiscoveryAdapter, FallbackStructuredGenerationAdapter } from "./research-ai-adapter.js";
import { TypedResearchExecutionGateway } from "./typed-research-execution.gateway.js";
import type { ArticleContentPort } from "./content/article-content.contracts.js";
import { ARTICLE_CONTENT_PORT } from "./content/article-content.tokens.js";

export type TypedResearchExecutionGatewayModuleOptions = {
  /**
   * A fully-constructed AI provider composition (see AiProvidersModule /
   * createFallbackAiProvider). Composed and owned by the caller — this
   * module does not decide how AI providers get built for the app, it only
   * consumes one, the same way every RESEARCH_EXECUTION_GATEWAY provider
   * takes its dependencies from the caller rather than constructing them.
   */
  aiProvider: FallbackAiProvider;
  /**
   * Optional. Absent, the gateway extracts exactly as it did before, so this
   * module can ship before any content provider is configured.
   */
  articleContent?: ArticleContentPort | null;
};

@Module({})
export class TypedResearchExecutionGatewayModule {
  static register({
    aiProvider,
    articleContent = null,
  }: TypedResearchExecutionGatewayModuleOptions): DynamicModule {
    const gatewayProvider: Provider = {
      provide: RESEARCH_EXECUTION_GATEWAY,
      useClass: TypedResearchExecutionGateway,
    };

    return {
      module: TypedResearchExecutionGatewayModule,
      imports: [
        CatalogPersistenceModule,
        ResearchPersistenceModule,
        StoryDeduplicationPersistenceModule,
        UsagePersistenceModule,
        SourceAcquisitionModule.register(new FallbackSourceDiscoveryAdapter(aiProvider)),
        EvidenceCurationModule.register({ structuredGeneration: new FallbackStructuredGenerationAdapter(aiProvider) }),
      ],
      providers: [
        gatewayProvider,
        { provide: AI_PROVIDER, useValue: aiProvider },
        { provide: ARTICLE_CONTENT_PORT, useValue: articleContent },
      ],
      exports: [RESEARCH_EXECUTION_GATEWAY],
    };
  }
}

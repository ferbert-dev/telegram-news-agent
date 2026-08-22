import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ResearchIngestionRepository } from "../database/repositories/research-ingestion-repository.js";
import { AiProviderAttemptsRepository } from "../database/repositories/ai-provider-attempts-repository.js";
import type { AiProviderAttemptsPersistence } from "../ai-provider-attempts-persistence.contracts.js";
import { AI_PROVIDER_ATTEMPTS_PERSISTENCE } from "../ai-provider-attempts-persistence.tokens.js";
import type { ResearchIngestionPersistence } from "./research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "./research-persistence.tokens.js";

const researchPersistenceProvider: Provider<ResearchIngestionPersistence> = {
  provide: RESEARCH_INGESTION_PERSISTENCE,
  useExisting: ResearchIngestionRepository,
};

const aiProviderAttemptsPersistenceProvider: Provider<AiProviderAttemptsPersistence> = {
  provide: AI_PROVIDER_ATTEMPTS_PERSISTENCE,
  useExisting: AiProviderAttemptsRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [ResearchIngestionRepository, AiProviderAttemptsRepository, researchPersistenceProvider, aiProviderAttemptsPersistenceProvider],
  exports: [RESEARCH_INGESTION_PERSISTENCE, AI_PROVIDER_ATTEMPTS_PERSISTENCE],
})
export class ResearchPersistenceModule {}

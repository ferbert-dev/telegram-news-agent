import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { ResearchIngestionRepository } from "../database/repositories/research-ingestion-repository.js";
import type { ResearchIngestionPersistence } from "./research-persistence.contracts.js";
import { RESEARCH_INGESTION_PERSISTENCE } from "./research-persistence.tokens.js";

const researchPersistenceProvider: Provider<ResearchIngestionPersistence> = {
  provide: RESEARCH_INGESTION_PERSISTENCE,
  useExisting: ResearchIngestionRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [ResearchIngestionRepository, researchPersistenceProvider],
  exports: [RESEARCH_INGESTION_PERSISTENCE],
})
export class ResearchPersistenceModule {}

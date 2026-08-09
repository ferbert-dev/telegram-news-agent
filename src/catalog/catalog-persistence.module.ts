import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { SourcesRepository } from "../database/repositories/sources-repository.js";
import type { CatalogPersistence } from "./catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "./catalog-persistence.tokens.js";

const catalogPersistenceProvider: Provider<CatalogPersistence> = {
  provide: CATALOG_PERSISTENCE,
  useExisting: SourcesRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [SourcesRepository, catalogPersistenceProvider],
  exports: [CATALOG_PERSISTENCE],
})
export class CatalogPersistenceModule {}

import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { EditorialRepository } from "../database/repositories/editorial-repository.js";
import type { EditorialPersistence } from "./editorial-persistence.contracts.js";
import { EDITORIAL_PERSISTENCE } from "./editorial-persistence.tokens.js";

const editorialPersistenceProvider: Provider<EditorialPersistence> = {
  provide: EDITORIAL_PERSISTENCE,
  useExisting: EditorialRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [EditorialRepository, editorialPersistenceProvider],
  exports: [EDITORIAL_PERSISTENCE],
})
export class EditorialPersistenceModule {}

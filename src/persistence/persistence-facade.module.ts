import { Module, type Provider } from "@nestjs/common";

import { CatalogPersistenceModule } from "../catalog/catalog-persistence.module.js";
import { EditorialPersistenceModule } from "../editorial/editorial-persistence.module.js";
import { OperationsPersistenceModule } from "../operations/operations-persistence.module.js";
import { ResearchPersistenceModule } from "../research/research-persistence.module.js";
import { SchedulerPersistenceModule } from "../scheduler/scheduler-persistence.module.js";
import { SettingsPersistenceModule } from "../settings/settings-persistence.module.js";
import { TelegramPersistenceModule } from "../telegram/telegram-persistence.module.js";
import { UsagePersistenceModule } from "../usage/usage-persistence.module.js";
import type { LegacyPersistence } from "./legacy-persistence.contracts.js";
import { LegacyPersistenceFacade } from "./legacy-persistence.facade.js";
import { LEGACY_PERSISTENCE } from "./legacy-persistence.tokens.js";

const legacyPersistenceProvider: Provider<LegacyPersistence> = {
  provide: LEGACY_PERSISTENCE,
  useExisting: LegacyPersistenceFacade,
};

@Module({
  imports: [
    CatalogPersistenceModule,
    ResearchPersistenceModule,
    EditorialPersistenceModule,
    UsagePersistenceModule,
    OperationsPersistenceModule,
    SettingsPersistenceModule,
    SchedulerPersistenceModule,
    TelegramPersistenceModule,
  ],
  providers: [LegacyPersistenceFacade, legacyPersistenceProvider],
  exports: [LEGACY_PERSISTENCE],
})
export class PersistenceFacadeModule {}

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { SchedulerRepository } from "../database/repositories/scheduler-repository.js";
import type { SchedulerPersistence } from "./scheduler-persistence.contracts.js";
import { SCHEDULER_PERSISTENCE } from "./scheduler-persistence.tokens.js";

const schedulerPersistenceProvider: Provider<SchedulerPersistence> = {
  provide: SCHEDULER_PERSISTENCE,
  useExisting: SchedulerRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [SchedulerRepository, schedulerPersistenceProvider],
  exports: [SCHEDULER_PERSISTENCE],
})
export class SchedulerPersistenceModule {}

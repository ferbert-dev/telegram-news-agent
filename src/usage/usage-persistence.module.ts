import "reflect-metadata";

import { Module, type Provider } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { UsageReportingRepository } from "../database/repositories/usage-reporting-repository.js";
import type { UsageReportingPersistence } from "./usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "./usage-persistence.tokens.js";

const usageReportingProvider: Provider<UsageReportingPersistence> = {
  provide: USAGE_REPORTING_PERSISTENCE,
  useExisting: UsageReportingRepository,
};

@Module({
  imports: [DatabaseModule],
  providers: [UsageReportingRepository, usageReportingProvider],
  exports: [USAGE_REPORTING_PERSISTENCE],
})
export class UsagePersistenceModule {}

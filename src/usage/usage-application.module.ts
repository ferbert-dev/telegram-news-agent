import "reflect-metadata";

import { Module } from "@nestjs/common";

import { UsageDashboardService } from "./application/usage-dashboard.service.js";
import { UsagePersistenceModule } from "./usage-persistence.module.js";

@Module({
  imports: [UsagePersistenceModule],
  providers: [UsageDashboardService],
  exports: [UsageDashboardService],
})
export class UsageApplicationModule {}

import { Inject, Injectable } from "@nestjs/common";

import type {
  DailyUsageDashboard,
  UsageReportingPersistence,
} from "../usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../usage-persistence.tokens.js";
import { GetDailyUsageDashboardQuery } from "./get-daily-usage-dashboard.query.js";

@Injectable()
export class UsageDashboardService {
  constructor(
    @Inject(USAGE_REPORTING_PERSISTENCE)
    private readonly usageReporting: UsageReportingPersistence,
  ) {}

  execute(
    query: GetDailyUsageDashboardQuery,
  ): Promise<DailyUsageDashboard> {
    return this.usageReporting.getDailyUsageDashboard(query);
  }
}

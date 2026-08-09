import type { GetDailyUsageDashboardInput } from "../usage-persistence.contracts.js";

/**
 * Read-only application query for the daily usage dashboard.
 *
 * Values intentionally keep the persistence contract's exact types so the
 * PostgreSQL adapter remains responsible for timezone boundaries, safe bigint
 * conversion, and decimal-string money values.
 */
export class GetDailyUsageDashboardQuery
  implements GetDailyUsageDashboardInput
{
  readonly channelId: string;
  readonly now?: string | Date;
  readonly timeZone?: string;
  readonly postLimit?: number;

  constructor(input: GetDailyUsageDashboardInput) {
    this.channelId = input.channelId;
    this.now = input.now;
    this.timeZone = input.timeZone;
    this.postLimit = input.postLimit;
  }
}

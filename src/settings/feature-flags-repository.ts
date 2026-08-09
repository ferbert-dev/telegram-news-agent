import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../database/database.tokens.js";
import type { DrizzleDatabase } from "../database/drizzle-client.js";
import {
  postgresRows,
  RepositorySupport,
} from "../database/repositories/repository-support.js";
import { newsFeatureFlags } from "../database/schema/settings.js";
import type {
  GetOrCreateNewsFeatureFlagsInput,
  NewsFeatureFlagRow,
  NewsFeatureFlagsPersistence,
  UpdateNewsFeatureFlagInput,
} from "./settings.contracts.js";
import {
  mapNewsFeatureFlagRow,
  type NewsFeatureFlagDatabaseRow,
} from "./settings-row-mappers.js";

const newsFeatureFlagSelection = {
  telegram_channel_id: newsFeatureFlags.telegramChannelId,
  feature_key: newsFeatureFlags.featureKey,
  state: newsFeatureFlags.state,
  config: newsFeatureFlags.config,
  version: newsFeatureFlags.version,
  updated_by: newsFeatureFlags.updatedBy,
  created_at: newsFeatureFlags.createdAt,
  updated_at: newsFeatureFlags.updatedAt,
};

const getOrCreateNewsFeatureFlagsFunction =
  postgresRows<NewsFeatureFlagDatabaseRow>(
    "public.get_or_create_news_feature_flags",
    2,
  );
const updateNewsFeatureFlagFunction =
  postgresRows<NewsFeatureFlagDatabaseRow>(
    "public.update_news_feature_flag",
    5,
  );

@Injectable()
export class FeatureFlagsRepository
  extends RepositorySupport
  implements NewsFeatureFlagsPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async getOrCreateNewsFeatureFlags({
    channelId,
    updatedBy,
  }: GetOrCreateNewsFeatureFlagsInput): Promise<NewsFeatureFlagRow[]> {
    const rows = await this.functionRows(
      "Get or create news feature flags",
      getOrCreateNewsFeatureFlagsFunction,
      [channelId, updatedBy],
    );
    return rows.map(mapNewsFeatureFlagRow);
  }

  async getNewsFeatureFlags(
    channelId: string,
  ): Promise<NewsFeatureFlagRow[]> {
    const rows = await this.operation("Get news feature flags", () =>
      this.database
        .select(newsFeatureFlagSelection)
        .from(newsFeatureFlags)
        .where(eq(newsFeatureFlags.telegramChannelId, channelId.trim()))
        .orderBy(asc(newsFeatureFlags.featureKey)),
    );
    return rows.map(mapNewsFeatureFlagRow);
  }

  async updateNewsFeatureFlag({
    channelId,
    featureKey,
    state,
    updatedBy,
    expectedVersion,
  }: UpdateNewsFeatureFlagInput): Promise<NewsFeatureFlagRow | null> {
    const rows = await this.functionRows(
      "Update news feature flag",
      updateNewsFeatureFlagFunction,
      [channelId, featureKey, state, updatedBy, expectedVersion],
    );
    const row = this.optionalOne(rows, "Update news feature flag");
    return row === null ? null : mapNewsFeatureFlagRow(row);
  }
}

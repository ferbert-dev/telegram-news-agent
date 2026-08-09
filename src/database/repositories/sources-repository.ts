import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Pool } from "pg";

import type {
  ArticleTagRow,
  CatalogPersistence,
  CompleteSourceDiscoveryInput,
  SourceRow,
  SourceWithTopics,
  UpsertDiscoveredSourceInput,
  UpsertSourceInput,
} from "../../catalog/catalog-persistence.js";
import {
  sourceTopics,
  sources,
  topicTranslations,
  topics,
} from "../schema/catalog.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import {
  postgresRows,
  postgresScalar,
  RepositorySupport,
  timestamp,
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "./repository-support.js";

export type {
  ArticleTagRow,
  CompleteSourceDiscoveryInput,
  SourceRow,
  SourceWithTopics,
  UpsertDiscoveredSourceInput,
  UpsertSourceInput,
} from "../../catalog/catalog-persistence.js";

type SourceTimestampFields = {
  last_checked_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  last_success_at: string | Date | null;
  last_failed_at: string | Date | null;
  disabled_until: string | Date | null;
};

export type SourceDatabaseRow = Omit<
  SourceRow,
  keyof SourceTimestampFields
> & SourceTimestampFields;

type CanonicalSourceRow<T extends SourceDatabaseRow> = Omit<
  T,
  keyof SourceTimestampFields
> & SourceRow;

/**
 * Canonical typed repository boundary: normalize only the six named timestamp
 * fields and preserve every other value, including JSON metadata. The later
 * legacy facade owns any external legacy timestamp adaptation that is required.
 */
export function mapSourceRow<T extends SourceDatabaseRow>(
  row: T,
): CanonicalSourceRow<T> {
  return {
    ...row,
    last_checked_at: toNullableIsoTimestamp(row.last_checked_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    last_success_at: toNullableIsoTimestamp(row.last_success_at),
    last_failed_at: toNullableIsoTimestamp(row.last_failed_at),
    disabled_until: toNullableIsoTimestamp(row.disabled_until),
  };
}

type ArticleTagDatabaseRow = {
  topicId: string;
  code: string;
  description: string | null;
  languageCode: string;
  label: string;
  hashtag: string;
};

function mapArticleTagRow(row: ArticleTagDatabaseRow): ArticleTagRow {
  return {
    topic_id: row.topicId,
    code: row.code,
    description: row.description,
    language_code: row.languageCode,
    label: row.label,
    hashtag: row.hashtag,
  };
}

const sourceSelection = {
  id: sources.id,
  name: sources.name,
  homepage_url: sources.homepageUrl,
  feed_url: sources.feedUrl,
  source_type: sources.sourceType,
  reliability_score: sources.reliabilityScore,
  enabled: sources.enabled,
  last_checked_at: sources.lastCheckedAt,
  created_at: sources.createdAt,
  updated_at: sources.updatedAt,
  is_primary: sources.isPrimary,
  last_success_at: sources.lastSuccessAt,
  last_failed_at: sources.lastFailedAt,
  consecutive_failures: sources.consecutiveFailures,
  last_error_code: sources.lastErrorCode,
  disabled_until: sources.disabledUntil,
  discovered_by: sources.discoveredBy,
  discovery_metadata: sources.discoveryMetadata,
};

const markSourceFetchSuccessFunction = postgresRows<SourceDatabaseRow>(
  "public.mark_source_fetch_success",
  1,
);
const markSourceFetchFailureFunction = postgresRows<SourceDatabaseRow>(
  "public.mark_source_fetch_failure",
  2,
);
const claimSourceDiscoveryFunction = postgresScalar<boolean>(
  "public.claim_source_discovery",
  1,
);
const completeSourceDiscoveryFunction = postgresScalar<boolean>(
  "public.complete_source_discovery",
  5,
);
const upsertDiscoveredSourceFunction = postgresRows<SourceDatabaseRow>(
  "public.upsert_discovered_source",
  7,
);

@Injectable()
export class SourcesRepository
  extends RepositorySupport
  implements CatalogPersistence
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  private topicsBySource() {
    return this.database
      .select({
        sourceId: sourceTopics.sourceId,
        topicCodes: sql<string[]>`array_agg(${topics.name} order by ${topics.name})`.as(
          "topic_codes",
        ),
      })
      .from(sourceTopics)
      .innerJoin(topics, eq(topics.id, sourceTopics.topicId))
      .where(eq(topics.enabled, true))
      .groupBy(sourceTopics.sourceId)
      .as("topics_by_source");
  }

  async listEnabledSources(): Promise<SourceWithTopics[]> {
    const topicsBySource = this.topicsBySource();
    return this.operation("List enabled sources", async () => {
      const rows = await this.database
        .select({
          ...sourceSelection,
          topic_codes: sql<string[]>`coalesce(${topicsBySource.topicCodes}, '{}'::text[])`,
        })
        .from(sources)
        .leftJoin(
          topicsBySource,
          eq(topicsBySource.sourceId, sources.id),
        )
        .where(
          and(
            eq(sources.enabled, true),
            or(
              isNull(sources.disabledUntil),
              lte(sources.disabledUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(
          sql`${sources.reliabilityScore} desc nulls last`,
          asc(sources.name),
        );
      return rows.map(mapSourceRow);
    });
  }

  async listEnabledArticleTags(
    languageCode: string,
  ): Promise<ArticleTagRow[]> {
    return this.operation("List enabled article tags", async () => {
      const rows = await this.database
        .select({
          topicId: topics.id,
          code: topics.name,
          description: topics.description,
          languageCode: topicTranslations.languageCode,
          label: topicTranslations.label,
          hashtag: topicTranslations.hashtag,
        })
        .from(topics)
        .innerJoin(
          topicTranslations,
          eq(topicTranslations.topicId, topics.id),
        )
        .where(
          and(
            eq(topics.enabled, true),
            eq(
              topicTranslations.languageCode,
              sql<string>`lower(btrim(${languageCode}))`,
            ),
          ),
        )
        .orderBy(asc(topics.name));
      return rows.map(mapArticleTagRow);
    });
  }

  async listSourceHealth(): Promise<SourceWithTopics[]> {
    const topicsBySource = this.topicsBySource();
    return this.operation("List source health", async () => {
      const rows = await this.database
        .select({
          ...sourceSelection,
          topic_codes: sql<string[]>`coalesce(${topicsBySource.topicCodes}, '{}'::text[])`,
        })
        .from(sources)
        .leftJoin(
          topicsBySource,
          eq(topicsBySource.sourceId, sources.id),
        )
        .orderBy(
          sql`${sources.enabled} desc`,
          sql`${sources.disabledUntil} nulls first`,
          sql`${sources.reliabilityScore} desc nulls last`,
          asc(sources.name),
        );
      return rows.map(mapSourceRow);
    });
  }

  async upsertSource(input: UpsertSourceInput): Promise<SourceRow> {
    const updatedAt = timestamp();
    const values: typeof sources.$inferInsert = {
      name: input.name,
      feedUrl: input.feed_url,
      sourceType: input.source_type,
      updatedAt,
    };
    const updates: Partial<typeof sources.$inferInsert> = {
      name: input.name,
      sourceType: input.source_type,
      updatedAt,
    };

    if (input.homepage_url !== undefined) {
      values.homepageUrl = input.homepage_url;
      updates.homepageUrl = input.homepage_url;
    }
    if (input.reliability_score !== undefined) {
      values.reliabilityScore = input.reliability_score;
      updates.reliabilityScore = input.reliability_score;
    }
    if (input.enabled !== undefined) {
      values.enabled = input.enabled;
      updates.enabled = input.enabled;
    }
    if (input.is_primary !== undefined) {
      values.isPrimary = input.is_primary;
      updates.isPrimary = input.is_primary;
    }
    if (input.last_checked_at !== undefined) {
      values.lastCheckedAt = input.last_checked_at;
      updates.lastCheckedAt = input.last_checked_at;
    }

    const rows = await this.operation("Upsert source", () =>
      this.database
        .insert(sources)
        .values(values)
        .onConflictDoUpdate({
          target: sources.feedUrl,
          set: updates,
        })
        .returning(sourceSelection),
    );
    return mapSourceRow(this.one(rows, "Upsert source"));
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<SourceRow> {
    const operation = `${enabled ? "Enable" : "Disable"} source`;
    const rows = await this.operation(operation, () =>
      this.database
        .update(sources)
        .set({ enabled, updatedAt: timestamp() })
        .where(eq(sources.id, id))
        .returning(sourceSelection),
    );
    return mapSourceRow(this.one(rows, operation));
  }

  async markSourceChecked(id: string): Promise<SourceRow> {
    const checkedAt = timestamp();
    const rows = await this.operation("Mark source checked", () =>
      this.database
        .update(sources)
        .set({ lastCheckedAt: checkedAt, updatedAt: checkedAt })
        .where(eq(sources.id, id))
        .returning(sourceSelection),
    );
    return mapSourceRow(this.one(rows, "Mark source checked"));
  }

  async markSourceFetchSuccess(id: string): Promise<SourceRow> {
    const rows = await this.functionRows<SourceDatabaseRow>(
      "Mark source fetch success",
      markSourceFetchSuccessFunction,
      [id],
    );
    return mapSourceRow(this.one(rows, "Mark source fetch success"));
  }

  async markSourceFetchFailure(
    id: string,
    errorCode: string,
  ): Promise<SourceRow> {
    const rows = await this.functionRows<SourceDatabaseRow>(
      "Mark source fetch failure",
      markSourceFetchFailureFunction,
      [id, errorCode],
    );
    return mapSourceRow(this.one(rows, "Mark source fetch failure"));
  }

  async claimSourceDiscovery(topicKey: string): Promise<boolean> {
    return this.functionScalar(
      "Claim source discovery",
      claimSourceDiscoveryFunction,
      [topicKey],
    );
  }

  async completeSourceDiscovery({
    topicKey,
    provider = null,
    model = null,
    resultCount = 0,
    errorCode = null,
  }: CompleteSourceDiscoveryInput): Promise<boolean> {
    return this.functionScalar(
      "Complete source discovery",
      completeSourceDiscoveryFunction,
      [topicKey, provider, model, resultCount, errorCode],
    );
  }

  async upsertDiscoveredSource({
    name,
    homepageUrl,
    feedUrl,
    reliabilityScore = 65,
    topicCodes: requestedTopicCodes = [],
    discoveredBy,
    discoveryMetadata = {},
  }: UpsertDiscoveredSourceInput): Promise<SourceRow> {
    const rows = await this.functionRows<SourceDatabaseRow>(
      "Upsert discovered source",
      upsertDiscoveredSourceFunction,
      [
        name,
        homepageUrl,
        feedUrl,
        reliabilityScore,
        requestedTopicCodes,
        discoveredBy,
        discoveryMetadata,
      ],
    );
    return mapSourceRow(this.one(rows, "Upsert discovered source"));
  }
}

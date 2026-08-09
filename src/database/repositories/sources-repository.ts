import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Pool, QueryResult, QueryResultRow } from "pg";

import {
  sourceTopics,
  sources,
  topics,
} from "../schema/catalog.js";
import {
  createDrizzleDatabase,
  type DrizzleDatabase,
} from "../drizzle-client.js";

export type SourceRow = {
  id: string;
  name: string;
  homepage_url: string | null;
  feed_url: string | null;
  source_type: string;
  reliability_score: number | null;
  enabled: boolean;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
  is_primary: boolean;
  last_success_at: string | null;
  last_failed_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  disabled_until: string | null;
  discovered_by: string;
  discovery_metadata: Record<string, unknown>;
};

export type SourceWithTopics = SourceRow & {
  topic_codes: string[];
};

export type UpsertSourceInput = {
  name: string;
  feed_url: string;
  source_type: string;
  homepage_url?: string | null;
  reliability_score?: number | null;
  enabled?: boolean;
  is_primary?: boolean;
  last_checked_at?: string | null;
};

export type CompleteSourceDiscoveryInput = {
  topicKey: string;
  provider?: string | null;
  model?: string | null;
  resultCount?: number;
  errorCode?: string | null;
};

export type UpsertDiscoveredSourceInput = {
  name: string;
  homepageUrl: string | null;
  feedUrl: string;
  reliabilityScore?: number;
  topicCodes?: string[];
  discoveredBy: string;
  discoveryMetadata?: Record<string, unknown>;
};

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

function timestamp() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class SourcesRepository {
  readonly database: DrizzleDatabase;

  constructor(
    private readonly pool: Pool,
    database?: DrizzleDatabase,
  ) {
    if (!pool?.query) {
      throw new Error("A PostgreSQL pool is required");
    }
    this.database = database ?? createDrizzleDatabase(pool);
  }

  private async operation<T>(name: string, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw new Error(`${name} failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  private one<T>(rows: T[], operation: string): T {
    if (rows.length !== 1) {
      throw new Error(
        `${operation} failed: expected one row, received ${rows.length}`,
      );
    }
    return rows[0];
  }

  private async functionRows<T extends QueryResultRow>(
    operation: string,
    text: string,
    parameters: unknown[],
  ): Promise<T[]> {
    const result = await this.operation<QueryResult<T>>(
      operation,
      () => this.pool.query<T>(text, parameters),
    );
    return result.rows;
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
    return this.operation("List enabled sources", () =>
      this.database
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
        ),
    );
  }

  async listSourceHealth(): Promise<SourceWithTopics[]> {
    const topicsBySource = this.topicsBySource();
    return this.operation("List source health", () =>
      this.database
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
        ),
    );
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
    return this.one(rows, "Upsert source");
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
    return this.one(rows, operation);
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
    return this.one(rows, "Mark source checked");
  }

  async markSourceFetchSuccess(id: string): Promise<SourceRow> {
    const rows = await this.functionRows<SourceRow>(
      "Mark source fetch success",
      "select * from public.mark_source_fetch_success($1)",
      [id],
    );
    return this.one(rows, "Mark source fetch success");
  }

  async markSourceFetchFailure(
    id: string,
    errorCode: string,
  ): Promise<SourceRow> {
    const rows = await this.functionRows<SourceRow>(
      "Mark source fetch failure",
      "select * from public.mark_source_fetch_failure($1, $2)",
      [id, errorCode],
    );
    return this.one(rows, "Mark source fetch failure");
  }

  async claimSourceDiscovery(topicKey: string): Promise<boolean> {
    const rows = await this.functionRows<{ value: boolean }>(
      "Claim source discovery",
      "select public.claim_source_discovery($1) as value",
      [topicKey],
    );
    return this.one(rows, "Claim source discovery").value;
  }

  async completeSourceDiscovery({
    topicKey,
    provider = null,
    model = null,
    resultCount = 0,
    errorCode = null,
  }: CompleteSourceDiscoveryInput): Promise<boolean> {
    const rows = await this.functionRows<{ value: boolean }>(
      "Complete source discovery",
      "select public.complete_source_discovery($1, $2, $3, $4, $5) as value",
      [topicKey, provider, model, resultCount, errorCode],
    );
    return this.one(rows, "Complete source discovery").value;
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
    const rows = await this.functionRows<SourceRow>(
      "Upsert discovered source",
      "select * from public.upsert_discovered_source($1, $2, $3, $4, $5, $6, $7)",
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
    return this.one(rows, "Upsert discovered source");
  }
}

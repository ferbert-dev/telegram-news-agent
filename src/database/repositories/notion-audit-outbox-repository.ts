import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import {
  type EnqueueNotionAuditBackfillInput,
  type NotionAuditOutboxRepositoryPort,
  type NotionAuditOutboxRow,
} from "../../operations/operations.interfaces.js";
import { DRIZZLE_DB, PG_POOL } from "../database.tokens.js";
import type { DrizzleDatabase } from "../drizzle-client.js";
import { notionAuditOutbox } from "../schema/operations.js";
import {
  postgresRows,
  postgresScalar,
  RepositorySupport,
  toIsoTimestamp,
  toNullableIsoTimestamp,
} from "./repository-support.js";

type NotionAuditOutboxTimestampFields = {
  available_at: string | Date;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  claimed_at: string | Date | null;
};

export type NotionAuditOutboxDatabaseRow = Omit<
  NotionAuditOutboxRow,
  keyof NotionAuditOutboxTimestampFields
> & NotionAuditOutboxTimestampFields;

export function mapNotionAuditOutboxRow(
  row: NotionAuditOutboxDatabaseRow,
): NotionAuditOutboxRow {
  return {
    ...row,
    available_at: toIsoTimestamp(row.available_at),
    completed_at: toNullableIsoTimestamp(row.completed_at),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
    claimed_at: toNullableIsoTimestamp(row.claimed_at),
  };
}

const notionAuditOutboxSelection = {
  id: notionAuditOutbox.id,
  notion_page_id: notionAuditOutbox.notionPageId,
  event_type: notionAuditOutbox.eventType,
  payload: notionAuditOutbox.payload,
  last_error: notionAuditOutbox.lastError,
  attempt_count: notionAuditOutbox.attemptCount,
  available_at: notionAuditOutbox.availableAt,
  completed_at: notionAuditOutbox.completedAt,
  created_at: notionAuditOutbox.createdAt,
  updated_at: notionAuditOutbox.updatedAt,
  claimed_at: notionAuditOutbox.claimedAt,
};

const claimNotionAuditBackfillFunction =
  postgresRows<NotionAuditOutboxDatabaseRow>(
    "public.claim_notion_audit_backfill",
    1,
  );
const completeNotionAuditBackfillFunction = postgresScalar<boolean>(
  "public.complete_notion_audit_backfill",
  1,
);
const retryNotionAuditBackfillFunction = postgresScalar<boolean>(
  "public.retry_notion_audit_backfill",
  2,
);

@Injectable()
export class NotionAuditOutboxRepository
  extends RepositorySupport
  implements NotionAuditOutboxRepositoryPort
{
  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(DRIZZLE_DB) database: DrizzleDatabase,
  ) {
    super(pool, database);
  }

  async enqueueNotionAuditBackfill(
    record: EnqueueNotionAuditBackfillInput,
  ): Promise<NotionAuditOutboxRow> {
    const values: typeof notionAuditOutbox.$inferInsert = {
      notionPageId: record.notion_page_id,
      eventType: record.event_type,
      payload: record.payload,
      lastError: record.last_error,
    };
    const updates: Partial<typeof notionAuditOutbox.$inferInsert> = {
      payload: record.payload,
      lastError: record.last_error,
    };

    if (record.attempt_count !== undefined) {
      values.attemptCount = record.attempt_count;
      updates.attemptCount = record.attempt_count;
    }
    if (record.available_at !== undefined) {
      const availableAt = toIsoTimestamp(record.available_at);
      values.availableAt = availableAt;
      updates.availableAt = availableAt;
    }
    if (record.completed_at !== undefined) {
      const completedAt = toNullableIsoTimestamp(record.completed_at);
      values.completedAt = completedAt;
      updates.completedAt = completedAt;
    }
    if (record.claimed_at !== undefined) {
      const claimedAt = toNullableIsoTimestamp(record.claimed_at);
      values.claimedAt = claimedAt;
      updates.claimedAt = claimedAt;
    }

    const rows = await this.operation("Enqueue Notion audit backfill", () =>
      this.database
        .insert(notionAuditOutbox)
        .values(values)
        .onConflictDoUpdate({
          target: [
            notionAuditOutbox.notionPageId,
            notionAuditOutbox.eventType,
          ],
          set: updates,
        })
        .returning(notionAuditOutboxSelection),
    );
    return mapNotionAuditOutboxRow(
      this.one(rows, "Enqueue Notion audit backfill"),
    );
  }

  async claimNotionAuditBackfill(
    limit = 25,
  ): Promise<NotionAuditOutboxRow[]> {
    const rows = await this.functionRows(
      "Claim Notion audit backfill",
      claimNotionAuditBackfillFunction,
      [limit],
    );
    return rows.map(mapNotionAuditOutboxRow);
  }

  completeNotionAuditBackfill(id: string): Promise<boolean> {
    return this.functionScalar(
      "Complete Notion audit backfill",
      completeNotionAuditBackfillFunction,
      [id],
    );
  }

  retryNotionAuditBackfill(id: string, error: unknown): Promise<boolean> {
    return this.functionScalar(
      "Retry Notion audit backfill",
      retryNotionAuditBackfillFunction,
      [id, error instanceof Error ? error.message : String(error)],
    );
  }
}

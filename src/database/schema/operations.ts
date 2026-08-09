import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { type JsonObject, timestampWithTimezone } from "./common.js";

export const pipelineLeases = pgTable("pipeline_leases", {
  name: text("name").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  acquiredAt: timestampWithTimezone("acquired_at").defaultNow().notNull(),
  expiresAt: timestampWithTimezone("expires_at").notNull(),
}).enableRLS();

export const notionAuditOutbox = pgTable(
  "notion_audit_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notionPageId: text("notion_page_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    lastError: text("last_error").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    availableAt: timestampWithTimezone("available_at").defaultNow().notNull(),
    completedAt: timestampWithTimezone("completed_at"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    claimedAt: timestampWithTimezone("claimed_at"),
  },
  (table) => [
    unique("notion_audit_outbox_notion_page_id_event_type_key").on(
      table.notionPageId,
      table.eventType,
    ),
    check(
      "notion_audit_outbox_event_type_check",
      sql`${table.eventType} in ('finalize_success')`,
    ),
    check(
      "notion_audit_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    index("notion_audit_outbox_pending_idx")
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.completedAt} is null`),
  ],
).enableRLS();

export const schemaMigrations = pgTable("schema_migrations", {
  filename: text("filename").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestampWithTimezone("applied_at").defaultNow().notNull(),
});

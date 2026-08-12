import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { type JsonObject, timestampWithTimezone } from "./common.js";
import { drafts } from "./editorial.js";

export const telegramReviewSessions = pgTable(
  "telegram_review_sessions",
  {
    id: text("id").primaryKey(),
    draftId: uuid("draft_id")
      .notNull()
      .unique()
      .references(() => drafts.id, { onDelete: "restrict" }),
    controlChatId: bigint("control_chat_id", { mode: "number" }).notNull(),
    previewMessageId: bigint("preview_message_id", {
      mode: "number",
    }).notNull(),
    requestedBy: bigint("requested_by", { mode: "number" }).notNull(),
    decision: text("decision"),
    decidedBy: bigint("decided_by", { mode: "number" }),
    decidedAt: timestampWithTimezone("decided_at"),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    telegramChannelId: text("telegram_channel_id"),
  },
  (table) => [
    check(
      "telegram_review_sessions_id_check",
      sql`length(${table.id}) between 32 and 64`,
    ),
    check(
      "telegram_review_sessions_decision_check",
      sql`${table.decision} in ('publish', 'reject')`,
    ),
    index("telegram_review_sessions_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.decision} is null`),
    index("telegram_review_sessions_pending_channel_idx")
      .on(table.telegramChannelId, table.expiresAt)
      .where(sql`${table.decision} is null`),
  ],
).enableRLS();

export const telegramUpdates = pgTable(
  "telegram_updates",
  {
    updateId: bigint("update_id", { mode: "number" }).primaryKey(),
    updateKind: text("update_kind").notNull(),
    status: text("status").default("processing").notNull(),
    receivedAt: timestampWithTimezone("received_at").defaultNow().notNull(),
    completedAt: timestampWithTimezone("completed_at"),
    errorCode: text("error_code"),
    claimToken: uuid("claim_token").defaultRandom().notNull(),
    claimedAt: timestampWithTimezone("claimed_at").defaultNow().notNull(),
    failureCount: integer("failure_count").default(0).notNull(),
    lastErrorAt: timestampWithTimezone("last_error_at"),
    quarantinedAt: timestampWithTimezone("quarantined_at"),
  },
  (table) => [
    check(
      "telegram_updates_status_check",
      sql`${table.status} in ('processing', 'completed', 'failed', 'quarantined')`,
    ),
    check(
      "telegram_updates_failure_count_check",
      sql`${table.failureCount} >= 0`,
    ),
    check(
      "telegram_updates_quarantine_metadata_check",
      sql`(${table.status} = 'quarantined') = (${table.quarantinedAt} is not null)`,
    ),
    index("telegram_updates_stale_processing_idx")
      .on(table.claimedAt)
      .where(sql`${table.status} = 'processing'`),
    index("telegram_updates_quarantined_at_idx")
      .on(table.quarantinedAt)
      .where(sql`${table.status} = 'quarantined'`),
  ],
).enableRLS();

export const telegramNewsRequestCheckpoints = pgTable(
  "telegram_news_request_checkpoints",
  {
    updateId: bigint("update_id", { mode: "number" })
      .primaryKey()
      .references(() => telegramUpdates.updateId, { onDelete: "cascade" }),
    status: text("status").notNull(),
    draftId: uuid("draft_id").references(() => drafts.id, {
      onDelete: "restrict",
    }),
    preview: text("preview"),
    windowHours: integer("window_hours"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    publicationMessageId: bigint("publication_message_id", { mode: "number" }),
    settingsSnapshot: jsonb("settings_snapshot")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    check(
      "telegram_news_request_checkpoints_status_check",
      sql`${table.status} in ('review_ready', 'published', 'no_candidates')`,
    ),
    index("telegram_news_request_checkpoints_draft_id_idx")
      .on(table.draftId)
      .where(sql`${table.draftId} is not null`),
  ],
).enableRLS();

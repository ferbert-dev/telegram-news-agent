import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
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
      sql`${table.status} in ('review_ready', 'published', 'no_candidates', 'blocked_by_policy')`,
    ),
    check(
      "telegram_news_request_checkpoints_result_check",
      sql`(
        (${table.status} = 'review_ready' and ${table.draftId} is not null and ${table.preview} is not null and ${table.publicationMessageId} is null)
        or (${table.status} = 'published' and ${table.draftId} is not null and ${table.preview} is not null and ${table.publicationMessageId} is not null)
        or (${table.status} = 'no_candidates' and ${table.draftId} is null and ${table.preview} is null and ${table.publicationMessageId} is null)
        or (${table.status} = 'blocked_by_policy' and ${table.draftId} is not null and ${table.preview} is not null and ${table.publicationMessageId} is null)
      )`,
    ),
    index("telegram_news_request_checkpoints_draft_id_idx")
      .on(table.draftId)
      .where(sql`${table.draftId} is not null`),
  ],
).enableRLS();

export const telegramNewsJobs = pgTable(
  "telegram_news_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestUpdateId: bigint("request_update_id", { mode: "number" })
      .notNull()
      .unique()
      .references(() => telegramUpdates.updateId, { onDelete: "restrict" }),
    telegramChannelId: text("telegram_channel_id").notNull(),
    controlChatId: bigint("control_chat_id", { mode: "number" }).notNull(),
    requestedBy: bigint("requested_by", { mode: "number" }).notNull(),
    settingsSnapshot: jsonb("settings_snapshot").$type<JsonObject>().notNull(),
    status: text("status").default("queued").notNull(),
    workerSlot: smallint("worker_slot").default(1).notNull(),
    activeJobId: uuid("active_job_id").references(
      (): AnyPgColumn => telegramNewsJobs.id,
      { onDelete: "restrict" },
    ),
    claimToken: uuid("claim_token"),
    claimedAt: timestampWithTimezone("claimed_at"),
    availableAt: timestampWithTimezone("available_at").defaultNow().notNull(),
    executionAttemptCount: integer("execution_attempt_count")
      .default(0)
      .notNull(),
    deliveryAttemptCount: integer("delivery_attempt_count")
      .default(0)
      .notNull(),
    outcomeStatus: text("outcome_status"),
    draftId: uuid("draft_id").references(() => drafts.id, {
      onDelete: "restrict",
    }),
    publicationMessageId: bigint("publication_message_id", {
      mode: "number",
    }),
    errorCode: text("error_code"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    completedAt: timestampWithTimezone("completed_at"),
  },
  (table) => [
    check(
      "telegram_news_jobs_channel_check",
      sql`btrim(${table.telegramChannelId}) <> '' and length(${table.telegramChannelId}) <= 255`,
    ),
    check(
      "telegram_news_jobs_actor_check",
      sql`${table.controlChatId} > 0 and ${table.requestedBy} > 0`,
    ),
    check(
      "telegram_news_jobs_settings_snapshot_check",
      sql`jsonb_typeof(${table.settingsSnapshot}) = 'object'`,
    ),
    check(
      "telegram_news_jobs_status_check",
      sql`${table.status} in ('queued', 'processing', 'outcome_ready', 'delivering', 'completed', 'failed', 'suppressed')`,
    ),
    check("telegram_news_jobs_worker_slot_check", sql`${table.workerSlot} = 1`),
    check(
      "telegram_news_jobs_attempts_check",
      sql`${table.executionAttemptCount} >= 0 and ${table.deliveryAttemptCount} >= 0`,
    ),
    check(
      "telegram_news_jobs_outcome_status_check",
      sql`${table.outcomeStatus} is null or ${table.outcomeStatus} in ('review_ready', 'published', 'no_candidates', 'blocked_by_policy', 'failed', 'already_running')`,
    ),
    uniqueIndex("telegram_news_jobs_single_worker_idx")
      .on(table.workerSlot)
      .where(sql`${table.status} in ('processing', 'delivering')`),
    uniqueIndex("telegram_news_jobs_active_channel_idx")
      .on(table.telegramChannelId)
      .where(
        sql`${table.status} in ('queued', 'processing', 'outcome_ready', 'delivering')`,
      ),
    index("telegram_news_jobs_available_idx")
      .on(table.availableAt, table.createdAt)
      .where(sql`${table.status} in ('queued', 'outcome_ready')`),
  ],
).enableRLS();

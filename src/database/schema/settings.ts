import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { type JsonObject, timestampWithTimezone } from "./common.js";
import { drafts } from "./editorial.js";

export const newsBotSettings = pgTable(
  "news_bot_settings",
  {
    telegramChannelId: text("telegram_channel_id").primaryKey(),
    reviewChatId: bigint("review_chat_id", { mode: "number" }).notNull(),
    scheduleIntervalMinutes: integer("schedule_interval_minutes"),
    languageCode: text("language_code").default("en").notNull(),
    topicCodes: text("topic_codes")
      .array()
      .default(
        sql`array['ai', 'world', 'science', 'nature', 'animals', 'history', 'culture', 'technology', 'society']::text[]`,
      )
      .notNull(),
    customTopics: text("custom_topics")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    approvalPolicy: text("approval_policy").default("manual").notNull(),
    nextRunAt: timestampWithTimezone("next_run_at"),
    version: integer("version").default(1).notNull(),
    updatedBy: bigint("updated_by", { mode: "number" }).notNull(),
    scheduleClaimToken: uuid("schedule_claim_token"),
    scheduleClaimedAt: timestampWithTimezone("schedule_claimed_at"),
    scheduleRunId: uuid("schedule_run_id"),
    scheduleRunDueAt: timestampWithTimezone("schedule_run_due_at"),
    scheduleSettingsSnapshot: jsonb("schedule_settings_snapshot").$type<JsonObject>(),
    scheduleDraftId: uuid("schedule_draft_id").references(() => drafts.id, {
      onDelete: "restrict",
    }),
    schedulePreview: text("schedule_preview"),
    scheduleWindowHours: integer("schedule_window_hours"),
    schedulePublicationMessageId: bigint("schedule_publication_message_id", {
      mode: "number",
    }),
    lastRunAt: timestampWithTimezone("last_run_at"),
    lastRunStatus: text("last_run_status"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    quietHoursEnabled: boolean("quiet_hours_enabled").default(true).notNull(),
  },
  (table) => [
    check(
      "news_bot_settings_schedule_interval_minutes_check",
      sql`${table.scheduleIntervalMinutes} in (60, 180, 360, 720, 1440)`,
    ),
    check(
      "news_bot_settings_language_code_check",
      sql`${table.languageCode} in ('en', 'uk', 'de')`,
    ),
    check(
      "news_bot_settings_approval_policy_check",
      sql`${table.approvalPolicy} in ('manual', 'automatic')`,
    ),
    check("news_bot_settings_version_check", sql`${table.version} > 0`),
    index("news_bot_settings_due_idx")
      .on(table.nextRunAt)
      .where(sql`${table.scheduleIntervalMinutes} is not null`),
    index("news_bot_settings_schedule_draft_id_idx")
      .on(table.scheduleDraftId)
      .where(sql`${table.scheduleDraftId} is not null`),
  ],
).enableRLS();

export const telegramSettingsInputs = pgTable(
  "telegram_settings_inputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    controlChatId: bigint("control_chat_id", { mode: "number" }).notNull(),
    requestedBy: bigint("requested_by", { mode: "number" }).notNull(),
    promptMessageId: bigint("prompt_message_id", { mode: "number" }).notNull(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("telegram_settings_inputs_control_chat_id_requested_by_key").on(
      table.controlChatId,
      table.requestedBy,
    ),
    check(
      "telegram_settings_inputs_prompt_message_id_check",
      sql`${table.promptMessageId} > 0`,
    ),
    index("telegram_settings_inputs_expires_idx").on(table.expiresAt),
  ],
).enableRLS();

export const newsFeatureFlags = pgTable(
  "news_feature_flags",
  {
    telegramChannelId: text("telegram_channel_id")
      .notNull()
      .references(() => newsBotSettings.telegramChannelId, {
        onDelete: "cascade",
      }),
    featureKey: text("feature_key").notNull(),
    state: text("state").default("off").notNull(),
    config: jsonb("config")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    version: integer("version").default(1).notNull(),
    updatedBy: bigint("updated_by", { mode: "number" }).notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.telegramChannelId, table.featureKey] }),
    check(
      "news_feature_flags_feature_key_check",
      sql`${table.featureKey} = 'article_tags'`,
    ),
    check(
      "news_feature_flags_state_check",
      sql`${table.state} in ('off', 'collect', 'enabled')`,
    ),
    check("news_feature_flags_version_check", sql`${table.version} > 0`),
  ],
).enableRLS();

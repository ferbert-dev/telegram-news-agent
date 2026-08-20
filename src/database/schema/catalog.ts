import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { type JsonObject, timestampWithTimezone } from "./common.js";

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    homepageUrl: text("homepage_url"),
    feedUrl: text("feed_url").unique(),
    sourceType: text("source_type").notNull(),
    reliabilityScore: smallint("reliability_score"),
    enabled: boolean("enabled").default(true).notNull(),
    lastCheckedAt: timestampWithTimezone("last_checked_at"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    lastSuccessAt: timestampWithTimezone("last_success_at"),
    lastFailedAt: timestampWithTimezone("last_failed_at"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    disabledUntil: timestampWithTimezone("disabled_until"),
    discoveredBy: text("discovered_by").default("manual").notNull(),
    discoveryMetadata: jsonb("discovery_metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    check(
      "sources_source_type_check",
      sql`${table.sourceType} in ('rss', 'website', 'api', 'manual')`,
    ),
    check(
      "sources_reliability_score_check",
      sql`${table.reliabilityScore} between 0 and 100`,
    ),
    check(
      "sources_consecutive_failures_check",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "sources_discovered_by_check",
      sql`${table.discoveredBy} in ('seed', 'manual', 'openai', 'gemini', 'exa')`,
    ),
    index("sources_enabled_primary_score_idx").on(
      table.enabled,
      table.isPrimary,
      table.reliabilityScore.desc(),
    ),
    index("sources_available_topic_scan_idx").on(
      table.enabled,
      table.disabledUntil,
      table.reliabilityScore.desc(),
    ),
  ],
).enableRLS();

export const topics = pgTable(
  "topics",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description"),
    keywords: text("keywords").array().default(sql`'{}'::text[]`).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
).enableRLS();

export const sourceTopics = pgTable(
  "source_topics",
  {
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.topicId] }),
    index("source_topics_topic_id_idx").on(table.topicId),
  ],
).enableRLS();

export const topicTranslations = pgTable(
  "topic_translations",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    languageCode: text("language_code").notNull(),
    label: text("label").notNull(),
    hashtag: text("hashtag").notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topicId, table.languageCode] }),
    check(
      "topic_translations_language_code_check",
      sql`${table.languageCode} in ('en', 'uk', 'de')`,
    ),
  ],
).enableRLS();

export const sourceDiscoveryState = pgTable(
  "source_discovery_state",
  {
    topicKey: text("topic_key").primaryKey(),
    status: text("status").notNull(),
    lastAttemptAt: timestampWithTimezone("last_attempt_at")
      .defaultNow()
      .notNull(),
    nextAttemptAt: timestampWithTimezone("next_attempt_at").notNull(),
    provider: text("provider"),
    model: text("model"),
    resultCount: integer("result_count").default(0).notNull(),
    lastErrorCode: text("last_error_code"),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "source_discovery_state_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      "source_discovery_state_result_count_check",
      sql`${table.resultCount} >= 0`,
    ),
  ],
).enableRLS();

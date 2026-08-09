import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { sources, topics } from "./catalog.js";
import { type JsonObject, timestampWithTimezone } from "./common.js";

export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    query: text("query").notNull(),
    status: text("status").default("running").notNull(),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    startedAt: timestampWithTimezone("started_at").defaultNow().notNull(),
    finishedAt: timestampWithTimezone("finished_at"),
    resultCount: integer("result_count").default(0).notNull(),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    check(
      "search_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check("search_runs_result_count_check", sql`${table.resultCount} >= 0`),
    index("search_runs_source_id_idx").on(table.sourceId),
  ],
).enableRLS();

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").references(() => sources.id, {
      onDelete: "set null",
    }),
    searchRunId: uuid("search_run_id").references(() => searchRuns.id, {
      onDelete: "set null",
    }),
    canonicalUrl: text("canonical_url").notNull().unique(),
    title: text("title").notNull(),
    author: text("author"),
    publishedAt: timestampWithTimezone("published_at"),
    discoveredAt: timestampWithTimezone("discovered_at")
      .defaultNow()
      .notNull(),
    contentHash: text("content_hash"),
    status: text("status").default("discovered").notNull(),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "articles_status_check",
      sql`${table.status} in ('discovered', 'extracted', 'reviewed', 'drafted', 'approved', 'published', 'rejected', 'failed')`,
    ),
    uniqueIndex("articles_content_hash_unique")
      .on(table.contentHash)
      .where(sql`${table.contentHash} is not null`),
    index("articles_source_published_idx").on(
      table.sourceId,
      table.publishedAt.desc(),
    ),
    index("articles_status_discovered_idx").on(
      table.status,
      table.discoveredAt.desc(),
    ),
    index("articles_search_run_id_idx").on(table.searchRunId),
  ],
).enableRLS();

export const rawContents = pgTable(
  "raw_contents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    contentType: text("content_type").default("text").notNull(),
    languageCode: text("language_code"),
    fetchedAt: timestampWithTimezone("fetched_at").defaultNow().notNull(),
    extractor: text("extractor"),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "raw_contents_content_type_check",
      sql`${table.contentType} in ('text', 'html', 'markdown', 'json')`,
    ),
    unique("raw_contents_article_id_content_hash_key").on(
      table.articleId,
      table.contentHash,
    ),
    index("raw_contents_article_fetched_idx").on(
      table.articleId,
      table.fetchedAt.desc(),
    ),
  ],
).enableRLS();

export const articleTopics = pgTable(
  "article_topics",
  {
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    relevanceScore: numeric("relevance_score", { precision: 5, scale: 4 }),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    assignmentSource: text("assignment_source").default("ai").notNull(),
    assignedModel: text("assigned_model"),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.topicId] }),
    check(
      "article_topics_relevance_score_check",
      sql`${table.relevanceScore} between 0 and 1`,
    ),
    check(
      "article_topics_assignment_source_check",
      sql`${table.assignmentSource} in ('ai', 'manual', 'rule')`,
    ),
    index("article_topics_topic_id_idx").on(table.topicId),
  ],
).enableRLS();

export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerResponseId: text("provider_response_id"),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    telegramChannelId: text("telegram_channel_id"),
    searchRunId: uuid("search_run_id").references(() => searchRuns.id, {
      onDelete: "set null",
    }),
    articleId: uuid("article_id").references(() => articles.id, {
      onDelete: "set null",
    }),
    inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" })
      .default(0)
      .notNull(),
    webSearchCalls: integer("web_search_calls").default(0).notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd", {
      precision: 16,
      scale: 8,
    }),
    pricingSnapshot: jsonb("pricing_snapshot").$type<JsonObject>(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("ai_usage_events_provider_provider_response_id_key").on(
      table.provider,
      table.providerResponseId,
    ),
    index("ai_usage_events_channel_created_idx").on(
      table.telegramChannelId,
      table.createdAt.desc(),
    ),
    index("ai_usage_events_search_run_idx")
      .on(table.searchRunId)
      .where(sql`${table.searchRunId} is not null`),
    index("ai_usage_events_article_idx")
      .on(table.articleId)
      .where(sql`${table.articleId} is not null`),
  ],
).enableRLS();

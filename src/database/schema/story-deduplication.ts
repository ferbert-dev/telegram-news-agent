import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { drafts } from "./editorial.js";
import { type JsonObject, timestampWithTimezone } from "./common.js";
import { articles } from "./research.js";

export const articleStoryDecisions = pgTable(
  "article_story_decisions",
  {
    articleId: uuid("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    storyFingerprint: text("story_fingerprint").notNull(),
    relation: text("relation").notNull(),
    duplicateOfArticleId: uuid("duplicate_of_article_id").references(
      () => articles.id,
      { onDelete: "set null" },
    ),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    reason: text("reason"),
    decisionSource: text("decision_source").notNull(),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    decidedAt: timestampWithTimezone("decided_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "article_story_decisions_relation_check",
      sql`${table.relation} in ('distinct', 'duplicate', 'follow_up', 'uncertain')`,
    ),
    check(
      "article_story_decisions_source_check",
      sql`${table.decisionSource} in ('deterministic', 'ai', 'fallback')`,
    ),
    check(
      "article_story_decisions_confidence_check",
      sql`${table.confidence} is null or ${table.confidence} between 0 and 1`,
    ),
    check(
      "article_story_decisions_duplicate_target_check",
      sql`(${table.relation} in ('duplicate', 'follow_up') and ${table.duplicateOfArticleId} is not null)
        or (${table.relation} in ('distinct', 'uncertain') and ${table.duplicateOfArticleId} is null)`,
    ),
    index("article_story_decisions_fingerprint_idx").on(
      table.storyFingerprint,
    ),
    index("article_story_decisions_duplicate_of_idx")
      .on(table.duplicateOfArticleId)
      .where(sql`${table.duplicateOfArticleId} is not null`),
  ],
).enableRLS();

export const storyPublicationClaims = pgTable(
  "story_publication_claims",
  {
    telegramChannelId: text("telegram_channel_id").notNull(),
    storyFingerprint: text("story_fingerprint").notNull(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "restrict" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    status: text("status").default("publishing").notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.telegramChannelId, table.storyFingerprint],
    }),
    unique("story_publication_claims_draft_id_key").on(table.draftId),
    check(
      "story_publication_claims_channel_check",
      sql`btrim(${table.telegramChannelId}) <> ''`,
    ),
    check(
      "story_publication_claims_fingerprint_check",
      sql`btrim(${table.storyFingerprint}) <> ''`,
    ),
    check(
      "story_publication_claims_status_check",
      sql`${table.status} in ('publishing', 'published')`,
    ),
    index("story_publication_claims_article_id_idx").on(table.articleId),
  ],
).enableRLS();

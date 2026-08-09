import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { type JsonObject, timestampWithTimezone } from "./common.js";
import { articles } from "./research.js";

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    status: text("status").default("draft").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    reviewerNotes: text("reviewer_notes"),
    approvedAt: timestampWithTimezone("approved_at"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "drafts_status_check",
      sql`${table.status} in ('draft', 'review', 'approved', 'publishing', 'rejected', 'published')`,
    ),
    index("drafts_status_created_idx").on(
      table.status,
      table.createdAt.desc(),
    ),
    index("drafts_article_id_idx").on(table.articleId),
    uniqueIndex("drafts_one_active_article_idx")
      .on(table.articleId)
      .where(sql`${table.status} <> 'rejected'`),
  ],
).enableRLS();

export const publishedPosts = pgTable(
  "published_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "restrict" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    telegramChannelId: text("telegram_channel_id").notNull(),
    telegramMessageId: bigint("telegram_message_id", {
      mode: "number",
    }).notNull(),
    publishedAt: timestampWithTimezone("published_at").defaultNow().notNull(),
    messageText: text("message_text").notNull(),
    metadata: jsonb("metadata")
      .$type<JsonObject>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("published_posts_telegram_channel_id_telegram_message_id_key").on(
      table.telegramChannelId,
      table.telegramMessageId,
    ),
    unique("published_posts_draft_id_unique").on(table.draftId),
    index("published_posts_published_idx").on(table.publishedAt.desc()),
    index("published_posts_article_id_idx").on(table.articleId),
    index("published_posts_draft_id_idx").on(table.draftId),
  ],
).enableRLS();

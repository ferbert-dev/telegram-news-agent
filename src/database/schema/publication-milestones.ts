import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { timestampWithTimezone } from "./common.js";
import { publishedPosts } from "./editorial.js";
import { newsBotSettings } from "./settings.js";

export const publicationMilestones = pgTable(
  "publication_milestones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramChannelId: text("telegram_channel_id")
      .notNull()
      .references(() => newsBotSettings.telegramChannelId, {
        onDelete: "cascade",
      }),
    ordinal: integer("ordinal").notNull(),
    publishedPostId: uuid("published_post_id")
      .notNull()
      .references(() => publishedPosts.id, {
        onDelete: "cascade",
      }),
    languageCode: text("language_code").notNull(),
    editorName: text("editor_name").notNull(),
    state: text("state").default("pending").notNull(),
    claimToken: uuid("claim_token"),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    claimedAt: timestampWithTimezone("claimed_at"),
    sentAt: timestampWithTimezone("sent_at"),
    failedAt: timestampWithTimezone("failed_at"),
    uncertainAt: timestampWithTimezone("uncertain_at"),
  },
  (table) => [
    unique("publication_milestones_channel_ordinal_key").on(
      table.telegramChannelId,
      table.ordinal,
    ),
    unique("publication_milestones_published_post_id_key").on(
      table.publishedPostId,
    ),
    check("publication_milestones_ordinal_check", sql`${table.ordinal} > 0`),
    check(
      "publication_milestones_language_code_check",
      sql`${table.languageCode} in ('en', 'uk', 'de')`,
    ),
    check(
      "publication_milestones_state_check",
      sql`${table.state} in ('pending', 'sending', 'sent', 'failed', 'uncertain')`,
    ),
    check(
      "publication_milestones_claim_check",
      sql`(
        (${table.state} = 'sending' and ${table.claimToken} is not null and ${table.claimedAt} is not null)
        or
        (${table.state} <> 'sending' and ${table.claimToken} is null and ${table.claimedAt} is null)
      )`,
    ),
    check(
      "publication_milestones_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    index("publication_milestones_state_idx").on(table.state),
  ],
).enableRLS();

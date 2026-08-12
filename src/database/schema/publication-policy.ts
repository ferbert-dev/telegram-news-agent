import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { drafts } from "./editorial.js";
import { articles } from "./research.js";
import { newsBotSettings } from "./settings.js";
import { timestampWithTimezone } from "./common.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const publicationPolicyBlocks = pgTable(
  "publication_policy_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    telegramChannelId: text("telegram_channel_id")
      .notNull()
      .references(() => newsBotSettings.telegramChannelId, {
        onDelete: "restrict",
      }),
    draftId: uuid("draft_id").references(() => drafts.id, {
      onDelete: "restrict",
    }),
    articleId: uuid("article_id").references(() => articles.id, {
      onDelete: "restrict",
    }),
    stage: text("stage").notNull(),
    publicationPath: text("publication_path").notNull(),
    topicCode: text("topic_code").notNull(),
    classification: text("classification").notNull(),
    settingsVersion: integer("settings_version").notNull(),
    outboundTextSha256: bytea("outbound_text_sha256").notNull(),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    reasonCode: text("reason_code").notNull(),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("publication_policy_blocks_idempotency_key_key").on(
      table.idempotencyKey,
    ),
    check(
      "publication_policy_blocks_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "publication_policy_blocks_channel_check",
      sql`char_length(btrim(${table.telegramChannelId})) between 1 and 255`,
    ),
    check(
      "publication_policy_blocks_stage_check",
      sql`${table.stage} in ('final_publication', 'direct_publication', 'reconciliation')`,
    ),
    check(
      "publication_policy_blocks_path_check",
      sql`${table.publicationPath} in ('automatic', 'automatic_news', 'manual_review', 'scheduler', 'drafts_cli', 'reconciliation', 'direct')`,
    ),
    check(
      "publication_policy_blocks_topic_check",
      sql`public.valid_news_excluded_topic_codes(array[${table.topicCode}]::text[])`,
    ),
    check(
      "publication_policy_blocks_classification_check",
      sql`${table.classification} in ('main_subject', 'uncertain', 'classifier_error')`,
    ),
    check(
      "publication_policy_blocks_settings_version_check",
      sql`${table.settingsVersion} >= 1`,
    ),
    check(
      "publication_policy_blocks_outbound_hash_check",
      sql`octet_length(${table.outboundTextSha256}) = 32`,
    ),
    check(
      "publication_policy_blocks_provider_check",
      sql`${table.provider} is null or ${table.provider} ~ '^[A-Za-z0-9._:/-]{1,100}$'`,
    ),
    check(
      "publication_policy_blocks_model_check",
      sql`${table.model} is null or ${table.model} ~ '^[A-Za-z0-9._:/-]{1,100}$'`,
    ),
    check(
      "publication_policy_blocks_prompt_version_check",
      sql`${table.promptVersion} is null or ${table.promptVersion} ~ '^[A-Za-z0-9._:/-]{1,100}$'`,
    ),
    check(
      "publication_policy_blocks_reason_check",
      sql`${table.reasonCode} in ('excluded_topic_main_subject', 'excluded_topic_uncertain', 'excluded_topic_classifier_error')`,
    ),
    uniqueIndex("publication_policy_blocks_draft_unique")
      .on(table.telegramChannelId, table.draftId)
      .where(sql`${table.draftId} is not null`),
    index("publication_policy_blocks_article_created_idx")
      .on(table.articleId, table.createdAt.desc())
      .where(sql`${table.articleId} is not null`),
    index("publication_policy_blocks_channel_created_idx").on(
      table.telegramChannelId,
      table.createdAt.desc(),
    ),
  ],
).enableRLS();
